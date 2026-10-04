/**
 * Datos de ejemplo para el modo demo de la interfaz (sin servidor) y para capturas/pruebas.
 * Incluye material con A-roll y B-roll, transcripción con tiempos por palabra, palabras clave,
 * dos versiones (V1 → V2 con la corrección "cambia la tipografía por una más bonita"),
 * estilos y reglas aprendidas.
 */
import {
  Asset,
  GlossaryEntry,
  Keyword,
  MemoryRule,
  Plan,
  Project,
  ProjectSettings,
  Style,
  StylePreset,
  StyleVersion,
  Transcript,
  Version,
  diffRecipes,
  type AssetCategory,
  type MediaKind,
  type PlanScene,
  type PublicConfig,
  type PublishCopy,
  type Recipe,
  type TranscriptWord,
} from "@autoeditor/shared";
import { posterThumb, sceneThumb, type ThumbScene } from "./thumbs.js";
import { freshSettings } from "../lib/settings.js";
import { applyDemoCorrection } from "../demo/corrections.js";
import { buildDemoRecipe, type ClipSeed } from "../demo/recipes.js";

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

export function wordsFrom(text: string, start: number, wps = 2.6) {
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

/** Palabras con tiempos por asset (para materializar subtítulos en las recetas de la demo). */
export function demoWordsByAsset(transcripts: Transcript[] = demoTranscripts): Map<string, TranscriptWord[]> {
  return new Map(transcripts.map((t) => [t.assetId, t.words]));
}

/** Clips de la edición del proyecto de ejemplo (A-roll con B-roll intercalado). */
export const DEMO_CLIPS: ClipSeed[] = [
  { assetId: "a-entrevista", sourceIn: 0.6, sourceOut: 4.0, label: "Gancho: ¿Sabías que…?", reason: "La pregunta engancha en los primeros 3 s" },
  { assetId: "a-producto", sourceIn: 0.8, sourceOut: 3.4, label: "Canela cayendo en la olla", reason: "B-roll como corte sobre “canela y piloncillo”" },
  { assetId: "a-entrevista", sourceIn: 4.2, sourceOut: 10.4, label: "Te enseño cómo lo hacemos", reason: "Promesa: paso a paso en menos de 5 minutos" },
  { assetId: "a-calle", sourceIn: 1.0, sourceOut: 3.4, label: "Calle al amanecer", reason: "Respiro visual y contexto del barrio" },
  { assetId: "a-entrevista", sourceIn: 10.6, sourceOut: 17.6, label: "Canela, piloncillo y café", reason: "El proceso, con B-roll de la olla de fondo" },
  { assetId: "a-testimonio", sourceIn: 0.4, sourceOut: 5.9, label: "Testimonio de clienta", reason: "Prueba social antes del cierre" },
  { assetId: "a-entrevista", sourceIn: 28.6, sourceOut: 32.5, label: "Visítanos este fin de semana", reason: "Llamado a la acción" },
];

/** Receta V1 del proyecto de ejemplo. */
export function demoRecipeV1(font = "Inter"): Recipe {
  return buildDemoRecipe({
    aspect: "9:16",
    platform: "reels",
    clips: DEMO_CLIPS,
    titleFont: font,
    shotLength: 2.5,
    target: { duration: 30, mode: "aproximada" },
    hook: "¿SABÍAS QUE…?",
    keywordText: "5 MINUTOS",
    cta: "VISÍTANOS ESTE FIN DE SEMANA",
    musicAssetId: "a-musica",
    sfxAssetId: "a-sfx",
    brollOverlay: { assetId: "a-producto", at: 13.2, duration: 3.2, sourceIn: 6.2 },
    logoAssetId: "a-logo",
    motion: true,
    highlightWords: ["café", "olla", "canela", "piloncillo", "cinco", "minutos", "visítanos"],
    transcripts: demoWordsByAsset(),
    notes: "Abro con la pregunta del gancho, muestro el proceso con B-roll de fondo, meto el testimonio como prueba social y cierro con la invitación del fin de semana.",
  });
}

const V1_RECIPE = demoRecipeV1();
const V2_CORRECTION = "cambia la tipografía por una más bonita";
const V2_RESULT = applyDemoCorrection(V1_RECIPE, V2_CORRECTION, null, demoWordsByAsset());

export const demoVersions: Version[] = [
  Version.parse({
    id: "v1",
    ownerId: DEMO_OWNER,
    projectId: DEMO_PROJECT_ID,
    number: 1,
    parentId: null,
    recipe: V1_RECIPE,
    status: "lista",
    videoKey: "demo/v1.mp4",
    posterKey: "demo/poster-v1.jpg",
    changeSummary: "",
    publishCopy: demoPublishCopy,
    qa: [
      { check: "Subtítulos dentro de la zona segura de Reels", ok: true },
      { check: `Duración ${V1_RECIPE.duration.toFixed(1)} s (objetivo 30 s ±15 %)`, ok: true },
      { check: "Sin palabras cortadas a la mitad", ok: true },
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
    recipe: V2_RESULT.recipe,
    correction: V2_CORRECTION,
    changes: diffRecipes(V1_RECIPE, V2_RESULT.recipe),
    changeSummary: V2_RESULT.summary,
    status: "lista",
    videoKey: "demo/v2.mp4",
    posterKey: "demo/poster-v2.jpg",
    publishCopy: demoPublishCopy,
    qa: [
      { check: "Subtítulos dentro de la zona segura de Reels", ok: true },
      { check: "Solo cambió la tipografía (regla de oro)", ok: true },
    ],
    renderSeconds: 96,
    costUsd: 0.08,
    createdAt: iso(25),
  }),
];

export const demoPosters = new Map<string, string>([
  ["v1", posterThumb(1, true, "Inter")],
  ["v2", posterThumb(2, true, V2_RESULT.recipe.style.titleFont.family)],
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

// Miniaturas de los proyectos secundarios y de los estilos.
demoThumbs.set("a-podcast", sceneThumb("ondas", false));
demoThumbs.set("a-skincare", sceneThumb("producto", true));
demoThumbs.set("thumb-s-zyra", posterThumb(1, true, "Bebas Neue"));
demoThumbs.set("thumb-s-podcast", posterThumb(2, false, "Inter"));

export const demoStyles: Style[] = [
  Style.parse({ id: "s-zyra", ownerId: DEMO_OWNER, name: "Reels de Zyra", slug: "reels-de-zyra", description: "Ritmo rápido, subtítulos amarillos en mayúsculas y cierre con logo.", currentVersion: 3, thumbnailAssetId: "thumb-s-zyra", timesUsed: 4, createdAt: iso(60 * 24 * 20), updatedAt: iso(60 * 24 * 2) }),
  Style.parse({ id: "s-podcast", ownerId: DEMO_OWNER, name: "Podcast limpio", slug: "podcast-limpio", description: "Cortes suaves, cintillos con nombre y sin música bajo la voz.", currentVersion: 1, thumbnailAssetId: "thumb-s-podcast", timesUsed: 1, createdAt: iso(60 * 24 * 9), updatedAt: iso(60 * 24 * 9) }),
];

/** Configuración que precarga cada estilo de ejemplo al crear un proyecto con él. */
export function demoStyleSettings(styleId: string): ProjectSettings {
  const s = freshSettings();
  if (styleId === "s-podcast") {
    s.instruction.format = "16:9";
    s.instruction.platform = "youtube";
    s.instruction.tone = "profesional";
    s.tools.pacing.value = "lento";
    s.tools.music.enabled = false;
    s.tools.lowerThirds.enabled = true;
    s.tools.zooms.enabled = false;
    s.captions.style.mode = "frase";
    s.captions.style.uppercase = false;
  } else {
    s.instruction.format = "9:16";
    s.instruction.platform = "reels";
    s.instruction.targetDuration = 30;
    s.instruction.durationMode = "aproximada";
    s.tools.pacing.value = "rapido";
    s.tools.motionGraphics.enabled = true;
    s.tools.cta.enabled = true;
    s.tools.cta.text = "Síguenos para más";
    s.tools.sfx.enabled = true;
    s.captions.style.highlightColor = "#FBE88A";
    s.captions.style.uppercase = true;
    s.context.brand.enabled = true;
    s.context.brand.inline = { ...s.context.brand.inline, name: "Zyra", colors: ["#8B7CF0", "#FBE88A", "#1F1F1F"], googleFonts: ["Bebas Neue"] };
  }
  return ProjectSettings.parse(s);
}

const STYLE_RULES: Record<string, string[]> = {
  "s-zyra": ["Títulos en Bebas Neue y en mayúsculas.", "Subtítulos palabra por palabra con resaltado amarillo.", "Un corte cada ~1.5 s.", "Cierre con logo animado y “Síguenos para más”.", "Nunca transiciones de zoom."],
  "s-podcast": ["Cortes suaves, sin zooms.", "Cintillo con nombre y cargo al presentar a cada persona.", "Sin música bajo la voz.", "Subtítulos por frase, sin mayúsculas."],
};

/** Versiones (con su ficha de reglas) de un estilo de la demo. */
export function demoStyleVersions(style: Style, settings?: ProjectSettings): StyleVersion[] {
  const rules = STYLE_RULES[style.id] ?? ["Misma tipografía, colores y ritmo que el video original.", "Subtítulos con el mismo estilo y palabras clave resaltadas."];
  return Array.from({ length: style.currentVersion }, (_, i) =>
    StyleVersion.parse({
      id: `${style.id}-v${i + 1}`,
      styleId: style.id,
      number: i + 1,
      preset: StylePreset.parse({ include: {}, settings: settings ?? demoStyleSettings(style.id), baseInstruction: "" }),
      rulesMarkdown: `# ${style.name}\n\n${rules.map((r) => `- ${r}`).join("\n")}`,
      rules: i === style.currentVersion - 1 ? rules : rules.slice(0, Math.max(1, rules.length - (style.currentVersion - 1 - i))),
      sourceProjectId: null,
      sourceVersionId: null,
      createdAt: style.updatedAt,
    }),
  );
}

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
  MemoryRule.parse({
    id: "r4",
    ownerId: DEMO_OWNER,
    scope: "proyecto",
    scopeId: DEMO_PROJECT_ID,
    text: "Mostrar la olla de barro en los primeros 5 segundos.",
    source: { type: "plan", excerpt: "quiero ver la olla desde el inicio" },
    timesApplied: 1,
    createdAt: iso(60 * 3),
    updatedAt: iso(60 * 3),
  }),
];

export const demoGlossary: GlossaryEntry[] = [
  GlossaryEntry.parse({ id: "g1", ownerId: DEMO_OWNER, term: "Zyra", variants: ["Sira", "Zaira", "Sayra"], scope: "global", timesApplied: 9, createdAt: iso(60 * 24 * 10) }),
  GlossaryEntry.parse({ id: "g2", ownerId: DEMO_OWNER, term: "piloncillo", variants: ["pilón cillo", "pilocillo"], scope: "global", timesApplied: 3, createdAt: iso(60 * 24 * 4) }),
  GlossaryEntry.parse({ id: "g3", ownerId: DEMO_OWNER, term: "Kie AI", variants: ["kiai", "qué ai"], scope: "global", timesApplied: 2, createdAt: iso(60 * 24 * 2) }),
];

/** Historial de "correcciones por video" de proyectos anteriores (para la métrica de aprendizaje). */
export const demoCorrectionHistory: { projectId: string; name: string; corrections: number; daysAgo: number }[] = [
  { projectId: "h1", name: "Promo de verano", corrections: 5, daysAgo: 40 },
  { projectId: "h2", name: "Tutorial de latte art", corrections: 4, daysAgo: 33 },
  { projectId: "h3", name: "Entrevista al chef", corrections: 4, daysAgo: 26 },
  { projectId: "demo-skincare", name: "Rutina de skincare en 60 s", corrections: 3, daysAgo: 6 },
  { projectId: "h4", name: "Nuevo menú de otoño", corrections: 2, daysAgo: 3 },
];

/** Plan (storyboard) a partir de una receta: una escena por clip con sus textos, música, gráficos y pedidos a IA. */
export function planScenesFromRecipe(recipe: Recipe, aiPrompts: { kind: string; prompt: string; model: string; costUsd: number | null }[] = []): PlanScene[] {
  const overlap = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;
  return recipe.tracks.video.map((c, i) => {
    const d = c.stillDuration ?? (c.sourceOut - c.sourceIn) / c.speed;
    const start = c.start;
    const end = Math.round((start + d) * 100) / 100;
    const words = recipe.tracks.captions.words.filter((w) => w.start >= start && w.start < end).map((w) => w.text);
    const music = recipe.tracks.audio.music[0];
    return {
      id: `e${i + 1}`,
      title: c.label || `Escena ${i + 1}`,
      start,
      end,
      clips: [{ assetId: c.assetId, sourceIn: c.sourceIn, sourceOut: c.sourceOut, label: c.label }],
      onScreenText: recipe.tracks.text.filter((t) => overlap(t.start, t.end, start, end)).map((t) => t.text),
      captions: words.join(" "),
      music: music ? (i === 0 ? "Entra suave (fade in)" : i === recipe.tracks.video.length - 1 ? "Sube y cierra (fade out)" : "Baja bajo la voz") : "",
      graphics: [
        ...recipe.tracks.graphics.filter((g) => overlap(g.start, g.end, start, end)).map((g) => g.description || g.templateId),
        ...recipe.tracks.overlays.filter((o) => overlap(o.start, o.end, start, end)).map((o) => (o.kind === "logo" ? "Logo" : o.layout === "fondo-con-orador" ? "B-roll de fondo con la persona en recuadro" : "B-roll")),
      ],
      ai: aiPrompts.filter((_, j) => j % Math.max(1, recipe.tracks.video.length) === i),
      notes: c.reason,
    };
  });
}

export function demoPlan(projectId: string, jobId: string, recipe: Recipe = V1_RECIPE, aiPrompts: { kind: string; prompt: string; model: string; costUsd: number | null }[] = []): Plan {
  const scenes = planScenesFromRecipe(recipe, aiPrompts);
  return Plan.parse({
    id: `plan-${jobId}`,
    ownerId: DEMO_OWNER,
    projectId,
    jobId,
    status: "pendiente",
    summary: recipe.notes || "Abro con el gancho, alterno la voz con tomas de apoyo y cierro con el llamado a la acción.",
    scenes,
    recipe,
    estimatedCostUsd: aiPrompts.reduce((s, a) => s + (a.costUsd ?? 0), 0),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}
