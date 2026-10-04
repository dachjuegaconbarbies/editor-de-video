/**
 * Entidades persistidas. Todas llevan `ownerId` para poder integrarse a Zyra (multiusuario).
 * Las fechas son ISO 8601 en texto.
 */
import { z } from "zod";
import { Recipe } from "./recipe.js";
import { ProjectSettings } from "./settings.js";

const Iso = z.string();

// ---------------------------------------------------------------------------
// Proyecto
// ---------------------------------------------------------------------------

export const ProjectStatus = z.enum(["borrador", "procesando", "listo", "error"]);

export const Project = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  settings: ProjectSettings,
  status: ProjectStatus.default("borrador"),
  /** Versión que se está mostrando/trabajando. */
  currentVersionId: z.string().nullable().default(null),
  thumbnailAssetId: z.string().nullable().default(null),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Project = z.infer<typeof Project>;

// ---------------------------------------------------------------------------
// Assets (archivos)
// ---------------------------------------------------------------------------

/** Categoría = zona de arrastre del nodo MATERIAL (o archivo generado internamente). */
export const AssetCategory = z.enum([
  "crudo-video",
  "crudo-foto",
  "crudo-voz",
  "musica",
  "sfx",
  "grafico",
  "logo",
  "fuente",
  "guion",
  "referencia",
  "marca-intro",
  "marca-outro",
  "marca-transicion",
  "ia-generado",
  "motion-render",
  "render",
  "otro",
]);
export type AssetCategory = z.infer<typeof AssetCategory>;

export const MediaKind = z.enum(["video", "imagen", "audio", "fuente", "documento", "otro"]);
export type MediaKind = z.infer<typeof MediaKind>;

export const MediaProbe = z.object({
  duration: z.number().nullable().default(null),
  width: z.number().nullable().default(null),
  height: z.number().nullable().default(null),
  fps: z.number().nullable().default(null),
  rotation: z.number().default(0),
  videoCodec: z.string().nullable().default(null),
  audioCodec: z.string().nullable().default(null),
  hasAudio: z.boolean().default(false),
  hasVideo: z.boolean().default(false),
  variableFrameRate: z.boolean().default(false),
});
export type MediaProbe = z.infer<typeof MediaProbe>;

export const AssetAnalysis = z.object({
  status: z.enum(["pendiente", "analizando", "listo", "error"]).default("pendiente"),
  error: z.string().nullable().default(null),
  /** Cambios de escena (segundos). */
  scenes: z.array(z.number()).default([]),
  /** Silencios detectados [inicio, fin] en segundos. */
  silences: z.array(z.tuple([z.number(), z.number()])).default([]),
  /** Loudness integrado (LUFS) si tiene audio. */
  loudness: z.number().nullable().default(null),
  /** Fotogramas clave extraídos (ids de assets internos o rutas relativas en el storage). */
  keyframes: z.array(z.object({ t: z.number(), key: z.string() })).default([]),
  /** Posición horizontal del rostro principal por tiempo (0..1), para reencuadre. */
  faces: z.array(z.object({ t: z.number(), x: z.number(), y: z.number(), size: z.number() })).default([]),
  /** Descripción breve del contenido visual (la escribe un modelo barato). */
  description: z.string().default(""),
  /** Tiene voz (para transcribir). */
  hasSpeech: z.boolean().nullable().default(null),
  /**
   * Rol de la toma: a-roll = alguien habla (toma principal); b-roll = toma de apoyo sin voz principal
   * (paisaje, producto, detalle, ambiente); mixto = tiene partes de ambos.
   */
  role: z.enum(["a-roll", "b-roll", "mixto", "desconocido"]).default("desconocido"),
  /** Fragmentos aprovechables como b-roll (estables, sin voz, visualmente interesantes). */
  brollSegments: z
    .array(z.object({ start: z.number(), end: z.number(), score: z.number().min(0).max(1), description: z.string().default(""), tags: z.array(z.string()).default([]) }))
    .default([]),
});
export type AssetAnalysis = z.infer<typeof AssetAnalysis>;

export const Asset = z.object({
  id: z.string(),
  ownerId: z.string(),
  projectId: z.string().nullable(),
  category: AssetCategory,
  kind: MediaKind,
  originalName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  /** Clave en el almacenamiento (nunca una ruta absoluta). */
  storageKey: z.string(),
  probe: MediaProbe.default(MediaProbe.parse({})),
  analysis: AssetAnalysis.default(AssetAnalysis.parse({})),
  thumbnailKey: z.string().nullable().default(null),
  /** "debe aparecer" u "opcional" para videos de material en crudo. */
  priority: z.enum(["debe-aparecer", "opcional"]).default("opcional"),
  note: z.string().default(""),
  /** Orden manual dentro de su zona. */
  order: z.number().default(0),
  sha256: z.string().nullable().default(null),
  createdAt: Iso,
});
export type Asset = z.infer<typeof Asset>;

// ---------------------------------------------------------------------------
// Transcripción, glosario y palabras clave
// ---------------------------------------------------------------------------

export const TranscriptWord = z.object({
  /** Índice estable dentro de la transcripción. */
  i: z.number().int(),
  text: z.string(),
  start: z.number(),
  end: z.number(),
  probability: z.number().min(0).max(1).default(1),
  speaker: z.string().nullable().default(null),
  /** Marca del usuario desde el texto. */
  mark: z.enum(["quitar", "debe-ir", "resaltar"]).nullable().default(null),
  /** Texto original antes de una corrección manual o del glosario. */
  original: z.string().nullable().default(null),
  /** Es muletilla detectada. */
  filler: z.boolean().default(false),
});
export type TranscriptWord = z.infer<typeof TranscriptWord>;

export const Transcript = z.object({
  id: z.string(),
  ownerId: z.string(),
  projectId: z.string(),
  assetId: z.string(),
  language: z.string(),
  provider: z.string(),
  model: z.string(),
  status: z.enum(["pendiente", "transcribiendo", "listo", "error"]),
  error: z.string().nullable().default(null),
  words: z.array(TranscriptWord).default([]),
  /** Segmentos (frases) con índices de palabras. */
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string(), firstWord: z.number(), lastWord: z.number(), speaker: z.string().nullable().default(null) })).default([]),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Transcript = z.infer<typeof Transcript>;

export const GlossaryEntry = z.object({
  id: z.string(),
  ownerId: z.string(),
  /** Cómo debe escribirse (p. ej. "Zyra"). */
  term: z.string(),
  /** Variantes erróneas que se reemplazan (p. ej. "Sira", "Zaira"). */
  variants: z.array(z.string()).default([]),
  scope: z.enum(["global", "marca", "estilo", "proyecto"]).default("global"),
  scopeId: z.string().nullable().default(null),
  timesApplied: z.number().int().default(0),
  createdAt: Iso,
});
export type GlossaryEntry = z.infer<typeof GlossaryEntry>;

export const KeywordCategory = z.enum(["tema", "nombre", "cifra", "beneficio", "cta", "gancho", "otro"]);

export const Keyword = z.object({
  id: z.string(),
  text: z.string(),
  category: KeywordCategory.default("otro"),
  /** Origen: detectada por Claude/heurística o agregada por el usuario. */
  source: z.enum(["auto", "usuario"]).default("auto"),
  enabled: z.boolean().default(true),
  /** Apariciones en la transcripción: assetId + índice de palabra. */
  occurrences: z.array(z.object({ assetId: z.string(), wordIndex: z.number().int(), t: z.number() })).default([]),
  score: z.number().default(0),
});
export type Keyword = z.infer<typeof Keyword>;

export const PublishCopy = z.object({
  title: z.string().default(""),
  description: z.string().default(""),
  hashtags: z.array(z.string()).default([]),
  coverText: z.string().default(""),
});
export type PublishCopy = z.infer<typeof PublishCopy>;

// ---------------------------------------------------------------------------
// Trabajos (cola) y progreso
// ---------------------------------------------------------------------------

export const JobType = z.enum(["analizar", "transcribir", "generar", "corregir", "exportar", "estilo-ficha", "re-render"]);
export type JobType = z.infer<typeof JobType>;

/** Etapas visibles en el diagrama durante el PROCESO. */
export const PipelineStage = z.enum([
  "analizando",
  "transcribiendo",
  "planeando",
  "esperando-aprobacion",
  "generando-ia",
  "motion-graphics",
  "render",
  "revision-calidad",
  "listo",
]);
export type PipelineStage = z.infer<typeof PipelineStage>;

export const STAGE_LABELS: Record<PipelineStage, string> = {
  analizando: "Analizando material",
  transcribiendo: "Transcribiendo",
  planeando: "Planeando edición",
  "esperando-aprobacion": "Esperando tu aprobación del plan",
  "generando-ia": "Generando con IA",
  "motion-graphics": "Motion graphics",
  render: "Render",
  "revision-calidad": "Revisión de calidad",
  listo: "Listo",
};

export const Job = z.object({
  id: z.string(),
  ownerId: z.string(),
  projectId: z.string().nullable(),
  type: JobType,
  status: z.enum(["en-cola", "corriendo", "esperando", "listo", "error", "cancelado"]),
  stage: PipelineStage.nullable().default(null),
  /** 0..1 */
  progress: z.number().min(0).max(1).default(0),
  message: z.string().default(""),
  input: z.record(z.string(), z.unknown()).default({}),
  result: z.record(z.string(), z.unknown()).nullable().default(null),
  error: z.string().nullable().default(null),
  attempts: z.number().int().default(0),
  /** Estimación al crear el trabajo (segundos) para calcular restante. */
  estimatedSeconds: z.number().nullable().default(null),
  /** Tiempos reales por etapa (segundos) para recalibrar el estimador. */
  stageTimings: z.record(z.string(), z.number()).default({}),
  costUsd: z.number().default(0),
  createdAt: Iso,
  startedAt: Iso.nullable().default(null),
  finishedAt: Iso.nullable().default(null),
});
export type Job = z.infer<typeof Job>;

// ---------------------------------------------------------------------------
// Plan (storyboard) y versiones
// ---------------------------------------------------------------------------

export const PlanScene = z.object({
  id: z.string(),
  title: z.string(),
  start: z.number(),
  end: z.number(),
  clips: z.array(z.object({ assetId: z.string(), sourceIn: z.number(), sourceOut: z.number(), label: z.string().default("") })).default([]),
  onScreenText: z.array(z.string()).default([]),
  captions: z.string().default(""),
  music: z.string().default(""),
  graphics: z.array(z.string()).default([]),
  ai: z.array(z.object({ kind: z.string(), prompt: z.string(), model: z.string(), costUsd: z.number().nullable().default(null) })).default([]),
  notes: z.string().default(""),
});
export type PlanScene = z.infer<typeof PlanScene>;

export const Plan = z.object({
  id: z.string(),
  ownerId: z.string(),
  projectId: z.string(),
  jobId: z.string().nullable(),
  status: z.enum(["pendiente", "aprobado", "ajustando", "descartado"]),
  summary: z.string().default(""),
  scenes: z.array(PlanScene).default([]),
  /** Receta propuesta completa (lo que se renderiza al aprobar). */
  recipe: Recipe,
  estimatedCostUsd: z.number().default(0),
  feedback: z.array(z.object({ text: z.string(), at: Iso })).default([]),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Plan = z.infer<typeof Plan>;

export const RecipeChange = z.object({
  /** Ruta JSON Pointer del cambio. */
  path: z.string(),
  op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  /** Descripción humana en español. */
  label: z.string(),
  /** Área afectada para agrupar en la UI. */
  area: z.enum(["cortes", "texto", "subtitulos", "graficos", "audio", "estilo", "formato", "ia", "otro"]),
  /** true si fue consecuencia automática (p. ej. subtítulos recalculados por un corte). */
  derived: z.boolean().default(false),
});
export type RecipeChange = z.infer<typeof RecipeChange>;

export const Version = z.object({
  id: z.string(),
  ownerId: z.string(),
  projectId: z.string(),
  /** 1, 2, 3… dentro del proyecto. */
  number: z.number().int().positive(),
  parentId: z.string().nullable(),
  recipe: Recipe,
  /** Corrección escrita que originó esta versión (se muestra sobre la flecha). */
  correction: z.string().nullable().default(null),
  correctionAt: z.number().nullable().default(null),
  changes: z.array(RecipeChange).default([]),
  changeSummary: z.string().default(""),
  status: z.enum(["renderizando", "lista", "error"]),
  videoKey: z.string().nullable().default(null),
  posterKey: z.string().nullable().default(null),
  captionsSrtKey: z.string().nullable().default(null),
  captionsVttKey: z.string().nullable().default(null),
  publishCopy: PublishCopy.default(PublishCopy.parse({})),
  rating: z.enum(["arriba", "abajo"]).nullable().default(null),
  exported: z.boolean().default(false),
  qa: z.array(z.object({ check: z.string(), ok: z.boolean(), detail: z.string().default("") })).default([]),
  renderSeconds: z.number().nullable().default(null),
  costUsd: z.number().default(0),
  createdAt: Iso,
});
export type Version = z.infer<typeof Version>;

// ---------------------------------------------------------------------------
// Marcas, estilos y memoria
// ---------------------------------------------------------------------------

export const Brand = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  logoAssetIds: z.array(z.string()).default([]),
  fontAssetIds: z.array(z.string()).default([]),
  googleFonts: z.array(z.string()).default([]),
  colors: z.array(z.string()).default([]),
  introAssetId: z.string().nullable().default(null),
  outroAssetId: z.string().nullable().default(null),
  transitionAssetIds: z.array(z.string()).default([]),
  lowerThirdTemplateIds: z.array(z.string()).default([]),
  notes: z.string().default(""),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Brand = z.infer<typeof Brand>;

export const StyleInclude = z.object({
  marca: z.boolean().default(true),
  tipografias: z.boolean().default(true),
  colores: z.boolean().default(true),
  musica: z.boolean().default(false),
  transiciones: z.boolean().default(true),
  plantillasMotion: z.boolean().default(true),
  ritmo: z.boolean().default(true),
  subtitulos: z.boolean().default(true),
  introOutro: z.boolean().default(true),
  herramientas: z.boolean().default(true),
  instruccionBase: z.boolean().default(true),
});
export type StyleInclude = z.infer<typeof StyleInclude>;

export const MotionTemplate = z.object({
  id: z.string(),
  name: z.string(),
  engine: z.enum(["hyperframes", "builtin", "remotion"]),
  /** Para hyperframes: HTML de la composición con marcadores {{prop}}. */
  source: z.string().default(""),
  propsSchema: z.record(z.string(), z.object({ type: z.enum(["string", "number", "color", "boolean"]), default: z.unknown().optional(), label: z.string().default("") })).default({}),
  defaultDuration: z.number().default(3),
  description: z.string().default(""),
});
export type MotionTemplate = z.infer<typeof MotionTemplate>;

export const StylePreset = z.object({
  include: StyleInclude,
  settings: ProjectSettings.partial(),
  styleTokens: Recipe.shape.style,
  captionStyle: z.unknown().optional(),
  templates: z.array(MotionTemplate).default([]),
  /** Generaciones con IA reutilizables (prompts, modelos y semillas). */
  aiRecipes: z.array(z.object({ kind: z.string(), model: z.string(), prompt: z.string(), seed: z.number().nullable(), params: z.record(z.string(), z.unknown()).default({}) })).default([]),
  baseInstruction: z.string().default(""),
  assetIds: z.array(z.string()).default([]),
});
export type StylePreset = z.infer<typeof StylePreset>;

export const StyleVersion = z.object({
  id: z.string(),
  styleId: z.string(),
  number: z.number().int().positive(),
  preset: StylePreset,
  /** Ficha de reglas en markdown (también es el cuerpo del SKILL.md). */
  rulesMarkdown: z.string(),
  rules: z.array(z.string()).default([]),
  sourceProjectId: z.string().nullable(),
  sourceVersionId: z.string().nullable(),
  createdAt: Iso,
});
export type StyleVersion = z.infer<typeof StyleVersion>;

export const Style = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().default(""),
  currentVersion: z.number().int().positive(),
  thumbnailAssetId: z.string().nullable().default(null),
  timesUsed: z.number().int().default(0),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Style = z.infer<typeof Style>;

export const MemoryScope = z.enum(["global", "marca", "estilo", "proyecto"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

/** Comprobaciones automáticas que la revisión de calidad puede verificar sobre la receta. */
export const RuleCheck = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fuente-titulos"), family: z.string() }),
  z.object({ type: z.literal("fuente-subtitulos"), family: z.string() }),
  z.object({ type: z.literal("subtitulos-mayusculas"), value: z.boolean() }),
  z.object({ type: z.literal("sin-transicion"), transition: z.string() }),
  z.object({ type: z.literal("duracion-plano-max"), seconds: z.number() }),
  z.object({ type: z.literal("color-resaltado"), color: z.string() }),
  z.object({ type: z.literal("musica-volumen-max"), gainDb: z.number() }),
  z.object({ type: z.literal("texto-palabra"), wrong: z.string(), right: z.string() }),
  z.object({ type: z.literal("duracion-objetivo"), seconds: z.number(), mode: z.enum(["aproximada", "exacta"]) }),
]);
export type RuleCheck = z.infer<typeof RuleCheck>;

export const MemoryRule = z.object({
  id: z.string(),
  ownerId: z.string(),
  scope: MemoryScope,
  scopeId: z.string().nullable().default(null),
  text: z.string(),
  check: RuleCheck.nullable().default(null),
  source: z.object({
    type: z.enum(["correccion", "calificacion", "manual", "glosario", "palabras-clave", "plan", "exportacion"]),
    refId: z.string().nullable().default(null),
    excerpt: z.string().default(""),
  }),
  enabled: z.boolean().default(true),
  timesApplied: z.number().int().default(0),
  /** Cuántas veces el usuario pidió lo mismo (refuerzo). */
  strength: z.number().int().default(1),
  createdAt: Iso,
  updatedAt: Iso,
});
export type MemoryRule = z.infer<typeof MemoryRule>;

export const LearningMetrics = z.object({
  projects: z.number().int(),
  versions: z.number().int(),
  correctionsPerVideo: z.array(z.object({ projectId: z.string(), name: z.string(), corrections: z.number().int(), createdAt: Iso })),
  averageCorrectionsRecent: z.number(),
  averageCorrectionsPrevious: z.number(),
  rules: z.number().int(),
  glossaryTerms: z.number().int(),
});
export type LearningMetrics = z.infer<typeof LearningMetrics>;
