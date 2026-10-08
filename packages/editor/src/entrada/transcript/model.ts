/**
 * Lógica PURA del editor de transcripción (sin React): párrafos, palabra activa durante la
 * reproducción, selección de frases, marcas ("quitar" / "debe ir" / "resaltar"), correcciones
 * y apariciones de palabras clave. Se prueba en test/entrada-transcript.test.ts.
 */
import { makeKeywordMatcher, type Keyword, type Transcript, type TranscriptWord } from "@autoeditor/shared";

export type WordMark = NonNullable<TranscriptWord["mark"]>;

export interface WordEdit {
  i: number;
  text?: string;
  mark?: WordMark | null;
}

export interface Paragraph {
  id: string;
  speaker: string | null;
  start: number;
  end: number;
  /** Posición (en `words`) de la primera palabra del párrafo. */
  from: number;
  /** Posición (en `words`) de la última palabra del párrafo (incluida). */
  to: number;
}

const SENTENCE_END = /[.!?…]["»”)]*$/;

export interface ParagraphOptions {
  /** Pausa (s) que abre un párrafo nuevo. */
  pause: number;
  /** A partir de cuántas palabras se corta en el siguiente fin de frase. */
  softMax: number;
  /** Corte forzado (aunque no haya fin de frase). */
  hardMax: number;
}

const DEFAULT_PARAGRAPHS: ParagraphOptions = { pause: 1.2, softMax: 26, hardMax: 70 };

/**
 * Agrupa las palabras en párrafos legibles: cambia de párrafo cuando cambia el hablante, hay una
 * pausa larga o, pasado cierto largo, al terminar una frase. Si la transcripción trae segmentos,
 * se respetan sus cortes (un párrafo nunca parte un segmento).
 */
export function groupParagraphs(t: Pick<Transcript, "words" | "segments">, options: Partial<ParagraphOptions> = {}): Paragraph[] {
  const opts = { ...DEFAULT_PARAGRAPHS, ...options };
  const words = t.words;
  if (!words.length) return [];
  // Posiciones donde PUEDE cortar un segmento (solo si hay segmentos).
  const segmentEnds = new Set<number>();
  if (t.segments.length) {
    const posByI = new Map(words.map((w, p) => [w.i, p]));
    for (const s of t.segments) {
      const p = posByI.get(s.lastWord);
      if (p != null) segmentEnds.add(p);
    }
  }
  const out: Paragraph[] = [];
  let from = 0;
  const flush = (to: number) => {
    const first = words[from]!;
    const last = words[to]!;
    out.push({ id: `p${from}`, speaker: first.speaker ?? null, start: first.start, end: last.end, from, to });
    from = to + 1;
  };
  for (let p = 1; p < words.length; p++) {
    const prev = words[p - 1]!;
    const w = words[p]!;
    const count = p - from;
    const speakerChange = (w.speaker ?? null) !== (prev.speaker ?? null);
    const gap = w.start - prev.end;
    const canCut = !segmentEnds.size || segmentEnds.has(p - 1);
    const sentenceEnd = SENTENCE_END.test(prev.text);
    if (speakerChange || (canCut && gap >= opts.pause) || (canCut && sentenceEnd && count >= opts.softMax) || count >= opts.hardMax) flush(p - 1);
  }
  flush(words.length - 1);
  return out;
}

/**
 * Posición de la palabra que suena en el segundo `t` (búsqueda binaria) o -1 en silencio.
 * Una palabra sigue "activa" un instante después de terminar para que el resaltado no parpadee.
 */
export function activeWordIndex(words: Pick<TranscriptWord, "start" | "end">[], t: number, tail = 0.35): number {
  if (!words.length || t < words[0]!.start - 0.05) return -1;
  let lo = 0;
  let hi = words.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (words[mid]!.start <= t) lo = mid;
    else hi = mid - 1;
  }
  const w = words[lo]!;
  const next = words[lo + 1];
  if (t <= w.end + tail || (next && t < next.start && next.start - w.end < 0.25)) return lo;
  return -1;
}

/** Rango ordenado [desde, hasta] (posiciones) a partir de dos extremos en cualquier orden. */
export function normalizeRange(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a];
}

/**
 * Ediciones para marcar (o desmarcar) un rango. Si TODAS las palabras del rango ya tienen esa
 * marca, se quita (alternar). `mark = null` siempre limpia.
 */
export function markEdits(words: TranscriptWord[], range: [number, number], mark: WordMark | null): WordEdit[] {
  const [a, b] = normalizeRange(range[0], range[1]);
  const slice = words.slice(Math.max(0, a), Math.min(words.length - 1, b) + 1);
  if (!slice.length) return [];
  const target = mark != null && slice.every((w) => w.mark === mark) ? null : mark;
  return slice.filter((w) => (w.mark ?? null) !== target).map((w) => ({ i: w.i, mark: target }));
}

/** Aplica ediciones a una transcripción (para la actualización optimista de la interfaz). */
export function applyEdits(t: Transcript, edits: WordEdit[]): Transcript {
  if (!edits.length) return t;
  const byI = new Map(edits.map((e) => [e.i, e]));
  const words = t.words.map((w) => {
    const e = byI.get(w.i);
    if (!e) return w;
    const next = { ...w };
    if (e.text !== undefined && e.text.trim() && e.text.trim() !== w.text) {
      next.original = w.original ?? w.text;
      next.text = e.text.trim();
    }
    if (e.mark !== undefined) next.mark = e.mark;
    return next;
  });
  return { ...t, words };
}

/** Separa puntuación de inicio y fin: "¿Sira," → ["¿", "Sira", ","]. */
export function splitPunctuation(text: string): [string, string, string] {
  const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(text);
  if (!m) return ["", text, ""];
  return [m[1] ?? "", m[2] ?? "", m[3] ?? ""];
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/** Núcleo normalizado de una palabra (sin puntuación, acentos ni mayúsculas). */
export function wordKey(text: string): string {
  return fold(splitPunctuation(text)[1]);
}

/**
 * Corrección de una palabra conservando su puntuación cuando la persona escribe solo el núcleo:
 * "Sira," + "Zyra" → "Zyra,". Si escribe puntuación, se respeta lo que escribió.
 */
export function correctedText(current: string, typed: string): string {
  const t = typed.trim();
  if (!t) return current;
  const [lead, , trail] = splitPunctuation(current);
  const [tl, tcore, tt] = splitPunctuation(t);
  if (!tcore) return t;
  return `${tl || lead}${tcore}${tt || trail}`;
}

/** Ediciones para corregir las demás apariciones de la misma palabra (mismo núcleo). */
export function sameWordEdits(words: TranscriptWord[], originalText: string, replacement: string, exceptI: number): WordEdit[] {
  const key = wordKey(originalText);
  const core = splitPunctuation(replacement)[1];
  if (!key || !core) return [];
  return words
    .filter((w) => w.i !== exceptI && wordKey(w.text) === key)
    .map((w) => {
      const [lead, , trail] = splitPunctuation(w.text);
      return { i: w.i, text: `${lead}${core}${trail}` };
    });
}

/** Par para el aviso del glosario: "Sira → Zyra" (sin puntuación). */
export function glossaryPair(before: string, after: string): { wrong: string; right: string } | null {
  const wrong = splitPunctuation(before)[1];
  const right = splitPunctuation(after)[1];
  if (!wrong || !right || wrong === right) return null;
  return { wrong, right };
}

export interface Occurrence {
  transcriptId: string;
  assetId: string;
  /** Posiciones (en `words`) que forman la aparición. */
  from: number;
  to: number;
  t: number;
}

/** Dónde aparece una palabra clave (o frase) en las transcripciones. */
export function keywordOccurrences(transcripts: Pick<Transcript, "id" | "assetId" | "words">[], text: string): Occurrence[] {
  const clean = text.replace(/[¿?¡!…]+/g, " ").trim();
  if (!clean) return [];
  const match = makeKeywordMatcher([clean]);
  const out: Occurrence[] = [];
  for (const t of transcripts) {
    const texts = t.words.map((w) => w.text);
    let start = -1;
    for (let p = 0; p <= texts.length; p++) {
      const hit = p < texts.length && match(texts, p);
      if (hit && start === -1) start = p;
      if (!hit && start !== -1) {
        out.push({ transcriptId: t.id, assetId: t.assetId, from: start, to: p - 1, t: t.words[start]!.start });
        start = -1;
      }
    }
  }
  return out;
}

/** Posiciones de palabras que coinciden con alguna palabra clave activa (para resaltarlas). */
export function keywordPositions(words: Pick<TranscriptWord, "text">[], keywords: Pick<Keyword, "text" | "enabled">[]): Set<number> {
  const active = keywords.filter((k) => k.enabled).map((k) => k.text.replace(/[¿?¡!…]+/g, " ").trim()).filter(Boolean);
  const out = new Set<number>();
  if (!active.length) return out;
  const match = makeKeywordMatcher(active);
  const texts = words.map((w) => w.text);
  for (let p = 0; p < texts.length; p++) if (match(texts, p)) out.add(p);
  return out;
}

/** Palabra con poca confianza (conviene revisarla: nombres propios, marcas…). */
export const isLowConfidence = (w: Pick<TranscriptWord, "probability">) => w.probability < 0.6;

export interface TranscriptStats {
  words: number;
  duration: number;
  fillers: number;
  edited: number;
  marks: Record<WordMark, number>;
}

export function transcriptStats(t: Pick<Transcript, "words">): TranscriptStats {
  const marks: Record<WordMark, number> = { quitar: 0, "debe-ir": 0, resaltar: 0 };
  let fillers = 0;
  let edited = 0;
  for (const w of t.words) {
    if (w.mark) marks[w.mark]++;
    if (w.filler) fillers++;
    if (w.original != null && w.original !== w.text) edited++;
  }
  const last = t.words[t.words.length - 1];
  return { words: t.words.length, duration: last ? last.end : 0, fillers, edited, marks };
}

/** Texto plano de un rango (para copiar la selección). */
export function rangeText(words: Pick<TranscriptWord, "text">[], range: [number, number]): string {
  const [a, b] = normalizeRange(range[0], range[1]);
  return words
    .slice(a, b + 1)
    .map((w) => w.text)
    .join(" ")
    .replace(/\s+([,.!?;:])/g, "$1");
}

/** Nombres legibles para los hablantes ("Hablante 1", "Hablante 2"…) en orden de aparición. */
export function speakerLabels(words: Pick<TranscriptWord, "speaker">[]): Map<string, { label: string; n: number }> {
  const out = new Map<string, { label: string; n: number }>();
  for (const w of words) {
    if (!w.speaker || out.has(w.speaker)) continue;
    const n = out.size + 1;
    out.set(w.speaker, { label: `Hablante ${n}`, n });
  }
  return out;
}

/** Movimiento del cursor/selección con el teclado (posiciones acotadas a la transcripción). */
export function moveSelection(sel: { a: number; b: number } | null, delta: number, extend: boolean, count: number): { a: number; b: number } | null {
  if (count <= 0) return null;
  const clampP = (p: number) => Math.max(0, Math.min(count - 1, p));
  if (!sel) return { a: clampP(delta > 0 ? 0 : count - 1), b: clampP(delta > 0 ? 0 : count - 1) };
  if (extend) return { a: sel.a, b: clampP(sel.b + delta) };
  const p = clampP((delta > 0 ? Math.max(sel.a, sel.b) : Math.min(sel.a, sel.b)) + (sel.a === sel.b ? delta : 0));
  return { a: p, b: p };
}
