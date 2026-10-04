/**
 * Transcripciones → palabras con tiempos, frases, muletillas y búsqueda de apariciones.
 * Base del editor demo, de las herramientas de Claude y de las palabras clave.
 */
import type { Keyword, SourceWord, Transcript } from "@autoeditor/shared";
import { AMBIGUOUS_FILLERS, endsSentence, normalize, normWord, STRONG_FILLERS } from "./text.js";

export interface TWord {
  assetId: string;
  /** Índice estable dentro de la transcripción. */
  i: number;
  /** Posición dentro de la lista ordenada del asset. */
  pos: number;
  text: string;
  norm: string;
  start: number;
  end: number;
  filler: boolean;
  mark: "quitar" | "debe-ir" | "resaltar" | null;
  speaker: string | null;
}

export interface Phrase {
  id: string;
  assetId: string;
  /** Índice de la frase dentro del asset (0 = la primera). */
  index: number;
  words: TWord[];
  start: number;
  end: number;
  text: string;
}

/** Transcripciones utilizables (listas y con palabras), una por asset (la más reciente). */
export function usableTranscripts(transcripts: Transcript[]): Transcript[] {
  const byAsset = new Map<string, Transcript>();
  for (const t of transcripts) {
    if (t.status !== "listo" || t.words.length === 0) continue;
    const prev = byAsset.get(t.assetId);
    if (!prev || prev.updatedAt < t.updatedAt) byAsset.set(t.assetId, t);
  }
  return [...byAsset.values()];
}

/** Palabras por asset, ordenadas por tiempo. */
export function wordsByAsset(transcripts: Transcript[]): Map<string, TWord[]> {
  const out = new Map<string, TWord[]>();
  for (const t of usableTranscripts(transcripts)) {
    const list = [...t.words]
      .filter((w) => w.end > w.start || w.text.trim() !== "")
      .sort((a, b) => a.start - b.start)
      .map((w, pos) => ({
        assetId: t.assetId,
        i: w.i,
        pos,
        text: w.text,
        norm: normWord(w.text),
        start: w.start,
        end: Math.max(w.end, w.start + 0.01),
        filler: w.filler,
        mark: w.mark,
        speaker: w.speaker ?? null,
      }));
    out.set(t.assetId, list);
  }
  return out;
}

/** Palabras en el formato que usa la materialización de subtítulos. */
export function sourceWords(transcripts: Transcript[]): SourceWord[] {
  const out: SourceWord[] = [];
  for (const t of usableTranscripts(transcripts)) {
    for (const w of t.words) out.push({ assetId: t.assetId, i: w.i, text: w.text, start: w.start, end: w.end, speaker: w.speaker, mark: w.mark });
  }
  return out;
}

/**
 * ¿Esta palabra es una muletilla que se puede quitar?
 * Las fuertes ("eh", "mmm") siempre; las ambiguas ("este", "pues", "o sea") solo si están aisladas
 * (coma pegada o pausa antes y después) o si la transcripción ya la marcó como muletilla.
 */
export function isRemovableFiller(w: TWord, prev: TWord | undefined, next: TWord | undefined, extra: string[] = []): boolean {
  if (w.mark === "debe-ir" || w.mark === "resaltar") return false;
  if (w.filler) return true;
  if (STRONG_FILLERS.has(w.norm)) return true;
  if (extra.some((e) => normWord(e) === w.norm)) return true;
  if (!AMBIGUOUS_FILLERS.has(w.norm)) return false;
  const gapBefore = prev ? w.start - prev.end : 1;
  const gapAfter = next ? next.start - w.end : 1;
  const commaAfter = /,\s*$/.test(w.text);
  const commaBefore = prev ? /,\s*$/.test(prev.text) : true;
  return (commaAfter && commaBefore) || (gapBefore > 0.35 && gapAfter > 0.25);
}

/** Divide las palabras de un asset en frases (puntuación final o pausa larga). */
export function splitPhrases(words: TWord[], maxGap = 0.9): Phrase[] {
  const phrases: Phrase[] = [];
  let cur: TWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    const first = cur[0]!;
    const last = cur[cur.length - 1]!;
    phrases.push({
      id: `${first.assetId}:${first.i}`,
      assetId: first.assetId,
      index: phrases.length,
      words: cur,
      start: first.start,
      end: last.end,
      text: cur.map((w) => w.text).join(" "),
    });
    cur = [];
  };
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!;
    const prev = cur[cur.length - 1];
    if (prev && w.start - prev.end > maxGap) flush();
    cur.push(w);
    if (endsSentence(w.text)) flush();
  }
  flush();
  return phrases;
}

/** Busca un texto (palabra o frase) en las transcripciones: devuelve cada aparición (primera palabra). */
export function findOccurrences(text: string, byAsset: Map<string, TWord[]>): Keyword["occurrences"] {
  const target = normalize(text).split(" ").filter(Boolean);
  if (!target.length) return [];
  const out: Keyword["occurrences"] = [];
  for (const [assetId, words] of byAsset) {
    for (let k = 0; k + target.length <= words.length; k++) {
      let ok = true;
      for (let j = 0; j < target.length; j++) {
        const w = words[k + j]!.norm;
        const t = target[j]!;
        // Tolera plural simple ("video" ~ "videos").
        if (w !== t && w !== `${t}s` && `${w}s` !== t && w !== `${t}es`) {
          ok = false;
          break;
        }
      }
      if (ok) out.push({ assetId, wordIndex: words[k]!.i, t: words[k]!.start });
    }
  }
  return out;
}

/** Palabras dentro de [from, to] de un asset (para leer la transcripción por rangos). */
export function wordsInRange(words: TWord[], from: number, to: number): TWord[] {
  return words.filter((w) => w.end > from && w.start < to);
}

/** ¿El instante t cae dentro de una palabra (sin contar un margen en los bordes)? */
export function wordAt(words: TWord[], t: number, margin = 0.03): TWord | null {
  for (const w of words) {
    if (t > w.start + margin && t < w.end - margin) return w;
    if (w.start > t) break;
  }
  return null;
}

/**
 * Términos que conviene RESALTAR en los subtítulos: palabras clave activas y cortas (≤ 3 palabras).
 * El gancho y el llamado a la acción son frases completas: sirven para títulos y texto de publicación,
 * pero resaltarlas pintaría la frase entera. Lo usa el servidor al materializar subtítulos.
 */
export function highlightTerms(keywords: Keyword[]): string[] {
  return keywords
    .filter((k) => k.enabled && k.category !== "gancho" && k.category !== "cta" && k.text.trim().split(/\s+/).length <= 3)
    .map((k) => k.text);
}
