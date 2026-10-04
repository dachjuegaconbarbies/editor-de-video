/**
 * Configuración del proyecto = el estado del diagrama.
 * Cada interruptor "TENGO …" y cada herramienta de la paleta vive aquí.
 * El frontend la edita (autoguardado) y el backend la usa para planear y estimar.
 */
import { z } from "zod";
import { AspectRatio, Platform } from "./formats.js";
import { CaptionStyle } from "./recipe.js";

const HexColor = z.string().regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);

export const ReferenceLink = z.object({
  id: z.string(),
  kind: z.enum(["red-social", "pagina-web"]),
  url: z.string().url().or(z.literal("")),
  likes: z.string().default(""),
  /** Estado del análisis del link (si no se puede, se pide captura o archivo). */
  status: z.enum(["pendiente", "analizado", "no-disponible"]).default("pendiente"),
  analysis: z.string().default(""),
});
export type ReferenceLink = z.infer<typeof ReferenceLink>;

export const BrandKitInline = z.object({
  name: z.string().default(""),
  logoAssetIds: z.array(z.string()).default([]),
  fontAssetIds: z.array(z.string()).default([]),
  googleFonts: z.array(z.string()).default([]),
  colors: z.array(HexColor).default([]),
  introAssetId: z.string().nullable().default(null),
  outroAssetId: z.string().nullable().default(null),
  transitionAssetIds: z.array(z.string()).default([]),
  lowerThirdTemplateIds: z.array(z.string()).default([]),
  notes: z.string().default(""),
});
export type BrandKitInline = z.infer<typeof BrandKitInline>;

export const ManualGraphic = z.object({
  id: z.string(),
  description: z.string().default(""),
  /** Momento aproximado en segundos del video final (null = que Claude decida). */
  at: z.number().min(0).nullable().default(null),
  duration: z.number().min(0.5).max(30).default(3),
});
export type ManualGraphic = z.infer<typeof ManualGraphic>;

/** Interruptor con sus campos; `prefault({})` hace que los valores por defecto internos apliquen si falta el objeto. */
const toggle = <T extends z.ZodRawShape>(shape: T, enabled = false) =>
  z.object({ enabled: z.boolean().default(enabled), ...shape }).prefault({} as never);

export const ToolSettings = z.object({
  // Edición
  removeSilences: toggle({ aggressiveness: z.enum(["suave", "media", "agresiva"]).default("media") }, true),
  removeFillers: toggle({}, true),
  pacing: toggle({ value: z.enum(["lento", "medio", "rapido"]).default("medio") }, true),
  transitions: toggle({ style: z.enum(["auto", "corte", "fundido", "barrido", "zoom", "deslizar"]).default("auto") }, true),
  zooms: toggle({ intensity: z.enum(["sutil", "media", "fuerte"]).default("sutil") }, true),
  reframe: toggle({ mode: z.enum(["auto", "centro", "fondo-desenfocado", "seguir"]).default("auto") }, true),
  colorCorrection: toggle({ look: z.enum(["natural", "calido", "frio", "vivo", "blanco-negro", "cine"]).default("natural") }, false),
  // Texto
  titles: toggle({}, true),
  lowerThirds: toggle({ name: z.string().default(""), role: z.string().default("") }, false),
  cta: toggle({ text: z.string().default("") }, false),
  // Audio
  music: toggle({ source: z.enum(["mia", "biblioteca", "ia"]).default("mia"), gainDb: z.number().default(-16) }, true),
  sfx: toggle({ source: z.enum(["biblioteca", "ia"]).default("biblioteca"), density: z.enum(["baja", "media", "alta"]).default("media") }, false),
  ducking: toggle({}, true),
  loudness: toggle({ targetLufs: z.number().min(-30).max(-8).default(-14) }, true),
  voiceEnhance: toggle({}, false),
  voiceover: toggle({ voice: z.string().default(""), script: z.string().default("") }, false),
  // Motion graphics e IA
  motionGraphics: toggle(
    {
      mode: z.enum(["automatico", "manual"]).default("automatico"),
      engine: z.enum(["hyperframes", "builtin", "remotion"]).default("hyperframes"),
      items: z.array(ManualGraphic).default([]),
    },
    false,
  ),
  aiImages: toggle(
    {
      max: z.number().int().min(1).max(30).default(4),
      style: z.string().default("fotográfico, natural"),
      usage: z.array(z.enum(["broll", "fondo", "portada"])).default(["broll"]),
      model: z.string().default(""),
    },
    false,
  ),
  aiVideos: toggle(
    {
      max: z.number().int().min(1).max(10).default(2),
      duration: z.number().min(2).max(15).default(5),
      model: z.string().default(""),
    },
    false,
  ),
});
export type ToolSettings = z.infer<typeof ToolSettings>;
export type ToolKey = keyof ToolSettings;

export const ProjectSettings = z.object({
  context: z
    .object({
      script: toggle({ text: z.string().default(""), fileAssetId: z.string().nullable().default(null), follow: z.enum(["estricto", "flexible"]).default("flexible") }),
      brand: toggle({ brandId: z.string().nullable().default(null), inline: BrandKitInline.default(BrandKitInline.parse({})) }),
      references: toggle({ imageAssetIds: z.array(z.string()).default([]), links: z.array(ReferenceLink).default([]) }),
    })
    .default({
      script: { enabled: false, text: "", fileAssetId: null, follow: "flexible" },
      brand: { enabled: false, brandId: null, inline: BrandKitInline.parse({}) },
      references: { enabled: false, imageAssetIds: [], links: [] },
    }),
  transcription: z
    .object({
      enabled: z.boolean().default(true),
      language: z.string().default("auto"),
      diarization: z.boolean().default(false),
    })
    .default({ enabled: true, language: "auto", diarization: false }),
  captions: z
    .object({
      enabled: z.boolean().default(true),
      style: CaptionStyle.default(CaptionStyle.parse({})),
      translateTo: z.string().nullable().default(null),
      exportFiles: z.boolean().default(true),
    })
    .default({ enabled: true, style: CaptionStyle.parse({}), translateTo: null, exportFiles: true }),
  tools: ToolSettings.default(ToolSettings.parse({})),
  engines: z
    .object({
      kie: z.boolean().default(false),
      hyperframes: z.boolean().default(true),
      remotion: z.boolean().default(false),
    })
    .default({ kie: false, hyperframes: true, remotion: false }),
  instruction: z
    .object({
      text: z.string().default(""),
      format: AspectRatio.default("9:16"),
      targetDuration: z.number().min(3).max(1800).nullable().default(null),
      platform: Platform.default("tiktok"),
      tone: z.string().default("dinámico"),
      reviewPlan: z.boolean().default(false),
    })
    .default({ text: "", format: "9:16", targetDuration: null, platform: "tiktok", tone: "dinámico", reviewPlan: false }),
  /** Estilo guardado que se está usando (si arrancó desde un estilo). */
  style: z
    .object({
      styleId: z.string().nullable().default(null),
      styleVersion: z.number().int().nullable().default(null),
    })
    .default({ styleId: null, styleVersion: null }),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;
export type ProjectSettingsInput = z.input<typeof ProjectSettings>;

export function defaultProjectSettings(): ProjectSettings {
  return ProjectSettings.parse({});
}

/**
 * Regla: prender IA IMÁGENES, IA VIDEOS, SFX con IA o voz con IA prende Kie AI en el recuadro de motores.
 * Motion graphics prende/apaga su motor elegido.
 */
export function deriveEngines(settings: ProjectSettings): ProjectSettings["engines"] {
  const t = settings.tools;
  const kie =
    (t.aiImages.enabled || t.aiVideos.enabled || (t.sfx.enabled && t.sfx.source === "ia") || t.voiceover.enabled || (t.music.enabled && t.music.source === "ia"));
  return {
    kie,
    hyperframes: t.motionGraphics.enabled ? t.motionGraphics.engine === "hyperframes" : settings.engines.hyperframes,
    remotion: t.motionGraphics.enabled && t.motionGraphics.engine === "remotion",
  };
}

// ---------------------------------------------------------------------------
// Catálogo de herramientas para la paleta (etiquetas en español, grupos).
// ---------------------------------------------------------------------------

export type ToolGroup = "edicion" | "texto" | "audio" | "ia";

export const TOOL_CATALOG: { key: ToolKey; group: ToolGroup; label: string; short: string; help: string; usesAi?: boolean }[] = [
  { key: "removeSilences", group: "edicion", label: "Quitar silencios", short: "Silencios", help: "Elimina pausas largas para que el video fluya." },
  { key: "removeFillers", group: "edicion", label: "Quitar muletillas", short: "Muletillas", help: "Quita 'eh', 'este', 'o sea' y repeticiones." },
  { key: "pacing", group: "edicion", label: "Ritmo", short: "Ritmo", help: "Qué tan seguido cambia el plano." },
  { key: "transitions", group: "edicion", label: "Transiciones", short: "Transiciones", help: "Cómo se pasa de un plano a otro." },
  { key: "zooms", group: "edicion", label: "Zooms y punch-ins", short: "Zooms", help: "Acercamientos para dar energía y énfasis." },
  { key: "reframe", group: "edicion", label: "Reencuadre automático", short: "Reencuadre", help: "Adapta horizontal a vertical siguiendo a quien habla." },
  { key: "colorCorrection", group: "edicion", label: "Corrección de color", short: "Color", help: "Ajusta el look del video." },
  { key: "titles", group: "texto", label: "Títulos en pantalla", short: "Títulos", help: "Frases clave grandes en momentos importantes." },
  { key: "lowerThirds", group: "texto", label: "Cintillos", short: "Cintillos", help: "Nombre y cargo de quien habla." },
  { key: "cta", group: "texto", label: "Llamado a la acción", short: "CTA", help: "Cierre con lo que quieres que haga quien ve." },
  { key: "music", group: "audio", label: "Música", short: "Música", help: "Tu música, de biblioteca o generada con IA." },
  { key: "sfx", group: "audio", label: "Efectos de sonido", short: "SFX", help: "Whoosh en cortes, golpes en textos." },
  { key: "ducking", group: "audio", label: "Bajar música al hablar", short: "Ducking", help: "La música baja sola cuando alguien habla." },
  { key: "loudness", group: "audio", label: "Volumen parejo", short: "Volumen", help: "Normaliza a -14 LUFS para redes." },
  { key: "voiceEnhance", group: "audio", label: "Limpieza de voz", short: "Voz limpia", help: "Reduce ruido de fondo y ecualiza la voz." },
  { key: "voiceover", group: "audio", label: "Voz en off con IA", short: "Voz IA", help: "Narración generada con IA.", usesAi: true },
  { key: "motionGraphics", group: "ia", label: "Motion graphics", short: "Motion", help: "Gráficos animados automáticos o manuales." },
  { key: "aiImages", group: "ia", label: "IA imágenes", short: "IA imágenes", help: "Imágenes generadas con Kie AI (b-roll, fondos, portada).", usesAi: true },
  { key: "aiVideos", group: "ia", label: "IA videos", short: "IA videos", help: "Clips generados con Kie AI.", usesAi: true },
];

export const TOOL_GROUP_LABELS: Record<ToolGroup, string> = {
  edicion: "Edición",
  texto: "Texto",
  audio: "Audio",
  ia: "IA y motion graphics",
};
