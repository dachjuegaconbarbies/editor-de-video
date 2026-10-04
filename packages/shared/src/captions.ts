/**
 * Subtítulos: convierte palabras de la transcripción (tiempo de la fuente) en palabras de la
 * línea de tiempo final según los cortes de la receta, agrupa en líneas y exporta .srt / .vtt.
 */
import type { CaptionStyle, CaptionWord, Recipe } from "./recipe.js";
import { clipDuration } from "./recipe.js";

export interface SourceWord {
  assetId: string;
  i: number;
  text: string;
  start: number;
  end: number;
  speaker?: string | null;
  mark?: "quitar" | "debe-ir" | "resaltar" | null;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}%$]+/gu, " ")
    .trim();

/** true si la palabra (o una frase clave que la contiene) coincide con alguna palabra clave activa. */
export function makeKeywordMatcher(keywords: string[]): (words: string[], index: number) => boolean {
  const phrases = keywords.map((k) => norm(k).split(/\s+/).filter(Boolean)).filter((p) => p.length > 0);
  return (words, index) => {
    const w = words.map(norm);
    return phrases.some((p) => {
      for (let offset = 0; offset < p.length; offset++) {
        const startIdx = index - offset;
        if (startIdx < 0 || startIdx + p.length > w.length) continue;
        let ok = true;
        for (let j = 0; j < p.length; j++) if (w[startIdx + j] !== p[j]) ok = false;
        if (ok) return true;
      }
      return false;
    });
  };
}

/**
 * Materializa las palabras de subtítulos en la línea de tiempo final.
 * Una palabra entra si su centro cae dentro de algún fragmento usado de su archivo.
 */
export function materializeCaptionWords(recipe: Recipe, words: SourceWord[], keywords: string[], overrides: Record<string, string> = {}): CaptionWord[] {
  const out: CaptionWord[] = [];
  const byAsset = new Map<string, SourceWord[]>();
  for (const w of words) {
    if (!byAsset.has(w.assetId)) byAsset.set(w.assetId, []);
    byAsset.get(w.assetId)!.push(w);
  }
  for (const list of byAsset.values()) list.sort((a, b) => a.start - b.start);
  const isKeyword = makeKeywordMatcher(keywords);

  for (const clip of recipe.tracks.video) {
    if (clip.stillDuration != null) continue;
    const list = byAsset.get(clip.assetId) ?? [];
    const texts = list.map((w) => w.text);
    list.forEach((w, idx) => {
      const mid = (w.start + w.end) / 2;
      if (mid < clip.sourceIn || mid > clip.sourceOut) return;
      if (w.mark === "quitar") return;
      const start = clip.start + (Math.max(w.start, clip.sourceIn) - clip.sourceIn) / clip.speed;
      const end = clip.start + (Math.min(w.end, clip.sourceOut) - clip.sourceIn) / clip.speed;
      const clipEnd = clip.start + clipDuration(clip);
      out.push({
        text: w.text,
        start: Math.round(start * 1000) / 1000,
        end: Math.round(Math.min(end, clipEnd) * 1000) / 1000,
        highlight: w.mark === "resaltar" || isKeyword(texts, idx),
        emoji: null,
        speaker: w.speaker ?? null,
      });
    });
  }
  out.sort((a, b) => a.start - b.start);
  // Overrides por índice en la lista final.
  for (const [k, v] of Object.entries(overrides)) {
    const i = Number(k);
    if (out[i]) out[i] = { ...out[i]!, text: v };
  }
  return out;
}

export interface CaptionLine {
  start: number;
  end: number;
  words: CaptionWord[];
  text: string;
}

/** Agrupa palabras en líneas/tarjetas según el estilo (máx. caracteres, pausas, puntuación). */
export function groupCaptionLines(words: CaptionWord[], style: Pick<CaptionStyle, "mode" | "maxCharsPerLine" | "maxLines">): CaptionLine[] {
  const maxChars = style.mode === "palabra" ? Math.min(style.maxCharsPerLine, 18) : style.maxCharsPerLine * (style.mode === "bloque" ? style.maxLines : 1);
  const lines: CaptionLine[] = [];
  let cur: CaptionWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    lines.push({ start: cur[0]!.start, end: cur[cur.length - 1]!.end, words: cur, text: cur.map((w) => w.text).join(" ") });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const prev = cur[cur.length - 1];
    const len = cur.map((x) => x.text).join(" ").length + (cur.length ? 1 : 0) + w.text.length;
    const gap = prev ? w.start - prev.end : 0;
    if (cur.length && (len > maxChars || gap > 0.6)) flush();
    cur.push(w);
    if (/[.!?…]$/.test(w.text) || (style.mode === "palabra" && cur.length >= 3 && /[,;:]$/.test(w.text))) flush();
  }
  flush();
  // Evita solapes y huecos mínimos.
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i]!;
    const b = lines[i + 1]!;
    if (a.end > b.start) a.end = b.start;
    if (b.start - a.end < 0.12) a.end = b.start;
  }
  return lines;
}

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, "0");

function stamp(t: number, sep: "," | "."): string {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

export function toSrt(lines: CaptionLine[], uppercase = false): string {
  return lines
    .map((l, i) => `${i + 1}\n${stamp(l.start, ",")} --> ${stamp(l.end, ",")}\n${uppercase ? l.text.toUpperCase() : l.text}\n`)
    .join("\n");
}

export function toVtt(lines: CaptionLine[], uppercase = false): string {
  return "WEBVTT\n\n" + lines.map((l) => `${stamp(l.start, ".")} --> ${stamp(l.end, ".")}\n${uppercase ? l.text.toUpperCase() : l.text}\n`).join("\n");
}

export function toPlainText(words: { text: string }[]): string {
  return words.map((w) => w.text).join(" ").replace(/\s+([,.!?;:])/g, "$1");
}

/** Muletillas comunes en español (se pueden ampliar desde la memoria). */
export const SPANISH_FILLERS = ["eh", "ehh", "em", "emm", "este", "esteee", "o sea", "osea", "pues", "bueno", "mmm", "ajá", "tipo", "digamos", "verdad", "¿no?", "no?"];

export function isFiller(text: string, extra: string[] = []): boolean {
  const n = norm(text);
  return [...SPANISH_FILLERS, ...extra].some((f) => norm(f) === n);
}
