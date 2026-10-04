/**
 * Cliente HTTP mínimo para Kie AI (sin dependencias: fetch nativo de Node 22, inyectable en pruebas).
 * Base: docs/research/kie-ai.md §2, §3, §5 y §9.
 *
 *  - Auth: `Authorization: Bearer <KIE_API_KEY>` (la llave solo vive en el backend).
 *  - Envoltorio `{ code, msg, data }`: Kie puede responder HTTP 200 con `code` ≠ 200 → error en las dos capas.
 *  - Reintentos con backoff exponencial en 429/455/5xx con envoltorio y en fallas de red de lecturas (GET).
 *    Una falla AMBIGUA al CREAR (red, timeout, 502/504, cuerpo no JSON) NO se reintenta: la tarea pudo
 *    crearse y cobrarse; se reporta como "creación incierta" (nunca se reenvía en automático).
 *  - Tres familias de estado: Market (`state` + `resultJson`), Veo (`successFlag` + `response.resultUrls`),
 *    Suno (`status` + `response.sunoData[].audio_url`). Runway (`state` + `videoInfo.videoUrl`) también.
 *  - Descarga del resultado SIN header de auth (las URLs son de una CDN y expiran en ~24 h).
 */
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

export type TaskState = "waiting" | "queuing" | "generating" | "success" | "fail";
export type KieFamily = "market" | "veo" | "suno" | "runway";

export interface KieEnvelope<T> {
  code?: number;
  msg?: string;
  data?: T | null;
}

export interface NormalizedTask {
  taskId: string;
  family: KieFamily;
  state: TaskState;
  resultUrls: string[];
  failCode?: string;
  failMsg?: string;
  creditsConsumed?: number;
  progress?: number;
  raw: unknown;
}

/**
 * Error de la API de Kie. `retryable`: 429/455/5xx (salvo 500 de validación).
 * `ambiguous`: no sabemos si Kie procesó la petición (red caída, timeout, 502/504, cuerpo no JSON).
 */
export class KieApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly httpStatus: number,
    readonly retryable: boolean,
    readonly body: unknown,
    readonly ambiguous = false,
    /** Etapa donde ocurrió: crear, consultar, descargar o saldo. */
    readonly stage: "crear" | "consultar" | "descargar" | "saldo" | "esperar" = "consultar",
  ) {
    super(message);
    this.name = "KieApiError";
  }
}

const RETRYABLE = new Set([408, 425, 429, 433, 455, 500, 502, 503, 504]);
const FATAL = new Set([400, 401, 402, 404, 405, 413, 422, 501, 505]);

/** ¿Se puede reintentar este código? Kie reutiliza 500 para errores de validación: el mensaje los distingue. */
export function isRetryable(code: number, msg = ""): boolean {
  const m = msg.toLowerCase();
  if (code === 500 && /required|not within the range|allowed options|invalid|not supported/.test(m)) return false;
  if (FATAL.has(code)) return false;
  return RETRYABLE.has(code) || /try again later|server is busy/.test(m);
}

export interface KieClientOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Tiempo límite por petición (ms). */
  timeoutMs?: number;
  maxRetries?: number;
  /** Base del backoff exponencial (ms): base·2^intento + azar. */
  retryBaseMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Cancelado"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("Cancelado"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Combina la señal del llamador con un tiempo límite por petición. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function urlsFrom(obj: unknown): string[] {
  if (!obj || typeof obj !== "object") return typeof obj === "string" && /^https?:/.test(obj) ? [obj] : [];
  const r = obj as Record<string, unknown>;
  const list = parseMaybeJson(r.resultUrls ?? r.result_urls ?? r.urls);
  const out = Array.isArray(list) ? list.filter((u): u is string => typeof u === "string") : [];
  for (const k of ["resultImageUrl", "resultUrl", "url", "videoUrl", "audioUrl", "audio_url"]) if (typeof r[k] === "string") out.push(r[k] as string);
  return [...new Set(out)];
}

const MARKET_STATES = new Set<TaskState>(["waiting", "queuing", "generating", "success", "fail"]);

/** Familia de la API según la ruta de estado configurada. */
export function familyFor(statusPath: string): KieFamily {
  if (/\/veo\//.test(statusPath)) return "veo";
  if (/\/generate\/record-info/.test(statusPath)) return "suno";
  if (/\/runway\//.test(statusPath)) return "runway";
  return "market";
}

export function normalizeMarket(taskId: string, d: Record<string, unknown>): NormalizedTask {
  const s = String(d.state ?? "waiting").toLowerCase() as TaskState;
  return {
    taskId,
    family: "market",
    state: MARKET_STATES.has(s) ? s : "waiting",
    resultUrls: urlsFrom(parseMaybeJson(d.resultJson)),
    failCode: d.failCode != null && d.failCode !== "" ? String(d.failCode) : undefined,
    failMsg: d.failMsg ? String(d.failMsg) : undefined,
    creditsConsumed: typeof d.creditsConsumed === "number" ? d.creditsConsumed : undefined,
    progress: typeof d.progress === "number" ? d.progress : undefined,
    raw: d,
  };
}

/** Veo: successFlag 0 generando · 1 éxito · 2 CREATE_TASK_FAILED · 3 GENERATE_FAILED. */
export function normalizeVeo(taskId: string, d: Record<string, unknown>): NormalizedTask {
  const flag = Number(d.successFlag ?? 0);
  const resp = parseMaybeJson(d.response) as Record<string, unknown> | null;
  return {
    taskId,
    family: "veo",
    state: flag === 1 ? "success" : flag === 0 ? "generating" : "fail",
    resultUrls: urlsFrom(resp),
    failCode: d.errorCode != null ? String(d.errorCode) : undefined,
    failMsg: d.errorMessage ? String(d.errorMessage) : undefined,
    raw: d,
  };
}

/** Suno: PENDING → TEXT_SUCCESS → FIRST_SUCCESS → SUCCESS; *_FAILED / SENSITIVE_WORD_ERROR son terminales. */
export function normalizeSuno(taskId: string, d: Record<string, unknown>): NormalizedTask {
  const status = String(d.status ?? "PENDING").toUpperCase();
  const resp = (parseMaybeJson(d.response) ?? {}) as { sunoData?: Array<Record<string, unknown>> };
  const tracks = Array.isArray(resp.sunoData) ? resp.sunoData : [];
  const urls = tracks.map((t) => (t.audio_url ?? t.audioUrl) as string | undefined).filter((u): u is string => typeof u === "string" && u.length > 0);
  const failed = status.includes("FAIL") || status === "SENSITIVE_WORD_ERROR" || status === "CALLBACK_EXCEPTION";
  return {
    taskId,
    family: "suno",
    // CALLBACK_EXCEPTION con audio = la generación sí terminó (la URL de callback era un marcador).
    state: status === "SUCCESS" || (status === "CALLBACK_EXCEPTION" && urls.length > 0) ? "success" : failed ? "fail" : "generating",
    resultUrls: urls,
    failCode: failed ? status : undefined,
    failMsg: d.errorMessage ? String(d.errorMessage) : failed ? status : undefined,
    raw: d,
  };
}

export function normalizeRunway(taskId: string, d: Record<string, unknown>): NormalizedTask {
  const s = String(d.state ?? "waiting").toLowerCase();
  const info = (d.videoInfo ?? {}) as Record<string, unknown>;
  return {
    taskId,
    family: "runway",
    state: s === "success" ? "success" : s === "fail" || s === "failed" ? "fail" : "generating",
    resultUrls: urlsFrom(info),
    failCode: d.failCode != null ? String(d.failCode) : undefined,
    failMsg: d.failMsg ? String(d.failMsg) : undefined,
    raw: d,
  };
}

export function normalizeTask(family: KieFamily, taskId: string, d: Record<string, unknown>): NormalizedTask {
  switch (family) {
    case "veo":
      return normalizeVeo(taskId, d);
    case "suno":
      return normalizeSuno(taskId, d);
    case "runway":
      return normalizeRunway(taskId, d);
    default:
      return normalizeMarket(taskId, d);
  }
}

export class KieClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Peticiones hechas (para pruebas y diagnóstico; nunca incluye la llave). */
  readonly calls: { method: string; url: string }[] = [];

  constructor(private readonly opts: KieClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 2_000;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Una petición JSON con reintentos (ver reglas en la cabecera). */
  async request<T>(method: "GET" | "POST", pathname: string, body: unknown, o: { stage: KieApiError["stage"]; signal?: AbortSignal; retryAmbiguous?: boolean }): Promise<KieEnvelope<T>> {
    const retryAmbiguous = o.retryAmbiguous ?? method === "GET";
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(method, pathname, body, o.stage, o.signal);
      } catch (err) {
        if (o.signal?.aborted) throw err;
        const kie = err instanceof KieApiError ? err : null;
        const ambiguous = !kie || kie.ambiguous;
        const retryable = ambiguous ? retryAmbiguous : kie.retryable;
        if (!retryable || attempt >= this.maxRetries) {
          if (kie) throw kie;
          throw new KieApiError(`Falla de red con Kie AI: ${err instanceof Error ? err.message : String(err)}`, 0, 0, retryAmbiguous, null, true, o.stage);
        }
        const retryAfter = kie?.code === 429 ? 1.5 : 1;
        await this.sleep(Math.round((this.retryBaseMs * 2 ** attempt + Math.random() * Math.min(250, this.retryBaseMs)) * retryAfter), o.signal);
      }
    }
  }

  private async once<T>(method: "GET" | "POST", pathname: string, body: unknown, stage: KieApiError["stage"], signal?: AbortSignal): Promise<KieEnvelope<T>> {
    const url = `${this.baseUrl}${pathname}`;
    this.calls.push({ method, url });
    const res = await this.fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: withTimeout(signal, this.timeoutMs),
    });
    const text = await res.text();
    let json: KieEnvelope<T>;
    try {
      json = JSON.parse(text) as KieEnvelope<T>;
    } catch {
      // Estados intermedios de recordInfo y 502 de gateway (HTML).
      throw new KieApiError(`Respuesta no JSON de Kie (HTTP ${res.status})`, res.status, res.status, true, text.slice(0, 300), true, stage);
    }
    const code = res.status !== 200 ? res.status : typeof json.code === "number" ? json.code : 200;
    if (code !== 200) {
      const msg = json.msg ?? "";
      throw new KieApiError(`Kie ${code}: ${msg}`, code, res.status, isRetryable(code, msg), json, res.status === 502 || res.status === 504, stage);
    }
    return json;
  }

  /** Crea la tarea y devuelve el taskId. Persistirlo ANTES de consultar (nunca reenviar para reintentar). */
  async createTask(pathname: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const env = await this.request<{ taskId?: string; task_id?: string }>("POST", pathname, body, { stage: "crear", signal, retryAmbiguous: false });
    const taskId = env.data?.taskId ?? env.data?.task_id;
    if (!taskId) throw new KieApiError("Kie no devolvió un id de tarea", 500, 200, false, env, false, "crear");
    return taskId;
  }

  async getTask(statusPath: string, taskId: string, signal?: AbortSignal): Promise<NormalizedTask> {
    const sep = statusPath.includes("?") ? "&" : "?";
    const env = await this.request<Record<string, unknown>>("GET", `${statusPath}${sep}taskId=${encodeURIComponent(taskId)}`, undefined, { stage: "consultar", signal });
    return normalizeTask(familyFor(statusPath), taskId, env.data ?? {});
  }

  /** GET /api/v1/chat/credit → créditos restantes. */
  async getCredits(signal?: AbortSignal): Promise<number> {
    const env = await this.request<number | { credits?: number }>("GET", "/api/v1/chat/credit", undefined, { stage: "saldo", signal });
    const d = env.data;
    const n = typeof d === "number" ? d : Number((d as { credits?: number } | null)?.credits ?? NaN);
    if (!Number.isFinite(n)) throw new KieApiError("Respuesta de saldo inesperada", 500, 200, false, env, false, "saldo");
    return n;
  }

  /**
   * Consulta el estado con intervalo creciente hasta éxito, falla o tiempo agotado. Un error reintentable
   * al consultar NO aborta: la tarea sigue viva (y cobrada) en Kie.
   */
  async waitFor(
    statusPath: string,
    taskId: string,
    o: { intervalMs: number; maxIntervalMs?: number; timeoutMs: number; signal?: AbortSignal; onUpdate?: (t: NormalizedTask) => void; now?: () => number },
  ): Promise<NormalizedTask> {
    const now = o.now ?? Date.now;
    let interval = Math.max(1, o.intervalMs);
    const maxInterval = o.maxIntervalMs ?? Math.max(interval, 30_000);
    const deadline = now() + o.timeoutMs;
    for (;;) {
      try {
        const t = await this.getTask(statusPath, taskId, o.signal);
        o.onUpdate?.(t);
        if (t.state === "success") return t;
        if (t.state === "fail") throw new KieApiError(`La tarea ${taskId} falló: ${t.failMsg ?? t.failCode ?? "sin detalle"}`, 501, 200, false, t.raw, false, "esperar");
      } catch (err) {
        if (o.signal?.aborted) throw err;
        if (err instanceof KieApiError && !err.retryable) throw err;
      }
      if (now() + interval > deadline) {
        throw new KieApiError(`Se agotó el tiempo esperando la tarea ${taskId} (puede terminar después; no se reenvía)`, 408, 0, false, null, false, "esperar");
      }
      await this.sleep(interval, o.signal);
      interval = Math.min(Math.round(interval * 1.5), maxInterval);
    }
  }

  /**
   * Descarga un resultado a `outPath` SIN la llave (CDN pública). Reintenta en 5xx y fallas de red:
   * el resultado ya está pagado. Devuelve el Content-Type informado.
   */
  async download(url: string, outPath: string, signal?: AbortSignal): Promise<{ contentType: string | null; bytes: number }> {
    await mkdir(path.dirname(outPath), { recursive: true });
    for (let attempt = 0; ; attempt++) {
      try {
        this.calls.push({ method: "GET", url });
        const res = await this.fetchImpl(url, { method: "GET", signal: withTimeout(signal, Math.max(this.timeoutMs, 300_000)) });
        if (!res.ok || !res.body) {
          throw new KieApiError(`No se pudo descargar el resultado (HTTP ${res.status})`, res.status, res.status, res.status >= 500 || res.status === 429, null, false, "descargar");
        }
        let bytes = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            bytes += chunk.length;
            cb(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>), counter, createWriteStream(outPath));
        if (bytes === 0) throw new KieApiError("El resultado descargado está vacío", 500, res.status, true, null, false, "descargar");
        return { contentType: res.headers.get("content-type"), bytes };
      } catch (err) {
        await rm(outPath, { force: true }).catch(() => undefined);
        if (signal?.aborted) throw err;
        const retryable = err instanceof KieApiError ? err.retryable : true;
        if (!retryable || attempt >= this.maxRetries) {
          if (err instanceof KieApiError) throw err;
          throw new KieApiError(`Falla de red al descargar el resultado: ${err instanceof Error ? err.message : String(err)}`, 0, 0, false, null, true, "descargar");
        }
        await this.sleep(this.retryBaseMs * 2 ** attempt, signal);
      }
    }
  }
}
