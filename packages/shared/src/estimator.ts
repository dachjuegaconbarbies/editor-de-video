/**
 * Estimador de TIEMPO y COSTO antes de generar.
 * Es una fórmula por etapa que se recalibra con los tiempos reales de cada render
 * (factor de calibración por etapa = mediana móvil de real/estimado).
 * Vive en el paquete compartido para que la interfaz lo recalcule al instante al prender/apagar opciones.
 */
import type { EstimatorCoefficients, KieModelConfig } from "./config.js";
import type { ProjectSettings } from "./settings.js";

export interface MaterialSummary {
  /** Minutos totales de video en crudo. */
  videoMinutes: number;
  /** Minutos con voz por transcribir (si aún no está transcrito). */
  speechMinutesPending: number;
  /** Minutos de material aún sin analizar. */
  unanalyzedMinutes: number;
  photos: number;
  /** Duración objetivo si no se indicó (segundos) — se infiere del material. */
  inferredDurationSeconds: number;
}

export interface PricingInput {
  editorModel: { inputUsdPerMTok: number; outputUsdPerMTok: number; cacheReadUsdPerMTok: number };
  helperModel: { inputUsdPerMTok: number; outputUsdPerMTok: number; cacheReadUsdPerMTok: number };
  kieModels: KieModelConfig[];
  kieDefaults: { imagen: string; video: string; musica: string; voz: string; sfx: string };
}

export type EstimateStage = "analizando" | "transcribiendo" | "planeando" | "generando-ia" | "motion-graphics" | "render" | "revision-calidad";

export interface EstimateLine {
  stage: EstimateStage;
  label: string;
  seconds: number;
  costUsd: number;
  detail: string;
}

export interface Estimate {
  seconds: { min: number; max: number; expected: number };
  costUsd: { min: number; max: number; expected: number };
  /** Texto listo para mostrar, p. ej. "6–9 min". */
  label: string;
  costLabel: string;
  lines: EstimateLine[];
  /** Cuántos renders reales alimentan la calibración. */
  calibrationSamples: number;
}

/** Factores de calibración por etapa (1 = la fórmula base acierta). */
export type Calibration = Partial<Record<EstimateStage, { factor: number; samples: number }>>;

const STAGE_LABELS: Record<EstimateStage, string> = {
  analizando: "Analizar material",
  transcribiendo: "Transcribir voz",
  planeando: "Claude planea la edición",
  "generando-ia": "Generar con IA (Kie AI)",
  "motion-graphics": "Motion graphics",
  render: "Render final",
  "revision-calidad": "Revisión de calidad",
};

function kieModel(pricing: PricingInput, kind: keyof PricingInput["kieDefaults"], explicit?: string): KieModelConfig | undefined {
  const id = explicit || pricing.kieDefaults[kind];
  return pricing.kieModels.find((m) => m.id === id) ?? pricing.kieModels.find((m) => m.kind === kind && m.enabled);
}

export function formatMinutesRange(minSec: number, maxSec: number): string {
  const toMin = (s: number) => Math.max(1, Math.round(s / 60));
  const a = toMin(minSec);
  const b = Math.max(a, toMin(maxSec));
  if (maxSec < 60) return "menos de 1 min";
  return a === b ? `~${a} min` : `${a}–${b} min`;
}

export function formatUsd(n: number): string {
  if (n < 0.01) return "< $0.01";
  return `$${n.toFixed(2)}`;
}

export function estimate(
  settings: ProjectSettings,
  material: MaterialSummary,
  coef: EstimatorCoefficients,
  pricing: PricingInput,
  calibration: Calibration = {},
): Estimate {
  const t = settings.tools;
  const targetSeconds = settings.instruction.targetDuration ?? material.inferredDurationSeconds ?? 30;
  const outMinutes = Math.max(5, targetSeconds) / 60;
  const lines: EstimateLine[] = [];
  const cal = (stage: EstimateStage) => calibration[stage]?.factor ?? 1;
  const push = (stage: EstimateStage, seconds: number, costUsd: number, detail: string) => {
    if (seconds <= 0 && costUsd <= 0) return;
    lines.push({ stage, label: STAGE_LABELS[stage], seconds: seconds * cal(stage), costUsd, detail });
  };

  // 1) Análisis (solo lo que falta)
  push("analizando", material.unanalyzedMinutes * coef.analyzePerMinute, 0, `${material.unanalyzedMinutes.toFixed(1)} min de material por analizar`);

  // 2) Transcripción local (sin costo de API con faster-whisper)
  if (settings.transcription.enabled) {
    push("transcribiendo", material.speechMinutesPending * coef.transcribePerMinute, 0, `${material.speechMinutesPending.toFixed(1)} min de voz`);
  }

  // 3) Planeación con Claude: tokens aproximados
  const framesPerMinute = 8;
  const inputTokens = 25_000 + material.videoMinutes * (900 /* transcripción */ + framesPerMinute * 400 /* fotogramas */);
  const outputTokens = 12_000 + outMinutes * 6_000;
  const turnsFactor = 2.2; // el agente repasa su trabajo; el historial se relee en caché
  const p = pricing.editorModel;
  const claudeCost =
    (inputTokens / 1e6) * p.inputUsdPerMTok +
    ((inputTokens * (turnsFactor - 1)) / 1e6) * (p.cacheReadUsdPerMTok || p.inputUsdPerMTok * 0.1) +
    ((outputTokens * turnsFactor) / 1e6) * p.outputUsdPerMTok;
  const helperCost = ((material.videoMinutes * framesPerMinute * 500) / 1e6) * pricing.helperModel.inputUsdPerMTok;
  push("planeando", coef.planBase + material.videoMinutes * coef.planPerMinute, claudeCost + helperCost, `Claude revisa material, transcripción y fotogramas`);

  // 4) IA generativa
  let aiSeconds = 0;
  let aiCost = 0;
  const aiDetail: string[] = [];
  if (t.aiImages.enabled) {
    const m = kieModel(pricing, "imagen", t.aiImages.model);
    const n = t.aiImages.max;
    aiSeconds = Math.max(aiSeconds, m?.typicalSeconds ?? coef.aiImage); // en paralelo
    aiCost += n * (m?.costUsd ?? 0);
    aiDetail.push(`${n} imágenes (${m?.label ?? "modelo por definir"})`);
  }
  if (t.aiVideos.enabled) {
    const m = kieModel(pricing, "video", t.aiVideos.model);
    const n = t.aiVideos.max;
    aiSeconds = Math.max(aiSeconds, (m?.typicalSeconds ?? coef.aiVideo) * Math.ceil(n / 2));
    aiCost += n * (m?.costUsd ?? 0);
    aiDetail.push(`${n} clips de ${t.aiVideos.duration}s (${m?.label ?? "modelo por definir"})`);
  }
  if (t.sfx.enabled && t.sfx.source === "ia") {
    const m = kieModel(pricing, "sfx");
    const n = t.sfx.density === "alta" ? 6 : t.sfx.density === "media" ? 4 : 2;
    aiSeconds = Math.max(aiSeconds, m?.typicalSeconds ?? coef.aiAudio);
    aiCost += n * (m?.costUsd ?? 0);
    aiDetail.push(`${n} efectos de sonido`);
  }
  if (t.voiceover.enabled) {
    const m = kieModel(pricing, "voz");
    aiSeconds = Math.max(aiSeconds, m?.typicalSeconds ?? coef.aiAudio);
    aiCost += m?.costUsd ?? 0;
    aiDetail.push("voz en off");
  }
  if (t.music.enabled && t.music.source === "ia") {
    const m = kieModel(pricing, "musica");
    aiSeconds = Math.max(aiSeconds, m?.typicalSeconds ?? coef.aiAudio * 2);
    aiCost += m?.costUsd ?? 0;
    aiDetail.push("música");
  }
  if (aiDetail.length) push("generando-ia", aiSeconds, aiCost, aiDetail.join(", "));

  // 5) Motion graphics
  if (t.motionGraphics.enabled) {
    const graphicSeconds =
      t.motionGraphics.mode === "manual"
        ? t.motionGraphics.items.reduce((s, it) => s + it.duration, 0) || 6
        : Math.min(30, Math.max(6, targetSeconds * 0.25));
    const engineFactor = t.motionGraphics.engine === "builtin" ? 0.2 : 1;
    push("motion-graphics", graphicSeconds * coef.motionPerSecond * engineFactor, 0, `~${Math.round(graphicSeconds)} s de gráficos`);
  }

  // 6) Render (1080p) — subtítulos y overlays agregan un poco
  const extras = 1 + (settings.captions.enabled ? 0.15 : 0) + (t.zooms.enabled ? 0.1 : 0) + (t.reframe.enabled ? 0.1 : 0);
  push("render", targetSeconds * coef.renderPerSecond * extras + 8, 0, `${Math.round(targetSeconds)} s de video a 1080p`);

  // 7) Revisión de calidad (Claude mira fotogramas del render)
  const qaCost = ((6 * 1200 + 3000) / 1e6) * p.inputUsdPerMTok + (1500 / 1e6) * p.outputUsdPerMTok;
  push("revision-calidad", coef.qaBase, qaCost, "Claude revisa fotogramas del render contra tus reglas");

  const expected = lines.reduce((s, l) => s + l.seconds, 0);
  const cost = lines.reduce((s, l) => s + l.costUsd, 0);
  const samples = Math.min(...Object.values(calibration).map((c) => c?.samples ?? 0), Infinity);
  const calibrationSamples = Number.isFinite(samples) ? samples : 0;
  // El rango se estrecha conforme hay más muestras reales.
  const spread = coef.spread * (calibrationSamples >= 5 ? 0.6 : calibrationSamples >= 2 ? 0.8 : 1);
  const min = expected * (1 - spread);
  const max = expected * (1 + spread);
  return {
    seconds: { min, max, expected },
    costUsd: { min: cost * 0.8, max: cost * 1.3, expected: cost },
    label: formatMinutesRange(min, max),
    costLabel: cost < 0.01 ? "< $0.01" : `${formatUsd(cost * 0.8)}–${formatUsd(cost * 1.3)}`,
    lines,
    calibrationSamples,
  };
}

/**
 * Actualiza el factor de calibración de una etapa con un tiempo real medido.
 * Usa un promedio móvil exponencial acotado para no sobre-reaccionar a un render atípico.
 */
export function updateCalibration(prev: { factor: number; samples: number } | undefined, estimatedSeconds: number, actualSeconds: number): { factor: number; samples: number } {
  if (estimatedSeconds <= 0 || actualSeconds <= 0) return prev ?? { factor: 1, samples: 0 };
  const current = prev ?? { factor: 1, samples: 0 };
  // ratio relativo a la fórmula base (estimatedSeconds ya incluye el factor previo)
  const baseEstimate = estimatedSeconds / current.factor;
  const observed = Math.min(10, Math.max(0.1, actualSeconds / baseEstimate));
  const alpha = current.samples < 3 ? 0.5 : 0.3;
  const factor = current.samples === 0 ? observed : current.factor * (1 - alpha) + observed * alpha;
  return { factor: Math.round(factor * 1000) / 1000, samples: current.samples + 1 };
}
