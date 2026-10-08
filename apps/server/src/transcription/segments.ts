/**
 * Normalización de transcripciones: limpia palabras, ordena tiempos y agrupa en segmentos (frases).
 *
 * Reglas de segmentación (iguales para todos los proveedores, así el resultado no depende de cómo
 * cada motor corte sus segmentos):
 * - Se corta tras un signo de fin de frase (. ? ! … ¿cierre de pregunta?) si la frase ya tiene
 *   al menos `minWords` palabras.
 * - Se corta en una pausa ≥ `pauseSec` entre palabras (aunque no haya puntuación).
 * - Se corta tras una coma/punto y coma/dos puntos si hay una pausa ≥ `commaPauseSec`.
 * - Se corta si la frase supera `maxSec` segundos o `maxWords` palabras (en el hueco más largo).
 * El texto de cada palabra se devuelve tal cual (las muletillas se marcan al guardar con `isFiller`).
 */
import type { RawTranscript, RawTranscriptWord } from "../services/types.js";

export interface SegmentRules {
  pauseSec: number;
  commaPauseSec: number;
  maxSec: number;
  maxWords: number;
  minWords: number;
}

export const DEFAULT_SEGMENT_RULES: SegmentRules = {
  pauseSec: 0.7,
  commaPauseSec: 0.35,
  maxSec: 12,
  maxWords: 30,
  minWords: 2,
};

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const SENTENCE_END = /[.?!…]["'»”)\]]*$/;
const CLAUSE_END = /[,;:]["'»”)\]]*$/;

/** Limpia y ordena las palabras: sin vacías, tiempos finitos, no negativos y monótonos. */
export function normalizeWords(words: RawTranscriptWord[]): RawTranscriptWord[] {
  const out: RawTranscriptWord[] = [];
  for (const w of words) {
    const text = String(w.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    let start = Number(w.start);
    let end = Number(w.end);
    if (!Number.isFinite(start)) continue;
    if (!Number.isFinite(end) || end < start) end = start;
    start = Math.max(0, start);
    end = Math.max(start, end);
    const p = Number(w.probability);
    out.push({
      text,
      start: round3(start),
      end: round3(end),
      probability: Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 1,
      ...(w.speaker ? { speaker: w.speaker } : {}),
    });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  // Que una palabra no termine después de que empiece la siguiente (solapes de los motores).
  for (let i = 0; i < out.length - 1; i++) {
    const cur = out[i]!;
    const next = out[i + 1]!;
    if (cur.end > next.start) cur.end = Math.max(cur.start, next.start);
  }
  return out;
}

/** Agrupa palabras en segmentos por pausas y puntuación. */
export function groupSegments(words: RawTranscriptWord[], rules: Partial<SegmentRules> = {}): RawTranscript["segments"] {
  const R = { ...DEFAULT_SEGMENT_RULES, ...rules };
  const segments: RawTranscript["segments"] = [];
  if (words.length === 0) return segments;

  const close = (first: number, last: number) => {
    const slice = words.slice(first, last + 1);
    const speakers = new Set(slice.map((w) => w.speaker ?? null));
    segments.push({
      start: slice[0]!.start,
      end: slice[slice.length - 1]!.end,
      text: slice.map((w) => w.text).join(" "),
      firstWord: first,
      lastWord: last,
      ...(speakers.size === 1 && slice[0]!.speaker ? { speaker: slice[0]!.speaker } : {}),
    });
  };

  let first = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const next = words[i + 1];
    if (!next) break;
    const gap = next.start - w.end;
    const count = i - first + 1;
    const span = w.end - words[first]!.start;
    const speakerChange = (w.speaker ?? null) !== (next.speaker ?? null);
    const cut =
      speakerChange ||
      gap >= R.pauseSec ||
      (SENTENCE_END.test(w.text) && count >= R.minWords) ||
      (CLAUSE_END.test(w.text) && gap >= R.commaPauseSec && count >= R.minWords);
    if (cut) {
      close(first, i);
      first = i + 1;
      continue;
    }
    if (span >= R.maxSec || count >= R.maxWords) {
      // Frase demasiado larga: se corta en el hueco más grande de su segunda mitad.
      let best = i;
      let bestGap = -1;
      for (let j = first + Math.floor(count / 2); j <= i; j++) {
        const g = words[j + 1]!.start - words[j]!.end;
        if (g > bestGap) {
          bestGap = g;
          best = j;
        }
      }
      close(first, best);
      first = best + 1;
    }
  }
  if (first < words.length) close(first, words.length - 1);
  return segments;
}

/** Normaliza palabras y rehace los segmentos. */
export function buildTranscript(language: string, words: RawTranscriptWord[], rules?: Partial<SegmentRules>): RawTranscript {
  const clean = normalizeWords(words);
  return { language: language || "", words: clean, segments: groupSegments(clean, rules) };
}
