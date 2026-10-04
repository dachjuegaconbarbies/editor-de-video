/**
 * Proveedor de IA generativa con Kie AI (implementa `GenerativeProvider`).
 *
 * Flujo real: elegir modelo (config/providers.json) → traducir parámetros genéricos a los campos del
 * modelo (fieldMap/defaults) → crear la tarea → consultar el estado con intervalos y tiempo límite de la
 * configuración → descargar el resultado a `outDir` → costo real (creditsConsumed) o estimado.
 * Modo demo (sin KIE_API_KEY o con el modo demo activo): marcadores locales con ffmpeg (sin red ni créditos).
 */
import { rename } from "node:fs/promises";
import path from "node:path";
import type { AiRequest, KieModelConfig } from "@autoeditor/shared";
import type { AiDeps } from "../deps.js";
import type { GenerationResult, GenerativeProvider, RunOptions } from "../../services/types.js";
import { UserFacingError } from "../../services/types.js";
import { KieClient, type NormalizedTask } from "./client.js";
import { demoGenerate } from "./demo.js";
import { toKieUserError } from "./errors.js";
import { buildKieRequest, estimateKieCostUsd, resolveKieModel } from "./params.js";

export interface KieProviderOptions {
  /** fetch inyectable (pruebas sin red). */
  fetchImpl?: typeof fetch;
  /** Base del backoff de reintentos (ms). */
  retryBaseMs?: number;
  /** Tiempo límite por petición HTTP (ms). */
  requestTimeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Fuerza el modo real o demo (por defecto: demo si no hay llave o está el modo demo). */
  demo?: boolean;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
};
const MIME_BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m]));
const DEFAULT_EXT: Record<AiRequest["kind"], string> = { imagen: ".png", video: ".mp4", musica: ".mp3", voz: ".mp3", sfx: ".mp3" };

/** Extensión y tipo del archivo resultante (por la URL o el Content-Type). */
function fileTypeFor(url: string, kind: AiRequest["kind"], contentType?: string | null): { ext: string; mime: string } {
  const fromUrl = path.extname(new URL(url, "https://x.invalid").pathname).toLowerCase();
  const ct = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct && EXT_BY_MIME[ct]) return { ext: EXT_BY_MIME[ct]!, mime: ct };
  if (fromUrl && MIME_BY_EXT[fromUrl]) return { ext: fromUrl, mime: MIME_BY_EXT[fromUrl]! };
  const ext = DEFAULT_EXT[kind];
  return { ext, mime: MIME_BY_EXT[ext] ?? "application/octet-stream" };
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60);

export function createKieProvider(deps: AiDeps, opts: KieProviderOptions = {}): GenerativeProvider & { readonly client: KieClient | null } {
  const kie = deps.providers.kie;
  const configured = deps.env.kieApiKey.trim() !== "";
  const demo = opts.demo ?? (!configured || deps.env.demoMode);
  const client = configured
    ? new KieClient({ apiKey: deps.env.kieApiKey, baseUrl: kie.baseUrl, fetchImpl: opts.fetchImpl, maxRetries: kie.maxRetries, retryBaseMs: opts.retryBaseMs, timeoutMs: opts.requestTimeoutMs, sleep: opts.sleep })
    : null;

  function model(request: AiRequest): KieModelConfig {
    const m = resolveKieModel(kie, request.kind, request.model || null);
    if (!m) throw new UserFacingError("kie-modelo-no-disponible", `No hay ningún modelo de Kie AI configurado para ${request.kind} (revisa config/providers.json).`, 424);
    if (!m.enabled) throw new UserFacingError("kie-modelo-no-disponible", `El modelo «${m.label}» está apagado en config/providers.json. Elige otro.`, 424);
    return m;
  }

  async function generateReal(request: AiRequest, m: KieModelConfig, ro: RunOptions & { outDir: string; aspect: string }): Promise<GenerationResult> {
    if (!client) throw new UserFacingError("kie-llave-invalida", "Falta KIE_API_KEY en el archivo .env del servidor.", 401);
    const built = buildKieRequest(m, request, ro.aspect);
    ro.onProgress?.(0.02, `Creando la tarea en Kie AI (${m.label})`);
    let taskId: string;
    try {
      taskId = await client.createTask(built.path, built.body, ro.signal);
    } catch (err) {
      throw toKieUserError(err, { model: m.id, kind: request.kind });
    }
    deps.log.info({ taskId, model: m.id, kind: request.kind }, "Tarea creada en Kie AI");
    ro.onProgress?.(0.1, "Generando con Kie AI");
    const started = (opts.now ?? Date.now)();
    let task: NormalizedTask;
    try {
      task = await client.waitFor(m.statusPath, taskId, {
        intervalMs: kie.pollIntervalMs,
        timeoutMs: kie.timeoutMs,
        signal: ro.signal,
        now: opts.now,
        onUpdate: (t) => {
          // Progreso estimado con los segundos típicos del modelo (o el que informe Kie).
          const elapsed = ((opts.now ?? Date.now)() - started) / 1000;
          const p = typeof t.progress === "number" ? t.progress / 100 : Math.min(0.9, elapsed / Math.max(10, m.typicalSeconds));
          ro.onProgress?.(0.1 + 0.8 * Math.min(1, p), t.state === "success" ? "Descargando el resultado" : "Generando con Kie AI");
        },
      });
    } catch (err) {
      throw toKieUserError(err, { model: m.id, kind: request.kind });
    }
    const url = task.resultUrls[0];
    if (!url) throw new UserFacingError("kie-generacion-fallida", `Kie AI terminó la tarea ${taskId} pero no entregó ningún archivo.`, 502, { taskId });
    const guess = fileTypeFor(url, request.kind);
    const tmpPath = path.join(ro.outDir, `${sanitize(request.id)}-${sanitize(m.id)}${guess.ext}`);
    let downloaded: { contentType: string | null };
    try {
      downloaded = await client.download(url, tmpPath, ro.signal);
    } catch (err) {
      throw toKieUserError(err, { model: m.id, kind: request.kind });
    }
    const type = fileTypeFor(url, request.kind, downloaded.contentType);
    let filePath = tmpPath;
    if (type.ext !== guess.ext) {
      filePath = tmpPath.slice(0, -guess.ext.length) + type.ext;
      await rename(tmpPath, filePath);
    }
    ro.onProgress?.(1, "Listo");
    const costUsd = task.creditsConsumed != null ? Math.round(task.creditsConsumed * kie.usdPerCredit * 10000) / 10000 : estimateKieCostUsd(m, request, kie.usdPerCredit);
    return { filePath, mimeType: type.mime, costUsd, model: m.id, taskId, seed: request.seed };
  }

  return {
    id: "kie",
    client,
    status: () => ({
      configured,
      demo,
      detail: demo
        ? configured
          ? "Modo demo activo: se generan marcadores locales sin gastar créditos de Kie AI."
          : "Sin KIE_API_KEY: se generan marcadores locales (modo demo)."
        : `Kie AI listo (${kie.models.filter((m) => m.enabled).length} modelos configurados).`,
    }),
    models: () => kie.models,
    async credits() {
      if (demo || !client) return null;
      try {
        return await client.getCredits();
      } catch (err) {
        deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, "No se pudo consultar el saldo de Kie AI");
        return null;
      }
    },
    async generate(request, ro) {
      const m = model(request);
      if (demo) {
        ro.onProgress?.(0.1, "Generando marcador (modo demo, sin gastar créditos)");
        try {
          const res = await demoGenerate(request, m.id, { ffmpegPath: deps.env.ffmpegPath, outDir: ro.outDir, aspect: ro.aspect, signal: ro.signal });
          ro.onProgress?.(1, "Listo (demo)");
          return res;
        } catch (err) {
          throw new UserFacingError("kie-demo-fallido", `No se pudo generar el marcador de IA en modo demo: ${err instanceof Error ? err.message : String(err)}`, 500);
        }
      }
      return generateReal(request, m, ro);
    },
  };
}
