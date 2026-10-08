/**
 * Transcripción por API compatible con OpenAI (`POST {apiBaseUrl}/audio/transcriptions`):
 * OpenAI, Groq, servidores locales tipo faster-whisper-server/speaches, etc.
 *
 * - Extrae el audio con ffmpeg a M4A (AAC) mono 16 kHz a 32 kbps (~14 MB por hora) para quedar
 *   bajo el límite de 25 MB; si el material es muy largo, lo parte en tramos y ajusta los tiempos.
 * - Pide `response_format=verbose_json` y `timestamp_granularities[]=word` (y `segment`).
 * - La llave (`TRANSCRIPTION_API_KEY`) solo vive en el backend y nunca aparece en errores ni logs.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UserFacingError, type Availability, type Log, type RawTranscript, type RawTranscriptWord, type StorageAdapter, type Transcriber } from "../services/types.js";
import { ffprobeJson, parseProbe } from "../media/probe.js";
import { decodeTimeout, runChecked, throwIfAborted } from "../media/process.js";
import { buildTranscript } from "./segments.js";

export interface OpenAiTranscriberDeps {
  ffmpegPath: string;
  ffprobePath: string;
  apiBaseUrl: string;
  apiModel: string;
  apiKey: string;
  log: Log;
  /** Carpeta temporal (por defecto la del sistema). */
  tempDir?: StorageAdapter["tempDir"];
  fetchImpl?: typeof fetch;
}

/** Límite de las API compatibles (25 MB) con margen. */
export const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
const AUDIO_KBPS = 32;
/** Tramo máximo por solicitud: 32 kbps × 80 min ≈ 19 MB. */
export const CHUNK_SEC = 80 * 60;

const LANGUAGE_NAMES: Record<string, string> = {
  spanish: "es", english: "en", portuguese: "pt", french: "fr", german: "de", italian: "it", catalan: "ca",
  dutch: "nl", japanese: "ja", chinese: "zh", korean: "ko", russian: "ru", arabic: "ar", hindi: "hi",
  polish: "pl", turkish: "tr", ukrainian: "uk", swedish: "sv", galician: "gl", basque: "eu",
};

/** Las API devuelven a veces el nombre del idioma ("spanish"); se normaliza a ISO. */
export function normalizeLanguage(lang: unknown): string {
  if (typeof lang !== "string" || !lang) return "";
  const l = lang.trim().toLowerCase();
  if (/^[a-z]{2,3}(-[a-z0-9]+)?$/.test(l)) return l.split("-")[0]!;
  return LANGUAGE_NAMES[l] ?? l;
}

interface VerboseJson {
  language?: string;
  duration?: number;
  text?: string;
  words?: { word?: string; text?: string; start?: number; end?: number; probability?: number }[];
  segments?: { start?: number; end?: number; text?: string; avg_logprob?: number }[];
}

/** Convierte la respuesta verbose_json en palabras (con `offset` en segundos). */
export function wordsFromVerbose(json: VerboseJson, offset = 0): RawTranscriptWord[] {
  const words: RawTranscriptWord[] = [];
  if (Array.isArray(json.words) && json.words.length) {
    for (const w of json.words) {
      const text = String(w.word ?? w.text ?? "").trim();
      if (!text || !Number.isFinite(w.start)) continue;
      words.push({ text, start: offset + Number(w.start), end: offset + Number(w.end ?? w.start), probability: Number.isFinite(w.probability) ? Number(w.probability) : 1 });
    }
    return words;
  }
  // Sin tiempos por palabra: se reparten las palabras de cada segmento a lo largo de su duración.
  for (const s of json.segments ?? []) {
    const parts = String(s.text ?? "").trim().split(/\s+/).filter(Boolean);
    const a = Number(s.start ?? 0);
    const b = Math.max(a, Number(s.end ?? a));
    const total = parts.reduce((acc, p) => acc + p.length, 0) || 1;
    let cur = a;
    const p = Number.isFinite(s.avg_logprob) ? Math.max(0, Math.min(1, Math.exp(Number(s.avg_logprob)))) : 0.5;
    for (const part of parts) {
      const len = ((b - a) * part.length) / total;
      words.push({ text: part, start: offset + cur, end: offset + cur + len, probability: p });
      cur += len;
    }
  }
  return words;
}

function apiError(status: number, body: string): UserFacingError {
  // Nunca se reenvía el cuerpo completo (podría traer datos de la cuenta); solo un extracto del mensaje.
  let msg = "";
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    msg = typeof j.error === "string" ? j.error : (j.error?.message ?? j.message ?? "");
  } catch {
    msg = body;
  }
  msg = msg.replace(/(sk|gsk|key)[-_][A-Za-z0-9_-]{8,}/g, "[llave]").slice(0, 200);
  if (status === 401 || status === 403) return new UserFacingError("transcripcion-llave-invalida", "La llave de transcripción no es válida o no tiene permiso (TRANSCRIPTION_API_KEY en .env).", 502);
  if (status === 404) return new UserFacingError("transcripcion-api-no-encontrada", "La API de transcripción no respondió en esa dirección. Revisa apiBaseUrl en config/models.json.", 502);
  if (status === 413) return new UserFacingError("transcripcion-archivo-grande", "El audio es demasiado grande para la API de transcripción.", 413);
  if (status === 429) return new UserFacingError("transcripcion-limite", "La API de transcripción rechazó la solicitud por límite de uso. Intenta más tarde.", 429);
  return new UserFacingError("transcripcion-api-fallo", `La API de transcripción respondió con un error (${status})${msg ? `: ${msg}` : ""}.`, 502);
}

export function createOpenAiTranscriber(deps: OpenAiTranscriberDeps): Transcriber {
  const baseUrl = deps.apiBaseUrl.replace(/\/+$/, "");
  const doFetch = deps.fetchImpl ?? fetch;

  async function extract(filePath: string, outPath: string, start: number, dur: number | null, signal?: AbortSignal): Promise<void> {
    const args = ["-hide_banner", "-nostdin", "-y", "-v", "error"];
    if (start > 0) args.push("-ss", start.toFixed(3));
    args.push("-i", filePath);
    if (dur !== null) args.push("-t", dur.toFixed(3));
    args.push("-vn", "-sn", "-dn", "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", `${AUDIO_KBPS}k`, "-movflags", "+faststart", outPath);
    await runChecked(deps.ffmpegPath, args, { label: "ffmpeg (audio para transcribir)", signal, timeoutMs: decodeTimeout(dur, 0.5), errorMessage: "No se pudo extraer el audio" });
  }

  async function send(audioPath: string, language: string, prompt: string, signal?: AbortSignal): Promise<VerboseJson> {
    const size = (await stat(audioPath)).size;
    if (size > MAX_UPLOAD_BYTES) throw new UserFacingError("transcripcion-archivo-grande", "El audio extraído supera 25 MB; no se puede enviar a la API.", 413);
    const form = new FormData();
    form.append("file", new Blob([await readFile(audioPath)], { type: "audio/mp4" }), path.basename(audioPath));
    form.append("model", deps.apiModel);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");
    if (language) form.append("language", language);
    if (prompt) form.append("prompt", prompt);
    const timeout = AbortSignal.timeout(15 * 60_000);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${deps.apiKey}` }, body: form, signal: sig });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (timeout.aborted) throw new UserFacingError("transcripcion-tiempo-agotado", "La API de transcripción tardó demasiado en responder.", 504);
      throw new UserFacingError("transcripcion-sin-conexion", `No se pudo conectar con la API de transcripción (${new URL(baseUrl).host}).`, 502);
    }
    const text = await res.text();
    if (!res.ok) throw apiError(res.status, text);
    try {
      return JSON.parse(text) as VerboseJson;
    } catch {
      throw new UserFacingError("transcripcion-api-fallo", "La API de transcripción devolvió una respuesta que no se pudo interpretar.", 502);
    }
  }

  async function available(): Promise<Availability> {
    if (!baseUrl) return { ready: false, detail: "Falta apiBaseUrl de transcripción en config/models.json." };
    try {
      new URL(baseUrl);
    } catch {
      return { ready: false, detail: "apiBaseUrl de transcripción no es una URL válida (config/models.json)." };
    }
    if (!deps.apiKey) return { ready: false, detail: "Falta TRANSCRIPTION_API_KEY en .env." };
    return { ready: true, detail: `API compatible (${new URL(baseUrl).host}) · modelo ${deps.apiModel}` };
  }

  async function workDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
    if (deps.tempDir) return deps.tempDir("transcripcion");
    const dir = await mkdtemp(path.join(os.tmpdir(), "autoeditor-trn-"));
    return { path: dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  return {
    provider: "openai-compatible",
    model: deps.apiModel,
    available,

    async transcribe(filePath, opts): Promise<RawTranscript> {
      const ready = await available();
      if (!ready.ready) throw new UserFacingError("transcripcion-no-configurada", ready.detail, 503);
      const probe = parseProbe(await ffprobeJson(deps.ffprobePath, filePath, opts.signal));
      const lang = opts.language && opts.language !== "auto" ? opts.language : "";
      if (!probe.hasAudio) return { language: lang, words: [], segments: [] };
      const duration = probe.duration ?? 0;
      const chunks: [number, number | null][] = [];
      if (duration > CHUNK_SEC) for (let s = 0; s < duration; s += CHUNK_SEC) chunks.push([s, Math.min(CHUNK_SEC, duration - s)]);
      else chunks.push([0, null]);
      const prompt = (opts.hotwords ?? []).filter(Boolean).slice(0, 60).join(", ").slice(0, 600);
      const tmp = await workDir();
      const dir = tmp.path;
      const words: RawTranscriptWord[] = [];
      let language = lang;
      try {
        for (let i = 0; i < chunks.length; i++) {
          throwIfAborted(opts.signal);
          const [start, dur] = chunks[i]!;
          const base = i / chunks.length;
          opts.onProgress?.(base + 0.05 / chunks.length, chunks.length > 1 ? `Preparando el audio (tramo ${i + 1} de ${chunks.length})` : "Preparando el audio");
          const out = path.join(dir, `audio-${process.pid}-${Date.now()}-${i}.m4a`);
          await extract(filePath, out, start, dur, opts.signal);
          opts.onProgress?.(base + 0.15 / chunks.length, "Enviando a la API de transcripción");
          const json = await send(out, lang, prompt, opts.signal);
          if (!language) language = normalizeLanguage(json.language);
          words.push(...wordsFromVerbose(json, start));
          opts.onProgress?.((i + 1) / chunks.length, "Transcripción recibida");
        }
      } finally {
        await tmp.cleanup().catch(() => undefined);
      }
      deps.log.debug({ words: words.length, chunks: chunks.length }, "Transcripción por API lista");
      return buildTranscript(language, words);
    },
  };
}
