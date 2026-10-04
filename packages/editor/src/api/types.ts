/**
 * Interfaz del cliente de API. La implementan el cliente HTTP real (`createApiClient`) y el
 * cliente de demostración en memoria (`createDemoApi`), así la interfaz no sabe cuál usa.
 * Hay una función por cada ruta de `ROUTES` (@autoeditor/shared/api).
 */
import type {
  Asset,
  AssetCategory,
  Brand,
  CompareResponse,
  CorrectionBody,
  CreateProjectBody,
  CreateStyleBody,
  EstimateResponse,
  GlossaryEntry,
  Job,
  Keyword,
  KeywordsResponse,
  LearningMetrics,
  MemoryRule,
  Plan,
  Project,
  ProjectDetail,
  ProjectSettings,
  PublicConfig,
  ServerEvent,
  Style,
  StyleVersion,
  Transcript,
  UpdateAssetBody,
  UpdateProjectBody,
  UpdateTranscriptWordsBody,
  Version,
} from "@autoeditor/shared";
import type { BrandBody, ExportBody, GlossaryBody, RatingBody, RuleBody, UpdateStyleBody } from "@autoeditor/shared";

/** Tipo de entrada de un esquema zod (equivale a `z.input<T>` sin depender de zod aquí). */
type InputOf<T extends { _zod: { input: unknown } }> = T["_zod"]["input"];

export type HeadersInput = Record<string, string> | (() => Record<string, string>);

export interface ApiClientOptions {
  /** Prefijo de la API, p. ej. "/api/v1" o "https://zyra.app/editor/api/v1". */
  baseUrl: string;
  /** Dueño (se manda como X-Owner-Id). En local, por defecto "local" lo decide el servidor. */
  ownerId?: string;
  /** Encabezados extra (p. ej. token de la app anfitriona). Puede ser una función para tokens que cambian. */
  headers?: HeadersInput;
  /** fetch alternativo (pruebas o SSR). */
  fetch?: typeof fetch;
}

export interface UploadOptions {
  onProgress?: (fraction: number, loaded: number, total: number) => void;
  signal?: AbortSignal;
}

export type StreamStatus = "conectando" | "conectado" | "reconectando" | "cerrado";

export interface SubscribeOptions {
  onEvent: (event: ServerEvent) => void;
  onStatus?: (status: StreamStatus) => void;
  /** Se llama al reconectar después de una caída (conviene volver a pedir el estado completo). */
  onReconnect?: () => void;
}

export interface EventSubscription {
  close(): void;
}

export type DownloadType = "mp4" | "srt" | "vtt" | "txt" | "copy";

export type RatingInput = InputOf<typeof RatingBody>;
export type ExportInput = InputOf<typeof ExportBody>;
export type UpdateStyleInput = InputOf<typeof UpdateStyleBody>;
export type RuleInput = InputOf<typeof RuleBody>;
export type GlossaryInput = InputOf<typeof GlossaryBody>;
export type BrandInput = InputOf<typeof BrandBody>;

export interface StyleDetail {
  style: Style;
  versions: StyleVersion[];
}

export interface ApiClient {
  readonly baseUrl: string;
  /** true para el cliente de demostración en memoria. */
  readonly isDemo: boolean;

  // Sistema
  health(): Promise<{ ok: boolean }>;
  getConfig(): Promise<PublicConfig>;

  // Proyectos
  listProjects(): Promise<Project[]>;
  createProject(body: CreateProjectBody): Promise<Project>;
  getProject(projectId: string): Promise<ProjectDetail>;
  updateProject(projectId: string, body: UpdateProjectBody): Promise<Project>;
  deleteProject(projectId: string): Promise<void>;

  // Archivos
  uploadAsset(projectId: string, file: File, category: AssetCategory, options?: UploadOptions): Promise<Asset>;
  listAssets(projectId: string): Promise<Asset[]>;
  updateAsset(assetId: string, body: UpdateAssetBody): Promise<Asset>;
  deleteAsset(assetId: string): Promise<void>;
  assetFileUrl(asset: Asset | string): string;
  assetThumbnailUrl(asset: Asset | string): string | null;
  assetFrameUrl(asset: Asset | string, t: number): string;

  // Transcripción y palabras clave
  listTranscripts(projectId: string): Promise<Transcript[]>;
  updateTranscriptWords(transcriptId: string, body: UpdateTranscriptWordsBody): Promise<Transcript>;
  /** Vuelve a transcribir un archivo (POST /assets/:assetId/transcribe → trabajo "transcribir"). */
  retranscribe(assetId: string): Promise<Job>;
  getKeywords(projectId: string): Promise<KeywordsResponse>;
  putKeywords(projectId: string, keywords: Keyword[]): Promise<Keyword[]>;
  detectKeywords(projectId: string): Promise<KeywordsResponse>;

  // Generar, plan y trabajos
  /** Con `settings`, estima esa configuración sin guardarla (para recalcular al prender/apagar cosas). */
  estimate(projectId: string, settings?: ProjectSettings): Promise<EstimateResponse>;
  generate(projectId: string): Promise<Job>;
  getPlan(planId: string): Promise<Plan>;
  approvePlan(planId: string): Promise<Job>;
  revisePlan(planId: string, feedback: string): Promise<Job>;
  getJob(jobId: string): Promise<Job>;
  cancelJob(jobId: string): Promise<Job>;
  retryJob(jobId: string): Promise<Job>;
  subscribe(projectId: string, options: SubscribeOptions): EventSubscription;

  // Versiones
  listVersions(projectId: string): Promise<Version[]>;
  getVersion(versionId: string): Promise<Version>;
  versionVideoUrl(version: Version | string): string | null;
  /** Imagen fija de la versión si existe (en el servidor real, el primer fotograma del video). */
  versionPosterUrl(version: Version): string | null;
  correct(versionId: string, body: CorrectionBody): Promise<Job>;
  rate(versionId: string, body: RatingInput): Promise<Version>;
  compare(aVersionId: string, bVersionId: string): Promise<CompareResponse>;
  exportVersion(versionId: string, body?: ExportInput): Promise<Job>;
  downloadUrl(versionId: string, type: DownloadType, quality?: "720" | "1080" | "2160"): string;
  restoreVersion(versionId: string): Promise<Project>;

  // Estilos
  listStyles(): Promise<Style[]>;
  createStyle(body: CreateStyleBody): Promise<Style>;
  getStyle(styleId: string): Promise<StyleDetail>;
  updateStyle(styleId: string, body: UpdateStyleInput): Promise<Style>;
  exportStyleUrl(styleId: string): string;
  importStyle(file: File, options?: UploadOptions): Promise<Style>;
  deleteStyle(styleId: string): Promise<void>;

  // Marcas
  listBrands(): Promise<Brand[]>;
  createBrand(body: BrandInput): Promise<Brand>;
  getBrand(brandId: string): Promise<Brand>;
  updateBrand(brandId: string, body: Partial<BrandInput>): Promise<Brand>;
  deleteBrand(brandId: string): Promise<void>;

  // Memoria (lo que Claude aprendió)
  listRules(): Promise<MemoryRule[]>;
  createRule(body: RuleInput): Promise<MemoryRule>;
  updateRule(ruleId: string, body: Partial<RuleInput>): Promise<MemoryRule>;
  deleteRule(ruleId: string): Promise<void>;
  listGlossary(): Promise<GlossaryEntry[]>;
  createGlossaryEntry(body: GlossaryInput): Promise<GlossaryEntry>;
  deleteGlossaryEntry(entryId: string): Promise<void>;
  getMetrics(): Promise<LearningMetrics>;
}
