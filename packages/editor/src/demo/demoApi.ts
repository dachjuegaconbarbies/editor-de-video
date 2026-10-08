/**
 * Cliente de API de DEMOSTRACIÓN (en memoria). Implementa la misma interfaz que el cliente real
 * para recorrer TODO el flujo sin servidor:
 *  - crear proyectos, subir archivos reales (se quedan en el navegador como blob: URLs para verlos),
 *  - análisis simulado con roles A-roll / B-roll, transcripción de ejemplo y palabras clave,
 *  - estimado (con avisos), GENERAR con etapas en vivo (~15–25 s, como los eventos SSE), plan opcional,
 *  - V1, correcciones que crean V2, V3… con un "qué cambió" real (diffRecipes) y preguntas aclaratorias,
 *  - comparar, exportar (diálogo; sin descarga), estilos (guardar, usar, importar), reglas y glosario.
 * Nada sale del navegador.
 *
 * Videos de ejemplo: con `mediaBaseUrl` (p. ej. "./demo-media/") toma de esa carpeta v1.mp4, v2.mp4,
 * poster-v1.jpg, poster-v2.jpg, a-roll.mp4, a-roll-2.mp4, b-roll-1.mp4, b-roll-2.mp4, musica.mp3 si existen.
 */
import {
  Asset,
  GlossaryEntry,
  Job,
  Keyword,
  MemoryRule,
  Project,
  ProjectSettings,
  PublishCopy,
  Style,
  Transcript,
  Version,
  diffRecipes,
  summarizeChanges,
  type AssetCategory,
  type EstimateResponse,
  type EstimateWarning,
  type PipelineStage,
  type Plan,
  type ProjectDetail,
  type Recipe,
  type ServerEvent,
  type TranscriptWord,
} from "@autoeditor/shared";
import { nanoid } from "nanoid";
import { ApiRequestError } from "../api/errors.js";
import type { ApiClient, EventSubscription, SubscribeOptions } from "../api/types.js";
import {
  DEMO_CLIPS,
  DEMO_OWNER,
  DEMO_PROJECT_ID,
  demoAssets,
  demoConfig,
  demoCorrectionHistory,
  demoGlossary,
  demoKeywords,
  demoPlan,
  demoPosters,
  demoProjects,
  demoPublishCopy,
  demoRules,
  demoStyleSettings,
  demoStyleVersions,
  demoStyles,
  demoThumbs,
  demoTranscripts,
  demoVersions,
  wordsFrom,
} from "../fixtures/index.js";
import { posterThumb, sceneThumb } from "../fixtures/thumbs.js";
import { freshSettings } from "../lib/settings.js";
import { computeEstimate, preflightWarnings } from "../store/derive.js";
import { applyDemoCorrection } from "./corrections.js";
import { buildDemoRecipe, recipeFromAssets, withFormat } from "./recipes.js";

export interface DemoApiOptions {
  /** Carpeta con videos y portadas de ejemplo (p. ej. "./demo-media/"). Si un archivo no existe se usa la ilustración. */
  mediaBaseUrl?: string;
  /** Multiplica las esperas simuladas (en pruebas: 0.01). */
  timeScale?: number;
}

const nowIso = () => new Date().toISOString();
const clone = <T>(v: T): T => structuredClone(v);
const notFound = (what = "lo que buscabas") => new ApiRequestError(`No se encontró ${what}.`, 404, "no-encontrado");
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Guion de ejemplo para "transcribir" el material que sube la persona en la demo. */
const SAMPLE_SPEECH =
  "Hola, hoy te voy a mostrar algo que cambió por completo mi forma de trabajar. Son tres pasos muy simples y en menos de un minuto lo vas a entender. Primero, prepara todo con… perdón. Primero, prepara todo con calma. Segundo, enfócate en lo importante y quita lo que sobra. Y tercero, compártelo con alguien que lo necesite. Si te sirvió, guárdalo y sígueme para más.";

const SAMPLE_KEYWORDS: [string, Keyword["category"]][] = [
  ["te voy a mostrar", "gancho"],
  ["tres pasos", "tema"],
  ["menos de un minuto", "cifra"],
  ["muy simples", "beneficio"],
  ["sígueme para más", "cta"],
];

/** Mapa de assets de ejemplo → archivo en la carpeta de medios. */
const ASSET_MEDIA: Record<string, string> = {
  "a-entrevista": "a-roll.mp4",
  "a-testimonio": "a-roll-2.mp4",
  "a-producto": "b-roll-1.mp4",
  "a-calle": "b-roll-2.mp4",
  "a-musica": "musica.mp3",
};

/** Lee duración, tamaño y un fotograma de un archivo local; deja una URL blob: para reproducirlo. */
async function readMedia(file: File): Promise<{ duration: number | null; width: number | null; height: number | null; thumb: string | null; url: string | null }> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return { duration: null, width: null, height: null, thumb: null, url: null };
  const url = URL.createObjectURL(file);
  if (file.type.startsWith("image/")) {
    const dims = await new Promise<{ w: number; h: number } | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = url;
    });
    return { duration: null, width: dims?.w ?? null, height: dims?.h ?? null, thumb: url, url };
  }
  if (!file.type.startsWith("video/") && !file.type.startsWith("audio/")) return { duration: null, width: null, height: null, thumb: null, url };
  const frame = await captureFrame(url, file.type.startsWith("video/"));
  return { ...frame, url };
}

/** Metadatos y fotograma (data URL) de un video/audio por URL (mismo origen o blob:). */
function captureFrame(url: string, isVideo: boolean): Promise<{ duration: number | null; width: number | null; height: number | null; thumb: string | null }> {
  return new Promise((resolve) => {
    const el = document.createElement(isVideo ? "video" : "audio");
    let settled = false;
    const done = (thumb: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const v = el as HTMLVideoElement;
      resolve({ duration: Number.isFinite(el.duration) ? el.duration : null, width: v.videoWidth || null, height: v.videoHeight || null, thumb });
    };
    const timer = setTimeout(() => done(null), 5000);
    el.preload = "metadata";
    el.muted = true;
    (el as HTMLVideoElement).playsInline = true;
    el.onloadedmetadata = () => {
      if (el instanceof HTMLVideoElement) el.currentTime = Math.min(1, (el.duration || 2) / 3);
      else done(null);
    };
    el.onseeked = () => {
      try {
        const v = el as HTMLVideoElement;
        const canvas = document.createElement("canvas");
        const scale = 360 / Math.max(v.videoWidth, v.videoHeight, 1);
        canvas.width = Math.round(v.videoWidth * scale);
        canvas.height = Math.round(v.videoHeight * scale);
        canvas.getContext("2d")?.drawImage(v, 0, 0, canvas.width, canvas.height);
        done(canvas.toDataURL("image/jpeg", 0.82));
      } catch {
        done(null);
      }
    };
    el.onerror = () => done(null);
    el.src = url;
  });
}

function kindFor(category: AssetCategory, mime: string, name: string): Asset["kind"] {
  if (mime.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv)$/i.test(name)) return "video";
  if (mime.startsWith("image/") || /\.(jpe?g|png|webp|gif|svg|heic)$/i.test(name)) return "imagen";
  if (mime.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg)$/i.test(name)) return "audio";
  if (category === "guion" || /\.(pdf|docx?|txt)$/i.test(name)) return "documento";
  if (/\.(ttf|otf|woff2?)$/i.test(name)) return "fuente";
  return "otro";
}

function messageFor(stage: PipelineStage): string {
  switch (stage) {
    case "analizando":
      return "Revisando escenas, voz y tomas de B-roll…";
    case "transcribiendo":
      return "Transcribiendo palabra por palabra…";
    case "planeando":
      return "Claude está armando la edición…";
    case "esperando-aprobacion":
      return "Esperando tu aprobación del plan";
    case "generando-ia":
      return "Generando imágenes y clips con Kie AI…";
    case "motion-graphics":
      return "Animando gráficos con HyperFrames…";
    case "render":
      return "Renderizando el video…";
    case "revision-calidad":
      return "Claude revisa fotogramas del render contra tus reglas…";
    default:
      return "";
  }
}

/** Duración simulada de cada etapa (ms). GENERAR completo ≈ 15–25 s. */
const STAGE_MS: Record<PipelineStage, number> = {
  analizando: 2600,
  transcribiendo: 2200,
  planeando: 4200,
  "esperando-aprobacion": 0,
  "generando-ia": 3400,
  "motion-graphics": 2800,
  render: 4400,
  "revision-calidad": 2200,
  listo: 0,
};

interface StyleData {
  settings: ProjectSettings;
  font: string;
  rules: string[];
}

export function createDemoApi(options: DemoApiOptions = {}): ApiClient {
  const scale = options.timeScale ?? 1;
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms * scale)));
  const mediaBase = options.mediaBaseUrl ? options.mediaBaseUrl.replace(/\/?$/, "/") : null;

  const projects = new Map<string, Project>(demoProjects.map((p) => [p.id, clone(p)]));
  const assets = new Map<string, Asset>(demoAssets.map((a) => [a.id, clone(a)]));
  const versions = new Map<string, Version>(demoVersions.map((v) => [v.id, clone(v)]));
  const transcripts = new Map<string, Transcript>(demoTranscripts.map((t) => [t.id, clone(t)]));
  const keywords = new Map<string, Keyword[]>([[DEMO_PROJECT_ID, clone(demoKeywords)]]);
  const publishCopies = new Map<string, PublishCopy>([[DEMO_PROJECT_ID, clone(demoPublishCopy)]]);
  const jobs = new Map<string, Job>();
  const plans = new Map<string, Plan>();
  const styles = demoStyles.map(clone);
  const styleData = new Map<string, StyleData>([
    ["s-zyra", { settings: demoStyleSettings("s-zyra"), font: "Bebas Neue", rules: [] }],
    ["s-podcast", { settings: demoStyleSettings("s-podcast"), font: "Inter", rules: [] }],
  ]);
  let rules = demoRules.map(clone);
  let glossary = demoGlossary.map(clone);
  const posters = new Map(demoPosters);
  /** URLs reproducibles: archivos subidos (blob:) y medios de ejemplo. */
  const assetFiles = new Map<string, string>();
  const versionVideos = new Map<string, string>();
  const listeners = new Map<string, Set<(e: ServerEvent) => void>>();
  /** Reglas sugeridas tras una corrección (para registrar su origen si la persona dice "recuérdalo"). */
  const suggested = new Map<string, { correction: string; versionId: string }>();

  // ------------------------------------------------------------------ Medios de ejemplo (opcionales)
  const probes = new Map<string, boolean>();
  const probe = async (file: string): Promise<boolean> => {
    if (!mediaBase || typeof fetch === "undefined") return false;
    const url = mediaBase + file;
    if (probes.has(url)) return probes.get(url)!;
    let ok = false;
    try {
      const res = await fetch(url, { method: "HEAD", cache: "no-store" });
      // Un servidor de desarrollo puede responder index.html con 200: revisamos el tipo.
      ok = res.ok && /^(video|image|audio)\//.test(res.headers.get("content-type") ?? "");
    } catch {
      ok = false;
    }
    probes.set(url, ok);
    return ok;
  };
  const media = (file: string) => (mediaBase && probes.get(mediaBase + file) ? mediaBase + file : null);

  let prepared: Promise<void> | null = null;
  const prepare = () =>
    (prepared ??= (async () => {
      if (!mediaBase) return;
      const files = ["v1.mp4", "v2.mp4", "v3.mp4", "poster-v1.jpg", "poster-v2.jpg", "poster-v3.jpg", ...Object.values(ASSET_MEDIA)];
      await Promise.race([Promise.all(files.map(probe)), new Promise((r) => setTimeout(r, 3000))]);
      for (const [assetId, file] of Object.entries(ASSET_MEDIA)) {
        const url = media(file);
        if (!url) continue;
        assetFiles.set(assetId, url);
        const a = assets.get(assetId);
        if (a?.kind === "video" && typeof document !== "undefined") {
          const frame = await Promise.race([captureFrame(url, true), new Promise<null>((r) => setTimeout(() => r(null), 2500))]);
          if (frame?.thumb) demoThumbs.set(assetId, frame.thumb);
        }
      }
      for (const v of versions.values()) applyVersionMedia(v);
    })());

  /** Video y portada de una versión: medios de ejemplo (proyecto de ejemplo) o el clip principal de la persona. */
  const applyVersionMedia = (v: Version) => {
    if (v.projectId === DEMO_PROJECT_ID) {
      const alt = ((v.number - 1) % 2) + 1;
      const video = media(`v${v.number}.mp4`) ?? media(`v${alt}.mp4`);
      const poster = media(`poster-v${v.number}.jpg`) ?? media(`poster-v${alt}.jpg`);
      if (video) versionVideos.set(v.id, video);
      if (poster) posters.set(v.id, poster);
      return;
    }
    const first = v.recipe.tracks.video.find((c) => assetFiles.has(c.assetId) && assets.get(c.assetId)?.kind === "video");
    if (first) {
      versionVideos.set(v.id, assetFiles.get(first.assetId)!);
      const thumb = demoThumbs.get(first.assetId);
      if (thumb) posters.set(v.id, thumb);
    }
  };

  // ------------------------------------------------------------------ Utilidades
  const emit = (projectId: string | null, event: ServerEvent) => {
    if (!projectId) return;
    listeners.get(projectId)?.forEach((fn) => fn(clone(event)));
  };

  const getProject = (id: string) => {
    const p = projects.get(id);
    if (!p) throw notFound("ese proyecto");
    return p;
  };

  const touch = (projectId: string, patch: Partial<Project> = {}) => {
    const p = projects.get(projectId);
    if (p) projects.set(projectId, { ...p, ...patch, updatedAt: nowIso() });
  };

  const updateJob = (job: Job, patch: Partial<Job>) => {
    const next = { ...(jobs.get(job.id) ?? job), ...patch };
    jobs.set(job.id, next);
    emit(next.projectId, { type: "job.updated", job: next });
    return next;
  };

  const wordsByAsset = (projectId: string) => {
    const m = new Map<string, TranscriptWord[]>();
    for (const t of transcripts.values()) if (t.projectId === projectId && t.status === "listo") m.set(t.assetId, t.words);
    return m;
  };

  const projectAssets = (projectId: string) => [...assets.values()].filter((a) => a.projectId === projectId);
  const projectVersions = (projectId: string) => [...versions.values()].filter((v) => v.projectId === projectId).sort((a, b) => a.number - b.number);

  const newJob = (projectId: string, type: Job["type"], input: Record<string, unknown> = {}, estimatedMs = 12000): Job =>
    Job.parse({ id: `job-${nanoid(6)}`, ownerId: DEMO_OWNER, projectId, type, status: "en-cola", input, estimatedSeconds: Math.round((estimatedMs * scale) / 100) / 10, createdAt: nowIso() });

  // ------------------------------------------------------------------ Análisis y transcripción simulados
  const simulateTranscription = async (asset: Asset) => {
    if (!asset.projectId) return;
    const id = `t-${asset.id}`;
    const base = Transcript.parse({ id, ownerId: DEMO_OWNER, projectId: asset.projectId, assetId: asset.id, language: "es", provider: "demo", model: "demo", status: "transcribiendo", createdAt: nowIso(), updatedAt: nowIso() });
    transcripts.set(id, base);
    emit(asset.projectId, { type: "transcript.updated", transcript: clone(base) });
    await wait(1800);
    const d = asset.probe.duration ?? 20;
    const all = wordsFrom(SAMPLE_SPEECH, 0.4);
    const words = all.filter((w) => w.end <= Math.max(4, d - 0.2));
    const done = Transcript.parse({ ...base, status: "listo", words: words.length ? words : all.slice(0, 12), updatedAt: nowIso() });
    transcripts.set(id, done);
    emit(asset.projectId, { type: "transcript.updated", transcript: clone(done) });
    // Palabras clave detectadas (si aún no hay).
    if (!keywords.get(asset.projectId)?.length) {
      await wait(900);
      const list = SAMPLE_KEYWORDS.map(([text, category], i) =>
        Keyword.parse({ id: `k-${nanoid(5)}`, text, category, source: "auto", enabled: true, score: 0.9 - i * 0.08, occurrences: [{ assetId: asset.id, wordIndex: 0, t: 0 }] }),
      );
      keywords.set(asset.projectId, list);
      publishCopies.set(asset.projectId, PublishCopy.parse({ title: "Tres pasos que cambiaron mi forma de trabajar", description: "En menos de un minuto: prepara, enfócate y comparte.", hashtags: ["#productividad", "#tips", "#reels"], coverText: "3 PASOS SIMPLES" }));
      emit(asset.projectId, { type: "keywords.updated", keywords: clone(list) });
    }
  };

  /** Clasifica la toma (A-roll / B-roll) con pistas del nombre y la duración. */
  const roleFor = (a: Asset): Asset["analysis"]["role"] => {
    if (a.kind !== "video") return "desconocido";
    // El clip base es la columna del video: habla y, si es largo, también partes sin voz.
    if (a.category === "clip-base") return (a.probe.duration ?? 0) > 12 ? "mixto" : "a-roll";
    const name = a.originalName.toLowerCase();
    if (/(entrevista|habla|selfie|testimonio|vlog|podcast|a-?roll|cam|charla|explica)/.test(name)) return "a-roll";
    if (/(b-?roll|paisaje|producto|detalle|ambiente|toma|drone|calle|plano)/.test(name)) return "b-roll";
    const hasAroll = projectAssets(a.projectId ?? "").some((x) => x.id !== a.id && x.analysis.role === "a-roll");
    if (!hasAroll) return "a-roll";
    return (a.probe.duration ?? 0) > 15 ? "mixto" : "b-roll";
  };

  const simulateAnalysis = async (asset: Asset) => {
    await wait(700);
    let a: Asset = { ...(assets.get(asset.id) ?? asset), analysis: { ...asset.analysis, status: "analizando" } };
    if (!assets.has(a.id)) return;
    assets.set(a.id, a);
    emit(a.projectId, { type: "asset.updated", asset: clone(a) });
    await wait(1800);
    if (!assets.has(a.id)) return;
    const role = roleFor(a);
    const d = a.probe.duration ?? 8;
    const speech = a.kind === "audio" ? a.category === "crudo-voz" : role === "a-roll" || role === "mixto";
    const pauses: [number, number][] = a.kind === "video" && speech && d > 6 ? [[Math.round(d * 0.22 * 10) / 10, Math.round(d * 0.22 * 10) / 10 + 1.6], [Math.round(d * 0.58 * 10) / 10, Math.round(d * 0.58 * 10) / 10 + 1.2]] : [];
    a = {
      ...(assets.get(a.id) ?? a),
      analysis: {
        ...a.analysis,
        status: "listo",
        hasSpeech: a.kind === "imagen" ? false : speech,
        role,
        scenes: a.kind === "video" ? [0, Math.round(d * 0.35 * 10) / 10, Math.round(d * 0.7 * 10) / 10] : [],
        loudness: a.kind === "video" || a.kind === "audio" ? -18.5 : null,
        silences: pauses,
        brollSegments:
          role === "b-roll"
            ? [{ start: Math.min(0.5, d / 4), end: Math.max(1, Math.round(d * 0.8 * 10) / 10), score: 0.82, description: "Toma estable aprovechable como B-roll", tags: ["apoyo"] }]
            : role === "mixto"
              ? [{ start: Math.round(d * 0.65 * 10) / 10, end: Math.round(d * 0.95 * 10) / 10, score: 0.68, description: "Parte sin voz, buena para cubrir cortes", tags: ["apoyo"] }]
              : [],
        description: role === "b-roll" ? "Toma de apoyo sin voz." : role === "a-roll" ? "Persona hablando a cámara." : role === "mixto" ? (a.category === "clip-base" ? "Hablas a cámara y hay tomas de apoyo sin voz." : "Habla y luego muestra el producto.") : "",
      },
    };
    assets.set(a.id, a);
    emit(a.projectId, { type: "asset.updated", asset: clone(a) });
    if (speech && (a.category === "clip-base" || a.category === "crudo-video" || a.category === "crudo-voz")) void simulateTranscription(a);
    if (a.category === "clip-base" && a.projectId) suggestOrder(a.projectId);
  };

  /**
   * Orden sugerido de los clips base (como el servidor): cuando todos están analizados, los ordena
   * por hora de grabación y nombre. Si la persona ya los reacomodó a mano, no se toca.
   */
  const recordedAt = new Map<string, number>();
  const manualOrder = new Set<string>();
  const suggestOrder = (projectId: string) => {
    if (manualOrder.has(projectId)) return;
    const base = projectAssets(projectId).filter((x) => x.category === "clip-base");
    if (base.length < 2 || base.some((x) => x.analysis.status !== "listo" && x.analysis.status !== "error")) return;
    const sorted = [...base].sort((x, y) => (recordedAt.get(x.id) ?? 0) - (recordedAt.get(y.id) ?? 0) || x.originalName.localeCompare(y.originalName, "es", { numeric: true }));
    sorted.forEach((x, i) => {
      if (x.order === i) return;
      const next = { ...x, order: i };
      assets.set(x.id, next);
      emit(projectId, { type: "asset.updated", asset: clone(next) });
    });
  };

  // ------------------------------------------------------------------ Recetas
  const styleFontFor = (p: Project) => (p.settings.style.styleId ? styleData.get(p.settings.style.styleId)?.font : undefined);

  const recipeFor = (p: Project): Recipe => {
    const s = p.settings;
    const applied = rules.filter((r) => r.enabled && (r.scope === "global" || r.scopeId === p.id || r.scopeId === s.style.styleId)).map((r) => r.id);
    let recipe: Recipe;
    if (p.id === DEMO_PROJECT_ID) {
      recipe = buildDemoRecipe({
        aspect: s.instruction.format,
        platform: s.instruction.platform,
        clips: DEMO_CLIPS,
        titleFont: styleFontFor(p) ?? "Inter",
        shotLength: s.tools.pacing.value === "rapido" ? 1.6 : s.tools.pacing.value === "lento" ? 4 : 2.5,
        target: { duration: s.instruction.targetDuration, mode: s.instruction.durationMode },
        hook: s.tools.titles.enabled ? "¿SABÍAS QUE…?" : undefined,
        keywordText: s.tools.titles.enabled ? "5 MINUTOS" : undefined,
        cta: s.tools.cta.enabled ? (s.tools.cta.text || "VISÍTANOS").toUpperCase() : null,
        musicAssetId: s.tools.music.enabled ? "a-musica" : null,
        sfxAssetId: s.tools.sfx.enabled ? "a-sfx" : null,
        brollOverlay: s.tools.broll.enabled ? { assetId: "a-producto", at: 13.2, duration: 3.2, sourceIn: 6.2 } : null,
        logoAssetId: "a-logo",
        motion: s.tools.motionGraphics.enabled,
        highlightWords: (keywords.get(p.id) ?? []).filter((k) => k.enabled).map((k) => k.text),
        transcripts: wordsByAsset(p.id),
        notes: "Abro con la pregunta del gancho, muestro el proceso con B-roll de fondo, meto el testimonio como prueba social y cierro con la invitación del fin de semana.",
      });
    } else {
      const kws = (keywords.get(p.id) ?? []).filter((k) => k.enabled).map((k) => k.text);
      recipe = recipeFromAssets(projectAssets(p.id), s, wordsByAsset(p.id), kws);
      const font = styleFontFor(p);
      if (font) {
        recipe.style.titleFont = { ...recipe.style.titleFont, family: font };
        recipe.tracks.captions.style.font = { ...recipe.tracks.captions.style.font, family: font };
      }
    }
    recipe.tracks.captions.style = { ...recipe.tracks.captions.style, ...s.captions.style, font: recipe.tracks.captions.style.font };
    recipe.tracks.captions.enabled = s.captions.enabled;
    recipe.meta = { ...recipe.meta, styleId: s.style.styleId, styleVersion: s.style.styleVersion, appliedRuleIds: applied };
    return withFormat(recipe, s.instruction.format, s.instruction.platform);
  };

  const aiPromptsFor = (p: Project) => {
    const out: { kind: string; prompt: string; model: string; costUsd: number | null }[] = [];
    const t = p.settings.tools;
    const model = (kind: string) => demoConfig.kieModels.find((m) => m.kind === kind);
    if (t.aiImages.enabled) {
      const m = model("imagen");
      for (let i = 0; i < Math.min(3, t.aiImages.max); i++) out.push({ kind: "imagen", prompt: [`Primer plano de ingredientes sobre mesa de madera, ${t.aiImages.style}`, `Taza humeante con luz de mañana, ${t.aiImages.style}`, `Fachada de cafetería de barrio al amanecer, ${t.aiImages.style}`][i]!, model: m?.label ?? "Imagen", costUsd: m?.costUsd ?? null });
    }
    if (t.aiVideos.enabled) {
      const m = model("video");
      out.push({ kind: "video", prompt: `Toma lenta de vapor saliendo de una olla de barro, ${t.aiVideos.duration} s`, model: m?.label ?? "Video", costUsd: m?.costUsd ?? null });
    }
    return out;
  };

  const createVersion = (projectId: string, parent: Version | null, recipe: Recipe, extra: { correction?: string | null; at?: number | null; summary?: string; changes?: Version["changes"]; costUsd?: number; renderSeconds?: number } = {}) => {
    const list = projectVersions(projectId);
    const number = list.reduce((m, v) => Math.max(m, v.number), 0) + 1;
    const p = getProject(projectId);
    const target = recipe.target;
    const qa = [
      { check: `Subtítulos dentro de la zona segura (${p.settings.instruction.platform})`, ok: true, detail: "" },
      { check: target.duration != null && target.mode !== "auto" ? `Duración ${recipe.duration.toFixed(1)} s (objetivo ${target.duration} s, ${target.mode})` : `Duración ${recipe.duration.toFixed(1)} s`, ok: true, detail: "" },
      ...(extra.correction ? [{ check: "Solo cambió lo que pediste (regla de oro)", ok: true, detail: "" }] : [{ check: "Sin palabras cortadas a la mitad", ok: true, detail: "" }]),
      ...(recipe.meta.appliedRuleIds.length ? [{ check: `Cumple ${recipe.meta.appliedRuleIds.length} reglas aprendidas`, ok: true, detail: "" }] : []),
    ];
    const v = Version.parse({
      id: `v-${nanoid(6)}`,
      ownerId: DEMO_OWNER,
      projectId,
      number,
      parentId: parent?.id ?? null,
      recipe,
      correction: extra.correction ?? null,
      correctionAt: extra.at ?? null,
      changes: extra.changes ?? [],
      changeSummary: extra.summary ?? "",
      status: "lista",
      videoKey: `demo/${number}.mp4`,
      posterKey: `demo/poster-${number}.jpg`,
      publishCopy: publishCopies.get(projectId) ?? {},
      qa,
      renderSeconds: extra.renderSeconds ?? (parent ? 84 : 290),
      costUsd: extra.costUsd ?? (parent ? 0.07 : 0.38),
      createdAt: nowIso(),
    });
    versions.set(v.id, v);
    posters.set(v.id, posterThumb(number, p.settings.instruction.format !== "16:9", recipe.style.titleFont.family));
    applyVersionMedia(v);
    touch(projectId, { currentVersionId: v.id, status: "listo" });
    emit(projectId, { type: "version.created", version: clone(v) });
    emit(projectId, { type: "project.updated", project: clone(projects.get(projectId)!) });
    return v;
  };

  /** Corre un trabajo etapa por etapa con progreso en vivo (como los eventos SSE del servidor). */
  const runStages = async (jobId: string, stages: PipelineStage[], from = 0, total = stages.length): Promise<boolean> => {
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]!;
      let cur = jobs.get(jobId);
      if (!cur || cur.status === "cancelado") return false;
      const base = (from + i) / total;
      cur = updateJob(cur, { status: "corriendo", stage, progress: base, message: messageFor(stage), startedAt: cur.startedAt ?? nowIso() });
      emit(cur.projectId, { type: "job.stage", jobId, stage, message: messageFor(stage), progress: base });
      const ms = STAGE_MS[stage] || 1000;
      const ticks = Math.max(2, Math.round(ms / 450));
      for (let k = 1; k <= ticks; k++) {
        await wait(ms / ticks);
        const now = jobs.get(jobId);
        if (!now || now.status === "cancelado") return false;
        if (k < ticks) updateJob(now, { progress: base + (k / ticks) * (1 / total) });
      }
    }
    return true;
  };

  const finishJob = (jobId: string, result: Record<string, unknown> | null = null, message = "Listo") => {
    const j = jobs.get(jobId);
    if (!j || j.status === "cancelado") return;
    const started = Date.parse(j.startedAt ?? j.createdAt);
    updateJob(j, { status: "listo", stage: "listo", progress: 1, finishedAt: nowIso(), message, result, stageTimings: { total: Math.round((Date.now() - started) / 100) / 10 } });
  };

  const generationStages = (p: Project): { before: PipelineStage[]; after: PipelineStage[] } => {
    const after: PipelineStage[] = [];
    if (p.settings.engines.kie) after.push("generando-ia");
    if (p.settings.tools.motionGraphics.enabled) after.push("motion-graphics");
    after.push("render", "revision-calidad");
    return { before: ["analizando", "transcribiendo", "planeando"], after };
  };

  const runGeneration = async (job: Job, p: Project) => {
    const { before, after } = generationStages(p);
    const total = before.length + after.length;
    if (!(await runStages(job.id, before, 0, total))) return;
    const fresh = getProject(p.id);
    const recipe = recipeFor(fresh);
    if (fresh.settings.instruction.reviewPlan) {
      const plan = demoPlan(p.id, job.id, recipe, aiPromptsFor(fresh));
      plans.set(plan.id, plan);
      const j = updateJob(jobs.get(job.id)!, { status: "esperando", stage: "esperando-aprobacion", message: messageFor("esperando-aprobacion"), progress: before.length / total, input: { ...job.input, planId: plan.id } });
      emit(p.id, { type: "job.stage", jobId: j.id, stage: "esperando-aprobacion", message: j.message, progress: j.progress });
      emit(p.id, { type: "plan.ready", plan: clone(plan) });
      return;
    }
    if (!(await runStages(job.id, after, before.length, total))) return;
    const v = createVersion(p.id, null, recipe, { costUsd: 0.32 + aiPromptsFor(fresh).reduce((s, a) => s + (a.costUsd ?? 0), 0) });
    finishJob(job.id, { versionId: v.id });
  };

  // ------------------------------------------------------------------ API
  const api: ApiClient & { prepare: () => Promise<void> } = {
    baseUrl: "demo://",
    isDemo: true,
    prepare,

    health: async () => ({ ok: true }),
    getConfig: async () => {
      await Promise.all([wait(120), prepare()]);
      return clone(demoConfig);
    },

    // -------------------------------------------------------------- Proyectos
    listProjects: async () =>
      [...projects.values()]
        .map((p) => ({ ...clone(p), assetCount: projectAssets(p.id).length, versionCount: projectVersions(p.id).length, coverAssetId: p.thumbnailAssetId }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    createProject: async (body) => {
      await wait(150);
      const id = `p-${nanoid(6)}`;
      const style = body.styleId ? styles.find((s) => s.id === body.styleId) : null;
      let settings = body.settings ? ProjectSettings.parse({ ...freshSettings(), ...clone(body.settings) }) : freshSettings();
      if (style) {
        settings = clone(styleData.get(style.id)?.settings ?? demoStyleSettings(style.id));
        settings.instruction.text = "";
        settings.style = { styleId: style.id, styleVersion: style.currentVersion };
        style.timesUsed += 1;
      }
      const p = Project.parse({
        id,
        ownerId: DEMO_OWNER,
        name: style && (!body.name || body.name === "Proyecto nuevo con estilo") ? `Nuevo · ${style.name}` : (body.name ?? "Proyecto sin título"),
        settings: ProjectSettings.parse({ ...settings, ...(body.settings ?? {}) }),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      projects.set(id, p);
      return clone(p);
    },
    getProject: async (projectId): Promise<ProjectDetail> => {
      await wait(80);
      const project = getProject(projectId);
      const active = [...jobs.values()].find((j) => j.projectId === projectId && (j.type === "generar" || j.type === "corregir") && (j.status === "corriendo" || j.status === "en-cola" || j.status === "esperando")) ?? null;
      const pending = [...plans.values()].find((pl) => pl.projectId === projectId && (pl.status === "pendiente" || pl.status === "ajustando")) ?? null;
      return clone({ project, assets: projectAssets(projectId), versions: projectVersions(projectId), activeJob: active, pendingPlan: pending });
    },
    updateProject: async (projectId, body) => {
      await wait(150);
      const p = getProject(projectId);
      const next = Project.parse({
        ...p,
        ...(body.name ? { name: body.name } : {}),
        ...(body.settings ? { settings: body.settings } : {}),
        ...(body.currentVersionId !== undefined ? { currentVersionId: body.currentVersionId } : {}),
        updatedAt: nowIso(),
      });
      projects.set(projectId, next);
      return clone(next);
    },
    deleteProject: async (projectId) => {
      projects.delete(projectId);
    },

    // -------------------------------------------------------------- Archivos
    uploadAsset: async (projectId, file, category, opts) => {
      getProject(projectId);
      const id = `a-${nanoid(6)}`;
      const info = await readMedia(file);
      const steps = Math.max(6, Math.min(24, Math.round(file.size / 4_000_000)));
      for (let i = 1; i <= steps; i++) {
        if (opts?.signal?.aborted) throw new ApiRequestError("Se canceló la operación.", 0, "abortado");
        await wait(70);
        opts?.onProgress?.(i / steps, (file.size * i) / steps, file.size);
      }
      const kind = kindFor(category, file.type, file.name);
      const thumb = info.thumb ?? (kind === "video" ? sceneThumb("persona", (info.height ?? 0) > (info.width ?? 0)) : kind === "audio" ? sceneThumb(category === "musica" ? "ondas" : "voz") : null);
      if (thumb) demoThumbs.set(id, thumb);
      if (info.url) assetFiles.set(id, info.url);
      const order = projectAssets(projectId).filter((a) => a.category === category).length;
      if (file.lastModified) recordedAt.set(id, file.lastModified);
      const asset = Asset.parse({
        id,
        ownerId: DEMO_OWNER,
        projectId,
        category,
        kind,
        originalName: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        storageKey: `demo/${id}`,
        probe: { duration: info.duration, width: info.width, height: info.height, fps: kind === "video" ? 30 : null, hasVideo: kind === "video", hasAudio: kind === "video" || kind === "audio" },
        analysis: { status: kind === "video" || kind === "audio" ? "pendiente" : "listo" },
        thumbnailKey: thumb ? `demo/${id}` : null,
        order,
        createdAt: nowIso(),
      });
      assets.set(id, asset);
      const p = getProject(projectId);
      touch(projectId, !p.thumbnailAssetId && (kind === "video" || kind === "imagen") && (category === "clip-base" || category.startsWith("crudo")) ? { thumbnailAssetId: id } : {});
      if (asset.analysis.status === "pendiente") void simulateAnalysis(asset);
      return clone(asset);
    },
    listAssets: async (projectId) => projectAssets(projectId).map(clone),
    updateAsset: async (assetId, body) => {
      const a = assets.get(assetId);
      if (!a) throw notFound("ese archivo");
      const { role, ...rest } = body;
      if (rest.order !== undefined && a.projectId) manualOrder.add(a.projectId);
      const next = Asset.parse({ ...a, ...rest, analysis: role ? { ...a.analysis, role } : a.analysis });
      assets.set(assetId, next);
      return clone(next);
    },
    deleteAsset: async (assetId) => {
      assets.delete(assetId);
    },
    assetFileUrl: (asset) => {
      const id = typeof asset === "string" ? asset : asset.id;
      return assetFiles.get(id) ?? demoThumbs.get(id) ?? "";
    },
    assetThumbnailUrl: (asset) => demoThumbs.get(typeof asset === "string" ? asset : asset.id) ?? null,
    assetFrameUrl: (asset) => demoThumbs.get(typeof asset === "string" ? asset : asset.id) ?? "",

    // -------------------------------------------------------------- Transcripción y palabras clave
    listTranscripts: async (projectId) => [...transcripts.values()].filter((t) => t.projectId === projectId).map(clone),
    updateTranscriptWords: async (transcriptId, body) => {
      const t = transcripts.get(transcriptId);
      if (!t) throw notFound("esa transcripción");
      const words = t.words.map((w) => {
        const e = body.edits.find((x) => x.i === w.i);
        if (!e) return w;
        return { ...w, text: e.text ?? w.text, mark: e.mark === undefined ? w.mark : e.mark, original: e.text && e.text !== w.text ? (w.original ?? w.text) : w.original };
      });
      if (body.saveToGlossary !== false) {
        for (const e of body.edits) {
          const w = t.words.find((x) => x.i === e.i);
          if (!w || !e.text || e.text === w.text) continue;
          const term = e.text.replace(/[.,;:!?¿¡]+$/g, "");
          const variant = (w.original ?? w.text).replace(/[.,;:!?¿¡]+$/g, "");
          const existing = glossary.find((g) => g.term.toLowerCase() === term.toLowerCase());
          if (existing) existing.variants = [...new Set([...existing.variants, variant])];
          else glossary = [GlossaryEntry.parse({ id: `g-${nanoid(5)}`, ownerId: DEMO_OWNER, term, variants: [variant], scope: "global", createdAt: nowIso() }), ...glossary];
        }
      }
      const next = { ...t, words, updatedAt: nowIso() };
      transcripts.set(t.id, next);
      return clone(next);
    },
    getKeywords: async (projectId) => ({ keywords: clone(keywords.get(projectId) ?? []), publishCopy: clone(publishCopies.get(projectId) ?? null) }),
    putKeywords: async (projectId, list) => {
      keywords.set(projectId, clone(list));
      return clone(list);
    },
    detectKeywords: async (projectId) => {
      await wait(900);
      if (!keywords.get(projectId)?.length) {
        keywords.set(
          projectId,
          SAMPLE_KEYWORDS.map(([text, category], i) => Keyword.parse({ id: `k-${nanoid(5)}`, text, category, source: "auto", enabled: true, score: 0.9 - i * 0.08 })),
        );
      }
      return { keywords: clone(keywords.get(projectId) ?? []), publishCopy: clone(publishCopies.get(projectId) ?? null) };
    },
    retranscribe: async (assetId) => {
      const a = assets.get(assetId);
      if (!a || !a.projectId) throw notFound("ese archivo");
      const job = newJob(a.projectId, "transcribir", { assetId }, 2000);
      jobs.set(job.id, job);
      void simulateTranscription(a).then(() => updateJob(job, { status: "listo", progress: 1, finishedAt: nowIso() }));
      return clone(job);
    },

    // -------------------------------------------------------------- Estimado, generar, plan y trabajos
    estimate: async (projectId, settings) => {
      await wait(60);
      const p = getProject(projectId);
      const s = settings ?? p.settings;
      const list = projectAssets(projectId);
      const est = computeEstimate(demoConfig, s, list, [...transcripts.values()].filter((t) => t.projectId === projectId));
      if (!est) throw new ApiRequestError("No se pudo estimar.", 500, "estimado");
      const warnings: EstimateWarning[] = preflightWarnings(s, list).map((w) => ({ code: w.id, level: w.severity === "bloqueo" ? "aviso" : "info", message: w.text }));
      if (s.tools.aiImages.enabled || s.tools.aiVideos.enabled) warnings.push({ code: "demo-ia", level: "info", message: "En la demo no se gastan créditos de Kie AI: el costo es una simulación." });
      const videos = list.filter((a) => a.category === "clip-base" || a.category === "crudo-video");
      const res: EstimateResponse = {
        ...est,
        warnings,
        material: {
          videoMinutes: videos.reduce((sum, a) => sum + (a.probe.duration ?? 0), 0) / 60,
          speechMinutesPending: 0,
          unanalyzedMinutes: 0,
          photos: list.filter((a) => a.category === "crudo-foto").length,
          inferredDurationSeconds: 30,
          brollSeconds: videos.reduce((sum, a) => sum + a.analysis.brollSegments.reduce((x, b) => x + (b.end - b.start), 0), 0),
          aRollAssets: videos.filter((a) => a.analysis.role === "a-roll" || a.analysis.role === "mixto").length,
          bRollAssets: videos.filter((a) => a.analysis.role === "b-roll" || a.analysis.role === "mixto").length,
          availableSeconds: videos.reduce((sum, a) => sum + (a.probe.duration ?? 0), 0) + list.filter((a) => a.category === "crudo-foto").length * 3,
        },
      };
      return res;
    },
    generate: async (projectId) => {
      await wait(120);
      const p = getProject(projectId);
      const raw = projectAssets(projectId).filter((a) => a.category === "clip-base" || a.category === "crudo-video" || a.category === "crudo-foto");
      if (!raw.length) throw new ApiRequestError("Sube tu clip base (el video principal) antes de generar.", 422, "sin-material");
      const running = [...jobs.values()].find((j) => j.projectId === projectId && (j.status === "corriendo" || j.status === "en-cola" || j.status === "esperando"));
      if (running) throw new ApiRequestError("Ya hay un trabajo en curso en este proyecto.", 409, "en-curso");
      const { before, after } = generationStages(p);
      const ms = [...before, ...after].reduce((s, st) => s + STAGE_MS[st], 0);
      const job = newJob(projectId, "generar", {}, ms);
      jobs.set(job.id, job);
      touch(projectId, { status: "procesando" });
      void runGeneration(job, p);
      return clone(job);
    },
    getPlan: async (planId) => {
      const pl = plans.get(planId);
      if (!pl) throw notFound("ese plan");
      return clone(pl);
    },
    approvePlan: async (planId) => {
      const pl = plans.get(planId);
      if (!pl) throw notFound("ese plan");
      const job = pl.jobId ? jobs.get(pl.jobId) : undefined;
      if (!job || !job.projectId) throw notFound("el trabajo del plan");
      plans.set(planId, { ...pl, status: "aprobado", updatedAt: nowIso() });
      const p = getProject(job.projectId);
      const { before, after } = generationStages(p);
      const total = before.length + after.length;
      const resumed = updateJob(job, { status: "corriendo", message: "Plan aprobado: renderizando…" });
      void (async () => {
        if (!(await runStages(job.id, after, before.length, total))) return;
        const v = createVersion(p.id, null, pl.recipe, { costUsd: 0.3 + pl.estimatedCostUsd });
        finishJob(job.id, { versionId: v.id });
      })();
      return clone(resumed);
    },
    revisePlan: async (planId, feedback) => {
      const pl = plans.get(planId);
      if (!pl) throw notFound("ese plan");
      const job = pl.jobId ? jobs.get(pl.jobId) : undefined;
      if (!job) throw notFound("el trabajo del plan");
      const adjusting = { ...pl, status: "ajustando" as const, feedback: [...pl.feedback, { text: feedback, at: nowIso() }], updatedAt: nowIso() };
      plans.set(planId, adjusting);
      emit(pl.projectId, { type: "plan.ready", plan: clone(adjusting) });
      const j = updateJob(job, { message: "Claude está ajustando el plan…" });
      void (async () => {
        await wait(2600);
        const res = applyDemoCorrection(pl.recipe, feedback, null, wordsByAsset(pl.projectId));
        const recipe = res.clarifyingQuestion ? pl.recipe : res.recipe;
        const p = getProject(pl.projectId);
        const fresh = demoPlan(pl.projectId, job.id, recipe, aiPromptsFor(p));
        const revised: Plan = {
          ...fresh,
          id: pl.id,
          feedback: adjusting.feedback,
          summary: res.clarifyingQuestion ? `${pl.summary} (No entendí bien el ajuste: ${res.clarifyingQuestion})` : `${res.summary.replace(" Todo lo demás quedó idéntico.", "")}. ${pl.summary}`,
          createdAt: pl.createdAt,
        };
        plans.set(planId, revised);
        updateJob(jobs.get(job.id)!, { message: messageFor("esperando-aprobacion") });
        emit(pl.projectId, { type: "plan.ready", plan: clone(revised) });
      })();
      return clone(j);
    },
    getJob: async (jobId) => {
      const j = jobs.get(jobId);
      if (!j) throw notFound("ese trabajo");
      return clone(j);
    },
    cancelJob: async (jobId) => {
      const j = jobs.get(jobId);
      if (!j) throw notFound("ese trabajo");
      for (const [id, pl] of plans) if (pl.jobId === jobId && pl.status !== "aprobado") plans.set(id, { ...pl, status: "descartado" });
      if (j.projectId) touch(j.projectId, { status: projectVersions(j.projectId).length ? "listo" : "borrador" });
      return clone(updateJob(j, { status: "cancelado", finishedAt: nowIso(), message: "Cancelado" }));
    },
    retryJob: async (jobId) => {
      const j = jobs.get(jobId);
      if (!j || !j.projectId) throw notFound("ese trabajo");
      if (j.type === "corregir" && typeof j.input.versionId === "string" && typeof j.input.text === "string") {
        return api.correct(j.input.versionId, { text: j.input.text, at: typeof j.input.at === "number" ? j.input.at : null });
      }
      return api.generate(j.projectId);
    },
    subscribe: (projectId, options: SubscribeOptions): EventSubscription => {
      const set = listeners.get(projectId) ?? new Set();
      set.add(options.onEvent);
      listeners.set(projectId, set);
      options.onStatus?.("conectado");
      return {
        close() {
          set.delete(options.onEvent);
          options.onStatus?.("cerrado");
        },
      };
    },

    // -------------------------------------------------------------- Versiones
    listVersions: async (projectId) => projectVersions(projectId).map(clone),
    getVersion: async (versionId) => {
      const v = versions.get(versionId);
      if (!v) throw notFound("esa versión");
      return clone(v);
    },
    versionVideoUrl: (version) => versionVideos.get(typeof version === "string" ? version : version.id) ?? null,
    versionPosterUrl: (version) => posters.get(version.id) ?? null,
    correct: async (versionId, body) => {
      await wait(120);
      const parent = versions.get(versionId);
      if (!parent) throw notFound("esa versión");
      const projectId = parent.projectId;
      const running = [...jobs.values()].find((j) => j.projectId === projectId && (j.status === "corriendo" || j.status === "en-cola" || j.status === "esperando"));
      if (running) throw new ApiRequestError("Espera a que termine el trabajo en curso.", 409, "en-curso");
      const at = body.at ?? null;
      const stages: PipelineStage[] = ["planeando", "render", "revision-calidad"];
      const job = newJob(projectId, "corregir", { versionId, text: body.text, at }, 2600 + STAGE_MS.render + STAGE_MS["revision-calidad"]);
      jobs.set(job.id, job);
      void (async () => {
        if (!(await runStages(job.id, ["planeando"], 0, stages.length))) return;
        const res = applyDemoCorrection(parent.recipe, body.text, at, wordsByAsset(projectId));
        if (res.clarifyingQuestion) {
          finishJob(job.id, { clarifyingQuestion: res.clarifyingQuestion }, "Necesito una aclaración antes de renderizar");
          return;
        }
        if (!(await runStages(job.id, ["render", "revision-calidad"], 1, stages.length))) return;
        const changes = diffRecipes(parent.recipe, res.recipe);
        const v = createVersion(projectId, parent, res.recipe, { correction: body.text, at, summary: res.summary || summarizeChanges(changes), changes });
        const remember = body.remember ?? null;
        if (res.ruleSuggestion) {
          if (remember && remember !== "no") {
            const p = getProject(projectId);
            const scope = remember === "siempre" ? "global" : remember;
            rules = [newRule(res.ruleSuggestion, scope, scope === "proyecto" ? projectId : scope === "estilo" ? p.settings.style.styleId : null, { type: "correccion", excerpt: body.text, refId: v.id }), ...rules];
          } else if (remember == null) {
            suggested.set(res.ruleSuggestion, { correction: body.text, versionId: v.id });
            emit(projectId, { type: "rule.suggested", suggestion: { text: res.ruleSuggestion, versionId: v.id, correction: body.text } });
          }
        }
        finishJob(job.id, { versionId: v.id, ruleSuggestion: res.ruleSuggestion ? { text: res.ruleSuggestion, check: null } : null });
      })();
      return clone(job);
    },
    rate: async (versionId, body) => {
      const v = versions.get(versionId);
      if (!v) throw notFound("esa versión");
      const next = { ...v, rating: body.rating ?? null };
      versions.set(versionId, next);
      emit(v.projectId, { type: "version.updated", version: clone(next) });
      return clone(next);
    },
    compare: async (a, b) => {
      await wait(150);
      const va = versions.get(a);
      const vb = versions.get(b);
      if (!va || !vb) throw notFound("esas versiones");
      const changes = diffRecipes(va.recipe, vb.recipe);
      return { a: clone(va), b: clone(vb), changes, summary: summarizeChanges(changes) };
    },
    exportVersion: async (versionId, body) => {
      await wait(300);
      const v = versions.get(versionId);
      if (!v) throw notFound("esa versión");
      const next = { ...v, exported: true };
      versions.set(versionId, next);
      emit(v.projectId, { type: "version.updated", version: clone(next) });
      const job = newJob(v.projectId, "exportar", { versionId, ...(body ?? {}) }, 3000);
      const done = { ...job, status: "listo" as const, stage: "listo" as const, progress: 1, message: "Exportación simulada (demo)", finishedAt: nowIso() };
      jobs.set(job.id, done);
      emit(v.projectId, { type: "job.updated", job: clone(done) });
      return clone(done);
    },
    downloadUrl: () => "#",
    restoreVersion: async (versionId) => {
      await wait(150);
      const v = versions.get(versionId);
      if (!v) throw notFound("esa versión");
      touch(v.projectId, { currentVersionId: versionId });
      const p = getProject(v.projectId);
      emit(p.id, { type: "project.updated", project: clone(p) });
      return clone(p);
    },

    // -------------------------------------------------------------- Estilos
    listStyles: async () => styles.map(clone).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    createStyle: async (body) => {
      await wait(500);
      const v = versions.get(body.versionId);
      if (!v) throw notFound("esa versión");
      const p = getProject(v.projectId);
      const id = `s-${nanoid(6)}`;
      const thumbId = `thumb-${id}`;
      demoThumbs.set(thumbId, posters.get(v.id) ?? posterThumb(v.number, p.settings.instruction.format !== "16:9", v.recipe.style.titleFont.family));
      const s = Style.parse({ id, ownerId: DEMO_OWNER, name: body.name, slug: slug(body.name), description: body.description ?? "", currentVersion: 1, thumbnailAssetId: thumbId, timesUsed: 0, createdAt: nowIso(), updatedAt: nowIso() });
      styles.unshift(s);
      const corrections = projectVersions(p.id).filter((x) => x.correction).map((x) => x.correction!);
      styleData.set(id, {
        settings: clone(p.settings),
        font: v.recipe.style.titleFont.family,
        rules: [`Títulos en ${v.recipe.style.titleFont.family}${v.recipe.style.textCase === "mayusculas" ? " y en mayúsculas" : ""}.`, `Un corte cada ~${v.recipe.style.targetShotLength} s.`, ...corrections.slice(-3).map((c) => `Aprendido de tu corrección: “${c}”.`)],
      });
      // El proyecto queda ligado al estilo (la siguiente vez ofrece "Actualizar estilo").
      const settings = { ...p.settings, style: { styleId: id, styleVersion: 1 } };
      touch(p.id, { settings });
      emit(p.id, { type: "project.updated", project: clone(getProject(p.id)) });
      return clone(s);
    },
    getStyle: async (styleId) => {
      const s = styles.find((x) => x.id === styleId);
      if (!s) throw notFound("ese estilo");
      const data = styleData.get(styleId);
      const versionsOf = demoStyleVersions(s, data?.settings);
      if (data?.rules.length) versionsOf.forEach((sv) => (sv.rules = data.rules));
      return { style: clone(s), versions: versionsOf };
    },
    updateStyle: async (styleId, body) => {
      await wait(400);
      const s = styles.find((x) => x.id === styleId);
      if (!s) throw notFound("ese estilo");
      if (body.asNew) {
        return api.createStyle({ versionId: body.versionId, name: body.name || `${s.name} (nuevo)`, description: s.description });
      }
      const v = versions.get(body.versionId);
      s.currentVersion += 1;
      s.updatedAt = nowIso();
      if (v) {
        const p = projects.get(v.projectId);
        const prev = styleData.get(styleId);
        styleData.set(styleId, { settings: clone(p?.settings ?? prev?.settings ?? freshSettings()), font: v.recipe.style.titleFont.family, rules: prev?.rules ?? [] });
        demoThumbs.set(s.thumbnailAssetId ?? `thumb-${s.id}`, posters.get(v.id) ?? posterThumb(v.number));
        if (p) {
          touch(p.id, { settings: { ...p.settings, style: { styleId, styleVersion: s.currentVersion } } });
          emit(p.id, { type: "project.updated", project: clone(getProject(p.id)) });
        }
      }
      return clone(s);
    },
    exportStyleUrl: () => "#",
    importStyle: async (file, opts) => {
      for (let i = 1; i <= 6; i++) {
        await wait(80);
        opts?.onProgress?.(i / 6, (file.size * i) / 6, file.size);
      }
      if (!/\.zip$/i.test(file.name)) throw new ApiRequestError("El estilo debe ser un .zip exportado desde el autoeditor (con SKILL.md).", 415, "formato");
      const name = file.name.replace(/\.zip$/i, "").replace(/[-_]+/g, " ").trim() || "Estilo importado";
      const id = `s-${nanoid(6)}`;
      demoThumbs.set(`thumb-${id}`, posterThumb(3, true, "Montserrat"));
      const s = Style.parse({ id, ownerId: DEMO_OWNER, name: name.charAt(0).toUpperCase() + name.slice(1), slug: slug(name), description: "Importado desde un archivo .zip (Skill de Claude).", currentVersion: 1, thumbnailAssetId: `thumb-${id}`, createdAt: nowIso(), updatedAt: nowIso() });
      styles.unshift(s);
      styleData.set(id, { settings: freshSettings(), font: "Montserrat", rules: ["Títulos en Montserrat.", "Subtítulos por frase con resaltado de marca."] });
      return clone(s);
    },
    deleteStyle: async (styleId) => {
      const i = styles.findIndex((x) => x.id === styleId);
      if (i >= 0) styles.splice(i, 1);
      styleData.delete(styleId);
    },

    // -------------------------------------------------------------- Marcas (la biblioteca completa vive en el servidor)
    listBrands: async () => [],
    createBrand: async () => {
      throw new ApiRequestError("La biblioteca de marcas no está disponible en la demo.", 501, "no-disponible");
    },
    getBrand: async () => {
      throw notFound("esa marca");
    },
    updateBrand: async () => {
      throw notFound("esa marca");
    },
    deleteBrand: async () => undefined,

    // -------------------------------------------------------------- Memoria
    listRules: async () => rules.map(clone),
    createRule: async (body) => {
      const from = suggested.get(body.text);
      const r = newRule(body.text, body.scope ?? "global", body.scopeId ?? null, from ? { type: "correccion", excerpt: from.correction, refId: from.versionId } : { type: "manual", excerpt: "", refId: null }, body.enabled ?? true);
      rules = [r, ...rules];
      return clone(r);
    },
    updateRule: async (ruleId, body) => {
      const r = rules.find((x) => x.id === ruleId);
      if (!r) throw notFound("esa regla");
      Object.assign(r, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)), { updatedAt: nowIso() });
      return clone(r);
    },
    deleteRule: async (ruleId) => {
      rules = rules.filter((r) => r.id !== ruleId);
    },
    listGlossary: async () => glossary.map(clone),
    createGlossaryEntry: async (body) => {
      const existing = glossary.find((g) => g.term.toLowerCase() === body.term.trim().toLowerCase());
      if (existing) {
        existing.variants = [...new Set([...existing.variants, ...(body.variants ?? [])])];
        return clone(existing);
      }
      const e = GlossaryEntry.parse({ id: `g-${nanoid(6)}`, ownerId: DEMO_OWNER, term: body.term.trim(), variants: body.variants ?? [], scope: body.scope ?? "global", scopeId: body.scopeId ?? null, createdAt: nowIso() });
      glossary = [e, ...glossary];
      return clone(e);
    },
    deleteGlossaryEntry: async (entryId) => {
      glossary = glossary.filter((g) => g.id !== entryId);
    },
    getMetrics: async () => {
      const day = 86_400_000;
      const history = demoCorrectionHistory.filter((h) => !projects.has(h.projectId) || h.projectId === "demo-skincare");
      const live = [...projects.values()]
        .filter((p) => projectVersions(p.id).length > 0)
        .map((p) => ({ projectId: p.id, name: p.name, corrections: projectVersions(p.id).filter((v) => v.correction).length, createdAt: p.createdAt }));
      const list = [...history.map((h) => ({ projectId: h.projectId, name: h.name, corrections: h.corrections, createdAt: new Date(Date.now() - h.daysAgo * day).toISOString() })), ...live].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : 0);
      const recent = list.slice(-3).map((x) => x.corrections);
      const previous = list.slice(0, -3).map((x) => x.corrections);
      return {
        projects: list.length,
        versions: versions.size,
        correctionsPerVideo: list,
        averageCorrectionsRecent: avg(recent),
        averageCorrectionsPrevious: avg(previous),
        rules: rules.length,
        glossaryTerms: glossary.length,
      };
    },
  };

  function newRule(text: string, scope: MemoryRule["scope"], scopeId: string | null, source: MemoryRule["source"], enabled = true): MemoryRule {
    return MemoryRule.parse({ id: `r-${nanoid(6)}`, ownerId: DEMO_OWNER, scope, scopeId, text, source, enabled, timesApplied: 0, strength: 1, createdAt: nowIso(), updatedAt: nowIso() });
  }

  return api;
}
