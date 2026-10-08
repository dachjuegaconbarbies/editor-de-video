/**
 * TOMAS REPETIDAS y ARRANQUES EN FALSO (función pura, sin IA).
 *
 * En una grabación cruda la misma frase suele decirse varias veces ("hoy te voy a… hoy te voy a enseñar
 * tres trucos"). Se comparan frases cercanas por similitud de texto normalizado (subsecuencia común más
 * larga sobre palabras, sin muletillas) y se agrupan. De cada grupo se queda la MEJOR toma: normalmente
 * la última completa y sin tropiezos (muletillas, palabras repetidas, pausas largas a mitad de frase).
 *
 * Es eficiente con material largo: solo compara cada frase con las siguientes dentro de una ventana
 * (por número de frases y por segundos), así que el costo crece en línea con la duración.
 */
import { normalize, STRONG_FILLERS } from "./text.js";

export interface TakeWord {
  text: string;
  start: number;
  end: number;
  filler?: boolean;
  probability?: number;
}

export interface TakePhrase {
  id: string;
  assetId: string;
  start: number;
  end: number;
  text: string;
  words?: TakeWord[];
}

export interface TakeGroup {
  id: string;
  /** Frases (en orden de la columna) que dicen lo mismo. */
  phraseIds: string[];
  /** La toma que se queda. */
  keepId: string;
  /** Frases que se descartan (repeticiones o arranques en falso). */
  discardIds: string[];
  /** Arranques en falso dentro del grupo (frases cortadas que se retoman después). */
  falseStartIds: string[];
  similarity: number;
  /** Explicación en español para mostrar al usuario. */
  reason: string;
}

export interface TakeOptions {
  /** Similitud mínima (0..1) para considerar que dos frases dicen lo mismo. */
  minSimilarity?: number;
  /** Ventana: cuántas frases hacia adelante se comparan. */
  maxPhraseGap?: number;
  /** Ventana: segundos máximos entre dos tomas del mismo archivo. */
  maxSeconds?: number;
  /** Palabras mínimas de una frase para compararla. */
  minTokens?: number;
}

export interface TakesResult {
  groups: TakeGroup[];
  /** id de frase descartada → id del grupo. */
  discarded: Map<string, string>;
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** Palabras normalizadas de una frase, sin muletillas fuertes ("eh", "mmm"). */
export function takeTokens(text: string): string[] {
  return normalize(text)
    .split(" ")
    .filter((w) => w && !STRONG_FILLERS.has(w));
}

/** Largo de la subsecuencia común más larga entre dos listas de palabras. */
export function lcsLength(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return prev[b.length]!;
}

/** Similitud de Dice sobre la subsecuencia común (1 = mismas palabras en el mismo orden). */
export function textSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  return (2 * lcsLength(a, b)) / (a.length + b.length);
}

/**
 * ¿`a` es un arranque en falso de `b`? (a es más corta, empieza igual y casi todas sus palabras están
 * al principio de b: "hoy te voy a" → "hoy te voy a enseñar tres trucos").
 */
export function isFalseStart(a: string[], b: string[], minTokens = 2): boolean {
  if (a.length < minTokens || a.length >= b.length * 0.85) return false;
  if (a[0] !== b[0]) return false;
  const head = b.slice(0, Math.min(b.length, a.length + 2));
  return lcsLength(a, head) / a.length >= 0.8;
}

/** Calidad de una toma (más alto = mejor). */
function takeScore(p: TakePhrase, tokens: string[], maxLen: number, rank: number, total: number): { score: number; stumbles: number; complete: boolean } {
  const words = p.words ?? [];
  const fillers = words.filter((w) => w.filler || STRONG_FILLERS.has(normalize(w.text))).length;
  let stutters = 0;
  for (let k = 1; k < tokens.length; k++) if (tokens[k] === tokens[k - 1]) stutters++;
  let pauses = 0;
  for (let k = 1; k < words.length; k++) if (words[k]!.start - words[k - 1]!.end > 0.8) pauses++;
  const probs = words.map((w) => w.probability ?? 1);
  const lowConfidence = probs.length && probs.reduce((s, x) => s + x, 0) / probs.length < 0.6 ? 1 : 0;
  const complete = tokens.length >= maxLen * 0.9;
  const endsWell = /[.!?…]["»”']?$/.test(p.text.trim());
  const stumbles = fillers + stutters + pauses;
  const score =
    2 * (tokens.length / Math.max(1, maxLen)) + (endsWell ? 0.3 : 0) - 0.25 * fillers - 0.4 * stutters - 0.2 * pauses - 0.3 * lowConfidence + 0.15 * (total > 1 ? rank / (total - 1) : 0);
  return { score, stumbles, complete };
}

/**
 * Detecta grupos de tomas repetidas en frases ordenadas (orden de la columna del video).
 * Devuelve los grupos con la toma elegida y el mapa de frases descartadas.
 */
export function detectRepeatedTakes(phrases: TakePhrase[], opts: TakeOptions = {}): TakesResult {
  const minSim = opts.minSimilarity ?? 0.6;
  const maxGap = opts.maxPhraseGap ?? 12;
  const maxSeconds = opts.maxSeconds ?? 150;
  const minTokens = opts.minTokens ?? 3;
  const tokens = phrases.map((p) => takeTokens(p.text));

  // Unión-búsqueda sobre pares cercanos que dicen lo mismo.
  const parent = phrases.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const bestSim = new Map<number, number>();
  const falseStarts = new Set<number>();
  for (let i = 0; i < phrases.length; i++) {
    const a = tokens[i]!;
    if (a.length < 2) continue;
    for (let j = i + 1; j < phrases.length && j <= i + maxGap; j++) {
      const pi = phrases[i]!;
      const pj = phrases[j]!;
      if (pi.assetId === pj.assetId && pj.start - pi.end > maxSeconds) break;
      const b = tokens[j]!;
      if (b.length < 2) continue;
      const shortest = Math.min(a.length, b.length);
      let same = false;
      if (shortest >= minTokens) {
        const sim = textSimilarity(a, b);
        const needed = shortest <= 4 ? Math.max(minSim, 0.75) : minSim;
        if (sim >= needed) {
          same = true;
          const root = Math.min(i, j);
          bestSim.set(root, Math.max(bestSim.get(root) ?? 0, sim));
        }
      }
      // Un arranque en falso se retoma enseguida (mismo archivo y pocos segundos, o el clip siguiente).
      const soon = pi.assetId === pj.assetId ? pj.start - pi.end <= 30 : j === i + 1;
      if (!same && soon && isFalseStart(a, b)) {
        same = true;
        falseStarts.add(i);
      }
      if (same) parent[find(j)] = find(i);
    }
  }

  const byRoot = new Map<number, number[]>();
  phrases.forEach((_, i) => {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r)!.push(i);
  });

  const groups: TakeGroup[] = [];
  const discarded = new Map<string, string>();
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    members.sort((x, y) => x - y);
    const maxLen = Math.max(...members.map((m) => tokens[m]!.length));
    const scored = members.map((m, rank) => ({ m, ...takeScore(phrases[m]!, tokens[m]!, maxLen, rank, members.length) }));
    const best = scored.reduce((acc, s) => (s.score > acc.score + 1e-9 || (Math.abs(s.score - acc.score) <= 1e-9 && s.m > acc.m) ? s : acc));
    const keep = phrases[best.m]!;
    const id = `toma-${keep.id}`;
    const discardIdx = members.filter((m) => m !== best.m);
    const isLast = best.m === members[members.length - 1];
    const fsIds = discardIdx.filter((m) => falseStarts.has(m)).map((m) => phrases[m]!.id);
    const times = members.length;
    const reason =
      fsIds.length === discardIdx.length
        ? `Arranque en falso: la frase se retoma completa en ${fmt(keep.start)}; me quedo con esa.`
        : `Dijiste esta frase ${times} veces; me quedo con ${isLast ? "la última completa" : "la toma más limpia"} (${fmt(keep.start)})${best.stumbles === 0 ? ", sin tropiezos" : ""}.`;
    const group: TakeGroup = {
      id,
      phraseIds: members.map((m) => phrases[m]!.id),
      keepId: keep.id,
      discardIds: discardIdx.map((m) => phrases[m]!.id),
      falseStartIds: fsIds,
      similarity: Math.round((bestSim.get(members[0]!) ?? 0.8) * 100) / 100,
      reason,
    };
    groups.push(group);
    for (const d of group.discardIds) discarded.set(d, id);
  }
  groups.sort((a, b) => phrases.findIndex((p) => p.id === a.phraseIds[0]) - phrases.findIndex((p) => p.id === b.phraseIds[0]));
  return { groups, discarded };
}
