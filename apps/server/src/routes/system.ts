/**
 * Rutas de sistema: salud y configuración pública.
 * `GET /config` JAMÁS incluye llaves ni rutas absolutas: solo booleanos de capacidad, modelos y precios.
 */
import { readFileSync } from "node:fs";
import type { PublicConfig } from "@autoeditor/shared";
import type { AppContext } from "../context.js";
import type { Availability } from "../services/types.js";
import { pricingFrom } from "../pipeline/estimate.js";
import type { RouteModule } from "./http.js";

export const SERVER_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const TIMEOUT_MS = 8000;
const CACHE_MS = 30_000;

/** Ejecuta una comprobación de disponibilidad con tiempo límite y sin lanzar. */
async function check<T extends Availability>(fn: (() => Promise<T>) | undefined, fallback: T): Promise<T> {
  if (!fn) return fallback;
  try {
    return await Promise.race([fn(), new Promise<T>((resolve) => setTimeout(() => resolve({ ...fallback, detail: "No respondió a tiempo" }), TIMEOUT_MS).unref())]);
  } catch (err) {
    return { ...fallback, detail: err instanceof Error ? err.message : String(err) };
  }
}

type Capabilities = PublicConfig["capabilities"];

/** Capacidades (con caché corta: algunas comprobaciones lanzan procesos como ffmpeg -version). */
export function createCapabilitiesProbe(ctx: AppContext): () => Promise<Capabilities> {
  let cached: { at: number; value: Promise<Capabilities> } | null = null;
  const compute = async (): Promise<Capabilities> => {
    const { services, scrub, config } = ctx;
    const [transcription, ffmpeg, hyperframes, remotion] = await Promise.all([
      check(() => services.transcriber.available(), { ready: false, detail: "No disponible" }),
      check(() => services.media.available(), { ready: false, detail: "No disponible", version: "" }),
      check(services.motion.hyperframes ? () => services.motion.hyperframes!.available() : undefined, { ready: false, detail: "Motor HyperFrames no instalado" }),
      check(services.motion.remotion ? () => services.motion.remotion!.available() : undefined, {
        ready: false,
        detail: config.providers.motion.remotion.licenseNote || "Apagado por defecto (requiere licencia)",
      }),
    ]);
    const gen = services.generative.status();
    return {
      claude: services.editor.kind === "claude" && !ctx.env.demoMode,
      kie: gen.configured && !gen.demo,
      transcription: { provider: services.transcriber.provider, ready: transcription.ready, detail: scrub(transcription.detail) },
      hyperframes: { ready: hyperframes.ready, detail: scrub(hyperframes.detail) },
      remotion: { ready: remotion.ready, detail: scrub(remotion.detail) },
      ffmpeg: { ready: ffmpeg.ready, version: scrub(ffmpeg.version ?? "") },
    };
  };
  return () => {
    if (!cached || Date.now() - cached.at > CACHE_MS) cached = { at: Date.now(), value: compute() };
    return cached.value;
  };
}

/** Construye la configuración pública para un dueño (la calibración del estimador es por dueño). */
export async function buildPublicConfig(ctx: AppContext, ownerId: string, capabilities: Capabilities): Promise<PublicConfig> {
  const { config, env } = ctx;
  const pricing = pricingFrom(config);
  const calibration = await ctx.db.calibration.get(ownerId);
  const cal: PublicConfig["estimator"]["calibration"] = {};
  for (const [stage, value] of Object.entries(calibration)) if (value) cal[stage] = { factor: value.factor, samples: value.samples };
  return {
    version: SERVER_VERSION,
    demoMode: env.demoMode || ctx.services.editor.kind === "demo",
    capabilities,
    models: {
      editor: config.models.claude.editor,
      helper: config.models.claude.helper,
      available: config.models.claude.models.map((m) => ({ id: m.id, label: m.label })),
    },
    kieModels: config.providers.kie.models.map((m) => ({ id: m.id, label: m.label, kind: m.kind, costUsd: m.costUsd, enabled: m.enabled, verified: m.verified })),
    estimator: { coefficients: { ...config.estimator }, calibration: cal },
    pricing: {
      editorModel: pricing.editorModel,
      helperModel: pricing.helperModel,
      kieDefaults: { ...config.providers.kie.defaults },
    },
    limits: { maxUploadBytes: env.maxUploadBytes },
  };
}

export const systemRoutes: RouteModule = (app, ctx) => {
  const startedAt = Date.now();
  const capabilities = createCapabilitiesProbe(ctx);

  app.get("/health", { schema: { tags: ["Sistema"], summary: "Salud del servidor" } }, async () => ({
    ok: true,
    version: SERVER_VERSION,
    demoMode: ctx.env.demoMode || ctx.services.editor.kind === "demo",
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    jobsRunning: ctx.queue.runningCount(),
  }));

  app.get("/config", { schema: { tags: ["Sistema"], summary: "Configuración pública (sin llaves)" } }, async (request) => {
    return buildPublicConfig(ctx, request.ownerId, await capabilities());
  });
};
