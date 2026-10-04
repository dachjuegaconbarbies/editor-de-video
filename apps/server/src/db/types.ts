/**
 * INTERFAZ DE PERSISTENCIA (Db / repositorios).
 *
 * Las rutas, la cola y el pipeline SOLO usan estas interfaces. Hoy hay una implementación con
 * SQLite (`node:sqlite`, ver `db/index.ts`); para pasar a Postgres (p. ej. al integrar con Zyra):
 *
 *   1. Crea `db/postgres.ts` que implemente `Db` con el mismo contrato (todas las funciones ya son
 *      asíncronas, pensadas para un driver como `pg`).
 *   2. Traduce `db/migrations.ts` (TEXT JSON → JSONB, INTEGER 0/1 → BOOLEAN, REAL → DOUBLE PRECISION).
 *   3. Las operaciones atómicas (`systemClaimNext`, `createNext`, `mutate` vía `update(fn)`) se
 *      implementan con `SELECT … FOR UPDATE SKIP LOCKED` / transacciones.
 *   4. Elige la implementación en `app.ts` según una variable de entorno (DATABASE_URL).
 *
 * Reglas del contrato:
 *  - TODA operación de usuario recibe `ownerId` y filtra por él (nunca se ve lo de otro dueño).
 *  - Las únicas excepciones son las funciones `system*` de la cola de trabajos (el trabajador del
 *    servidor procesa trabajos de todos los dueños) y están marcadas explícitamente.
 *  - Lo que se lee se valida con los esquemas zod de `@autoeditor/shared`.
 */
import { z } from "zod";
import type {
  Asset,
  Brand,
  Calibration,
  EstimateStage,
  GlossaryEntry,
  Job,
  Keyword,
  MemoryRule,
  Plan,
  Project,
  PublishCopy,
  Style,
  StyleVersion,
  Transcript,
  Version,
} from "@autoeditor/shared";

export type Scalar = string | number | boolean | null;

/** Filtro de igualdad por campo (un arreglo = "IN"). Solo campos escalares. */
export type Where<T> = { [K in keyof T & string]?: Scalar | readonly Scalar[] };

export interface ListOptions<T> {
  orderBy?: keyof T & string;
  desc?: boolean;
  limit?: number;
  offset?: number;
}

/** Repositorio genérico de una entidad con dueño. */
export interface OwnedRepo<T extends { id: string }> {
  create(ownerId: string, entity: T): Promise<T>;
  get(ownerId: string, id: string): Promise<T | null>;
  list(ownerId: string, where?: Where<T>, opts?: ListOptions<T>): Promise<T[]>;
  count(ownerId: string, where?: Where<T>): Promise<number>;
  /**
   * Actualiza (lectura-modificación-escritura atómica). `patch` puede ser un objeto parcial o una
   * función que recibe el valor actual. `updatedAt` se actualiza solo si la entidad lo tiene.
   */
  update(ownerId: string, id: string, patch: Partial<T> | ((current: T) => T)): Promise<T | null>;
  delete(ownerId: string, id: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Entidades propias del servidor (no viajan a la interfaz tal cual)
// ---------------------------------------------------------------------------

export const FeedbackKind = z.enum([
  "calificacion",
  "correccion",
  "exportacion",
  "descarte",
  "plan-aprobado",
  "plan-ajustado",
  "palabras-clave",
  "glosario",
]);
export type FeedbackKind = z.infer<typeof FeedbackKind>;

/** Señales de aprendizaje: calificaciones, correcciones, exportaciones, planes aprobados… */
export const Feedback = z.object({
  id: z.string(),
  ownerId: z.string(),
  projectId: z.string().nullable().default(null),
  versionId: z.string().nullable().default(null),
  kind: FeedbackKind,
  rating: z.enum(["arriba", "abajo"]).nullable().default(null),
  text: z.string().default(""),
  data: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
});
export type Feedback = z.infer<typeof Feedback>;

export interface KeywordsRecord {
  ownerId: string;
  projectId: string;
  keywords: Keyword[];
  publishCopy: PublishCopy | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Repositorios específicos
// ---------------------------------------------------------------------------

export type ProjectRepo = OwnedRepo<Project>;
export type AssetRepo = OwnedRepo<Asset>;
export type PlanRepo = OwnedRepo<Plan>;
export type StyleRepo = OwnedRepo<Style>;
export type BrandRepo = OwnedRepo<Brand>;
export type FeedbackRepo = OwnedRepo<Feedback>;

export interface TranscriptRepo extends OwnedRepo<Transcript> {
  getByAsset(ownerId: string, assetId: string): Promise<Transcript | null>;
}

export interface JobRepo extends OwnedRepo<Job> {
  /** Trabajo activo (en cola, corriendo o esperando) más reciente del proyecto. */
  activeForProject(ownerId: string, projectId: string): Promise<Job | null>;
  /** SISTEMA: toma atómicamente el trabajo en cola más antiguo de esos tipos y lo marca "corriendo". */
  systemClaimNext(types: readonly string[]): Promise<Job | null>;
  /** SISTEMA: lectura sin filtro de dueño (solo para el trabajador de la cola). */
  systemGet(id: string): Promise<Job | null>;
  /** SISTEMA: actualización sin filtro de dueño (solo para el trabajador de la cola). */
  systemUpdate(id: string, patch: Partial<Job> | ((current: Job) => Job)): Promise<Job | null>;
  /** SISTEMA: marca como error los trabajos en esos estados (p. ej. al reiniciar el servidor). */
  systemMarkInterrupted(statuses: Job["status"][], message: string): Promise<Job[]>;
}

export interface VersionRepo extends OwnedRepo<Version> {
  /** Crea la versión asignando `number` = siguiente del proyecto, de forma atómica. */
  createNext(ownerId: string, entity: Omit<Version, "number">): Promise<Version>;
  latest(ownerId: string, projectId: string): Promise<Version | null>;
  /** Conteos por proyecto (sin leer las recetas): versiones y cuántas nacieron de una corrección. */
  statsByProject(ownerId: string): Promise<Record<string, { versions: number; corrections: number }>>;
}

export interface StyleVersionRepo extends OwnedRepo<StyleVersion> {
  createNext(ownerId: string, entity: Omit<StyleVersion, "number">): Promise<StyleVersion>;
  getByNumber(ownerId: string, styleId: string, number: number): Promise<StyleVersion | null>;
}

export interface GlossaryRepo extends OwnedRepo<GlossaryEntry> {
  /** Suma `timesApplied` por id. */
  incrementApplied(ownerId: string, counts: Record<string, number>): Promise<void>;
}

export interface MemoryRuleRepo extends OwnedRepo<MemoryRule> {
  incrementApplied(ownerId: string, ids: readonly string[]): Promise<void>;
}

export interface KeywordsRepo {
  get(ownerId: string, projectId: string): Promise<KeywordsRecord | null>;
  put(ownerId: string, projectId: string, keywords: Keyword[], publishCopy?: PublishCopy | null): Promise<KeywordsRecord>;
}

export interface CalibrationRepo {
  /**
   * Factores por etapa para un dueño. Si el dueño aún no tiene muestras de una etapa, se usa la
   * calibración del servidor (la velocidad de la máquina es común a todos).
   */
  get(ownerId: string): Promise<Calibration>;
  /** Registra un tiempo real medido (actualiza la del dueño y la del servidor). */
  record(ownerId: string, stage: EstimateStage, estimatedSeconds: number, actualSeconds: number): Promise<{ factor: number; samples: number }>;
}

export interface KvRepo {
  get<T = unknown>(ownerId: string, key: string): Promise<T | null>;
  set(ownerId: string, key: string, value: unknown): Promise<void>;
  delete(ownerId: string, key: string): Promise<void>;
}

export interface Db {
  readonly kind: "sqlite" | "postgres";
  projects: ProjectRepo;
  assets: AssetRepo;
  transcripts: TranscriptRepo;
  keywords: KeywordsRepo;
  jobs: JobRepo;
  plans: PlanRepo;
  versions: VersionRepo;
  styles: StyleRepo;
  styleVersions: StyleVersionRepo;
  brands: BrandRepo;
  rules: MemoryRuleRepo;
  glossary: GlossaryRepo;
  feedback: FeedbackRepo;
  calibration: CalibrationRepo;
  kv: KvRepo;
  close(): Promise<void>;
}
