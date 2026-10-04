/**
 * Estimado de tiempo y costo de un proyecto + avisos antes de generar.
 * La fórmula vive en `@autoeditor/shared` (`estimate`); aquí se arma el resumen del material desde
 * los assets/transcripciones, se aplica la calibración guardada y se agregan avisos como
 * "pides 60 s y solo hay 20 s de material" o "prendiste B-roll pero no hay tomas de apoyo".
 */
import {
  estimate,
  type Asset,
  type EstimateResponse,
  type EstimateWarning,
  type MaterialSummary,
  type Platform,
  type PricingInput,
  type ProjectSettings,
  type Transcript,
} from "@autoeditor/shared";
import type { AppConfig } from "../config/index.js";
import type { AppContext } from "../context.js";

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Duración razonable máxima por plataforma cuando la persona no la indica (segundos). */
const PLATFORM_DEFAULT_MAX: Record<Platform, number> = { tiktok: 60, reels: 60, shorts: 60, youtube: 300, linkedin: 90, generico: 90 };

/** Segundos que se cuentan por foto en pantalla al calcular el material disponible. */
const SECONDS_PER_PHOTO = 3;

export type MaterialDetail = NonNullable<EstimateResponse["material"]>;

/** Resume el material del proyecto para el estimador (incluye lo detectado como b-roll). */
export function summarizeMaterial(assets: Asset[], transcripts: Transcript[], settings: ProjectSettings): MaterialDetail {
  const videos = assets.filter((a) => a.kind === "video" && a.category === "crudo-video");
  const voiceNotes = assets.filter((a) => a.category === "crudo-voz" && a.kind === "audio");
  const photos = assets.filter((a) => a.category === "crudo-foto" && a.kind === "imagen").length;
  const transcribed = new Set(transcripts.filter((t) => t.status === "listo").map((t) => t.assetId));
  const dur = (a: Asset) => Math.max(0, a.probe.duration ?? 0);

  const videoSeconds = videos.reduce((s, a) => s + dur(a), 0);
  const speechPending = [...videos, ...voiceNotes]
    .filter((a) => !transcribed.has(a.id) && a.analysis.hasSpeech !== false && (a.kind === "audio" || a.probe.hasAudio || a.probe.duration == null))
    .reduce((s, a) => s + dur(a), 0);
  const unanalyzed = [...videos, ...voiceNotes].filter((a) => a.analysis.status !== "listo").reduce((s, a) => s + dur(a), 0);

  // B-roll: fragmentos detectados por el análisis; si una toma completa es b-roll sin fragmentos, cuenta entera.
  let brollSeconds = 0;
  let aRollAssets = 0;
  let bRollAssets = 0;
  for (const a of assets.filter((x) => x.kind === "video")) {
    const role = a.analysis.role;
    if (role === "a-roll" || role === "mixto") aRollAssets++;
    if (role === "b-roll") bRollAssets++;
    const segs = a.analysis.brollSegments.reduce((s, b) => s + Math.max(0, b.end - b.start), 0);
    brollSeconds += segs > 0 ? segs : role === "b-roll" ? dur(a) : 0;
  }

  const availableSeconds = videoSeconds + photos * SECONDS_PER_PHOTO;
  const platformMax = PLATFORM_DEFAULT_MAX[settings.instruction.platform] ?? 90;
  const inferred = availableSeconds <= 0 ? 30 : availableSeconds < 15 ? availableSeconds : Math.min(platformMax, Math.max(15, Math.round(availableSeconds * 0.45)));

  const summary: MaterialSummary = {
    videoMinutes: videoSeconds / 60,
    speechMinutesPending: speechPending / 60,
    unanalyzedMinutes: unanalyzed / 60,
    photos,
    inferredDurationSeconds: Math.round(inferred),
  };
  return { ...summary, brollSeconds: round1(brollSeconds), aRollAssets, bRollAssets, availableSeconds: round1(availableSeconds) };
}

/** Avisos que se muestran antes de GENERAR. */
export function materialWarnings(
  assets: Asset[],
  settings: ProjectSettings,
  material: MaterialDetail,
  caps: { kieConfigured: boolean },
): EstimateWarning[] {
  const out: EstimateWarning[] = [];
  const raw = assets.filter((a) => ["crudo-video", "crudo-foto", "crudo-voz"].includes(a.category));
  if (raw.length === 0) {
    out.push({ code: "sin-material", level: "aviso", message: "Aún no subes material: arrastra tus videos, fotos o notas de voz a MATERIAL." });
    return out;
  }
  const { targetDuration: target, durationMode: mode } = settings.instruction;
  const available = material.availableSeconds;

  // Duración del video final.
  if (target != null && mode === "auto") {
    out.push({
      code: "duracion-referencia",
      level: "info",
      message: `Con el modo automático, los ${target} s son solo una referencia. Elige «aproximada» (±15 %) o «exacta» (±0.5 s) si quieres que se cumpla.`,
    });
  }
  if (target == null && mode !== "auto") {
    out.push({ code: "duracion-sin-valor", level: "info", message: `Elegiste duración ${mode} pero no indicaste cuántos segundos; Claude la definirá según el material.` });
  }
  if (target != null && available > 0) {
    const tolerance = mode === "exacta" ? 0.5 : mode === "aproximada" ? target * 0.15 : 0;
    if (target - tolerance > available) {
      out.push({
        code: "duracion-mayor-que-material",
        level: "aviso",
        message: `Pides ${target} s pero solo hay ${Math.round(available)} s de material. Sube más material o baja la duración; si no, Claude tendrá que alargar fotos o repetir tomas.`,
      });
    }
  }
  if (target != null && mode !== "auto") {
    const mustAppear = assets.filter((a) => a.category === "crudo-video" && a.priority === "debe-aparecer").reduce((s, a) => s + (a.probe.duration ?? 0), 0);
    if (mustAppear > target * (mode === "exacta" ? 1 : 1.15) + (mode === "exacta" ? 0.5 : 0)) {
      out.push({
        code: "debe-aparecer-excede",
        level: "info",
        message: `Los videos marcados como «debe aparecer» suman ${Math.round(mustAppear)} s y pediste ${target} s: Claude usará solo sus mejores fragmentos.`,
      });
    }
  }

  // B-roll.
  const broll = settings.tools.broll;
  if (broll.enabled) {
    const videos = assets.filter((a) => a.kind === "video" && a.category === "crudo-video");
    const pending = videos.some((a) => a.analysis.status === "pendiente" || a.analysis.status === "analizando");
    if (broll.source !== "material" && !caps.kieConfigured) {
      out.push({
        code: "broll-ia-sin-kie",
        level: "aviso",
        message: "El B-roll con IA necesita Kie AI activo (con llave y fuera del modo demo). Mientras tanto se usarán las tomas de apoyo de tu material.",
      });
    }
    if (broll.source === "material" && videos.length > 0) {
      if (pending) {
        out.push({ code: "broll-analizando", level: "info", message: "Las tomas de B-roll se detectan cuando termina el análisis del material." });
      } else if (material.brollSeconds <= 0) {
        out.push({
          code: "broll-sin-tomas",
          level: "aviso",
          message: "Prendiste B-roll pero no encontré tomas de apoyo (paisaje, producto, detalle) en tu material. Sube algunas o cambia la fuente a «IA» o «ambos».",
        });
      }
    }
  }

  // IA generativa sin llave.
  const t = settings.tools;
  const usesAi = t.aiImages.enabled || t.aiVideos.enabled || t.voiceover.enabled || (t.sfx.enabled && t.sfx.source === "ia") || (t.music.enabled && t.music.source === "ia");
  if (usesAi && !caps.kieConfigured) {
    out.push({ code: "ia-sin-kie", level: "aviso", message: "Prendiste herramientas de IA pero Kie AI no está activo (sin llave o en modo demo): se usarán marcadores de demostración sin gastar créditos." });
  }
  return out;
}

/** Precios para el estimador, desde /config (nunca fijos en código). */
export function pricingFrom(config: AppConfig): PricingInput {
  const models = config.models.claude.models;
  const pick = (id: string) => {
    const m = models.find((x) => x.id === id) ?? models[0];
    return { inputUsdPerMTok: m?.inputUsdPerMTok ?? 0, outputUsdPerMTok: m?.outputUsdPerMTok ?? 0, cacheReadUsdPerMTok: m?.cacheReadUsdPerMTok ?? 0 };
  };
  return {
    editorModel: pick(config.models.claude.editor),
    helperModel: pick(config.models.claude.helper),
    kieModels: config.providers.kie.models,
    kieDefaults: config.providers.kie.defaults,
  };
}

/** Estimado completo de un proyecto (con calibración del dueño y avisos). */
export async function estimateProject(ctx: AppContext, ownerId: string, projectId: string, settings: ProjectSettings): Promise<EstimateResponse> {
  const [assets, transcripts, calibration] = await Promise.all([
    ctx.db.assets.list(ownerId, { projectId }),
    ctx.db.transcripts.list(ownerId, { projectId }),
    ctx.db.calibration.get(ownerId),
  ]);
  const material = summarizeMaterial(assets, transcripts, settings);
  const est = estimate(settings, material, ctx.config.estimator, pricingFrom(ctx.config), calibration);
  const gen = ctx.services.generative.status();
  const warnings = materialWarnings(assets, settings, material, { kieConfigured: gen.configured && !gen.demo });
  return { ...est, warnings, material };
}
