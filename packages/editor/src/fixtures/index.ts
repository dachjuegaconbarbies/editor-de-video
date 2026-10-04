/**
 * Datos de ejemplo para el modo demo de la interfaz (sin servidor) y para capturas/pruebas.
 * Incluye material con A-roll y B-roll, transcripción con tiempos por palabra, palabras clave,
 * dos versiones (V1 → V2 con la corrección "cambia la tipografía por una más bonita"),
 * estilos y reglas aprendidas.
 */
import {
  Asset,
  Keyword,
  MemoryRule,
  Plan,
  Project,
  ProjectSettings,
  Recipe,
  Style,
  Transcript,
  Version,
  type AssetCategory,
  type MediaKind,
  type PublicConfig,
  type PublishCopy,
} from "@autoeditor/shared";
import { posterThumb, sceneThumb, type ThumbScene } from "./thumbs.js";
import { freshSettings } from "../lib/settings.js";

export const DEMO_OWNER = "demo";
export const DEMO_PROJECT_ID = "demo-cafe";

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

export const demoConfig: PublicConfig = {
  version: "0.1.0-demo",
  demoMode: true,
  capabilities: {
    claude: false,
    kie: false,
    transcription: { provider: "demo", ready: true, detail: "Transcripción simulada (modo demo)." },
    hyperframes: { ready: true, detail: "HyperFrames listo." },
    remotion: { ready: false, detail: "Opcional y apagado por licencia." },
    ffmpeg: { ready: true, version: "6.1" },
  },
  models: {
    editor: "claude-opus-5-5",
    helper: "claude-sonnet-5-5",
    available: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    ],
  },
  kieModels: [
    { id: "kie-imagen-demo", label: "Imagen (demo)", kind: "imagen", costUsd: 0.02, enabled: true, verified: false },
    { id: "kie-video-demo", label: "Video (demo)", kind: "video", costUsd: 0.25, enabled: true, verified: false },
    { id: "kie-sfx-demo", label: "Efectos (demo)", kind: "sfx", costUsd: 0.01, enabled: true, verified: false },
    { id: "kie-voz-demo", label: "Voz (demo)", kind: "voz", costUsd: 0.03, enabled: true, verified: false },
    { id: "kie-musica-demo", label: "Música (demo)", kind: "musica", costUsd: 0.05, enabled: true, verified: false },
  ],
  estimator: {
    coefficients: { analyzePerMinute: 6, transcribePerMinute: 30, planBase: 45, planPerMinute: 12, aiImage: 40, aiVideo: 150, aiAudio: 45, motionPerSecond: 6, renderPerSecond: 1.2, qaBase: 20, spread: 0.25 },
    calibration: {},
  },
  pricing: {
    editorModel: { inputUsdPerMTok: 4, outputUsdPerMTok: 20, cacheReadUsdPerMTok: 0.2 },
    helperModel: { inputUsdPerMTok: 2, outputUsdPerMTok: 10, cacheReadUsdPerMTok: 0.2 },
    kieDefaults: { imagen: "kie-imagen-demo", video: "kie-video-demo", musica: "kie-musica-demo", voz: "kie-voz-demo", sfx: "kie-sfx-demo" },
  },
  limits: { maxUploadBytes: 4 * 1024 ** 3 },
};

/** Miniatura por id de asset (el cliente demo la sirve en lugar de /assets/:id/thumbnail). */
export const demoThumbs = new Map<string, string>();

interface AssetSeed {
  id: string;
  name: string;
  category: AssetCategory;
  kind: MediaKind;
  mime: string;
  size: number;
  duration?: number;
  w?: number;
  h?: number;
  scene: ThumbScene;
  role?: "a-roll" | "b-roll" | "mixto";
  speech?: boolean;
  segments?: { start: number; end: number; score: number; description: string }[];
  description?: string;
  priority?: "debe-aparecer" | "opcional";
  note?: string;
  status?: "listo" | "analizando" | "pendiente";
  projectId?: string;
}

export function makeAsset(seed: AssetSeed): Asset {
  const vertical = (seed.h ?? 0) > (seed.w ?? 0);
  demoThumbs.set(seed.id, sceneThumb(seed.scene, vertical));
  return Asset.parse({
    id: seed.id,
    ownerId: DEMO_OWNER,
    projectId: seed.projectId ?? DEMO_PROJECT_ID,
    category: seed.category,
    kind: seed.kind,
    originalName: seed.name,
    mimeType: seed.mime,
    sizeBytes: seed.size,
    storageKey: `demo/${seed.id}`,
    probe: {
      duration: seed.duration ?? null,
      width: seed.w ?? null,
      height: seed.h ?? null,
      fps: seed.kind === "video" ? 30 : null,
      hasAudio: seed.kind !== "imagen",
      hasVideo: seed.kind === "video" || seed.kind === "imagen",
      videoCodec: seed.kind === "video" ? "h264" : null,
      audioCodec: seed.kind === "video" || seed.kind === "audio" ? "aac" : null,
    },
    analysis: {
      status: seed.status ?? "listo",
      hasSpeech: seed.speech ?? null,
      role: seed.role ?? "desconocido",
      brollSegments: (seed.segments ?? []).map((s) => ({ ...s, tags: [] })),
      description: seed.description ?? "",
      scenes: seed.duration ? [0, seed.duration * 0.3, seed.duration * 0.7] : [],
    },
    thumbnailKey: `demo/${seed.id}.jpg`,
    priority: seed.priority ?? "opcional",
    note: seed.note ?? "",
    createdAt: iso(90),
  });
}

export const demoAssets: Asset[] = [
  makeAsset({
    id: "a-entrevista",
    name: "entrevista-barista.mp4",
    category: "crudo-video",
    kind: "video",
    mime: "video/mp4",
    size: 186_400_000,
    duration: 48.2,
    w: 1080,
    h: 1920,
    scene: "persona",
    role: "a-roll",
    speech: true,
    description: "Barista hablando a cámara detrás de la barra.",
    priority: "debe-aparecer",
    note: "Abre con este",
  }),
  makeAsset({
    id: "a-producto",
    name: "olla-canela-detalle.mov",
    category: "crudo-video",
    kind: "video",
    mime: "video/quicktime",
    size: 64_200_000,
    duration: 12.4,
    w: 1920,
    h: 1080,
    scene: "taza",
    role: "b-roll",
    speech: false,
    segments: [
      { start: 0.8, end: 4.6, score: 0.92, description: "Canela cayendo en la olla" },
      { start: 6.2, end: 10.8, score: 0.85, description: "Vapor sobre la taza" },
    ],
    description: "Detalle de la olla con canela y vapor.",
  }),
  makeAsset({
    id: "a-calle",
    name: "calle-amanecer.mp4",
    category: "crudo-video",
    kind: "video",
    mime: "video/mp4",
    size: 41_700_000,
    duration: 9.1,
    w: 1920,
    h: 1080,
    scene: "ciudad",
    role: "b-roll",
    speech: false,
    segments: [{ start: 1, end: 7.5, score: 0.78, description: "Calle con luz cálida al amanecer" }],
    description: "Calle del barrio al amanecer.",
  }),
  makeAsset({
    id: "a-testimonio",
    name: "testimonio-clienta.mp4",
    category: "crudo-video",
    kind: "video",
    mime: "video/mp4",
    size: 92_300_000,
    duration: 22.6,
    w: 1080,
    h: 1920,
    scene: "producto",
    role: "mixto",
    speech: true,
    segments: [{ start: 15.2, end: 21.4, score: 0.7, description: "Manos sirviendo café" }],
    description: "Clienta comenta y luego sirve café.",
  }),
  makeAsset({ id: "a-foto", name: "fachada-local.jpg", category: "crudo-foto", kind: "imagen", mime: "image/jpeg", size: 3_400_000, w: 1600, h: 1200, scene: "local" }),
  makeAsset({ id: "a-voz", name: "nota-de-voz-idea.m4a", category: "crudo-voz", kind: "audio", mime: "audio/mp4", size: 980_000, duration: 31, scene: "voz", speech: true }),
  makeAsset({ id: "a-musica", name: "acustica-mañanera.mp3", category: "musica", kind: "audio", mime: "audio/mpeg", size: 4_100_000, duration: 95, scene: "ondas" }),
  makeAsset({ id: "a-logo", name: "logo-cafe-de-barrio.png", category: "logo", kind: "imagen", mime: "image/png", size: 120_000, w: 800, h: 800, scene: "logo" }),
  makeAsset({ id: "a-sfx", name: "whoosh-suave.wav", category: "sfx", kind: "audio", mime: "audio/wav", size: 210_000, duration: 1.2, scene: "ondas" }),
];

const TRANSCRIPT_TEXT =
  "¿Sabías que el café de olla se prepara con canela y piloncillo? Hoy te enseño cómo lo hacemos en nuestra cafetería, paso a paso, en menos de cinco minutos. Eh, primero calentamos el agua con la canela hasta que suelta todo su aroma. Luego agregamos el piloncillo y, cuando hierve, el café molido. Lo dejamos reposar un minuto, colamos y listo. Si quieres probarlo, visítanos este fin de semana.";

function wordsFrom(text: string, start: number, wps = 2.6) {
  const tokens = text.split(/\s+/).filter(Boolean);
  let t = start;
  return tokens.map((tok, i) => {
    const d = Math.max(0.18, tok.length / (wps * 5.2));
    const w = { i, text: tok, start: Math.round(t * 100) / 100, end: Math.round((t + d) * 100) / 100, probability: 0.96, filler: /^eh,?$/i.test(tok) };
    t += d + (/[.,?!]$/.test(tok) ? 0.28 : 0.06);
    return w;
  });
}

export const demoTranscripts: Transcript[] = [
  Transcript.parse({
    id: "t-entrevista",
    ownerId: DEMO_OWNER,
    projectId: DEMO_PROJECT_ID,
    assetId: "a-entrevista",
    language: "es",
    provider: "demo",
    model: "demo",
    status: "listo",
    words: wordsFrom(TRANSCRIPT_TEXT, 0.6),
    createdAt: iso(80),
    updatedAt: iso(80),
  }),
  Transcript.parse({
    id: "t-testimonio",
    ownerId: DEMO_OWNER,
    projectId: DEMO_PROJECT_ID,
    assetId: "a-testimonio",
    language: "es",
    provider: "demo",
    model: "demo",
    status: "listo",
    words: wordsFrom("Vengo cada sábado. El café de olla de aquí me recuerda al de mi abuela, de verdad.", 0.4),
    createdAt: iso(80),
    updatedAt: iso(80),
  }),
];

const kw = (id: string, text: string, category: Keyword["category"], source: Keyword["source"] = "auto") =>
  Keyword.parse({ id, text, category, source, enabled: true, occurrences: [], score: 0.8 });

export const demoKeywords: Keyword[] = [
  kw("k1", "¿Sabías que…?", "gancho"),
  kw("k2", "café de olla", "tema"),
  kw("k3", "canela", "tema"),
  kw("k4", "piloncillo", "nombre"),
  kw("k5", "cinco minutos", "cifra"),
  kw("k6", "paso a paso", "beneficio"),
  kw("k7", "visítanos", "cta"),
  kw("k8", "fin de semana", "otro", "usuario"),
];

export const demoPublishCopy: PublishCopy = {
  title: "Así hacemos el café de olla ☕",
  description: "Canela, piloncillo y cinco minutos. Te esperamos este fin de semana.",
  hashtags: ["#cafedeolla", "#cafeteria", "#recetas"],
  coverText: "EL CAFÉ DE OLLA MÁS RICO",
};

export function demoSettings(): ProjectSettings {
  const s = freshSettings();
  s.instruction.text = "Reel de 30 s para Instagram presentando nuestro café de olla: gancho fuerte al inicio, B-roll de la olla de fondo y subtítulos grandes.";
  s.instruction.platform = "reels";
  s.instruction.format = "9:16";
  s.instruction.targetDuration = 30;
  s.instruction.durationMode = "aproximada";
  s.tools.motionGraphics.enabled = true;
  s.tools.cta.enabled = true;
  s.tools.cta.text = "Visítanos este fin de semana";
  s.engines = { kie: false, hyperframes: true, remotion: false };
  return ProjectSettings.parse(s);
}

function demoRecipe(font: string, duration: number) {
  return Recipe.parse({
    format: { aspect: "9:16", width: 1080, height: 1920, fps: 30, platform: "reels" },
    duration,
    style: { titleFont: { family: font, weight: 800, assetId: null, googleFont: font } },
    target: { duration: 30, mode: "aproximada" },
    meta: { generator: "demo" },
  });
}

export const demoVersions: Version[] = [
  Version.parse({
    id: "v1",
    ownerId: DEMO_OWNER,
    projectId: DEMO_PROJECT_ID,
    number: 1,
    parentId: null,
    recipe: demoRecipe("Inter", 31.4),
    status: "lista",
    videoKey: "demo/v1.mp4",
    changeSummary: "",
    qa: [
      { check: "Subtítulos dentro de la zona segura", ok: true },
      { check: "Duración 31.4 s (objetivo 30 s ±15 %)", ok: true },
      { check: "Sin palabras cortadas", ok: true },
    ],
    renderSeconds: 312,
    costUsd: 0.41,
    createdAt: iso(42),
  }),
  Version.parse({
    id: "v2",
    ownerId: DEMO_OWNER,
    projectId: DEMO_PROJECT_ID,
    number: 2,
    parentId: "v1",
    recipe: demoRecipe("Playfair Display", 31.4),
    correction: "cambia la tipografía por una más bonita",
    changes: [
      { path: "/style/titleFont/family", op: "replace", before: "Inter", after: "Playfair Display", label: "Tipografía de títulos: Inter → Playfair Display", area: "estilo" },
      { path: "/tracks/captions/style/font/family", op: "replace", before: "Inter", after: "Playfair Display", label: "Tipografía de subtítulos: Inter → Playfair Display", area: "subtitulos" },
    ],
    changeSummary: "Cambié la tipografía de títulos y subtítulos a Playfair Display. Cortes, música y textos quedaron idénticos.",
    status: "lista",
    videoKey: "demo/v2.mp4",
    qa: [
      { check: "Subtítulos dentro de la zona segura", ok: true },
      { check: "Solo cambió el estilo de texto", ok: true },
    ],
    renderSeconds: 96,
    costUsd: 0.08,
    createdAt: iso(25),
  }),
];

export const demoPosters = new Map<string, string>([
  ["v1", posterThumb(1, true, "Inter")],
  ["v2", posterThumb(2, true, "Playfair Display")],
]);

export const demoProjects: Project[] = [
  Project.parse({
    id: DEMO_PROJECT_ID,
    ownerId: DEMO_OWNER,
    name: "Café de olla · reel de lanzamiento",
    settings: demoSettings(),
    status: "listo",
    currentVersionId: "v2",
    thumbnailAssetId: "a-entrevista",
    createdAt: iso(120),
    updatedAt: iso(25),
  }),
  Project.parse({
    id: "demo-podcast",
    ownerId: DEMO_OWNER,
    name: "Podcast ep. 12 · mejores momentos",
    settings: freshSettings(),
    status: "borrador",
    thumbnailAssetId: "a-podcast",
    createdAt: iso(60 * 26),
    updatedAt: iso(60 * 22),
  }),
  Project.parse({
    id: "demo-skincare",
    ownerId: DEMO_OWNER,
    name: "Rutina de skincare en 60 s",
    settings: freshSettings(),
    status: "listo",
    thumbnailAssetId: "a-skincare",
    createdAt: iso(60 * 24 * 6),
    updatedAt: iso(60 * 24 * 5),
  }),
];

// Miniaturas de los proyectos secundarios.
demoThumbs.set("a-podcast", sceneThumb("ondas", false));
demoThumbs.set("a-skincare", sceneThumb("producto", true));

export const demoStyles: Style[] = [
  Style.parse({ id: "s-zyra", ownerId: DEMO_OWNER, name: "Reels de Zyra", slug: "reels-de-zyra", description: "Ritmo rápido, subtítulos amarillos en mayúsculas y cierre con logo.", currentVersion: 3, timesUsed: 4, createdAt: iso(60 * 24 * 20), updatedAt: iso(60 * 24 * 2) }),
  Style.parse({ id: "s-podcast", ownerId: DEMO_OWNER, name: "Podcast limpio", slug: "podcast-limpio", description: "Cortes suaves, cintillos con nombre y sin música bajo la voz.", currentVersion: 1, timesUsed: 1, createdAt: iso(60 * 24 * 9), updatedAt: iso(60 * 24 * 9) }),
];

export const demoRules: MemoryRule[] = [
  MemoryRule.parse({
    id: "r1",
    ownerId: DEMO_OWNER,
    scope: "global",
    text: "Subtítulos siempre en mayúsculas.",
    check: { type: "subtitulos-mayusculas", value: true },
    source: { type: "correccion", excerpt: "pon los subtítulos en mayúsculas" },
    timesApplied: 6,
    strength: 3,
    createdAt: iso(60 * 24 * 12),
    updatedAt: iso(60 * 24 * 3),
  }),
  MemoryRule.parse({
    id: "r2",
    ownerId: DEMO_OWNER,
    scope: "global",
    text: "“Zyra” se escribe con Z.",
    check: { type: "texto-palabra", wrong: "Sira", right: "Zyra" },
    source: { type: "glosario", excerpt: "Sira → Zyra" },
    timesApplied: 9,
    createdAt: iso(60 * 24 * 10),
    updatedAt: iso(60 * 24 * 10),
  }),
  MemoryRule.parse({
    id: "r3",
    ownerId: DEMO_OWNER,
    scope: "estilo",
    scopeId: "s-zyra",
    text: "Nunca usar transiciones de zoom.",
    check: { type: "sin-transicion", transition: "zoom" },
    source: { type: "correccion", excerpt: "quita esas transiciones de zoom" },
    enabled: false,
    createdAt: iso(60 * 24 * 7),
    updatedAt: iso(60 * 24 * 7),
  }),
];

export function demoPlan(projectId: string, jobId: string): Plan {
  return Plan.parse({
    id: `plan-${jobId}`,
    ownerId: DEMO_OWNER,
    projectId,
    jobId,
    status: "pendiente",
    summary: "Abro con la pregunta del gancho, muestro el proceso con B-roll de fondo y cierro con la invitación del fin de semana.",
    scenes: [
      { id: "e1", title: "Gancho: “¿Sabías que…?”", start: 0, end: 3.2, onScreenText: ["¿SABÍAS QUE…?"], music: "Entra suave" },
      { id: "e2", title: "Canela y piloncillo (B-roll de fondo)", start: 3.2, end: 10.5, graphics: ["Lista animada de ingredientes"] },
      { id: "e3", title: "Paso a paso en 5 minutos", start: 10.5, end: 21, onScreenText: ["5 MINUTOS"] },
      { id: "e4", title: "Testimonio de clienta", start: 21, end: 27 },
      { id: "e5", title: "Cierre: visítanos este fin de semana", start: 27, end: 31, onScreenText: ["VISÍTANOS"], graphics: ["Logo animado"] },
    ],
    recipe: demoRecipe("Inter", 31),
    estimatedCostUsd: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}
