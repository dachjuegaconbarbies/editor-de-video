/**
 * Contrato de la API REST (prefijo /api/v1) y eventos en vivo (SSE).
 * El frontend y cualquier integración (p. ej. el backend de Zyra) usan estos tipos.
 *
 * Autenticación/propietario: el servidor toma el dueño del header `X-Owner-Id`
 * (o del token de la app anfitriona vía un adaptador). En local, por defecto es "local".
 */
import { z } from "zod";
import { AssetCategory, Brand, Job, Keyword, PipelineStage, Plan, Project, PublishCopy, StyleInclude, Transcript, Version } from "./entities.js";
import type { Asset, GlossaryEntry, MemoryRule, Style, StyleVersion } from "./entities.js";
import { ExportQuality } from "./formats.js";
import { ProjectSettings } from "./settings.js";
import type { Estimate, MaterialSummary } from "./estimator.js";

export const API_PREFIX = "/api/v1";

/** Lista de rutas (documentación viva; la fuente formal es /api/v1/openapi.json). */
export const ROUTES = {
  health: "GET /health",
  config: "GET /config",
  listProjects: "GET /projects",
  createProject: "POST /projects",
  getProject: "GET /projects/:projectId",
  updateProject: "PATCH /projects/:projectId",
  deleteProject: "DELETE /projects/:projectId",
  uploadAsset: "POST /projects/:projectId/assets (multipart: file, category)",
  listAssets: "GET /projects/:projectId/assets",
  updateAsset: "PATCH /assets/:assetId",
  deleteAsset: "DELETE /assets/:assetId",
  assetFile: "GET /assets/:assetId/file (soporta Range)",
  assetThumbnail: "GET /assets/:assetId/thumbnail",
  assetFrame: "GET /assets/:assetId/frame?t=segundos",
  transcripts: "GET /projects/:projectId/transcripts",
  updateTranscriptWords: "PATCH /transcripts/:transcriptId/words",
  keywords: "GET /projects/:projectId/keywords",
  putKeywords: "PUT /projects/:projectId/keywords",
  detectKeywords: "POST /projects/:projectId/keywords/detect",
  estimate: "POST /projects/:projectId/estimate",
  generate: "POST /projects/:projectId/generate",
  plan: "GET /plans/:planId",
  approvePlan: "POST /plans/:planId/approve",
  revisePlan: "POST /plans/:planId/revise",
  job: "GET /jobs/:jobId",
  cancelJob: "POST /jobs/:jobId/cancel",
  retryJob: "POST /jobs/:jobId/retry",
  events: "GET /projects/:projectId/events (SSE)",
  versions: "GET /projects/:projectId/versions",
  version: "GET /versions/:versionId",
  versionVideo: "GET /versions/:versionId/video (Range)",
  correct: "POST /versions/:versionId/corrections",
  rate: "POST /versions/:versionId/rating",
  compare: "GET /versions/compare?a=:id&b=:id",
  exportVersion: "POST /versions/:versionId/export",
  download: "GET /versions/:versionId/download?type=mp4|srt|vtt|txt|copy&quality=1080",
  restoreVersion: "POST /versions/:versionId/restore",
  styles: "GET /styles",
  createStyle: "POST /styles",
  style: "GET /styles/:styleId",
  updateStyle: "POST /styles/:styleId/versions",
  exportStyle: "GET /styles/:styleId/export (zip con SKILL.md)",
  importStyle: "POST /styles/import (multipart zip)",
  deleteStyle: "DELETE /styles/:styleId",
  brands: "GET|POST /brands, GET|PATCH|DELETE /brands/:brandId",
  rules: "GET|POST /memory/rules, PATCH|DELETE /memory/rules/:ruleId",
  glossary: "GET|POST /memory/glossary, DELETE /memory/glossary/:entryId",
  metrics: "GET /memory/metrics",
  // Extras (aditivos): volver a transcribir un archivo, portada de una versión y especificación OpenAPI.
  retranscribe: "POST /assets/:assetId/transcribe",
  versionPoster: "GET /versions/:versionId/poster",
  openapi: "GET /openapi.json (documentación interactiva en /docs)",
} as const;

// ---------------------------------------------------------------------------
// Peticiones
// ---------------------------------------------------------------------------

export const CreateProjectBody = z.object({
  name: z.string().min(1).max(200).default("Proyecto sin título"),
  /** Arrancar desde un estilo guardado. */
  styleId: z.string().nullable().optional(),
  settings: ProjectSettings.partial().optional(),
});
export type CreateProjectBody = z.input<typeof CreateProjectBody>;

export const UpdateProjectBody = z.object({
  name: z.string().min(1).max(200).optional(),
  settings: ProjectSettings.optional(),
  currentVersionId: z.string().nullable().optional(),
});
export type UpdateProjectBody = z.input<typeof UpdateProjectBody>;

export const UploadAssetFields = z.object({ category: AssetCategory });

export const UpdateAssetBody = z.object({
  note: z.string().max(2000).optional(),
  priority: z.enum(["debe-aparecer", "opcional"]).optional(),
  order: z.number().optional(),
  category: AssetCategory.optional(),
});
export type UpdateAssetBody = z.input<typeof UpdateAssetBody>;

export const UpdateTranscriptWordsBody = z.object({
  edits: z.array(
    z.object({
      i: z.number().int(),
      text: z.string().optional(),
      mark: z.enum(["quitar", "debe-ir", "resaltar"]).nullable().optional(),
    }),
  ),
  /** Guardar las correcciones de texto en el glosario para futuros videos. */
  saveToGlossary: z.boolean().default(true),
});
export type UpdateTranscriptWordsBody = z.input<typeof UpdateTranscriptWordsBody>;

export const PutKeywordsBody = z.object({ keywords: z.array(Keyword) });

export const GenerateBody = z.object({
  /** Si viene, sobrescribe la configuración guardada (normalmente no hace falta). */
  settings: ProjectSettings.optional(),
});

export const RevisePlanBody = z.object({ feedback: z.string().min(1).max(4000) });

export const CorrectionBody = z.object({
  text: z.string().min(1).max(4000),
  /** Momento del video (segundos) al que se ancla la corrección, si se tocó el reproductor. */
  at: z.number().min(0).nullable().optional(),
  /** Recordar como regla: null = preguntar después; o el alcance elegido. */
  remember: z.enum(["no", "proyecto", "estilo", "siempre"]).nullable().optional(),
});
export type CorrectionBody = z.input<typeof CorrectionBody>;

export const RatingBody = z.object({ rating: z.enum(["arriba", "abajo"]).nullable(), comment: z.string().max(2000).optional() });

export const ExportBody = z.object({
  quality: ExportQuality.default("1080"),
  includeSrt: z.boolean().default(true),
  includeVtt: z.boolean().default(true),
  burnCaptions: z.boolean().default(true),
});

export const CreateStyleBody = z.object({
  versionId: z.string(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  include: StyleInclude.default(StyleInclude.parse({})),
});
export type CreateStyleBody = z.input<typeof CreateStyleBody>;

export const UpdateStyleBody = z.object({
  versionId: z.string(),
  include: StyleInclude.optional(),
  /** true = actualizar el estilo existente; false = crear uno nuevo con este nombre. */
  asNew: z.boolean().default(false),
  name: z.string().optional(),
});

export const RuleBody = z.object({
  text: z.string().min(1).max(500),
  scope: z.enum(["global", "marca", "estilo", "proyecto"]).default("global"),
  scopeId: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
});

export const GlossaryBody = z.object({
  term: z.string().min(1).max(120),
  variants: z.array(z.string()).default([]),
  scope: z.enum(["global", "marca", "estilo", "proyecto"]).default("global"),
  scopeId: z.string().nullable().default(null),
});

export const BrandBody = Brand.omit({ id: true, ownerId: true, createdAt: true, updatedAt: true }).partial().extend({ name: z.string().min(1) });

// ---------------------------------------------------------------------------
// Respuestas
// ---------------------------------------------------------------------------

/** Configuración pública que el frontend necesita (NUNCA incluye llaves). */
export interface PublicConfig {
  version: string;
  demoMode: boolean;
  capabilities: {
    claude: boolean;
    kie: boolean;
    transcription: { provider: string; ready: boolean; detail: string };
    hyperframes: { ready: boolean; detail: string };
    remotion: { ready: boolean; detail: string };
    ffmpeg: { ready: boolean; version: string };
  };
  models: { editor: string; helper: string; available: { id: string; label: string }[] };
  kieModels: { id: string; label: string; kind: string; costUsd: number; enabled: boolean; verified: boolean }[];
  estimator: { coefficients: Record<string, number>; calibration: Record<string, { factor: number; samples: number }> };
  pricing: {
    editorModel: { inputUsdPerMTok: number; outputUsdPerMTok: number; cacheReadUsdPerMTok: number };
    helperModel: { inputUsdPerMTok: number; outputUsdPerMTok: number; cacheReadUsdPerMTok: number };
    kieDefaults: { imagen: string; video: string; musica: string; voz: string; sfx: string };
  };
  limits: { maxUploadBytes: number };
}

export interface ProjectDetail {
  project: Project;
  assets: import("./entities.js").Asset[];
  versions: Version[];
  activeJob: Job | null;
  pendingPlan: Plan | null;
}

/** Aviso antes de generar (p. ej. "pides 60 s y solo hay 20 s de material"). */
export interface EstimateWarning {
  code: string;
  level: "info" | "aviso";
  message: string;
}

export interface EstimateResponse extends Estimate {
  /** Avisos de cosas que no cuadran (duración vs. material, b-roll sin tomas de apoyo…). */
  warnings?: EstimateWarning[];
  /** Resumen del material con el que se calculó (incluye lo detectado como b-roll). */
  material?: MaterialSummary & {
    /** Segundos aprovechables como b-roll (fragmentos detectados + tomas completas de b-roll). */
    brollSeconds: number;
    aRollAssets: number;
    bRollAssets: number;
    /** Segundos de material utilizable en total (video + fotos), para comparar con la duración pedida. */
    availableSeconds: number;
  };
}

// Respuestas de listas: siempre envueltas en un objeto con nombre (permite agregar paginación sin romper).
export interface ProjectListItem extends Project {
  assetCount: number;
  versionCount: number;
  /** Asset cuya miniatura representa al proyecto (null si aún no hay). */
  coverAssetId: string | null;
}
export interface ProjectsResponse {
  projects: ProjectListItem[];
}
export interface AssetsResponse {
  assets: Asset[];
}
export interface VersionsResponse {
  versions: Version[];
}
export interface StylesResponse {
  styles: Style[];
}
export interface StyleDetail {
  style: Style;
  versions: StyleVersion[];
  /** Trabajo en curso (p. ej. Claude escribiendo la ficha de reglas), si lo hay. */
  job?: Job | null;
}
export interface BrandsResponse {
  brands: Brand[];
}
export interface RulesResponse {
  rules: MemoryRule[];
}
export interface GlossaryResponse {
  entries: GlossaryEntry[];
}

export interface CompareResponse {
  a: Version;
  b: Version;
  changes: import("./entities.js").RecipeChange[];
  summary: string;
}

export interface TranscriptsResponse {
  transcripts: Transcript[];
}

export interface KeywordsResponse {
  keywords: Keyword[];
  publishCopy: PublishCopy | null;
}

export interface ApiError {
  error: string;
  /** Mensaje en español para mostrar al usuario. */
  message: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Eventos en vivo (SSE): GET /projects/:projectId/events
// ---------------------------------------------------------------------------

export type ServerEvent =
  | { type: "job.updated"; job: Job }
  | { type: "job.stage"; jobId: string; stage: PipelineStage; message: string; progress: number }
  | { type: "asset.updated"; asset: import("./entities.js").Asset }
  | { type: "transcript.updated"; transcript: Transcript }
  | { type: "keywords.updated"; keywords: Keyword[] }
  | { type: "plan.ready"; plan: Plan }
  | { type: "version.created"; version: Version }
  | { type: "version.updated"; version: Version }
  | { type: "project.updated"; project: Project }
  | { type: "rule.suggested"; suggestion: { text: string; versionId: string; correction: string } }
  | { type: "ping"; at: string };
