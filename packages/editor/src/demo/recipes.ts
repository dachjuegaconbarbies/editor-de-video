/**
 * Recetas de la DEMO: arma recetas completas y plausibles (clips, b-roll, textos, gráficos,
 * subtítulos con tiempos, música y SFX) a partir del material, para que "qué cambió" y
 * "comparar" muestren diferencias reales calculadas con `diffRecipes` de @autoeditor/shared.
 */
import {
  RESOLUTIONS,
  Recipe,
  clipDuration,
  normalizeRecipe,
  type AspectRatio,
  type Asset,
  type Platform,
  type ProjectSettings,
  type RecipeInput,
  type TranscriptWord,
} from "@autoeditor/shared";

export interface ClipSeed {
  assetId: string;
  sourceIn: number;
  sourceOut: number;
  label: string;
  reason?: string;
  stillDuration?: number;
}

export interface DemoRecipeOptions {
  aspect: AspectRatio;
  platform: Platform;
  clips: ClipSeed[];
  titleFont?: string;
  captionFont?: string;
  shotLength?: number;
  target?: { duration: number | null; mode: "auto" | "aproximada" | "exacta" };
  hook?: string;
  keywordText?: string;
  cta?: string | null;
  musicAssetId?: string | null;
  sfxAssetId?: string | null;
  brollOverlay?: { assetId: string; at: number; duration: number; sourceIn: number } | null;
  logoAssetId?: string | null;
  motion?: boolean;
  highlightWords?: string[];
  transcripts?: Map<string, TranscriptWord[]>;
  notes?: string;
}

const round = (n: number) => Math.round(n * 100) / 100;
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ]/g, "");

/** Pone en la línea de tiempo final las palabras de la transcripción que caen dentro de cada clip. */
export function materializeCaptions(recipe: Recipe, transcripts: Map<string, TranscriptWord[]>, highlight: string[] = []): Recipe {
  const hl = new Set(highlight.flatMap((h) => h.split(/\s+/)).map(norm).filter((w) => w.length > 2));
  const words: Recipe["tracks"]["captions"]["words"] = [];
  for (const clip of recipe.tracks.video) {
    if (clip.stillDuration != null) continue;
    const list = transcripts.get(clip.assetId) ?? [];
    for (const w of list) {
      if (w.mark === "quitar" || w.filler) continue;
      if (w.start < clip.sourceIn || w.end > clip.sourceOut) continue;
      const start = round(clip.start + (w.start - clip.sourceIn) / clip.speed);
      const end = round(clip.start + (w.end - clip.sourceIn) / clip.speed);
      words.push({ text: w.text, start, end, highlight: hl.has(norm(w.text)) || w.mark === "resaltar", emoji: null, speaker: w.speaker ?? null });
    }
  }
  const next = structuredClone(recipe);
  next.tracks.captions.words = words.sort((a, b) => a.start - b.start);
  return next;
}

/** Receta completa a partir de clips elegidos. */
export function buildDemoRecipe(o: DemoRecipeOptions): Recipe {
  const res = RESOLUTIONS[o.aspect];
  const titleFont = o.titleFont ?? "Inter";
  const captionFont = o.captionFont ?? titleFont;
  const vertical = o.aspect !== "16:9";
  const input: RecipeInput = {
    format: { aspect: o.aspect, width: res.width, height: res.height, fps: 30, platform: o.platform },
    style: {
      titleFont: { family: titleFont, weight: 800, assetId: null, googleFont: null },
      bodyFont: { family: "Inter", weight: 500, assetId: null, googleFont: null },
      targetShotLength: o.shotLength ?? 2.5,
      defaultTransition: { type: "corte", duration: 0 },
    },
    tracks: {
      video: o.clips.map((c, i) => ({
        id: `c${i + 1}`,
        assetId: c.assetId,
        sourceIn: c.sourceIn,
        sourceOut: c.sourceOut,
        stillDuration: c.stillDuration ?? null,
        label: c.label,
        reason: c.reason ?? "",
        reframe: { mode: vertical ? "seguir" : "llenar", focusX: 0.5, focusY: 0.45, keyframes: [] },
        zoom: i % 3 === 2 ? { from: 1, to: 1.12, start: 0, end: null, ease: "suave" } : null,
      })),
      captions: {
        enabled: true,
        style: { font: { family: captionFont, weight: 800, assetId: null, googleFont: null }, fontSize: vertical ? 72 : 56, uppercase: true, highlightColor: "#FBE88A" },
      },
      audio: {
        music: o.musicAssetId ? [{ id: "m1", assetId: o.musicAssetId, start: 0, gainDb: -18, fadeIn: 0.8, fadeOut: 1.8, duck: true }] : [],
        sfx: [],
        voiceover: [],
        mix: { targetLufs: -14, duckingDb: -12 },
      },
    },
    target: o.target ?? { duration: null, mode: "auto" },
    notes: o.notes ?? "",
    meta: { generator: "demo", model: "demo" },
  };
  let recipe = normalizeRecipe(Recipe.parse(input));
  const total = recipe.duration;
  const starts = recipe.tracks.video.map((c) => c.start);

  // Textos: gancho, palabra clave a la mitad y llamado a la acción al final.
  const text: Recipe["tracks"]["text"] = [];
  if (o.hook) text.push({ id: "t-gancho", kind: "titulo", text: o.hook, subtitle: "", start: 0.2, end: Math.min(2.8, total), position: "centro", font: null, fontSize: 104, color: null, background: null, uppercase: null, animation: "pop", engine: "builtin" });
  if (o.keywordText && total > 8) {
    const at = starts[Math.min(2, starts.length - 1)] ?? total * 0.35;
    text.push({ id: "t-clave", kind: "palabra-clave", text: o.keywordText, subtitle: "", start: round(at + 0.6), end: round(Math.min(total, at + 2.8)), position: "arriba", font: null, fontSize: 88, color: "#FBE88A", background: null, uppercase: null, animation: "pop", engine: "builtin" });
  }
  if (o.cta && total > 5) text.push({ id: "t-cta", kind: "cta", text: o.cta, subtitle: "", start: round(Math.max(0, total - 3.6)), end: total, position: "abajo", font: null, fontSize: 80, color: null, background: "#1F1F1FCC", uppercase: null, animation: "subir", engine: "builtin" });
  recipe.tracks.text = text;

  // B-roll de fondo con la persona en un recuadro.
  if (o.brollOverlay && total > o.brollOverlay.at + 1) {
    recipe.tracks.overlays = [
      {
        id: "o-broll",
        kind: "broll",
        assetId: o.brollOverlay.assetId,
        start: round(o.brollOverlay.at),
        end: round(Math.min(total, o.brollOverlay.at + o.brollOverlay.duration)),
        sourceIn: o.brollOverlay.sourceIn,
        layout: "fondo-con-orador",
        opacity: 1,
        kenBurns: false,
        transition: { type: "fundido", duration: 0.25 },
        reason: "B-roll de fondo mientras explica el proceso",
      },
    ];
  }

  // Motion graphics (HyperFrames).
  if (o.motion) {
    const g: Recipe["tracks"]["graphics"] = [];
    if (total > 10) g.push({ id: "g-lista", templateId: "lista-animada", engine: "hyperframes", props: { titulo: "Ingredientes" }, start: round(total * 0.22), end: round(total * 0.22 + 3), layout: "superpuesto", renderedAssetId: null, description: "Lista animada de ingredientes" });
    g.push({ id: "g-logo", templateId: "logo-animado", engine: "hyperframes", props: {}, start: round(Math.max(0, total - 2.6)), end: total, layout: "superpuesto", renderedAssetId: null, description: "Logo animado de cierre" });
    recipe.tracks.graphics = g;
  }

  // Logo fijo al final.
  if (o.logoAssetId && total > 3) {
    recipe.tracks.overlays = [
      ...recipe.tracks.overlays,
      { id: "o-logo", kind: "logo", assetId: o.logoAssetId, start: round(total - 2.4), end: total, sourceIn: 0, layout: "pip-arriba-der", opacity: 1, kenBurns: false, transition: { type: "fundido", duration: 0.25 }, reason: "Cierre con logo" },
    ];
  }

  // Whoosh en algunos cortes.
  if (o.sfxAssetId) {
    recipe.tracks.audio.sfx = starts.slice(1, 4).map((t, i) => ({ id: `s${i + 1}`, assetId: o.sfxAssetId!, at: round(Math.max(0, t - 0.15)), gainDb: -8, kind: "whoosh" as const, origin: "usuario" as const }));
  }

  if (o.transcripts) recipe = materializeCaptions(recipe, o.transcripts, o.highlightWords ?? []);
  return normalizeRecipe(recipe);
}

/** Cambia el formato (y la resolución) de una receta conservando todo lo demás. */
export function withFormat(recipe: Recipe, aspect: AspectRatio, platform: Platform): Recipe {
  if (recipe.format.aspect === aspect && recipe.format.platform === platform) return recipe;
  const next = structuredClone(recipe);
  const res = RESOLUTIONS[aspect];
  next.format = { ...next.format, aspect, platform, width: res.width, height: res.height };
  return next;
}

/** Duración total de los clips de una receta (para pruebas y resúmenes). */
export function totalClipSeconds(recipe: Recipe): number {
  return round(recipe.tracks.video.reduce((s, c) => s + clipDuration(c), 0));
}

/**
 * Receta para un proyecto con material subido por la persona: alterna A-roll (habla) con B-roll
 * (apoyo) hasta llegar a la duración pedida.
 */
export function recipeFromAssets(assets: Asset[], settings: ProjectSettings, transcripts: Map<string, TranscriptWord[]>, keywords: string[]): Recipe {
  // El clip base (en su orden) es la columna del video; los otros clips son tomas de apoyo.
  const baseClips = [...assets.filter((a) => a.category === "clip-base")].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
  const others = assets.filter((a) => a.category === "crudo-video");
  const videos = [...baseClips, ...others];
  const photos = assets.filter((a) => a.category === "crudo-foto");
  const aroll = baseClips.length ? baseClips : others.filter((a) => a.analysis.role === "a-roll" || a.analysis.role === "mixto");
  const broll = baseClips.length
    ? [...others, ...baseClips.filter((a) => a.analysis.brollSegments.length > 0)]
    : others.filter((a) => a.analysis.role === "b-roll" || a.analysis.role === "desconocido");
  const target = settings.instruction.targetDuration ?? Math.min(45, Math.max(15, videos.reduce((s, a) => s + (a.probe.duration ?? 8), 0) * 0.5 + photos.length * 2));
  const shot = settings.tools.pacing.value === "rapido" ? 1.6 : settings.tools.pacing.value === "lento" ? 4 : 2.6;
  const main = aroll.length ? aroll : videos;
  const clips: ClipSeed[] = [];
  let acc = 0;
  let iMain = 0;
  let iB = 0;
  let iPhoto = 0;
  const cursor = new Map<string, number>();
  let guard = 0;
  while (acc < target - 0.5 && guard++ < 40) {
    const useB = clips.length % 3 === 2 && (broll.length > 0 || photos.length > 0) && aroll.length > 0;
    if (useB && broll.length) {
      const a = broll[iB++ % broll.length]!;
      const d = a.probe.duration ?? 6;
      const seg = a.analysis.brollSegments[0];
      const len = Math.min(shot * 1.2, (seg ? seg.end - seg.start : d) || 2);
      const from = seg?.start ?? Math.min(0.5, d / 4);
      clips.push({ assetId: a.id, sourceIn: round(from), sourceOut: round(Math.min(d, from + len)), label: "B-roll", reason: "Toma de apoyo como corte sobre la voz" });
      acc += Math.min(d, from + len) - from;
      continue;
    }
    if (useB && photos.length) {
      const p = photos[iPhoto++ % photos.length]!;
      clips.push({ assetId: p.id, sourceIn: 0, sourceOut: 0, stillDuration: 2.2, label: "Foto", reason: "Foto con movimiento suave" });
      acc += 2.2;
      continue;
    }
    if (!main.length) {
      if (!photos.length) break;
      const p = photos[iPhoto++ % photos.length]!;
      clips.push({ assetId: p.id, sourceIn: 0, sourceOut: 0, stillDuration: 3, label: "Foto" });
      acc += 3;
      continue;
    }
    const a = main[iMain++ % main.length]!;
    const d = a.probe.duration ?? 10;
    const start = cursor.get(a.id) ?? Math.min(0.4, d / 5);
    if (start >= d - 0.8) {
      cursor.set(a.id, Math.min(0.4, d / 5));
      if (main.length === 1 && broll.length === 0 && photos.length === 0) break;
      continue;
    }
    const len = Math.min(d - start, shot * 2.2, target - acc);
    if (len < 0.8) break;
    clips.push({ assetId: a.id, sourceIn: round(start), sourceOut: round(start + len), label: clips.length === 0 ? "Gancho" : a.analysis.role === "a-roll" ? "Habla a cámara" : "Toma", reason: clips.length === 0 ? "Abre con la frase más fuerte" : "" });
    cursor.set(a.id, start + len + 0.6);
    acc += len;
  }
  if (!clips.length && videos[0]) clips.push({ assetId: videos[0].id, sourceIn: 0, sourceOut: Math.min(videos[0].probe.duration ?? 5, target), label: "Clip" });
  const music = assets.find((a) => a.category === "musica");
  const sfx = assets.find((a) => a.category === "sfx");
  const logo = assets.find((a) => a.category === "logo");
  const bFirst = broll[0];
  const t = settings.tools;
  return buildDemoRecipe({
    aspect: settings.instruction.format,
    platform: settings.instruction.platform,
    clips,
    shotLength: shot,
    target: { duration: settings.instruction.targetDuration, mode: settings.instruction.durationMode },
    hook: t.titles.enabled ? (keywords[0] ? keywords[0].toUpperCase() : "MIRA ESTO") : undefined,
    keywordText: t.titles.enabled && keywords[1] ? keywords[1].toUpperCase() : undefined,
    cta: t.cta.enabled ? (t.cta.text || "SÍGUEME PARA MÁS").toUpperCase() : null,
    musicAssetId: t.music.enabled ? (music?.id ?? null) : null,
    sfxAssetId: t.sfx.enabled ? (sfx?.id ?? null) : null,
    brollOverlay: t.broll.enabled && bFirst && aroll.length ? { assetId: bFirst.id, at: 3.5, duration: 2.6, sourceIn: bFirst.analysis.brollSegments[0]?.start ?? 0.5 } : null,
    logoAssetId: logo?.id ?? null,
    motion: t.motionGraphics.enabled,
    highlightWords: keywords,
    transcripts,
    notes: "Abrí con la frase más fuerte, alterné la voz con tomas de apoyo y cerré con el llamado a la acción.",
  });
}
