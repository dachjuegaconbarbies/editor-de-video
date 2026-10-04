/**
 * Datos derivados (funciones puras): resumen de material, estimado de tiempo/costo, estado de
 * cada etapa y avisos antes de generar. Se usan en la interfaz y en las pruebas.
 */
import {
  EstimatorCoefficients,
  KieModelConfig,
  estimate,
  type Asset,
  type Calibration,
  type Estimate,
  type Job,
  type MaterialSummary,
  type Plan,
  type PricingInput,
  type ProjectSettings,
  type PublicConfig,
  type Transcript,
  type Version,
} from "@autoeditor/shared";
import { formatSecondsShort } from "../lib/format.js";
import type { ContextKey, StageId, StageState } from "../lib/stages.js";
import type { UploadItem } from "./editorStore.js";

export const RAW_CATEGORIES = ["crudo-video", "crudo-foto", "crudo-voz"] as const;
export const ELEMENT_CATEGORIES = ["musica", "sfx", "grafico", "logo"] as const;

const dur = (a: Asset) => a.probe.duration ?? 0;

/** Resumen del material para el estimador (lo mismo que calcula el servidor). */
export function summarizeMaterial(assets: Asset[], transcripts: Transcript[]): MaterialSummary {
  const videos = assets.filter((a) => a.category === "crudo-video");
  const voices = assets.filter((a) => a.category === "crudo-voz");
  const photos = assets.filter((a) => a.category === "crudo-foto").length;
  const videoSeconds = videos.reduce((s, a) => s + dur(a), 0);
  const transcribed = new Set(transcripts.filter((t) => t.status === "listo").map((t) => t.assetId));
  const speechPending = [...videos, ...voices]
    .filter((a) => a.analysis.hasSpeech !== false && a.analysis.role !== "b-roll" && !transcribed.has(a.id))
    .reduce((s, a) => s + dur(a), 0);
  const unanalyzed = videos.filter((a) => a.analysis.status !== "listo").reduce((s, a) => s + dur(a), 0);
  const available = videoSeconds + photos * 3;
  const inferred = available > 0 ? Math.round(Math.min(60, Math.max(15, available * 0.5))) : 30;
  return {
    videoMinutes: videoSeconds / 60,
    speechMinutesPending: speechPending / 60,
    unanalyzedMinutes: unanalyzed / 60,
    photos,
    inferredDurationSeconds: inferred,
  };
}

/** Segundos de material aprovechable (video en crudo + ~3 s por foto). */
export function availableMaterialSeconds(assets: Asset[]): number {
  return assets.reduce((s, a) => s + (a.category === "crudo-video" ? dur(a) : a.category === "crudo-foto" ? 3 : 0), 0);
}

/** Convierte la configuración pública en las entradas del estimador compartido. */
export function estimatorInputs(config: PublicConfig): { coef: EstimatorCoefficients; pricing: PricingInput; calibration: Calibration } {
  const coef = EstimatorCoefficients.parse(config.estimator.coefficients ?? {});
  const kieModels = config.kieModels.map((m) => KieModelConfig.parse({ ...m, api: "market" }));
  return {
    coef,
    pricing: {
      editorModel: config.pricing.editorModel,
      helperModel: config.pricing.helperModel,
      kieModels,
      kieDefaults: config.pricing.kieDefaults,
    },
    calibration: config.estimator.calibration as Calibration,
  };
}

/** Estimado instantáneo en el cliente (se recalcula al prender/apagar cualquier cosa). */
export function computeEstimate(config: PublicConfig | null, settings: ProjectSettings, assets: Asset[], transcripts: Transcript[]): Estimate | null {
  if (!config) return null;
  const { coef, pricing, calibration } = estimatorInputs(config);
  return estimate(settings, summarizeMaterial(assets, transcripts), coef, pricing, calibration);
}

export interface Warning {
  id: string;
  text: string;
  severity: "aviso" | "bloqueo";
}

/** Avisos antes de generar (p. ej. pides 60 s y solo hay 20 s de material). */
export function preflightWarnings(settings: ProjectSettings, assets: Asset[]): Warning[] {
  const out: Warning[] = [];
  const raw = assets.filter((a) => a.category === "crudo-video" || a.category === "crudo-foto");
  if (raw.length === 0) out.push({ id: "sin-material", text: "Sube al menos un video o una foto en MATERIAL.", severity: "bloqueo" });
  const available = availableMaterialSeconds(assets);
  const target = settings.instruction.targetDuration;
  if (target != null && raw.length > 0 && available > 0 && target > available) {
    out.push({
      id: "duracion",
      text: `Pides ${formatSecondsShort(target)} y solo hay ${formatSecondsShort(available)} de material. Claude usará lo que hay${settings.tools.broll.enabled ? " y B-roll" : ""}.`,
      severity: "aviso",
    });
  }
  const ctx = settings.context;
  if (ctx.script.enabled && !ctx.script.text.trim() && !ctx.script.fileAssetId) out.push({ id: "guion", text: "Prendiste TENGO GUION pero está vacío.", severity: "aviso" });
  if (ctx.references.enabled && ctx.references.imageAssetIds.length === 0 && ctx.references.links.filter((l) => l.url).length === 0) {
    out.push({ id: "referencias", text: "Prendiste TENGO REFERENCIAS VISUALES sin agregar ninguna.", severity: "aviso" });
  }
  const broll = assets.filter((a) => a.analysis.role === "b-roll" || a.analysis.brollSegments.length > 0);
  if (settings.tools.broll.enabled && settings.tools.broll.source === "material" && raw.length > 0 && broll.length === 0 && assets.every((a) => a.analysis.status === "listo")) {
    out.push({ id: "broll", text: "No se detectó B-roll en tu material. Sube tomas de apoyo o usa B-roll con IA.", severity: "aviso" });
  }
  return out;
}

export interface StageInput {
  settings: ProjectSettings;
  assets: Asset[];
  uploads: UploadItem[];
  transcripts: Transcript[];
  versions: Version[];
  activeJob: Job | null;
  pendingPlan: Plan | null;
}

const PROCESS_STAGES_RESULT = new Set(["generando-ia", "motion-graphics", "render", "revision-calidad"]);

/** Estado (vacío / listo / procesando / error) y qué le falta a cada etapa. */
export function stageStates(input: StageInput): Record<StageId, StageState> {
  const { settings, assets, uploads, transcripts, versions, activeJob, pendingPlan } = input;
  const raw = assets.filter((a) => (RAW_CATEGORIES as readonly string[]).includes(a.category));
  const analyzing = assets.filter((a) => a.analysis.status === "pendiente" || a.analysis.status === "analizando");
  const failed = assets.filter((a) => a.analysis.status === "error");
  const uploading = uploads.filter((u) => u.status === "subiendo");

  const material: StageState =
    uploading.length > 0
      ? { status: "procesando", hint: `Subiendo ${uploading.length} ${uploading.length === 1 ? "archivo" : "archivos"}…` }
      : raw.length === 0
        ? { status: "vacio", hint: "Arrastra tus videos, fotos o notas de voz." }
        : failed.length > 0
          ? { status: "error", hint: `${failed.length} ${failed.length === 1 ? "archivo no se pudo" : "archivos no se pudieron"} analizar.` }
          : analyzing.length > 0
            ? { status: "procesando", hint: `Analizando ${analyzing.length} ${analyzing.length === 1 ? "archivo" : "archivos"}…` }
            : { status: "listo", hint: `${raw.length} ${raw.length === 1 ? "archivo" : "archivos"} listos.` };

  const ctxIssues = contextIssues(settings);
  const anyCtx = settings.context.script.enabled || settings.context.brand.enabled || settings.context.references.enabled;
  const contexto: StageState = !anyCtx
    ? { status: "opcional", hint: "Opcional: guion, marca o referencias." }
    : ctxIssues.length
      ? { status: "vacio", hint: ctxIssues[0]!.hint }
      : { status: "listo", hint: "Claude usará tu contexto." };

  const speech = assets.filter((a) => (a.category === "crudo-video" || a.category === "crudo-voz") && a.analysis.hasSpeech !== false && a.analysis.role !== "b-roll");
  const tBusy = transcripts.filter((t) => t.status === "pendiente" || t.status === "transcribiendo");
  const tErr = transcripts.filter((t) => t.status === "error");
  const tReady = transcripts.filter((t) => t.status === "listo");
  const transcripcion: StageState = !settings.transcription.enabled
    ? { status: "opcional", hint: "Transcripción apagada." }
    : tErr.length
      ? { status: "error", hint: tErr[0]!.error ?? "No se pudo transcribir." }
      : tBusy.length
        ? { status: "procesando", hint: "Transcribiendo…" }
        : tReady.length
          ? { status: "listo", hint: `${tReady.reduce((s, t) => s + t.words.length, 0)} palabras con tiempos.` }
          : speech.length
            ? { status: "esperando", hint: "Se transcribe al terminar el análisis." }
            : { status: "vacio", hint: "Aparece cuando subas material con voz." };

  const enabledTools = Object.values(settings.tools).filter((t) => t.enabled).length;
  const herramientas: StageState = { status: "listo", hint: `${enabledTools} herramientas prendidas.` };

  const instruccion: StageState = settings.instruction.text.trim()
    ? { status: "listo", hint: "Instrucción lista." }
    : { status: "vacio", hint: "Describe el video que quieres (opcional, pero ayuda)." };

  const plan: StageState = !settings.instruction.reviewPlan
    ? { status: "opcional", hint: "Prende “Revisar plan” para verlo antes del render." }
    : pendingPlan && pendingPlan.status === "pendiente"
      ? { status: "esperando", hint: "Revisa y aprueba el plan." }
      : activeJob?.stage === "planeando"
        ? { status: "procesando", hint: "Claude está planeando…" }
        : pendingPlan
          ? { status: "listo", hint: "Plan aprobado." }
          : { status: "vacio", hint: "Aparece después de GENERAR." };

  const jobFailed = activeJob?.status === "error";
  const busyResult = !!activeJob && (activeJob.status === "corriendo" || activeJob.status === "en-cola") && (versions.length === 0 || activeJob.type !== "generar" || PROCESS_STAGES_RESULT.has(activeJob.stage ?? ""));
  const resultado: StageState = jobFailed
    ? { status: "error", hint: activeJob?.error ?? "Falló la generación." }
    : busyResult && versions.length === 0
      ? { status: "procesando", hint: activeJob?.message || "Generando tu video…" }
      : versions.length
        ? { status: "listo", hint: "V1 lista." }
        : { status: "vacio", hint: "Pulsa GENERAR para crear tu V1." };

  const versiones: StageState =
    versions.length > 1
      ? { status: busyResult ? "procesando" : "listo", hint: `${versions.length} versiones.` }
      : busyResult && versions.length > 0
        ? { status: "procesando", hint: "Aplicando tu corrección…" }
        : { status: versions.length ? "opcional" : "vacio", hint: versions.length ? "Escribe una corrección para crear V2." : "Aparecen al corregir tu V1." };

  return { material, contexto, transcripcion, herramientas, instruccion, plan, resultado, versiones };
}

/** Qué le falta a cada interruptor de contexto prendido. */
export function contextIssues(settings: ProjectSettings): { key: ContextKey; hint: string }[] {
  const c = settings.context;
  const out: { key: ContextKey; hint: string }[] = [];
  if (c.script.enabled && !c.script.text.trim() && !c.script.fileAssetId) out.push({ key: "script", hint: "Pega tu guion o sube un archivo." });
  if (c.brand.enabled && !c.brand.brandId && !c.brand.inline.name && c.brand.inline.colors.length === 0 && c.brand.inline.logoAssetIds.length === 0 && c.brand.inline.googleFonts.length === 0) {
    out.push({ key: "brand", hint: "Agrega logo, colores o tipografías." });
  }
  if (c.references.enabled && c.references.imageAssetIds.length === 0 && c.references.links.filter((l) => l.url).length === 0) {
    out.push({ key: "references", hint: "Agrega imágenes, videos o links." });
  }
  return out;
}

/** Etapa sugerida (la primera que necesita atención) para el stepper. */
export function suggestedStage(states: Record<StageId, StageState>, settings: ProjectSettings): StageId {
  if (states.material.status === "vacio") return "material";
  if (states.resultado.status === "procesando") return "resultado";
  if (states.plan.status === "esperando") return "plan";
  if (states.versiones.status === "listo" || states.versiones.status === "procesando") return "versiones";
  if (states.resultado.status === "listo") return "resultado";
  void settings;
  return "instruccion";
}
