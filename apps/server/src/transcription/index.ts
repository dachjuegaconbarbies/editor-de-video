/**
 * Módulo de transcripción: faster-whisper (local), API compatible con OpenAI o demo.
 *
 * - `createTranscriber(deps)`: el proveedor que diga `config/models.json` (transcription.provider).
 * - `createTranscriberWithFallback(deps)`: igual, pero si el proveedor real no está listo (sin venv,
 *   sin modelo y sin red, sin llave…) usa el demo e informa el motivo en `available()` y en
 *   `fallbackReason`. Vuelve a comprobar cada cierto tiempo, así que instalar el modelo con la app
 *   abierta basta para que se use.
 *
 * Todos devuelven palabras con tiempos y segmentos agrupados por pausas/puntuación (segments.ts).
 * El texto se devuelve tal cual: las muletillas (`filler`) se marcan al guardar con `isFiller`.
 */
import type { ModelsConfig } from "@autoeditor/shared";
import type { Env } from "../env.js";
import { UserFacingError, type Availability, type Log, type RawTranscript, type RunOptions, type StorageAdapter, type Transcriber } from "../services/types.js";
import { createDemoTranscriber } from "./demo.js";
import { createOpenAiTranscriber } from "./openai.js";
import { createWhisperTranscriber, NOT_INSTALLED_CODES } from "./whisper.js";

export { buildTranscript, groupSegments, normalizeWords } from "./segments.js";
export { createDemoTranscriber, DEMO_EMPTY_DETAIL, embeddedTranscript } from "./demo.js";
export { createWhisperTranscriber, DEFAULT_MODELS_DIR, TRANSCRIBE_SCRIPT } from "./whisper.js";
export { createOpenAiTranscriber } from "./openai.js";

export interface TranscriptionDeps {
  env: Env;
  config: ModelsConfig["transcription"];
  log: Log;
  /** Opcional: carpeta temporal del almacenamiento (para el audio extraído). */
  storage?: Pick<StorageAdapter, "tempDir">;
  /** Opcional: carpeta de modelos de whisper (por defecto models/whisper). */
  modelsDir?: string;
}

export function createTranscriber(deps: TranscriptionDeps): Transcriber {
  const { env, config, log } = deps;
  switch (config.provider) {
    case "faster-whisper":
      return createWhisperTranscriber({
        pythonPath: env.pythonPath,
        ffprobePath: env.ffprobePath,
        model: config.model,
        device: config.device,
        computeType: config.computeType,
        log,
        modelsDir: deps.modelsDir,
      });
    case "openai-compatible":
      return createOpenAiTranscriber({
        ffmpegPath: env.ffmpegPath,
        ffprobePath: env.ffprobePath,
        apiBaseUrl: config.apiBaseUrl,
        apiModel: config.apiModel,
        apiKey: env.transcriptionApiKey,
        log,
        tempDir: deps.storage?.tempDir.bind(deps.storage),
      });
    case "demo":
    default:
      return createDemoTranscriber({ ffprobePath: env.ffprobePath, log });
  }
}

export interface FallbackTranscriber extends Transcriber {
  /** Motivo por el que se está usando el demo (null si se usa el proveedor configurado o aún no se comprobó). */
  readonly fallbackReason: string | null;
  /** Proveedor configurado (aunque esté usando el demo). */
  readonly configuredProvider: string;
}

/** Cuánto vale una comprobación de disponibilidad. */
const READY_TTL_MS = 5 * 60_000;
const NOT_READY_TTL_MS = 30_000;

/**
 * Transcriptor que usa el proveedor configurado si está listo y, si no, el demo (indicando el
 * motivo). Si una transcripción real falla porque falta el entorno o el modelo, también cae al demo.
 */
export function createTranscriberWithFallback(deps: TranscriptionDeps): FallbackTranscriber {
  const primary = createTranscriber(deps);
  const configuredProvider = primary.provider;
  if (primary.provider === "demo") return Object.assign(primary, { fallbackReason: null, configuredProvider });

  let reason: string | null = null;
  let active: Transcriber = primary;
  let checkedAt = 0;
  let checking: Promise<void> | null = null;
  let lastReady: Availability | null = null;
  let demo = createDemoTranscriber({ ffprobePath: deps.env.ffprobePath, log: deps.log });

  const useDemo = (why: string) => {
    if (reason !== why) deps.log.warn({ provider: configuredProvider, reason: why }, "Transcripción real no disponible; se usa el modo demo");
    reason = why;
    demo = createDemoTranscriber({ ffprobePath: deps.env.ffprobePath, log: deps.log, reason: why });
    active = demo;
    checkedAt = Date.now();
  };

  async function refresh(force = false): Promise<void> {
    const ttl = reason ? NOT_READY_TTL_MS : READY_TTL_MS;
    if (!force && checkedAt && Date.now() - checkedAt < ttl) return;
    if (!checking) {
      checking = (async () => {
        try {
          const a = await primary.available();
          if (a.ready) {
            lastReady = a;
            if (reason) deps.log.info({ provider: configuredProvider }, "La transcripción real ya está disponible");
            reason = null;
            active = primary;
            checkedAt = Date.now();
          } else useDemo(a.detail);
        } catch (err) {
          useDemo(err instanceof Error ? err.message : String(err));
        } finally {
          checking = null;
        }
      })();
    }
    await checking;
  }

  return {
    get provider() {
      return active.provider;
    },
    get model() {
      return active.model;
    },
    get fallbackReason() {
      return reason;
    },
    configuredProvider,

    async available(): Promise<Availability> {
      await refresh();
      if (!reason) return lastReady ?? primary.available();
      return { ready: false, detail: `${reason} Mientras tanto se usa el modo demo.` };
    },

    async transcribe(filePath: string, opts: RunOptions & { language?: string; hotwords?: string[]; diarization?: boolean }): Promise<RawTranscript> {
      await refresh();
      if (active === primary) {
        try {
          return await primary.transcribe(filePath, opts);
        } catch (err) {
          if (opts.signal?.aborted) throw err;
          // Falta el entorno o el modelo (p. ej. se perdió la conexión al descargarlo): demo.
          if (err instanceof UserFacingError && NOT_INSTALLED_CODES.has(err.code)) {
            useDemo(err.userMessage);
            return demo.transcribe(filePath, opts);
          }
          throw err;
        }
      }
      return demo.transcribe(filePath, opts);
    },
  };
}
