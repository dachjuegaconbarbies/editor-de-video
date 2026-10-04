/**
 * Esquemas de los archivos de configuración editables en /config (modelos, precios, proveedores).
 * Nada de esto vive fijo en el código: el usuario puede cambiar modelos y precios sin programar.
 */
import { z } from "zod";

export const ClaudeModelConfig = z.object({
  id: z.string(),
  label: z.string(),
  inputUsdPerMTok: z.number(),
  outputUsdPerMTok: z.number(),
  cacheReadUsdPerMTok: z.number().default(0),
});

export const ModelsConfig = z.object({
  claude: z.object({
    /** Modelo editor principal. */
    editor: z.string().default("claude-opus-5-5"),
    /** Modelo barato para tareas simples (describir fotogramas, clasificar, palabras clave). */
    helper: z.string().default("claude-sonnet-5-5"),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
    helperEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
    maxAgentTurns: z.number().int().min(1).max(200).default(40),
    /** Activa el reintento automático en otro modelo si el principal rechaza la petición. */
    serverSideFallback: z.boolean().default(true),
    models: z.array(ClaudeModelConfig),
  }),
  transcription: z.object({
    /** faster-whisper (local), openai-compatible (API) o demo. */
    provider: z.enum(["faster-whisper", "openai-compatible", "demo"]).default("faster-whisper"),
    model: z.string().default("small"),
    device: z.enum(["auto", "cpu", "cuda"]).default("auto"),
    computeType: z.string().default("int8"),
    apiBaseUrl: z.string().default(""),
    apiModel: z.string().default("whisper-1"),
  }),
});
export type ModelsConfig = z.infer<typeof ModelsConfig>;

export const KieModelConfig = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["imagen", "video", "musica", "voz", "sfx"]),
  /** market = POST /api/v1/jobs/createTask; dedicated = endpoint propio. */
  api: z.enum(["market", "dedicated"]),
  /** Para market: valor de "model". Para dedicated: ruta relativa del endpoint de creación. */
  model: z.string().default(""),
  createPath: z.string().default("/api/v1/jobs/createTask"),
  statusPath: z.string().default("/api/v1/jobs/recordInfo"),
  /** Plantilla de input: claves de entrada fijas que se fusionan con las generadas. */
  defaults: z.record(z.string(), z.unknown()).default({}),
  /** Mapeo de nuestros parámetros genéricos a los campos del modelo. */
  fieldMap: z.record(z.string(), z.string()).default({}),
  costCredits: z.number().default(0),
  costUsd: z.number().default(0),
  /** Segundos típicos que tarda en generar (para el estimador). */
  typicalSeconds: z.number().default(60),
  enabled: z.boolean().default(true),
  verified: z.boolean().default(false),
  notes: z.string().default(""),
});
export type KieModelConfig = z.infer<typeof KieModelConfig>;

export const ProvidersConfig = z.object({
  kie: z.object({
    baseUrl: z.string().default("https://api.kie.ai"),
    usdPerCredit: z.number().default(0.005),
    pollIntervalMs: z.number().default(4000),
    timeoutMs: z.number().default(15 * 60 * 1000),
    maxRetries: z.number().int().default(3),
    defaults: z.object({
      imagen: z.string(),
      video: z.string(),
      musica: z.string(),
      voz: z.string(),
      sfx: z.string(),
    }),
    models: z.array(KieModelConfig),
  }),
  motion: z.object({
    defaultEngine: z.enum(["hyperframes", "builtin", "remotion"]).default("hyperframes"),
    hyperframes: z.object({
      enabled: z.boolean().default(true),
      /** Comando para invocar el CLI (se resuelve desde node_modules del servidor). */
      command: z.string().default("hyperframes"),
      timeoutMs: z.number().default(5 * 60 * 1000),
    }),
    remotion: z.object({
      enabled: z.boolean().default(false),
      licenseNote: z.string().default(""),
    }),
  }),
});
export type ProvidersConfig = z.infer<typeof ProvidersConfig>;

/** Coeficientes del estimador de tiempo (segundos). Se recalibran con renders reales. */
export const EstimatorCoefficients = z.object({
  /** Segundos de análisis por minuto de material. */
  analyzePerMinute: z.number().default(6),
  /** Segundos de transcripción por minuto de audio (depende del modelo y CPU). */
  transcribePerMinute: z.number().default(30),
  /** Segundos fijos de planeación con Claude + por minuto de material. */
  planBase: z.number().default(45),
  planPerMinute: z.number().default(12),
  /** Por imagen / clip de IA (si no hay dato del modelo). */
  aiImage: z.number().default(40),
  aiVideo: z.number().default(150),
  aiAudio: z.number().default(45),
  /** Segundos de render de motion graphics por segundo de gráfico. */
  motionPerSecond: z.number().default(6),
  /** Segundos de render por segundo de video final a 1080p. */
  renderPerSecond: z.number().default(1.2),
  qaBase: z.number().default(20),
  /** Factor de incertidumbre para el rango (±). */
  spread: z.number().default(0.25),
});
export type EstimatorCoefficients = z.infer<typeof EstimatorCoefficients>;
