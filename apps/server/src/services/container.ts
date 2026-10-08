/**
 * Arma los servicios (reales o demo) según la configuración y las llaves disponibles.
 *
 * Cada fábrica se envuelve: si una implementación todavía no existe o falla al construirse, se usa
 * un respaldo "no disponible" que lo dice claro (la app sigue funcionando en lo demás).
 */
import { createClaudeEditor, createDemoEditor, createGenerativeProvider } from "../ai/index.js";
import type { AppConfig } from "../config/index.js";
import type { Env } from "../env.js";
import { createMediaAnalyzer } from "../media/index.js";
import { createMotionEngines } from "../motion/index.js";
import { createRenderer } from "../render/index.js";
import { createLocalStorage } from "../storage/local.js";
import { createTranscriberWithFallback } from "../transcription/index.js";
import type { EditorBrain, GenerativeProvider, Log, MediaAnalyzer, Renderer, Services, Transcriber } from "./types.js";

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

function unavailable(what: string): () => Promise<never> {
  return async () => {
    throw new Error(`${what} no está disponible en este servidor`);
  };
}

function fallbackMedia(detail: string): MediaAnalyzer {
  return {
    available: async () => ({ ready: false, detail, version: "" }),
    probe: unavailable("El análisis de medios"),
    thumbnail: unavailable("El análisis de medios"),
    frameAt: unavailable("El análisis de medios"),
    analyze: unavailable("El análisis de medios"),
  };
}

function fallbackTranscriber(detail: string): Transcriber {
  return { provider: "ninguno", model: "", available: async () => ({ ready: false, detail }), transcribe: unavailable("La transcripción") };
}

function fallbackRenderer(detail: string): Renderer {
  return {
    available: async () => ({ ready: false, detail, version: "" }),
    render: unavailable("El render"),
    renderFrame: unavailable("El render"),
    poster: unavailable("El render"),
    captionFiles: () => ({ srt: "", vtt: "WEBVTT\n", txt: "" }),
  };
}

function fallbackEditor(detail: string): EditorBrain {
  const fail = unavailable(`El editor (${detail})`);
  return {
    kind: "demo",
    model: "demo",
    plan: fail,
    revisePlan: fail,
    correct: fail,
    review: fail,
    detectKeywords: fail,
    styleRules: fail,
    analyzeReference: fail,
  };
}

function fallbackGenerative(detail: string): GenerativeProvider {
  return {
    id: "ninguno",
    status: () => ({ configured: false, demo: true, detail }),
    models: () => [],
    credits: async () => null,
    generate: unavailable("La generación con IA"),
  };
}

/** Construye un servicio; si la fábrica lanza, registra el problema y usa el respaldo. */
function safely<T>(log: Log, name: string, build: () => T, fallback: (detail: string) => T): T {
  try {
    return build();
  } catch (err) {
    log.warn({ err: describe(err) }, `No se pudo iniciar ${name}; queda como no disponible`);
    return fallback(`No se pudo iniciar: ${describe(err)}`);
  }
}

export async function createServices(env: Env, config: AppConfig, log: Log, overrides: Partial<Services> = {}): Promise<Services> {
  const storage = overrides.storage ?? (await createLocalStorage(env));
  const aiDeps = { env, models: config.models, providers: config.providers, log };
  const demoEditor = overrides.demoEditor ?? safely(log, "el editor demo", () => createDemoEditor(aiDeps), fallbackEditor);
  const claude = overrides.editor ? null : safely<EditorBrain | null>(log, "el editor con Claude", () => (env.demoMode ? null : createClaudeEditor(aiDeps)), () => null);
  return {
    storage,
    media: overrides.media ?? safely(log, "el análisis de medios", () => createMediaAnalyzer({ env, storage, log }), fallbackMedia),
    transcriber: overrides.transcriber ?? safely(log, "la transcripción", () => createTranscriberWithFallback({ env, config: config.models.transcription, log, storage }), fallbackTranscriber),
    renderer: overrides.renderer ?? safely(log, "el render", () => createRenderer({ env, log }), fallbackRenderer),
    motion:
      overrides.motion ??
      safely(log, "los motores de motion graphics", () => createMotionEngines({ env, config: config.providers.motion, log }), () => ({ hyperframes: null, builtin: null, remotion: null })),
    generative: overrides.generative ?? safely(log, "la IA generativa", () => createGenerativeProvider(aiDeps), fallbackGenerative),
    editor: overrides.editor ?? claude ?? demoEditor,
    demoEditor,
    log: overrides.log ?? log,
  };
}
