/**
 * Lógica pura del ESTUDIO (sin React): qué va arriba (clip base) y qué abajo (todo lo demás),
 * categoría automática por tipo de archivo, resumen de lo que Claude detectó en el material,
 * tomas repetidas en la transcripción, valores por defecto del estudio y presets de texto.
 *
 * El usuario nunca etiqueta nada: todo se infiere del tipo de archivo y del análisis del servidor.
 */
import { defaultProjectSettings, isFiller, type Asset, type AssetCategory, type CaptionStyle, type ProjectSettings, type Transcript, type TranscriptWord } from "@autoeditor/shared";
import { sortByOrder } from "../entrada/order.js";
import { fileKind } from "../entrada/uploads.js";
import { formatSecondsShort, plural } from "../lib/format.js";

// ---------------------------------------------------------------------------- Material

export const BASE_CATEGORY: AssetCategory = "clip-base";

/** Archivos internos que no se muestran en el estudio. */
const HIDDEN_CATEGORIES: AssetCategory[] = ["render", "motion-render"];

/** A partir de esta duración un clip se considera "largo" (grabación sin cortar). */
export const LONG_CLIP_SECONDS = 240;

/** Separa el material: arriba el clip base (en su orden), abajo todo lo demás. */
export function splitMaterial(assets: Asset[]): { base: Asset[]; extras: Asset[] } {
  const base = sortByOrder(assets.filter((a) => a.category === BASE_CATEGORY));
  const extras = sortByOrder(assets.filter((a) => a.category !== BASE_CATEGORY && !HIDDEN_CATEGORIES.includes(a.category)));
  return { base, extras };
}

export const isLongClip = (a: Pick<Asset, "probe">) => (a.probe.duration ?? 0) >= LONG_CLIP_SECONDS;

/**
 * Categoría de un archivo soltado ABAJO, solo por su tipo (nunca se le pregunta al usuario).
 * `null` si no se puede usar.
 */
export function inferExtraCategory(file: Pick<File, "name" | "type">): AssetCategory | null {
  const kind = fileKind(file);
  const name = file.name.toLowerCase();
  switch (kind) {
    case "video":
      return "crudo-video";
    case "audio":
      return /(whoosh|swoosh|swish|golpe|hit|sfx|efecto|impact|impacto|pop|click|clic|transici|riser|boom)/.test(name) ? "sfx" : "musica";
    case "imagen":
      return /logo/.test(name) ? "logo" : "grafico";
    case "fuente":
      return "fuente";
    case "documento":
      return "guion";
    default:
      return null;
  }
}

/** Agrupa archivos por la categoría que les toca (para subirlos en lotes). */
export function groupFilesByCategory<F extends Pick<File, "name" | "type">>(files: F[]): { groups: Map<AssetCategory, F[]>; rejected: F[] } {
  const groups = new Map<AssetCategory, F[]>();
  const rejected: F[] = [];
  for (const f of files) {
    const c = inferExtraCategory(f);
    if (!c) {
      rejected.push(f);
      continue;
    }
    groups.set(c, [...(groups.get(c) ?? []), f]);
  }
  return { groups, rejected };
}

export type ChipTone = "neutral" | "purple" | "mint" | "coral" | "yellow" | "pink";

/** Chip pequeño por tipo (y B-ROLL cuando el análisis lo detectó). */
export function extraChip(a: Pick<Asset, "category" | "kind" | "analysis">): { label: string; tone: ChipTone } {
  if (a.kind === "video" && (a.analysis.role === "b-roll" || (a.analysis.role !== "a-roll" && a.analysis.brollSegments.length > 0))) return { label: "B-ROLL", tone: "mint" };
  switch (a.category) {
    case "crudo-video":
      return { label: "Clip", tone: "neutral" };
    case "crudo-foto":
      return { label: "Foto", tone: "neutral" };
    case "crudo-voz":
      return { label: "Voz", tone: "neutral" };
    case "musica":
      return { label: "Música", tone: "purple" };
    case "sfx":
      return { label: "Efecto", tone: "purple" };
    case "grafico":
      return { label: a.kind === "video" ? "Gráfico" : "Imagen", tone: "neutral" };
    case "logo":
      return { label: "Logo", tone: "yellow" };
    case "referencia":
      return { label: "Referencia", tone: "pink" };
    case "fuente":
      return { label: "Tipografía", tone: "neutral" };
    case "guion":
      return { label: "Guion", tone: "yellow" };
    case "ia-generado":
      return { label: "IA", tone: "purple" };
    case "marca-intro":
    case "marca-outro":
    case "marca-transicion":
      return { label: "Marca", tone: "coral" };
    default:
      return { label: "Archivo", tone: "neutral" };
  }
}

// ---------------------------------------------------------------------------- Tomas repetidas

export interface RepeatedTake {
  /** Texto de la toma que se queda (normalmente la última completa). */
  phrase: string;
  /** Cuántas veces se dijo. */
  count: number;
  /** Inicio (s) de cada intento, en orden. */
  starts: number[];
}

const normWord = (t: string) =>
  t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ]+/g, "");

interface Phrase {
  text: string;
  start: number;
  tokens: string[];
}

/** Parte la transcripción en frases por pausas (> 0.7 s) o puntuación final. */
function phrasesOf(words: Pick<TranscriptWord, "text" | "start" | "end">[]): Phrase[] {
  const out: Phrase[] = [];
  let cur: Pick<TranscriptWord, "text" | "start" | "end">[] = [];
  const flush = () => {
    if (!cur.length) return;
    const tokens = cur.filter((w) => !isFiller(w.text)).map((w) => normWord(w.text)).filter(Boolean);
    out.push({ text: cur.map((w) => w.text).join(" ").trim(), start: cur[0]!.start, tokens });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const prev = cur[cur.length - 1];
    if (prev && w.start - prev.end > 0.7) flush();
    cur.push(w);
    if (/[.?!…]["”»)]?$/.test(w.text.trim())) flush();
  }
  flush();
  return out;
}

function sameTake(a: string[], b: string[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  // Arranque en falso: empiezan con las mismas 3 palabras.
  if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) return true;
  const A = new Set(a);
  const B = new Set(b);
  let common = 0;
  for (const t of A) if (B.has(t)) common++;
  return common / Math.min(A.size, B.size) >= 0.75 && Math.min(A.size, B.size) >= 3;
}

/**
 * Detecta frases dichas varias veces (tomas repetidas o arranques en falso) en una transcripción.
 * Solo compara frases cercanas (las repeticiones suelen ir seguidas). Se queda con la última.
 */
export function detectRepeatedTakes(words: Pick<TranscriptWord, "text" | "start" | "end">[], window = 6): RepeatedTake[] {
  const phrases = phrasesOf(words);
  const parent = phrases.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < phrases.length; i++) {
    for (let j = i + 1; j < Math.min(phrases.length, i + 1 + window); j++) {
      if (sameTake(phrases[i]!.tokens, phrases[j]!.tokens)) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, number[]>();
  phrases.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
  const out: RepeatedTake[] = [];
  for (const idx of groups.values()) {
    if (idx.length < 2) continue;
    const last = phrases[idx[idx.length - 1]!]!;
    out.push({ phrase: last.text, count: idx.length, starts: idx.map((i) => phrases[i]!.start) });
  }
  return out.sort((a, b) => a.starts[0]! - b.starts[0]!);
}

// ---------------------------------------------------------------------------- Lo que Claude detectó

export interface ClipInsight {
  assetId: string;
  name: string;
  status: Asset["analysis"]["status"];
  duration: number | null;
  role: Asset["analysis"]["role"];
  description: string;
  spoken: boolean;
  support: { start: number; end: number; description: string }[];
  repeated: RepeatedTake[];
  pauseSeconds: number;
  long: boolean;
}

export interface MaterialInsights {
  /** Hay al menos un clip base con análisis terminado. */
  ready: boolean;
  /** Clips que siguen analizándose. */
  analyzing: number;
  clips: number;
  spoken: number;
  supportShots: number;
  repeatedTakes: number;
  pauseSeconds: number;
  /** Tomas de apoyo que vienen de los otros clips (abajo). */
  extraSupport: number;
  items: ClipInsight[];
}

const silenceSeconds = (a: Asset) => a.analysis.silences.reduce((s, [x, y]) => s + Math.max(0, y - x), 0);

export function materialInsights(base: Asset[], extras: Asset[], transcripts: Pick<Transcript, "assetId" | "status" | "words">[]): MaterialInsights {
  const byAsset = new Map(transcripts.filter((t) => t.status === "listo").map((t) => [t.assetId, t.words]));
  const items: ClipInsight[] = base.map((a) => {
    const words = byAsset.get(a.id) ?? [];
    return {
      assetId: a.id,
      name: a.originalName,
      status: a.analysis.status,
      duration: a.probe.duration,
      role: a.analysis.role,
      description: a.analysis.description,
      spoken: a.analysis.role === "a-roll" || a.analysis.role === "mixto" || a.analysis.hasSpeech === true,
      support: a.analysis.brollSegments.map((s) => ({ start: s.start, end: s.end, description: s.description })),
      repeated: detectRepeatedTakes(words),
      pauseSeconds: silenceSeconds(a),
      long: isLongClip(a),
    };
  });
  const analyzed = items.filter((i) => i.status === "listo");
  const extraSupport = extras
    .filter((a) => a.kind === "video" && a.analysis.status === "listo" && (a.analysis.role === "b-roll" || a.analysis.brollSegments.length > 0))
    .reduce((s, a) => s + Math.max(1, a.analysis.brollSegments.length), 0);
  return {
    ready: analyzed.length > 0,
    analyzing: items.filter((i) => i.status === "pendiente" || i.status === "analizando").length,
    clips: base.length,
    spoken: analyzed.filter((i) => i.spoken).length,
    supportShots: analyzed.reduce((s, i) => s + i.support.length, 0) + extraSupport,
    repeatedTakes: analyzed.reduce((s, i) => s + i.repeated.reduce((x, r) => x + r.count - 1, 0), 0),
    pauseSeconds: analyzed.reduce((s, i) => s + i.pauseSeconds, 0),
    extraSupport,
    items,
  };
}

/** Resumen en una línea: "3 clips · 2 tomas repetidas · 4 tomas de apoyo". */
export function insightsLine(ins: MaterialInsights): string {
  const parts = [plural(ins.clips, "clip", "clips")];
  if (ins.repeatedTakes > 0) parts.push(plural(ins.repeatedTakes, "toma repetida", "tomas repetidas"));
  if (ins.supportShots > 0) parts.push(plural(ins.supportShots, "toma de apoyo", "tomas de apoyo"));
  if (ins.pauseSeconds >= 3) parts.push(`${formatSecondsShort(Math.round(ins.pauseSeconds))} de pausas`);
  return parts.join(" · ");
}

/** Descripción corta de un clip según lo detectado. */
export function clipRoleText(i: Pick<ClipInsight, "role" | "description" | "support">): string {
  if (i.description) return i.description;
  if (i.role === "a-roll") return "Persona hablando";
  if (i.role === "b-roll") return "Toma de apoyo (sin voz)";
  if (i.role === "mixto") return i.support.length ? "Habla y tiene tomas de apoyo" : "Habla con partes sin voz";
  return "Video";
}

// ---------------------------------------------------------------------------- Valores por defecto

/**
 * Configuración inicial del estudio: todas las opciones apagadas menos "Quitar silencios y
 * muletillas". Lo invisible (ritmo, transiciones, reencuadre, volumen parejo) queda con sus valores
 * inteligentes por defecto.
 */
export function studioDefaultSettings(): ProjectSettings {
  const s = defaultProjectSettings();
  s.captions.enabled = false;
  s.tools.titles.enabled = false;
  s.tools.broll.enabled = false;
  s.tools.music.enabled = false;
  s.tools.zooms.enabled = false;
  s.tools.motionGraphics.enabled = false;
  s.tools.aiImages.enabled = false;
  s.tools.aiVideos.enabled = false;
  s.tools.removeSilences.enabled = true;
  s.tools.removeFillers.enabled = true;
  s.engines = { kie: false, hyperframes: true, remotion: false };
  return s;
}

// ---------------------------------------------------------------------------- Formato y duración

export const FORMAT_CHIPS: { value: ProjectSettings["instruction"]["format"]; label: string; hint: string }[] = [
  { value: "9:16", label: "9:16", hint: "Reels, TikTok, Shorts" },
  { value: "1:1", label: "1:1", hint: "Cuadrado" },
  { value: "4:5", label: "4:5", hint: "Feed de Instagram" },
  { value: "16:9", label: "16:9", hint: "YouTube, horizontal" },
];

export const DURATION_CHIPS: (number | null)[] = [null, 15, 30, 45, 60, 90];

export const durationLabel = (d: number | null) => (d == null ? "Auto" : `${d} s`);

// ---------------------------------------------------------------------------- Estilos de texto

export interface CaptionPreset {
  id: string;
  label: string;
  hint: string;
  style: Partial<CaptionStyle>;
  /** Muestra para la miniatura: palabra de entrada + palabra clave. */
  sample: { lead: string; key: string; leadFont: string; keyFont: string; keyColor: string; keyItalic?: boolean; upper?: boolean; box?: boolean; top?: boolean };
}

export const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: "cinetico",
    label: "Cinético",
    hint: "Palabra clave grande y gruesa, al centro",
    style: { mode: "frase", font: { family: "Montserrat", weight: 900, assetId: null, googleFont: "Montserrat" }, uppercase: false, primaryColor: "#FFFFFF", highlightColor: "#FFFFFF", background: "sombra", position: "centro", highlightKeywords: true, highlightStyle: "escala", animation: "pop", maxLines: 3 },
    sample: { lead: "es hora de", key: "remodelar", leadFont: "Georgia, serif", keyFont: "Montserrat, Arial Black, sans-serif", keyColor: "#FFFFFF" },
  },
  {
    id: "cursiva",
    label: "Cursiva color",
    hint: "Clave en cursiva serif de color",
    style: { mode: "frase", font: { family: "Playfair Display", weight: 700, assetId: null, googleFont: "Playfair Display" }, uppercase: false, primaryColor: "#FFFFFF", highlightColor: "#7ED957", background: "sombra", position: "centro", highlightKeywords: true, highlightStyle: "color", animation: "fundido", maxLines: 3 },
    sample: { lead: "ven a", key: "conocerla", leadFont: "Inter, Arial, sans-serif", keyFont: "Playfair Display, Georgia, serif", keyColor: "#7ED957", keyItalic: true },
  },
  {
    id: "clasico",
    label: "Clásico",
    hint: "Mayúsculas blancas, resalta en amarillo",
    style: { mode: "palabra", font: { family: "Inter", weight: 800, assetId: null, googleFont: "Inter" }, uppercase: true, primaryColor: "#FFFFFF", highlightColor: "#FBE88A", background: "sombra", position: "abajo", highlightKeywords: true, highlightStyle: "color", animation: "pop", maxLines: 2 },
    sample: { lead: "tres", key: "pasos", leadFont: "Inter, Arial, sans-serif", keyFont: "Inter, Arial, sans-serif", keyColor: "#FBE88A", upper: true },
  },
  {
    id: "caja",
    label: "Caja",
    hint: "Texto sobre caja oscura, fácil de leer",
    style: { mode: "frase", font: { family: "Inter", weight: 700, assetId: null, googleFont: "Inter" }, uppercase: false, primaryColor: "#FFFFFF", highlightColor: "#FBE88A", background: "caja", position: "abajo", highlightKeywords: true, highlightStyle: "caja", animation: "fundido", maxLines: 2 },
    sample: { lead: "en menos de", key: "un minuto", leadFont: "Inter, Arial, sans-serif", keyFont: "Inter, Arial, sans-serif", keyColor: "#FBE88A", box: true },
  },
  {
    id: "script",
    label: "Título script",
    hint: "Letra script elegante, arriba",
    style: { mode: "frase", font: { family: "Dancing Script", weight: 700, assetId: null, googleFont: "Dancing Script" }, uppercase: false, primaryColor: "#FFFFFF", highlightColor: "#FFFFFF", background: "sombra", position: "arriba", highlightKeywords: false, highlightStyle: "color", animation: "fundido", maxLines: 2 },
    sample: { lead: "se te antoja…", key: "¿un cafecito?", leadFont: "Dancing Script, Brush Script MT, cursive", keyFont: "Dancing Script, Brush Script MT, cursive", keyColor: "#FFFFFF", top: true },
  },
];

/** Preset que coincide con el estilo actual (por tipografía, fondo y posición). */
export function activePreset(style: CaptionStyle): string | null {
  const p = CAPTION_PRESETS.find(
    (x) => x.style.font?.family === style.font.family && x.style.background === style.background && x.style.position === style.position && x.style.highlightStyle === style.highlightStyle,
  );
  return p?.id ?? null;
}
