/**
 * Clasificación de la toma (A-roll / B-roll / mixto) y fragmentos aprovechables como B-roll.
 *
 * Reglas (deterministas, documentadas para poder explicarlas en la interfaz):
 *
 * - **Foto** → "b-roll", un solo fragmento de `PHOTO_SEGMENT_SEC`.
 * - **Solo audio** → "a-roll" si hay voz; si no, "desconocido". Sin fragmentos visuales.
 * - **Video con voz**: si hay un tramo largo sin voz (≥ max(4 s, 20 % de la duración)) y lo que no es
 *   voz suma ≥ 25 % → "mixto"; si no → "a-roll" (voz sostenida; las pausas normales no cuentan).
 * - **Video sin voz**: "a-roll" solo si NO tiene pista de audio y hay un rostro prominente (alto ≥ 18 %
 *   del cuadro) en ≥ 70 % de los fotogramas clave (persona a cámara con la voz grabada aparte);
 *   en cualquier otro caso → "b-roll".
 *
 * Fragmentos B-roll (`brollSegments`): tramos sin voz (silencios ∪ ventanas sin voz; todo el clip si
 * no hay voz), partidos por los cambios de escena, sin tramos congelados ni en negro, de ≥ 1.5 s.
 * Puntaje 0..1 = 0.4·duración (satura a 5 s) + 0.4·movimiento (ideal: movimiento suave) +
 * 0.2·detalle (densidad de bordes), multiplicado por el rol (b-roll 1, mixto 0.85, a-roll 0.6: en un
 * A-roll los "huecos" son pausas de la misma toma, útiles pero no ideales).
 * Etiquetas: "estable" (movimiento bajo), "movimiento", "detalle" (mucha textura), "rostro".
 */
import type { AssetAnalysis } from "@autoeditor/shared";
import { intersectIntervals, invertIntervals, mergeIntervals, round3, type SpeechAnalysis } from "./audio.js";
import { meanIn, medianIn, type VideoSample } from "./video.js";

export const MIN_BROLL_SEC = 1.5;
export const PHOTO_SEGMENT_SEC = 4;
/** Diferencia media entre fotogramas (0–255) por debajo de la cual una toma se considera estable. */
export const STABLE_MOTION = 2;
/** Diferencia media por debajo de la cual un tramo marcado por freezedetect se da por congelado. */
export const FROZEN_MOTION = 0.1;
/** Densidad de bordes (0–255) desde la cual se etiqueta "detalle". */
export const DETAIL_EDGES = 5;

export type Role = AssetAnalysis["role"];
export type BrollSegment = AssetAnalysis["brollSegments"][number];

export interface FaceSample {
  t: number;
  x: number;
  y: number;
  size: number;
}

export interface ClassifyInput {
  durationSec: number;
  hasAudio: boolean;
  hasVideo: boolean;
  isImage: boolean;
  speech: SpeechAnalysis | null;
  silences: [number, number][];
  cuts: number[];
  freezes: [number, number][];
  blacks: [number, number][];
  motion: VideoSample[];
  detail: VideoSample[];
  /** Rostro principal por fotograma clave (solo los que tienen rostro). */
  faces: FaceSample[];
  keyframeTimes: number[];
  /** Detalle de una imagen fija (fotos). */
  imageDetail?: number | null;
}

export interface ClassifyResult {
  role: Role;
  brollSegments: BrollSegment[];
  /** Motivo legible (para registros y depuración). */
  reason: string;
}

/** Tramos congelados confirmados: freezedetect ∩ movimiento casi nulo. */
export function frozenIntervals(freezes: [number, number][], motion: VideoSample[]): [number, number][] {
  return freezes.filter(([a, b]) => {
    const m = medianIn(motion, a, b);
    return m === null || m < FROZEN_MOTION;
  });
}

/** Parte [a,b] en los cortes que caen dentro. */
export function splitByCuts(intervals: [number, number][], cuts: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of intervals) {
    let cur = a;
    for (const c of cuts) {
      if (c > cur && c < b) {
        out.push([cur, c]);
        cur = c;
      }
    }
    out.push([cur, b]);
  }
  return out.map(([a, b]) => [round3(a), round3(b)]);
}

function motionScore(m: number | null): number {
  if (m === null) return 0.6;
  if (m < 0.05) return 0.5; // casi estático
  if (m < 1) return 0.8;
  if (m < 8) return 1; // movimiento suave: lo ideal para un corte de apoyo
  return Math.max(0.3, 1 - (m - 8) / 16); // agitado
}

function describe(tags: string[], dur: number): string {
  const parts: string[] = [];
  if (tags.includes("movimiento")) parts.push("con movimiento");
  else if (tags.includes("estable")) parts.push("estable");
  if (tags.includes("detalle")) parts.push("con mucho detalle");
  if (tags.includes("rostro")) parts.push("con una persona");
  return `Toma ${parts.join(", ") || "sin voz"} (${dur.toFixed(1)} s)`;
}

function roleFactor(role: Role): number {
  return role === "b-roll" ? 1 : role === "mixto" ? 0.85 : role === "a-roll" ? 0.6 : 0.8;
}

export function scoreSegment(start: number, end: number, input: ClassifyInput, role: Role): BrollSegment {
  const dur = end - start;
  // +0.05 s: el primer fotograma tras un corte compara contra la escena anterior.
  const m = meanIn(input.motion, start + 0.05, end);
  const d = input.isImage ? (input.imageDetail ?? null) : meanIn(input.detail, start, end);
  const durScore = Math.min(1, dur / 5);
  const detailScore = d === null ? 0.5 : Math.min(1, d / 6);
  const base = 0.4 * durScore + 0.4 * motionScore(input.isImage ? 0.5 : m) + 0.2 * detailScore;
  const tags: string[] = [];
  if (input.isImage || (m !== null && m < STABLE_MOTION)) tags.push("estable");
  else if (m !== null) tags.push("movimiento");
  if (d !== null && d >= DETAIL_EDGES) tags.push("detalle");
  if (input.faces.some((f) => f.t >= start && f.t < end && f.size >= 0.08)) tags.push("rostro");
  const score = Math.max(0, Math.min(1, base * roleFactor(role)));
  return { start: round3(start), end: round3(end), score: Math.round(score * 100) / 100, description: describe(tags, dur), tags };
}

/** Tramos sin voz del clip (candidatos a B-roll), antes de partir por escenas. */
export function nonSpeechIntervals(input: ClassifyInput): [number, number][] {
  const D = input.durationSec;
  if (!input.hasAudio || !input.speech || !input.speech.hasSpeech) return [[0, D]];
  const fromWindows = invertIntervals(input.speech.speech, D);
  return mergeIntervals([...input.silences.map(([a, b]) => [a, Math.min(b, D)] as [number, number]), ...fromWindows]);
}

export function classifyClip(input: ClassifyInput): ClassifyResult {
  const D = input.durationSec;
  if (input.isImage) {
    return { role: "b-roll", brollSegments: [scoreSegment(0, PHOTO_SEGMENT_SEC, input, "b-roll")], reason: "Foto" };
  }
  const hasSpeech = !!input.speech?.hasSpeech;
  if (!input.hasVideo) {
    return { role: hasSpeech ? "a-roll" : "desconocido", brollSegments: [], reason: hasSpeech ? "Audio con voz" : "Audio sin voz" };
  }
  if (!(D > 0)) return { role: "desconocido", brollSegments: [], reason: "Sin duración" };

  const nonSpeech = nonSpeechIntervals(input);
  const nonSpeechTotal = nonSpeech.reduce((acc, [a, b]) => acc + (b - a), 0);
  const longest = nonSpeech.reduce((acc, [a, b]) => Math.max(acc, b - a), 0);
  const kf = Math.max(1, input.keyframeTimes.length);
  const prominent = input.faces.filter((f) => f.size >= 0.18).length / kf;

  let role: Role;
  let reason: string;
  if (hasSpeech) {
    if (longest >= Math.max(4, 0.2 * D) && nonSpeechTotal >= 0.25 * D) {
      role = "mixto";
      reason = `Voz en ${Math.round(((D - nonSpeechTotal) / D) * 100)} % del clip y un tramo sin voz de ${longest.toFixed(1)} s`;
    } else {
      role = "a-roll";
      reason = "Voz sostenida";
    }
  } else if (!input.hasAudio && prominent >= 0.7) {
    role = "a-roll";
    reason = "Sin audio, con una persona a cámara en casi todo el clip";
  } else {
    role = "b-roll";
    reason = input.hasAudio ? "Sin voz principal" : "Sin audio";
  }

  // Candidatos: sin voz, partidos por escenas, sin congelados ni negros.
  const bad = mergeIntervals([...frozenIntervals(input.freezes, input.motion), ...input.blacks]);
  const usable = intersectIntervals(nonSpeech, invertIntervals(bad, D));
  const pieces = splitByCuts(usable, input.cuts).filter(([a, b]) => b - a >= MIN_BROLL_SEC);
  const brollSegments = pieces.map(([a, b]) => scoreSegment(a, b, input, role));
  return { role, brollSegments, reason };
}
