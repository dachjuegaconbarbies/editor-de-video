/**
 * LA RECETA: fuente de verdad de cada versión del video.
 *
 * Una receta describe por completo un video editado: qué fragmentos de qué archivos,
 * en qué orden, con qué transiciones, textos, subtítulos, gráficos, audio y pedidos a la IA.
 * El render es determinista: la misma receta + los mismos archivos producen el mismo video.
 *
 * Reglas:
 *  - Todos los tiempos están en SEGUNDOS (número decimal).
 *  - `sourceIn`/`sourceOut` son tiempos dentro del archivo original.
 *  - `start`/`end` de pistas superpuestas (texto, gráficos, overlays, audio) son tiempos
 *    en la línea de tiempo FINAL del video.
 *  - La secuencia principal (`tracks.video`) se ordena por `start`; `normalizeRecipe`
 *    recalcula los `start` a partir del orden, duración y transiciones.
 *  - Las correcciones se aplican como parches mínimos (RFC 6902) sobre esta estructura.
 */
import { z } from "zod";
import { AspectRatio, Platform } from "./formats.js";

export const RECIPE_SCHEMA_VERSION = 1 as const;

const Id = z.string().min(1);
const Seconds = z.number().min(0);
const HexColor = z.string().regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "Color hex #RRGGBB o #RRGGBBAA");

export const RecipeFormat = z.object({
  aspect: AspectRatio,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive().default(30),
  platform: Platform.default("generico"),
});
export type RecipeFormat = z.infer<typeof RecipeFormat>;

// ---------------------------------------------------------------------------
// Estilo global (tokens) — es lo que un "estilo guardado" fija entre videos.
// ---------------------------------------------------------------------------

export const FontRef = z.object({
  family: z.string().min(1).default("Inter"),
  /** Peso CSS (100-900). */
  weight: z.number().int().min(100).max(900).default(700),
  /** Id del asset .ttf/.otf subido por el usuario, o null para fuentes del sistema / Google Fonts. */
  assetId: z.string().nullable().default(null),
  /** Si viene de Google Fonts, el nombre exacto de la familia. */
  googleFont: z.string().nullable().default(null),
});
export type FontRef = z.infer<typeof FontRef>;

export const TransitionType = z.enum([
  "corte",
  "fundido",
  "fundido-negro",
  "deslizar-izq",
  "deslizar-der",
  "zoom",
  "barrido",
  "desenfoque",
]);
export type TransitionType = z.infer<typeof TransitionType>;

export const Transition = z.object({
  type: TransitionType.default("corte"),
  /** Duración de la transición en segundos (0 para corte). */
  duration: z.number().min(0).max(3).default(0),
});
export type Transition = z.infer<typeof Transition>;

export const CaptionStyle = z.object({
  /** palabra = karaoke palabra por palabra; frase = una frase a la vez; bloque = 2 líneas fijas. */
  mode: z.enum(["palabra", "frase", "bloque"]).default("palabra"),
  font: FontRef.default({ family: "Inter", weight: 800, assetId: null, googleFont: "Inter" }),
  /** Tamaño en px relativo a un cuadro de 1080 px de ancho. */
  fontSize: z.number().min(16).max(200).default(72),
  uppercase: z.boolean().default(true),
  primaryColor: HexColor.default("#FFFFFF"),
  highlightColor: HexColor.default("#FBE88A"),
  outlineColor: HexColor.default("#000000"),
  outlineWidth: z.number().min(0).max(20).default(6),
  background: z.enum(["ninguno", "caja", "sombra"]).default("sombra"),
  boxColor: HexColor.default("#000000B3"),
  position: z.enum(["abajo", "centro", "arriba"]).default("abajo"),
  /** Margen vertical extra en px (además de la zona segura de la plataforma). */
  marginV: z.number().min(0).max(800).default(0),
  maxCharsPerLine: z.number().int().min(8).max(60).default(22),
  maxLines: z.number().int().min(1).max(3).default(2),
  emojis: z.boolean().default(false),
  animation: z.enum(["ninguna", "pop", "fundido", "rebote"]).default("pop"),
  highlightKeywords: z.boolean().default(true),
  highlightStyle: z.enum(["color", "escala", "caja"]).default("color"),
});
export type CaptionStyle = z.infer<typeof CaptionStyle>;

export const StyleTokens = z.object({
  titleFont: FontRef.default({ family: "Inter", weight: 800, assetId: null, googleFont: "Inter" }),
  bodyFont: FontRef.default({ family: "Inter", weight: 500, assetId: null, googleFont: "Inter" }),
  palette: z
    .object({
      primary: HexColor.default("#8B7CF0"),
      secondary: HexColor.default("#FBE88A"),
      accent: HexColor.default("#EE6B6B"),
      text: HexColor.default("#FFFFFF"),
      background: HexColor.default("#111111"),
    })
    .default({ primary: "#8B7CF0", secondary: "#FBE88A", accent: "#EE6B6B", text: "#FFFFFF", background: "#111111" }),
  defaultTransition: Transition.default({ type: "corte", duration: 0 }),
  /** Segundos promedio por plano que busca el ritmo (lento ~4, medio ~2.5, rápido ~1.5). */
  targetShotLength: z.number().min(0.5).max(20).default(2.5),
  textCase: z.enum(["original", "mayusculas", "titulo"]).default("mayusculas"),
});
export type StyleTokens = z.infer<typeof StyleTokens>;

// ---------------------------------------------------------------------------
// Pistas
// ---------------------------------------------------------------------------

export const ReframeKeyframe = z.object({
  /** Tiempo relativo al inicio del clip, en segundos. */
  t: Seconds,
  /** Centro del recorte en fracción del ancho/alto de la fuente (0..1). */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1).default(0.5),
});

export const Reframe = z.object({
  /**
   * ajustar = cabe completo con barras; llenar = recorta al centro (o al foco);
   * fondo-desenfocado = cabe completo sobre una copia desenfocada; seguir = recorte que sigue a quien habla.
   */
  mode: z.enum(["ajustar", "llenar", "fondo-desenfocado", "seguir"]).default("llenar"),
  focusX: z.number().min(0).max(1).default(0.5),
  focusY: z.number().min(0).max(1).default(0.5),
  keyframes: z.array(ReframeKeyframe).default([]),
});
export type Reframe = z.infer<typeof Reframe>;

export const ColorAdjust = z.object({
  look: z.enum(["natural", "calido", "frio", "vivo", "blanco-negro", "cine"]).default("natural"),
  brightness: z.number().min(-1).max(1).default(0),
  contrast: z.number().min(0).max(3).default(1),
  saturation: z.number().min(0).max(3).default(1),
});
export type ColorAdjust = z.infer<typeof ColorAdjust>;

export const ZoomMove = z.object({
  from: z.number().min(1).max(3).default(1),
  to: z.number().min(1).max(3).default(1.12),
  /** Tiempo relativo al clip donde empieza y termina el zoom. */
  start: Seconds.default(0),
  end: Seconds.nullable().default(null),
  ease: z.enum(["lineal", "suave", "golpe"]).default("suave"),
});
export type ZoomMove = z.infer<typeof ZoomMove>;

export const VideoClip = z.object({
  id: Id,
  assetId: Id,
  sourceIn: Seconds,
  sourceOut: Seconds,
  /** Inicio en la línea de tiempo final (lo recalcula normalizeRecipe). */
  start: Seconds.default(0),
  speed: z.number().min(0.25).max(4).default(1),
  reframe: Reframe.default({ mode: "llenar", focusX: 0.5, focusY: 0.5, keyframes: [] }),
  zoom: ZoomMove.nullable().default(null),
  color: ColorAdjust.default({ look: "natural", brightness: 0, contrast: 1, saturation: 1 }),
  /** Volumen lineal del audio original del clip (1 = sin cambio). */
  volume: z.number().min(0).max(4).default(1),
  /** Transición de entrada desde el clip anterior. */
  transitionIn: Transition.default({ type: "corte", duration: 0 }),
  /** Para fotos: duración en pantalla (sourceIn/sourceOut se ignoran). */
  stillDuration: Seconds.nullable().default(null),
  label: z.string().default(""),
  /** Por qué Claude eligió este fragmento (se muestra en el storyboard). */
  reason: z.string().default(""),
});
export type VideoClip = z.infer<typeof VideoClip>;

export const OverlayLayout = z.enum([
  "pantalla-completa",
  /** b-roll de fondo a pantalla completa y la persona que habla en un recuadro. */
  "fondo-con-orador",
  "pip-arriba-der",
  "pip-arriba-izq",
  "pip-abajo-der",
  "pip-abajo-izq",
  "mitad-superior",
  "mitad-inferior",
]);

export const OverlayItem = z.object({
  id: Id,
  kind: z.enum(["broll", "imagen", "ia-imagen", "ia-video", "logo"]),
  assetId: Id,
  start: Seconds,
  end: Seconds,
  sourceIn: Seconds.default(0),
  layout: OverlayLayout.default("pantalla-completa"),
  opacity: z.number().min(0).max(1).default(1),
  /** Efecto Ken Burns para imágenes fijas. */
  kenBurns: z.boolean().default(true),
  transition: Transition.default({ type: "fundido", duration: 0.25 }),
  reason: z.string().default(""),
});
export type OverlayItem = z.infer<typeof OverlayItem>;

export const TextKind = z.enum(["titulo", "cintillo", "cta", "palabra-clave", "etiqueta"]);

export const TextItem = z.object({
  id: Id,
  kind: TextKind,
  text: z.string().min(1),
  subtitle: z.string().default(""),
  start: Seconds,
  end: Seconds,
  position: z.enum(["centro", "arriba", "abajo", "cintillo", "arriba-izq", "arriba-der"]).default("centro"),
  font: FontRef.nullable().default(null),
  fontSize: z.number().min(12).max(300).default(96),
  color: HexColor.nullable().default(null),
  background: HexColor.nullable().default(null),
  uppercase: z.boolean().nullable().default(null),
  animation: z.enum(["ninguna", "fundido", "pop", "subir", "maquina-escribir", "deslizar"]).default("pop"),
  /** builtin = ffmpeg/ASS; hyperframes = plantilla HTML animada. */
  engine: z.enum(["builtin", "hyperframes", "remotion"]).default("builtin"),
});
export type TextItem = z.infer<typeof TextItem>;

export const GraphicItem = z.object({
  id: Id,
  /** Id de plantilla de motion graphics (del proyecto o del estilo). */
  templateId: Id,
  engine: z.enum(["hyperframes", "builtin", "remotion"]).default("hyperframes"),
  props: z.record(z.string(), z.unknown()).default({}),
  start: Seconds,
  end: Seconds,
  layout: z.enum(["superpuesto", "pantalla-completa"]).default("superpuesto"),
  /** Asset del clip ya renderizado (con alfa) — cache determinista por hash de plantilla+props. */
  renderedAssetId: z.string().nullable().default(null),
  description: z.string().default(""),
});
export type GraphicItem = z.infer<typeof GraphicItem>;

export const CaptionWord = z.object({
  text: z.string(),
  start: Seconds,
  end: Seconds,
  highlight: z.boolean().default(false),
  emoji: z.string().nullable().default(null),
  speaker: z.string().nullable().default(null),
});
export type CaptionWord = z.infer<typeof CaptionWord>;

export const CaptionTrack = z.object({
  enabled: z.boolean().default(true),
  style: CaptionStyle.default(CaptionStyle.parse({})),
  /** Palabras ya mapeadas a la línea de tiempo final (las materializa el servidor). */
  words: z.array(CaptionWord).default([]),
  /** Correcciones manuales de texto por índice de palabra (sobreviven a recálculos). */
  overrides: z.record(z.string(), z.string()).default({}),
  language: z.string().default("es"),
  burnIn: z.boolean().default(true),
});
export type CaptionTrack = z.infer<typeof CaptionTrack>;

export const MusicItem = z.object({
  id: Id,
  assetId: Id,
  start: Seconds.default(0),
  end: Seconds.nullable().default(null),
  sourceIn: Seconds.default(0),
  /** Ganancia en dB (0 = original, -18 típico para música bajo voz). */
  gainDb: z.number().min(-60).max(12).default(-16),
  fadeIn: Seconds.default(0.5),
  fadeOut: Seconds.default(1.5),
  duck: z.boolean().default(true),
});
export type MusicItem = z.infer<typeof MusicItem>;

export const SfxItem = z.object({
  id: Id,
  assetId: Id,
  at: Seconds,
  gainDb: z.number().min(-60).max(12).default(-6),
  kind: z.enum(["whoosh", "golpe", "pop", "subida", "clic", "otro"]).default("whoosh"),
  origin: z.enum(["biblioteca", "usuario", "ia"]).default("biblioteca"),
});
export type SfxItem = z.infer<typeof SfxItem>;

export const VoiceItem = z.object({
  id: Id,
  assetId: Id,
  start: Seconds,
  gainDb: z.number().min(-60).max(12).default(0),
  text: z.string().default(""),
});
export type VoiceItem = z.infer<typeof VoiceItem>;

export const MixSettings = z.object({
  targetLufs: z.number().min(-30).max(-8).default(-14),
  /** Cuánto baja la música cuando hay voz (dB negativos). */
  duckingDb: z.number().min(-40).max(0).default(-12),
  voiceEnhance: z.boolean().default(false),
  normalize: z.boolean().default(true),
});
export type MixSettings = z.infer<typeof MixSettings>;

export const AiRequestKind = z.enum(["imagen", "video", "sfx", "voz", "musica"]);

export const AiRequest = z.object({
  id: Id,
  kind: AiRequestKind,
  provider: z.string().default("kie"),
  model: z.string(),
  prompt: z.string(),
  negativePrompt: z.string().default(""),
  params: z.record(z.string(), z.unknown()).default({}),
  seed: z.number().int().nullable().default(null),
  status: z.enum(["pendiente", "generando", "listo", "fallido", "omitido"]).default("pendiente"),
  resultAssetId: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  costUsd: z.number().min(0).nullable().default(null),
  usage: z.enum(["broll", "fondo", "portada", "sfx", "voz", "musica"]).default("broll"),
  /** Dónde se coloca el resultado en la línea de tiempo (opcional). */
  placeAt: z.object({ start: Seconds, end: Seconds }).nullable().default(null),
});
export type AiRequest = z.infer<typeof AiRequest>;

export const RecipeTracks = z.object({
  video: z.array(VideoClip).default([]),
  overlays: z.array(OverlayItem).default([]),
  text: z.array(TextItem).default([]),
  graphics: z.array(GraphicItem).default([]),
  captions: CaptionTrack.default(CaptionTrack.parse({})),
  audio: z
    .object({
      music: z.array(MusicItem).default([]),
      sfx: z.array(SfxItem).default([]),
      voiceover: z.array(VoiceItem).default([]),
      mix: MixSettings.default(MixSettings.parse({})),
    })
    .default({ music: [], sfx: [], voiceover: [], mix: MixSettings.parse({}) }),
});
export type RecipeTracks = z.infer<typeof RecipeTracks>;

export const Recipe = z.object({
  schemaVersion: z.literal(RECIPE_SCHEMA_VERSION).default(RECIPE_SCHEMA_VERSION),
  format: RecipeFormat,
  /** Duración total calculada (la recalcula normalizeRecipe). */
  duration: Seconds.default(0),
  style: StyleTokens.default(StyleTokens.parse({})),
  tracks: RecipeTracks.default(RecipeTracks.parse({})),
  ai: z.array(AiRequest).default([]),
  /** Duración objetivo pedida (la revisión de calidad verifica que se cumpla). */
  target: z
    .object({
      duration: z.number().min(1).nullable().default(null),
      mode: z.enum(["auto", "aproximada", "exacta"]).default("auto"),
    })
    .default({ duration: null, mode: "auto" }),
  /** Resumen editorial de Claude (qué hizo y por qué). */
  notes: z.string().default(""),
  meta: z
    .object({
      generator: z.enum(["claude", "demo", "manual"]).default("demo"),
      model: z.string().nullable().default(null),
      styleId: z.string().nullable().default(null),
      styleVersion: z.number().int().nullable().default(null),
      /** Reglas aprendidas que se aplicaron al generar esta receta. */
      appliedRuleIds: z.array(z.string()).default([]),
    })
    .default({ generator: "demo", model: null, styleId: null, styleVersion: null, appliedRuleIds: [] }),
});
export type Recipe = z.infer<typeof Recipe>;

/** ¿La duración cumple el objetivo? (aproximada ±15 %, exacta ±0.5 s). */
export function durationMeetsTarget(recipe: Pick<Recipe, "duration" | "target">): { ok: boolean; detail: string } {
  const { duration, mode } = recipe.target;
  if (duration == null || mode === "auto") return { ok: true, detail: "Sin duración objetivo estricta." };
  const tol = mode === "exacta" ? 0.5 : duration * 0.15;
  const ok = Math.abs(recipe.duration - duration) <= tol;
  return { ok, detail: `Duración ${recipe.duration.toFixed(1)} s; objetivo ${duration} s (${mode}, tolerancia ±${tol.toFixed(1)} s).` };
}
export type RecipeInput = z.input<typeof Recipe>;

// ---------------------------------------------------------------------------
// Utilidades deterministas
// ---------------------------------------------------------------------------

/** Duración en la línea de tiempo de un clip principal. */
export function clipDuration(clip: VideoClip): number {
  if (clip.stillDuration != null) return clip.stillDuration;
  return Math.max(0, (clip.sourceOut - clip.sourceIn) / clip.speed);
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Recalcula `start` de cada clip principal (encadenados, restando el traslape de transiciones),
 * acota las pistas superpuestas a la duración total y ordena todo de forma estable.
 * Es puro: devuelve una receta nueva.
 */
export function normalizeRecipe(input: Recipe): Recipe {
  const recipe: Recipe = structuredClone(input);
  let cursor = 0;
  recipe.tracks.video = recipe.tracks.video.map((clip, i) => {
    const d = clipDuration(clip);
    let overlap = 0;
    if (i > 0 && clip.transitionIn.type !== "corte") {
      const prev = recipe.tracks.video[i - 1]!;
      overlap = Math.min(clip.transitionIn.duration, d / 2, clipDuration(prev) / 2);
    } else if (i === 0 || clip.transitionIn.type === "corte") {
      clip = { ...clip, transitionIn: { type: clip.transitionIn.type, duration: clip.transitionIn.type === "corte" ? 0 : clip.transitionIn.duration } };
    }
    const start = round3(Math.max(0, cursor - overlap));
    cursor = start + d;
    return { ...clip, start };
  });
  const total = round3(cursor);
  recipe.duration = total;

  const clampSpan = <T extends { start: number; end: number }>(items: T[]): T[] =>
    items
      .map((it) => ({ ...it, start: round3(Math.min(it.start, total)), end: round3(Math.min(Math.max(it.end, it.start), total)) }))
      .filter((it) => it.end > it.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);

  recipe.tracks.overlays = clampSpan(recipe.tracks.overlays);
  recipe.tracks.text = clampSpan(recipe.tracks.text);
  recipe.tracks.graphics = clampSpan(recipe.tracks.graphics);
  recipe.tracks.audio.sfx = recipe.tracks.audio.sfx.filter((s) => s.at <= total).sort((a, b) => a.at - b.at);
  recipe.tracks.captions.words = recipe.tracks.captions.words
    .filter((w) => w.start < total)
    .map((w) => ({ ...w, end: Math.min(w.end, total) }));
  return recipe;
}

/**
 * Convierte un tiempo de un archivo fuente a tiempo de la línea de tiempo final.
 * Devuelve null si ese instante quedó fuera de la edición.
 */
export function sourceToTimeline(recipe: Recipe, assetId: string, t: number): number | null {
  for (const clip of recipe.tracks.video) {
    if (clip.assetId !== assetId || clip.stillDuration != null) continue;
    if (t >= clip.sourceIn && t <= clip.sourceOut) {
      return round3(clip.start + (t - clip.sourceIn) / clip.speed);
    }
  }
  return null;
}

/** Convierte un tiempo de la línea final al archivo fuente (clip principal visible en ese instante). */
export function timelineToSource(recipe: Recipe, t: number): { assetId: string; time: number; clipId: string } | null {
  for (let i = recipe.tracks.video.length - 1; i >= 0; i--) {
    const clip = recipe.tracks.video[i]!;
    const d = clipDuration(clip);
    if (t >= clip.start && t <= clip.start + d) {
      const time = clip.stillDuration != null ? 0 : clip.sourceIn + (t - clip.start) * clip.speed;
      return { assetId: clip.assetId, time: round3(time), clipId: clip.id };
    }
  }
  return null;
}

/** Ids de assets que la receta necesita para renderizarse. */
export function referencedAssetIds(recipe: Recipe): string[] {
  const ids = new Set<string>();
  recipe.tracks.video.forEach((c) => ids.add(c.assetId));
  recipe.tracks.overlays.forEach((o) => ids.add(o.assetId));
  recipe.tracks.graphics.forEach((g) => g.renderedAssetId && ids.add(g.renderedAssetId));
  recipe.tracks.audio.music.forEach((m) => ids.add(m.assetId));
  recipe.tracks.audio.sfx.forEach((s) => ids.add(s.assetId));
  recipe.tracks.audio.voiceover.forEach((v) => ids.add(v.assetId));
  const fonts = [recipe.style.titleFont, recipe.style.bodyFont, recipe.tracks.captions.style.font];
  recipe.tracks.text.forEach((t) => t.font && fonts.push(t.font));
  fonts.forEach((f) => f.assetId && ids.add(f.assetId));
  return [...ids];
}

/** Serialización canónica (claves ordenadas) para hashes y comparaciones estables. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

export function parseRecipe(data: unknown): Recipe {
  return normalizeRecipe(Recipe.parse(data));
}
