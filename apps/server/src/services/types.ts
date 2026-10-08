/**
 * CONTRATOS INTERNOS DEL SERVIDOR.
 *
 * Cada módulo (almacenamiento, análisis, transcripción, render, motion graphics, IA generativa,
 * cerebro editor) implementa una de estas interfaces en su carpeta. `services/container.ts` los
 * arma según la configuración (real o modo demo). Las rutas y el pipeline SOLO dependen de estas
 * interfaces, nunca de implementaciones concretas — así se puede cambiar ffmpeg, Kie AI, el
 * proveedor de transcripción o la base de datos sin tocar el resto.
 */
import type {
  AiRequest,
  Asset,
  AssetAnalysis,
  Brand,
  ExportQuality,
  GlossaryEntry,
  KieModelConfig,
  Keyword,
  MediaProbe,
  MemoryRule,
  MotionTemplate,
  PlanScene,
  Project,
  ProjectSettings,
  PublishCopy,
  Recipe,
  RecipeChange,
  RuleCheck,
  StyleVersion,
  Transcript,
} from "@autoeditor/shared";
import type { MaterialMap } from "../ai/shared/material-map.js";

// ---------------------------------------------------------------------------
// Utilidades comunes
// ---------------------------------------------------------------------------

export interface Log {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

/** Progreso de 0 a 1 con mensaje opcional en español. */
export type ProgressFn = (progress: number, message?: string) => void;

export interface RunOptions {
  signal?: AbortSignal;
  onProgress?: ProgressFn;
}

/** Disponibilidad de una capacidad (se muestra en la UI y en /config). */
export interface Availability {
  ready: boolean;
  detail: string;
}

/** Error con mensaje para el usuario en español y código estable. */
export class UserFacingError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(userMessage);
    this.name = "UserFacingError";
  }
}

// ---------------------------------------------------------------------------
// Almacenamiento de archivos (local ahora; S3 u otro después)
// ---------------------------------------------------------------------------

export interface StoredFile {
  key: string;
  sizeBytes: number;
  sha256: string;
}

export interface StorageAdapter {
  /** Construye una clave relativa segura (sin "..", sin rutas absolutas). */
  key(...parts: string[]): string;
  put(key: string, data: Buffer | NodeJS.ReadableStream): Promise<StoredFile>;
  /** Copia (o mueve) un archivo local al almacenamiento. */
  putFile(key: string, srcPath: string, opts?: { move?: boolean }): Promise<StoredFile>;
  createReadStream(key: string, range?: { start: number; end?: number }): NodeJS.ReadableStream;
  stat(key: string): Promise<{ sizeBytes: number; mtimeMs: number } | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  /**
   * Ruta local para herramientas que necesitan archivos en disco (ffmpeg, Python).
   * En un adaptador remoto descargaría a un caché temporal.
   */
  localPath(key: string): Promise<string>;
  /** Directorio temporal de trabajo (se limpia con cleanup()). */
  tempDir(prefix: string): Promise<{ path: string; cleanup: () => Promise<void> }>;
}

// ---------------------------------------------------------------------------
// Análisis de medios
// ---------------------------------------------------------------------------

export interface KeyframeFile {
  t: number;
  /** Clave en el almacenamiento del JPG extraído. */
  key: string;
}

export interface MediaAnalyzer {
  available(): Promise<Availability & { version: string }>;
  probe(filePath: string): Promise<MediaProbe>;
  /** Miniatura JPG (para imagen o video). */
  thumbnail(filePath: string, probe: MediaProbe, outPath: string): Promise<void>;
  /** Fotograma JPG en el segundo `t` (ancho opcional para ahorrar tokens). */
  frameAt(filePath: string, t: number, outPath: string, opts?: { width?: number }): Promise<void>;
  /**
   * Análisis completo: escenas, silencios, loudness, fotogramas clave, rostros, si hay voz.
   * Los fotogramas clave se guardan con `saveKeyframe` y se devuelven sus claves.
   */
  analyze(
    input: { asset: Asset; filePath: string; probe: MediaProbe; saveKeyframe: (t: number, jpgPath: string) => Promise<string> },
    opts?: RunOptions,
  ): Promise<AssetAnalysis>;
}

// ---------------------------------------------------------------------------
// Transcripción
// ---------------------------------------------------------------------------

export interface RawTranscriptWord {
  text: string;
  start: number;
  end: number;
  probability: number;
  speaker?: string | null;
}

export interface RawTranscript {
  language: string;
  words: RawTranscriptWord[];
  segments: { start: number; end: number; text: string; firstWord: number; lastWord: number; speaker?: string | null }[];
}

export interface Transcriber {
  readonly provider: string;
  readonly model: string;
  available(): Promise<Availability>;
  /**
   * `hotwords`: términos del glosario para sesgar el reconocimiento (nombres, marcas).
   * `language`: "auto" o código ISO (es, en…).
   */
  transcribe(filePath: string, opts: RunOptions & { language?: string; hotwords?: string[]; diarization?: boolean }): Promise<RawTranscript>;
}

// ---------------------------------------------------------------------------
// Render (ffmpeg) y motion graphics
// ---------------------------------------------------------------------------

export interface ResolvedAsset {
  asset: Asset;
  path: string;
}

export interface RenderContext {
  resolveAsset(assetId: string): Promise<ResolvedAsset>;
  /** Carpeta con las fuentes .ttf/.otf disponibles para subtítulos y textos. */
  fontsDir: string;
  /** Carpeta de trabajo temporal (cachés intermedios). */
  workDir: string;
  log: Log;
}

export interface RenderOutput {
  outPath: string;
  durationSeconds: number;
  renderSeconds: number;
  /** Comando(s) ffmpeg usados, para depurar y reproducir. */
  commands: string[];
}

export interface Renderer {
  available(): Promise<Availability & { version: string }>;
  /** Render completo y determinista de la receta. */
  render(recipe: Recipe, ctx: RenderContext, opts: RunOptions & { outPath: string; quality: ExportQuality; burnCaptions: boolean }): Promise<RenderOutput>;
  /** Un solo fotograma de la receta en el segundo `t` (con textos y subtítulos), para revisión de calidad. */
  renderFrame(recipe: Recipe, ctx: RenderContext, t: number, outPath: string, opts?: { width?: number }): Promise<void>;
  /** Imagen de portada. */
  poster(videoPath: string, outPath: string, t?: number): Promise<void>;
  /** Archivos de subtítulos sueltos. */
  captionFiles(recipe: Recipe): { srt: string; vtt: string; txt: string };
}

export interface MotionRenderInput {
  template: MotionTemplate;
  props: Record<string, unknown>;
  duration: number;
  width: number;
  height: number;
  fps: number;
  outPath: string;
  /** Fuentes disponibles (familia → ruta local) para inyectar en el HTML. */
  fonts?: { family: string; path: string }[];
}

export interface MotionEngine {
  readonly id: "hyperframes" | "builtin" | "remotion";
  available(): Promise<Availability>;
  /** Renderiza un gráfico a un clip (idealmente con canal alfa) listo para superponer. */
  renderGraphic(input: MotionRenderInput, opts?: RunOptions): Promise<{ path: string; hasAlpha: boolean; seconds: number }>;
  /** Plantillas incluidas de fábrica. */
  builtinTemplates(): MotionTemplate[];
}

// ---------------------------------------------------------------------------
// IA generativa (Kie AI u otro proveedor)
// ---------------------------------------------------------------------------

export interface GenerationResult {
  filePath: string;
  mimeType: string;
  costUsd: number;
  model: string;
  taskId: string | null;
  seed: number | null;
}

export interface GenerativeProvider {
  readonly id: string;
  /** configured = hay llave; demo = genera marcadores locales sin gastar créditos. */
  status(): { configured: boolean; demo: boolean; detail: string };
  models(): KieModelConfig[];
  /** Saldo de créditos si el proveedor lo expone (null si no se sabe). */
  credits(): Promise<number | null>;
  /** Crea la tarea, consulta su estado con reintentos y descarga el resultado a `outDir`. */
  generate(request: AiRequest, opts: RunOptions & { outDir: string; aspect: string }): Promise<GenerationResult>;
}

// ---------------------------------------------------------------------------
// Cerebro editor (Claude o demo determinista)
// ---------------------------------------------------------------------------

/** Herramientas que el servidor le presta al editor durante su trabajo. */
export interface EditorToolbox {
  /** JPG (base64) de un archivo fuente en el segundo t, ancho reducido. */
  sourceFrame(assetId: string, t: number, width?: number): Promise<{ base64: string; mediaType: "image/jpeg" }>;
  /** JPG (base64) de cómo se ve la receta en el segundo t (incluye textos/subtítulos). */
  previewFrame(recipe: Recipe, t: number, width?: number): Promise<{ base64: string; mediaType: "image/jpeg" }>;
  /** Valida y normaliza una receta; devuelve errores legibles si no es válida. */
  validateRecipe(data: unknown): { ok: true; recipe: Recipe } | { ok: false; errors: string[] };
  /** Materializa los subtítulos de la receta a partir de la transcripción y palabras clave. */
  materializeCaptions(recipe: Recipe): Recipe;
  /** Plantillas de motion graphics disponibles (de fábrica + estilo + proyecto). */
  motionTemplates(): MotionTemplate[];
  /** Guía de autoría de HyperFrames (texto) para que el editor escriba plantillas válidas. */
  hyperframesGuide(): Promise<string>;
}

export interface EditInput {
  project: Project;
  settings: ProjectSettings;
  assets: Asset[];
  transcripts: Transcript[];
  keywords: Keyword[];
  rules: MemoryRule[];
  glossary: GlossaryEntry[];
  brand: Brand | null;
  /** Estilo guardado en uso (ficha de reglas + preset), si aplica. */
  style: { version: StyleVersion; skillMarkdown: string } | null;
  /** Receta base (p. ej. desde un estilo) que el editor debe respetar/adaptar. */
  baseRecipe: Recipe | null;
  toolbox: EditorToolbox;
  /** Modelos de IA generativa disponibles con su costo (para que el editor elija y presupueste). */
  aiModels: KieModelConfig[];
  /**
   * Mapa del material (opcional): columna del video en el orden sugerido, fragmentos de habla / b-roll /
   * tomas repetidas / tiempos muertos dentro de cada clip. Si falta, el editor lo calcula con
   * `buildMaterialMap` (ai/shared/material-map.ts).
   */
  materialMap?: MaterialMap | null;
}

export interface EditPlanResult {
  recipe: Recipe;
  scenes: PlanScene[];
  summary: string;
  /** Plantillas nuevas que escribió el editor (HyperFrames HTML) para esta edición. */
  newTemplates: MotionTemplate[];
  usage: Usage;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  model: string;
}

export interface CorrectionInput extends EditInput {
  current: Recipe;
  correction: string;
  /** Segundo del video final al que se ancla la corrección (si se tocó el reproductor). */
  at: number | null;
  /** Historial de correcciones previas del proyecto (más reciente al final). */
  history: { correction: string; summary: string }[];
}

export interface CorrectionResult {
  /** Operaciones RFC 6902 sobre la receta actual. */
  patch: { op: "add" | "remove" | "replace" | "move" | "copy" | "test"; path: string; value?: unknown; from?: string }[];
  /** Áreas que la corrección tiene permitido tocar (para verificar la regla de oro). */
  areas: RecipeChange["area"][];
  summary: string;
  /** Si la corrección es ambigua, una pregunta para el usuario (no se renderiza). */
  clarifyingQuestion: string | null;
  /** Regla candidata para recordar ("títulos siempre en Montserrat"). */
  ruleSuggestion: { text: string; check: RuleCheck | null } | null;
  newTemplates: MotionTemplate[];
  usage: Usage;
}

export interface QaInput {
  recipe: Recipe;
  rules: MemoryRule[];
  settings: ProjectSettings;
  /** Fotogramas del render final con su tiempo. */
  frames: { t: number; base64: string; mediaType: "image/jpeg" }[];
}

export interface QaResult {
  checks: { check: string; ok: boolean; detail: string }[];
  /** Si hay fallas corregibles, parche sugerido para un segundo intento. */
  fixPatch: CorrectionResult["patch"] | null;
  usage: Usage;
}

export interface KeywordInput {
  transcripts: Transcript[];
  settings: ProjectSettings;
  existing: Keyword[];
  glossary: GlossaryEntry[];
}

export interface StyleRulesInput {
  recipe: Recipe;
  settings: ProjectSettings;
  corrections: { correction: string; summary: string }[];
  rules: MemoryRule[];
  name: string;
}

export interface EditorBrain {
  readonly kind: "claude" | "demo";
  readonly model: string;
  plan(input: EditInput, opts?: RunOptions): Promise<EditPlanResult>;
  revisePlan(input: EditInput, current: Recipe, feedback: string, opts?: RunOptions): Promise<EditPlanResult>;
  correct(input: CorrectionInput, opts?: RunOptions): Promise<CorrectionResult>;
  review(input: QaInput, opts?: RunOptions): Promise<QaResult>;
  detectKeywords(input: KeywordInput, opts?: RunOptions): Promise<{ keywords: Keyword[]; publishCopy: PublishCopy; usage: Usage }>;
  /** Ficha de reglas del estilo (markdown) a partir del video final y TODAS las correcciones. */
  styleRules(input: StyleRulesInput, opts?: RunOptions): Promise<{ rulesMarkdown: string; rules: string[]; usage: Usage }>;
  /** Análisis de una referencia visual (imagen) → qué tomar de ella (ritmo, textos, colores…). */
  analyzeReference(input: { imageBase64: string; mediaType: "image/jpeg" | "image/png"; likes: string }, opts?: RunOptions): Promise<{ analysis: string; usage: Usage }>;
}

/** Contenedor de servicios inyectado en rutas y pipeline. */
export interface Services {
  storage: StorageAdapter;
  media: MediaAnalyzer;
  transcriber: Transcriber;
  renderer: Renderer;
  motion: Record<"hyperframes" | "builtin" | "remotion", MotionEngine | null>;
  generative: GenerativeProvider;
  /** Cerebro con Claude si hay llave; si no, el demo. */
  editor: EditorBrain;
  /** Siempre disponible: editor determinista sin IA (respaldo y modo demo). */
  demoEditor: EditorBrain;
  log: Log;
}
