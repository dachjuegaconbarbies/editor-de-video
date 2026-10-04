/**
 * Ejecución de ffmpeg/ffprobe: siempre con `spawn` y argumentos en arreglo (sin shell), con
 * AbortSignal, tiempo límite, progreso (`-progress pipe:1`) y cola de stderr para diagnosticar.
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { UserFacingError, type Log } from "../services/types.js";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunProcessOptions {
  signal?: AbortSignal;
  /** Tiempo límite en ms (por defecto 30 min). */
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Recibe cada fragmento de stdout (para progreso). */
  onStdout?: (chunk: string) => void;
  /** Guardar stdout completo (si no, solo la cola). */
  keepStdout?: boolean;
}

const TAIL = 64 * 1024;

/** Error de cancelación coherente con la cola de trabajos (usa el motivo del AbortSignal si existe). */
export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new UserFacingError("cancelado", "Se canceló el render", 409);
}

/** Ejecuta un proceso y junta su salida. Nunca usa shell. */
export function runProcess(bin: string, args: string[], opts: RunProcessOptions = {}): Promise<ProcessResult> {
  const { signal, timeoutMs = 30 * 60 * 1000 } = opts;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const onAbort = () => {
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      opts.onStdout?.(d);
      stdout = opts.keepStdout ? stdout + d : (stdout + d).slice(-TAIL);
    });
    child.stderr!.on("data", (d: string) => {
      stderr = (stderr + d).slice(-TAIL);
    });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) =>
      finish(() => {
        if (signal?.aborted) return reject(abortError(signal));
        if (timedOut) {
          return reject(new UserFacingError("tiempo-agotado", `El proceso ${path.basename(bin)} superó el tiempo límite`, 504, { tail: stderr.slice(-2000) }));
        }
        resolve({ code: code ?? -1, stdout, stderr });
      }),
    );
  });
}

/** Representación legible (y copiable a una terminal POSIX) de un comando. */
export function formatCommand(bin: string, args: string[]): string {
  const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
  return [bin, ...args].map(q).join(" ");
}

/** Último mensaje de error útil de la salida de ffmpeg. */
export function ffmpegErrorSummary(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^(frame|fps|stream_|bitrate|total_size|out_time|dup_frames|drop_frames|speed|progress)=/.test(l));
  return lines.slice(-6).join(" | ").slice(0, 900);
}

export interface FfmpegRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  cwd?: string;
  /** Duración esperada de la salida en segundos (para calcular el progreso). */
  durationSeconds?: number;
  onProgress?: (fraction: number) => void;
  log?: Log;
  /** Qué se estaba haciendo (para el mensaje de error). */
  what?: string;
}

/**
 * Ejecuta ffmpeg con `-progress pipe:1` y traduce `out_time_us` a progreso 0..1.
 * Ojo: `out_time_ms` también viene en microsegundos (trampa documentada en media-pipeline.md §5.8).
 */
export async function runFfmpeg(bin: string, args: string[], opts: FfmpegRunOptions = {}): Promise<ProcessResult> {
  const full = ["-hide_banner", "-nostdin", "-y", ...(opts.onProgress ? ["-progress", "pipe:1", "-nostats"] : []), ...args];
  let buf = "";
  const res = await runProcess(bin, full, {
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    cwd: opts.cwd,
    onStdout: opts.onProgress
      ? (chunk) => {
          buf += chunk;
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const m = /^out_time_us=(\d+)/.exec(line.trim());
            if (m && opts.durationSeconds && opts.durationSeconds > 0) {
              opts.onProgress!(Math.max(0, Math.min(1, Number(m[1]) / 1e6 / opts.durationSeconds)));
            } else if (line.trim() === "progress=end") {
              opts.onProgress!(1);
            }
          }
        }
      : undefined,
  });
  if (res.code !== 0) {
    const summary = ffmpegErrorSummary(res.stderr);
    opts.log?.error({ what: opts.what, summary }, "ffmpeg falló");
    throw new UserFacingError(
      "render-ffmpeg",
      `No se pudo ${opts.what ?? "procesar el video"} (ffmpeg terminó con código ${res.code}).`,
      500,
      { ffmpeg: summary },
    );
  }
  return res;
}

/** Escribe un grafo grande a archivo y devuelve los argumentos adecuados para la versión de ffmpeg. */
export async function filterGraphArgs(graph: string, workDir: string, ffmpegMajor: number, name = "grafo.txt"): Promise<string[]> {
  // En Linux un solo argumento debe medir < 128 KiB (MAX_ARG_STRLEN). Dejamos margen.
  if (Buffer.byteLength(graph) < 100_000) return ["-filter_complex", graph];
  const file = path.join(workDir, name);
  await writeFile(file, graph, "utf8");
  // ffmpeg < 7: -filter_complex_script; ffmpeg >= 7: -/filter_complex (el primero ya no existe en 9.x).
  return ffmpegMajor >= 7 ? ["-/filter_complex", file] : ["-filter_complex_script", file];
}

export interface FfmpegInfo {
  version: string;
  major: number;
  filters: Set<string>;
  encoders: Set<string>;
}

const infoCache = new Map<string, Promise<FfmpegInfo>>();

/** Versión, filtros y codificadores disponibles (en caché por binario). */
export function ffmpegInfo(bin: string): Promise<FfmpegInfo> {
  let p = infoCache.get(bin);
  if (!p) {
    p = (async () => {
      const v = await runProcess(bin, ["-hide_banner", "-version"], { timeoutMs: 20_000 });
      const first = v.stdout.split("\n")[0] ?? "";
      const m = /ffmpeg version n?(\d+)\.?(\d+)?/i.exec(first);
      const filters = await runProcess(bin, ["-hide_banner", "-filters"], { timeoutMs: 20_000, keepStdout: true });
      const encoders = await runProcess(bin, ["-hide_banner", "-encoders"], { timeoutMs: 20_000, keepStdout: true });
      const names = (txt: string) =>
        new Set(
          txt
            .split("\n")
            .map((l) => l.trim().split(/\s+/)[1] ?? "")
            .filter(Boolean),
        );
      return { version: first.trim(), major: m ? Number(m[1]) : 0, filters: names(filters.stdout), encoders: names(encoders.stdout) };
    })();
    infoCache.set(bin, p);
    p.catch(() => infoCache.delete(bin));
  }
  return p;
}
