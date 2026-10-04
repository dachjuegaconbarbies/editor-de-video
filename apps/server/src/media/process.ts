/**
 * Ejecución de procesos externos (ffmpeg, ffprobe, Python) con las reglas del proyecto:
 * siempre `spawn` con argumentos en arreglo (nunca un string de shell), `AbortSignal`, tiempo
 * límite y salida leída por líneas o en binario sin acumular memoria de más.
 */
import { spawn } from "node:child_process";
import { UserFacingError } from "../services/types.js";

export interface ProcOptions {
  signal?: AbortSignal;
  /** Tiempo límite en ms (por defecto 10 min). */
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Nombre legible para los mensajes ("ffmpeg", "Python"…). */
  label?: string;
  /** Cada línea de stdout (texto). Si se usa, stdout no se acumula salvo `collectStdout`. */
  onStdoutLine?: (line: string) => void;
  /** Cada trozo binario de stdout (p. ej. PCM). Si se usa, stdout no se acumula. */
  onStdoutData?: (chunk: Buffer) => void;
  /** Cada línea de stderr (ffmpeg escribe ahí los resultados de showinfo, silencedetect, ebur128…). */
  onStderrLine?: (line: string) => void;
  /** Acumular stdout aunque haya callbacks. */
  collectStdout?: boolean;
  /** Límite de stdout acumulado (por defecto 64 MB). */
  maxStdoutBytes?: number;
  /** Cuánto del final de stderr se conserva para mensajes de error (por defecto 64 KB). */
  stderrTailBytes?: number;
}

export interface ProcResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  /** Final de stderr (hasta `stderrTailBytes`). */
  stderr: string;
  ms: number;
}

const DEFAULT_TIMEOUT = 10 * 60_000;

/** Error de cancelación (el trabajo se canceló desde la cola). */
export function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : "Operación cancelada");
  err.name = "AbortError";
  return err;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

/** Corta un buffer de texto en líneas y entrega las completas. */
function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer): void; end(): void } {
  let rest = "";
  return {
    push(chunk) {
      rest += chunk.toString("utf8");
      const parts = rest.split(/\r?\n|\r/);
      rest = parts.pop() ?? "";
      for (const p of parts) onLine(p);
    },
    end() {
      if (rest) onLine(rest);
      rest = "";
    },
  };
}

/** Ejecuta un proceso y resuelve siempre con su código (no lanza por código ≠ 0). */
export function runProcess(cmd: string, args: string[], opts: ProcOptions = {}): Promise<ProcResult> {
  const label = opts.label ?? cmd;
  const started = Date.now();
  const maxStdout = opts.maxStdoutBytes ?? 64 * 1024 * 1024;
  const tailBytes = opts.stderrTailBytes ?? 64 * 1024;
  const collect = opts.collectStdout ?? (!opts.onStdoutLine && !opts.onStdoutData);

  return new Promise<ProcResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(abortError(opts.signal));
      return;
    }
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | null = null;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = "";
    const outLines = opts.onStdoutLine ? lineSplitter(opts.onStdoutLine) : null;
    const errLines = opts.onStderrLine ? lineSplitter(opts.onStderrLine) : null;

    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 3000);
      killTimer.unref?.();
    };

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        opts.onStdoutData?.(chunk);
        outLines?.push(chunk);
      } catch (err) {
        // Un error al procesar la salida corta el proceso y se informa.
        if (!settled) {
          settled = true;
          cleanup();
          kill();
          reject(err);
        }
        return;
      }
      if (collect && stdoutBytes < maxStdout) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errLines?.push(chunk);
      stderrTail += chunk.toString("utf8");
      if (stderrTail.length > tailBytes * 2) stderrTail = stderrTail.slice(-tailBytes);
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err.code === "ENOENT") {
        reject(new UserFacingError("programa-no-encontrado", `No se encontró ${label} (${cmd}). Revisa que esté instalado o corre «pnpm diagnostico».`, 503));
      } else {
        reject(new UserFacingError("programa-fallo", `No se pudo ejecutar ${label}: ${err.message}`, 500));
      }
    });

    child.on("close", (code, sig) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        outLines?.end();
        errLines?.end();
      } catch {
        // ignorado: el proceso ya terminó
      }
      if (aborted || opts.signal?.aborted) {
        reject(abortError(opts.signal));
        return;
      }
      if (timedOut) {
        reject(new UserFacingError("proceso-tiempo-agotado", `${label} tardó demasiado (más de ${Math.round(timeoutMs / 1000)} s) y se detuvo.`, 504));
        return;
      }
      resolve({
        code,
        signal: sig,
        stdout: collect ? Buffer.concat(stdoutChunks).toString("utf8") : "",
        stderr: stderrTail.slice(-tailBytes),
        ms: Date.now() - started,
      });
    });
  });
}

/** Últimas líneas útiles de stderr (para mensajes de error). */
export function stderrSummary(stderr: string, lines = 3): string {
  return stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\s*(frame=|size=|video:|Press \[q\])/.test(l))
    .slice(-lines)
    .join(" · ")
    .slice(0, 400);
}

/** Igual que runProcess pero lanza si el código de salida no es 0. */
export async function runChecked(cmd: string, args: string[], opts: ProcOptions & { errorMessage?: string } = {}): Promise<ProcResult> {
  const res = await runProcess(cmd, args, opts);
  if (res.code !== 0) {
    const why = stderrSummary(res.stderr);
    throw new Error(`${opts.errorMessage ?? `${opts.label ?? cmd} falló`} (código ${res.code ?? res.signal})${why ? `: ${why}` : ""}`);
  }
  return res;
}

/** Tiempo límite razonable para una pasada que decodifica `durationSec` de medio. */
export function decodeTimeout(durationSec: number | null | undefined, perSecond = 2, baseMs = 60_000): number {
  const d = Number.isFinite(durationSec) && durationSec ? durationSec : 600;
  return Math.round(baseMs + d * perSecond * 1000);
}

/** Ejecuta tareas asíncronas con un máximo de concurrencia, conservando el orden de resultados. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
