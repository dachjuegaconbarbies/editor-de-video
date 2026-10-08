/**
 * Transcripción local con faster-whisper (worker de Python `workers/python/transcribe.py`).
 *
 * Protocolo con el worker: JSON-lines por stdout.
 *   {"type":"progress","p":0.42,"message":"…"}
 *   {"type":"result","language":"es","words":[…],"segments":[…]}
 *   {"type":"error","code":"modelo-no-disponible","message":"…en español…","detail":"…"}
 *   {"type":"check",…}   (solo con --check)
 *
 * Los modelos viven en `models/whisper/faster-whisper-<modelo>` (carpeta ignorada por git).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../env.js";
import { UserFacingError, type Availability, type Log, type RawTranscript, type RawTranscriptWord, type RunOptions, type Transcriber } from "../services/types.js";
import { ffprobeJson, parseProbe } from "../media/probe.js";
import { runProcess, stderrSummary } from "../media/process.js";
import { buildTranscript } from "./segments.js";

export const TRANSCRIBE_SCRIPT = path.join(REPO_ROOT, "workers/python/transcribe.py");
export const DEFAULT_MODELS_DIR = path.join(REPO_ROOT, "models/whisper");

export interface WhisperDeps {
  pythonPath: string;
  ffprobePath: string;
  model: string;
  device: string;
  computeType: string;
  log: Log;
  modelsDir?: string;
  script?: string;
}

interface WorkerMessage {
  type: "progress" | "result" | "error" | "check";
  p?: number;
  message?: string;
  code?: string;
  detail?: string;
  language?: string;
  words?: RawTranscriptWord[];
  segments?: RawTranscript["segments"];
  [k: string]: unknown;
}

export interface WhisperCheck {
  fasterWhisper: string;
  modelPresent: boolean;
  path: string;
  canDownload: boolean | null;
  approxSize: string;
  detail: string;
}

/** Códigos del worker que significan "no está instalado / no hay modelo" (permiten caer a demo). */
export const NOT_INSTALLED_CODES = new Set(["falta-faster-whisper", "modelo-no-disponible", "programa-no-encontrado", "falta-python"]);

const MISSING_ENV = "Falta el entorno de Python con faster-whisper (workers/python/.venv). Corre «pnpm instalar».";

/** Ejecuta el worker y procesa sus JSON-lines. */
async function runWorker(
  deps: WhisperDeps,
  args: string[],
  opts: { signal?: AbortSignal; timeoutMs: number; onProgress?: (p: number, message?: string) => void },
): Promise<WorkerMessage> {
  const script = deps.script ?? TRANSCRIBE_SCRIPT;
  if (!existsSync(script)) throw new UserFacingError("falta-python", "No se encontró workers/python/transcribe.py.", 503);
  let result: WorkerMessage | null = null;
  let error: WorkerMessage | null = null;
  let res;
  try {
    res = await runProcess(deps.pythonPath, [script, ...args], {
      label: "Python (transcripción)",
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
      onStdoutLine: (line) => {
        const t = line.trim();
        if (!t.startsWith("{")) return;
        let msg: WorkerMessage;
        try {
          msg = JSON.parse(t) as WorkerMessage;
        } catch {
          return;
        }
        if (msg.type === "progress" && typeof msg.p === "number") opts.onProgress?.(msg.p, msg.message);
        else if (msg.type === "result" || msg.type === "check") result = msg;
        else if (msg.type === "error") error = msg;
      },
    });
  } catch (err) {
    if (err instanceof UserFacingError && err.code === "programa-no-encontrado") throw new UserFacingError("falta-python", MISSING_ENV, 503);
    throw err;
  }
  const failed = error as WorkerMessage | null;
  if (failed) {
    deps.log.warn({ code: failed.code, detail: failed.detail }, "El worker de transcripción informó un error");
    throw new UserFacingError(failed.code ?? "transcripcion-fallida", failed.message ?? "Falló la transcripción.", failed.code && NOT_INSTALLED_CODES.has(failed.code) ? 503 : 500, { detail: failed.detail });
  }
  // (las variables se asignan dentro del callback: TypeScript no lo ve)
  const got = result as WorkerMessage | null;
  if (!got || res.code !== 0) {
    const why = stderrSummary(res.stderr, 2);
    if (/No module named|ModuleNotFoundError/.test(res.stderr)) throw new UserFacingError("falta-faster-whisper", MISSING_ENV, 503);
    throw new UserFacingError("transcripcion-fallida", `El proceso de transcripción terminó sin resultado${why ? ` (${why})` : ""}.`, 500);
  }
  return got;
}

export function createWhisperTranscriber(deps: WhisperDeps): Transcriber & {
  check(signal?: AbortSignal): Promise<WhisperCheck>;
  download(opts?: RunOptions): Promise<void>;
} {
  const modelsDir = deps.modelsDir ?? DEFAULT_MODELS_DIR;
  const base = ["--model", deps.model, "--models-dir", modelsDir];

  async function check(signal?: AbortSignal): Promise<WhisperCheck> {
    const msg = await runWorker(deps, [...base, "--check"], { signal, timeoutMs: 45_000 });
    return {
      fasterWhisper: String(msg.fasterWhisper ?? ""),
      modelPresent: msg.modelPresent === true,
      path: String(msg.path ?? ""),
      canDownload: typeof msg.canDownload === "boolean" ? msg.canDownload : null,
      approxSize: String(msg.approxSize ?? ""),
      detail: String(msg.detail ?? ""),
    };
  }

  return {
    provider: "faster-whisper",
    model: deps.model,
    check,

    async available(): Promise<Availability> {
      try {
        const c = await check();
        if (c.modelPresent) return { ready: true, detail: `faster-whisper ${c.fasterWhisper} · modelo «${deps.model}» listo` };
        if (c.canDownload) {
          return { ready: true, detail: `faster-whisper ${c.fasterWhisper} · el modelo «${deps.model}» (~${c.approxSize || "varios cientos de MB"}) se descargará en el primer uso` };
        }
        return {
          ready: false,
          detail: `El modelo de voz «${deps.model}» no está descargado y no hay conexión con Hugging Face. Conéctate a internet y corre «pnpm instalar».`,
        };
      } catch (err) {
        const msg = err instanceof UserFacingError ? err.userMessage : err instanceof Error ? err.message : String(err);
        return { ready: false, detail: msg };
      }
    },

    /** Descarga el modelo (lo usa la instalación o el diagnóstico). */
    async download(opts: RunOptions = {}): Promise<void> {
      await runWorker(deps, [...base, "--download-only"], { signal: opts.signal, timeoutMs: 60 * 60_000, onProgress: opts.onProgress });
    },

    async transcribe(filePath, opts): Promise<RawTranscript> {
      const lang = opts.language && opts.language !== "auto" ? opts.language : "auto";
      // Sin pista de audio no hay nada que transcribir (p. ej. un B-roll mudo).
      const probe = parseProbe(await ffprobeJson(deps.ffprobePath, filePath, opts.signal));
      if (!probe.hasAudio) {
        opts.onProgress?.(1, "El archivo no tiene audio");
        return { language: lang === "auto" ? "" : lang, words: [], segments: [] };
      }
      if (opts.diarization) deps.log.debug({}, "faster-whisper no separa hablantes; se transcribe sin diarización");
      const hotwords = (opts.hotwords ?? [])
        .map((h) => h.replace(/[,\n\r]+/g, " ").trim())
        .filter(Boolean)
        .join(",");
      const args = [...base, "--file", filePath, "--language", lang, "--device", deps.device || "auto", "--compute-type", deps.computeType || "int8"];
      if (hotwords) args.push("--hotwords", hotwords);
      // Tiempo límite generoso: CPU modesta con un modelo mediano ≈ 1–3× tiempo real (+ descarga).
      const d = probe.duration ?? 600;
      const timeoutMs = Math.round(20 * 60_000 + d * 6_000);
      const msg = await runWorker(deps, args, { signal: opts.signal, timeoutMs, onProgress: opts.onProgress });
      return buildTranscript(String(msg.language ?? (lang === "auto" ? "" : lang)), Array.isArray(msg.words) ? msg.words : []);
    },
  };
}
