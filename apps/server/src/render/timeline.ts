/**
 * Plan de la línea de tiempo en FOTOGRAMAS (puro y determinista).
 *
 * La receta trae tiempos en segundos (ya normalizados por `normalizeRecipe`, que es la verdad);
 * aquí se convierten a números enteros de fotogramas para que la duración del render sea exacta y
 * no se acumulen errores de redondeo: cada clip ocupa [startFrame, endFrame) en la línea final y
 * el traslape con el anterior (transición) es `prev.endFrame − startFrame`.
 *
 * Ventanas: el mismo constructor del grafo sirve para el render completo, para un fotograma suelto
 * (renderFrame) y para segmentos (videos largos). Una ventana pide [start, end) en fotogramas; si
 * un borde cae en medio de una transición, la ventana EFECTIVA se amplía hasta cubrirla completa
 * (para que el xfade avance igual que en el render completo) y al final se recorta a lo pedido.
 */
import { clipDuration, type Recipe, type TransitionType, type VideoClip } from "@autoeditor/shared";

export interface ClipSpan {
  index: number;
  clip: VideoClip;
  /** Fotograma de inicio en la línea final (incluido). */
  startFrame: number;
  /** Fotograma de fin en la línea final (excluido). */
  endFrame: number;
  /** Fotogramas de traslape con el clip anterior (0 = corte). */
  overlapFrames: number;
  /** Transición efectiva de entrada ("corte" si no hay traslape). */
  transition: TransitionType;
}

export interface TimelinePlan {
  fps: number;
  totalFrames: number;
  spans: ClipSpan[];
}

/** Segundos → fotograma más cercano. */
export const toFrame = (seconds: number, fps: number): number => Math.round(seconds * fps + 1e-9);

/** Plan en fotogramas de la secuencia principal (la receta debe venir normalizada). */
export function planTimeline(recipe: Recipe): TimelinePlan {
  const fps = recipe.format.fps;
  const spans: ClipSpan[] = [];
  recipe.tracks.video.forEach((clip, index) => {
    const startFrame = toFrame(clip.start, fps);
    let endFrame = toFrame(clip.start + clipDuration(clip), fps);
    if (endFrame <= startFrame) endFrame = startFrame + 1; // un clip nunca dura 0 fotogramas
    const prev = spans[spans.length - 1];
    const wantsTransition = !!prev && clip.transitionIn.type !== "corte";
    const overlapFrames = wantsTransition ? Math.max(0, Math.min(prev.endFrame - startFrame, endFrame - startFrame - 1, prev.endFrame - prev.startFrame - 1)) : 0;
    const transition: TransitionType = overlapFrames > 0 ? clip.transitionIn.type : "corte";
    // Si la transición quedó en 0 fotogramas el clip arranca justo donde terminó el anterior.
    const s = prev ? prev.endFrame - overlapFrames : startFrame;
    const len = endFrame - startFrame;
    spans.push({ index, clip, startFrame: s, endFrame: s + len, overlapFrames, transition });
  });
  const totalFrames = spans.length ? spans[spans.length - 1]!.endFrame : toFrame(recipe.duration, fps);
  return { fps, totalFrames, spans };
}

export interface WindowPiece {
  span: ClipSpan;
  /** Fotogramas recortados al inicio del clip (por la ventana). */
  headFrames: number;
  /** Fotogramas del clip dentro de la ventana efectiva. */
  frames: number;
  /** Inicio relativo a la ventana efectiva. */
  localStart: number;
  /** Traslape con la pieza anterior dentro de la ventana (0 = corte o primera pieza). */
  overlapFrames: number;
}

export interface WindowPlan {
  fps: number;
  /** Lo pedido (fotogramas absolutos). */
  reqStart: number;
  reqEnd: number;
  /** Ventana efectiva (ampliada para no cortar transiciones). */
  start: number;
  end: number;
  pieces: WindowPiece[];
}

/** Ventana [reqStart, reqEnd) en fotogramas absolutos. */
export function planWindow(plan: TimelinePlan, reqStart: number, reqEnd: number): WindowPlan {
  const total = plan.totalFrames;
  const rs = Math.max(0, Math.min(reqStart, total - 1));
  const re = Math.max(rs + 1, Math.min(reqEnd, total));
  let start = rs;
  let end = re;
  // Ampliar para no cortar una transición (como mucho una por borde: traslape ≤ mitad del clip).
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 1; i < plan.spans.length; i++) {
      const cur = plan.spans[i]!;
      const prev = plan.spans[i - 1]!;
      if (cur.overlapFrames <= 0) continue;
      if (start > cur.startFrame && start < prev.endFrame) {
        start = cur.startFrame;
        changed = true;
      }
      if (end > cur.startFrame && end < prev.endFrame) {
        end = prev.endFrame;
        changed = true;
      }
    }
  }
  const pieces: WindowPiece[] = [];
  for (const span of plan.spans) {
    if (span.endFrame <= start || span.startFrame >= end) continue;
    const s = Math.max(span.startFrame, start);
    const e = Math.min(span.endFrame, end);
    const localStart = s - start;
    const prev = pieces[pieces.length - 1];
    const overlapFrames = prev ? Math.max(0, prev.localStart + prev.frames - localStart) : 0;
    pieces.push({ span, headFrames: s - span.startFrame, frames: e - s, localStart, overlapFrames });
  }
  return { fps: plan.fps, reqStart: rs, reqEnd: re, start, end, pieces };
}

export interface SegmentOptions {
  /** Máximo de clips por segmento (grafos legibles y pocos decodificadores abiertos). */
  clipsPerSegment: number;
  /** Duración objetivo de un segmento en segundos (los videos largos se reparten en procesos en paralelo). */
  targetSeconds: number;
  /** Por debajo de esta duración total no se segmenta por tiempo. */
  minTotalSeconds: number;
}

export const DEFAULT_SEGMENTS: SegmentOptions = { clipsPerSegment: 12, targetSeconds: 12, minTotalSeconds: 24 };

/**
 * Corta la línea de tiempo en segmentos (ventanas) para videos largos o con muchos clips.
 * Es una función PURA de la receta (no depende de la máquina): así el resultado es determinista.
 *  1. Bordes en cortes secos cuando el segmento junta `clipsPerSegment` clips o `targetSeconds`.
 *  2. Un segmento que aún mida más de 2× el objetivo (p. ej. un clip larguísimo sin cortes) se
 *     parte en tramos iguales; la ventana recorta el clip por delante sin problema.
 */
export function segmentWindows(plan: TimelinePlan, opts: number | Partial<SegmentOptions> = {}): [number, number][] {
  const o: SegmentOptions = { ...DEFAULT_SEGMENTS, ...(typeof opts === "number" ? { clipsPerSegment: opts } : opts) };
  const F = plan.fps;
  const total = plan.totalFrames;
  const byTime = total / F > o.minTotalSeconds;
  if (plan.spans.length <= o.clipsPerSegment && !byTime) return [[0, total]];
  const target = byTime ? Math.round(o.targetSeconds * F) : Number.POSITIVE_INFINITY;
  const minTail = Math.min(Math.round(4 * F), Number.isFinite(target) ? Math.round(target / 3) : Math.round(4 * F));
  const bounds: number[] = [0];
  let segStart = 0;
  let clipsIn = 0;
  for (let i = 1; i < plan.spans.length; i++) {
    clipsIn++;
    const span = plan.spans[i]!;
    const b = span.startFrame;
    if (span.overlapFrames !== 0 || b - segStart <= 0) continue;
    if ((clipsIn >= o.clipsPerSegment || b - segStart >= target) && total - b >= minTail) {
      bounds.push(b);
      segStart = b;
      clipsIn = 0;
    }
  }
  bounds.push(total);
  const out: [number, number][] = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const a = bounds[k]!;
    const z = bounds[k + 1]!;
    if (z <= a) continue;
    const parts = Number.isFinite(target) && z - a > 2 * target ? Math.ceil((z - a) / target) : 1;
    for (let j = 0; j < parts; j++) {
      const s = a + Math.round(((z - a) * j) / parts);
      const e = a + Math.round(((z - a) * (j + 1)) / parts);
      if (e > s) out.push([s, e]);
    }
  }
  return out;
}
