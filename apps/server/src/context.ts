/**
 * Contexto de la aplicación: todo lo que las rutas, la cola y el pipeline necesitan, inyectado.
 * Aquí viven también las interfaces de alto nivel que usan las rutas:
 *   - PipelineApi (pipeline/): análisis al subir, generar, plan, corregir, exportar, restaurar.
 *   - StyleApi    (styles/):   guardar/actualizar estilo, exportar/importar zip, settings desde un estilo.
 *   - MemoryApi   (memory/):   reglas aprendidas, glosario y métricas de aprendizaje.
 */
import type {
  Asset,
  CorrectionBody,
  CreateStyleBody,
  ExportBody,
  Job,
  KeywordsResponse,
  LearningMetrics,
  MemoryRule,
  Project,
  ProjectSettings,
  RuleCheck,
  StyleDetail,
  StyleVersion,
  UpdateStyleBody,
} from "@autoeditor/shared";
import type { z } from "zod";
import type { OwnerResolver, Scrubber } from "./auth/index.js";
import type { AppConfig } from "./config/index.js";
import type { Db } from "./db/types.js";
import type { Env } from "./env.js";
import type { EventBus } from "./events/bus.js";
import type { JobQueue } from "./jobs/queue.js";
import type { Log, Services } from "./services/types.js";

// Cuerpos ya validados (con valores por defecto aplicados).
export type CorrectionInput = z.output<typeof CorrectionBody>;
export type ExportInput = z.output<typeof ExportBody>;
export type CreateStyleInput = z.output<typeof CreateStyleBody>;
export type UpdateStyleInput = z.output<typeof UpdateStyleBody>;

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface PipelineApi {
  /**
   * Se llama en segundo plano después de guardar un archivo subido: probe + miniatura y, para
   * video/voz, análisis completo (escenas, silencios, rostros, A-roll/B-roll y fragmentos de b-roll)
   * y transcripción. Nunca debe romper la subida: los fallos quedan en `asset.analysis`.
   */
  onAssetUploaded(ownerId: string, asset: Asset): Promise<void>;
  /** Vuelve a transcribir un archivo (p. ej. después de corregir el glosario). */
  retranscribe(ownerId: string, assetId: string): Promise<Job>;
  /** Detecta palabras clave y texto para publicar con el editor (Claude o demo). */
  detectKeywords(ownerId: string, projectId: string): Promise<KeywordsResponse>;
  /** Arranca la generación (V1): plan → (aprobación) → IA → motion → render → revisión. */
  generate(ownerId: string, projectId: string): Promise<Job>;
  approvePlan(ownerId: string, planId: string): Promise<Job>;
  revisePlan(ownerId: string, planId: string, feedback: string): Promise<Job>;
  /** Corrección con texto sobre una versión → nueva versión (parche mínimo). */
  correct(ownerId: string, versionId: string, body: CorrectionInput): Promise<Job>;
  exportVersion(ownerId: string, versionId: string, body: ExportInput): Promise<Job>;
  /** Vuelve a una versión anterior (queda como versión actual del proyecto). */
  restoreVersion(ownerId: string, versionId: string): Promise<Project>;
}

// ---------------------------------------------------------------------------
// Estilos
// ---------------------------------------------------------------------------

export interface StyleApi {
  create(ownerId: string, body: CreateStyleInput): Promise<StyleDetail>;
  update(ownerId: string, styleId: string, body: UpdateStyleInput): Promise<StyleDetail>;
  /** Zip con SKILL.md + preset.json + assets + plantillas. */
  exportZip(ownerId: string, styleId: string): Promise<{ filename: string; stream: NodeJS.ReadableStream }>;
  importZip(ownerId: string, filePath: string): Promise<StyleDetail>;
  /** Settings iniciales de un proyecto nuevo que arranca desde un estilo (todo editable). */
  settingsForNewProject(ownerId: string, styleId: string): Promise<{ settings: ProjectSettings; styleVersion: StyleVersion }>;
}

// ---------------------------------------------------------------------------
// Memoria (aprendizaje)
// ---------------------------------------------------------------------------

/** Contexto para saber qué capas de memoria aplican (global + marca + estilo + proyecto). */
export interface MemoryScopeContext {
  projectId?: string | null;
  styleId?: string | null;
  brandId?: string | null;
}

export interface LearnFromCorrectionInput {
  projectId: string;
  versionId: string;
  correction: string;
  /** Lo que eligió la persona: null = preguntar después (se emite `rule.suggested`). */
  remember: CorrectionInput["remember"];
  suggestion: { text: string; check: RuleCheck | null } | null;
  styleId: string | null;
  brandId?: string | null;
}

export interface RatingInput {
  projectId: string;
  versionId: string;
  rating: "arriba" | "abajo" | null;
  comment?: string;
}

/** Palabra a la que se le puede aplicar el glosario (TranscriptWord o RawTranscriptWord). */
export interface GlossaryWord {
  text: string;
  original?: string | null;
}

export interface MemoryApi {
  /** Reglas activas que aplican a ese contexto, de la más fuerte a la más débil. */
  rulesFor(ownerId: string, scope: MemoryScopeContext): Promise<MemoryRule[]>;
  learnFromCorrection(ownerId: string, input: LearnFromCorrectionInput): Promise<MemoryRule | null>;
  onRating(ownerId: string, input: RatingInput): Promise<void>;
  /** Reemplaza variantes erróneas por el término correcto (guarda `original`). */
  applyGlossary<T extends GlossaryWord>(ownerId: string, words: T[], scopes: MemoryScopeContext): Promise<{ words: T[]; replacements: number }>;
  metrics(ownerId: string): Promise<LearningMetrics>;
}

// ---------------------------------------------------------------------------
// Contexto
// ---------------------------------------------------------------------------

export interface AppContext {
  env: Env;
  config: AppConfig;
  db: Db;
  services: Services;
  queue: JobQueue;
  events: EventBus;
  pipeline: PipelineApi;
  styles: StyleApi;
  memory: MemoryApi;
  resolveOwner: OwnerResolver;
  /** Limpia textos que salen al usuario (sin llaves ni rutas absolutas). */
  scrub: Scrubber;
  log: Log;
}

/** Contexto antes de armar pipeline/estilos/memoria (las fábricas lo reciben ya completo). */
export type CoreContext = Omit<AppContext, "pipeline" | "styles" | "memory">;
