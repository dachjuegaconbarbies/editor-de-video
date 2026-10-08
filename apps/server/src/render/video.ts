/**
 * Secuencia principal (tracks.video) → flujos normalizados W×H a fps fijos, yuv420p, con el número
 * EXACTO de fotogramas de cada pieza, y su encadenado con xfade (transiciones) o concat (cortes).
 *
 * Por clip: recorte exacto (`-ss`/`-t` por entrada + trim por fotogramas), velocidad (setpts),
 * reencuadre (llenar / seguir con keyframes suavizados / fondo desenfocado / ajustar), color (eq +
 * lutyuv: casi gratis; colorbalance/curves cuestan ~+0.7 s/s, media-pipeline.md §5.5), zoom con
 * easing (scale eval=frame + crop) y fotos fijas con Ken Burns (zoompan sobre UN solo fotograma
 * pre-escalado: el costo de escalar la foto se paga una vez y no tiembla).
 */
import type { Asset, ColorAdjust, Reframe, TransitionType, ZoomMove } from "@autoeditor/shared";
import { even, frameIndexPts, frameTimebase, num, type FilterGraph } from "./graph.js";
import type { OutputSpec } from "./layout.js";
import type { SourceInfo } from "./probe.js";
import type { WindowPiece, WindowPlan } from "./timeline.js";

export interface LoadedSource {
  asset: Asset;
  path: string;
  info: SourceInfo;
}
export type SourceMap = Map<string, LoadedSource>;

export interface VideoBuildOptions {
  graph: FilterGraph;
  spec: OutputSpec;
  sources: SourceMap;
  /** ¿Hay zscale para mapear HDR→SDR? */
  canTonemap: boolean;
}

const XFADE: Record<TransitionType, string> = {
  corte: "fade",
  fundido: "fade",
  "fundido-negro": "fadeblack",
  "deslizar-izq": "slideleft",
  "deslizar-der": "slideright",
  zoom: "zoomin",
  barrido: "wipeleft",
  desenfoque: "hblur",
};

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

/** Filtros de color baratos (YUV): lutyuv para el tinte y eq para brillo/contraste/saturación. */
export function colorFilters(c: ColorAdjust): string[] {
  let k = c.contrast;
  let s = c.saturation;
  let gamma = 1;
  let u = 0;
  let v = 0;
  switch (c.look) {
    case "calido":
      u = -6;
      v = 7;
      s *= 1.05;
      break;
    case "frio":
      u = 7;
      v = -5;
      break;
    case "vivo":
      s *= 1.3;
      k *= 1.08;
      break;
    case "blanco-negro":
      s = 0;
      k *= 1.1;
      break;
    case "cine":
      k *= 1.12;
      s *= 0.88;
      gamma = 0.95;
      u = -2;
      v = 3;
      break;
    default:
      break;
  }
  const out: string[] = [];
  const sh = (d: number) => (d >= 0 ? `val+${d}` : `val${d}`);
  if (u || v) out.push(`lutyuv=u='${sh(u)}':v='${sh(v)}'`);
  const b = Math.max(-1, Math.min(1, c.brightness));
  s = Math.max(0, Math.min(3, s));
  if (b !== 0 || Math.abs(k - 1) > 1e-6 || Math.abs(s - 1) > 1e-6 || gamma !== 1) {
    out.push(`eq=brightness=${num(b, 4)}:contrast=${num(k, 4)}:saturation=${num(s, 4)}${gamma !== 1 ? `:gamma=${num(gamma, 3)}` : ""}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Expresiones de tiempo
// ---------------------------------------------------------------------------

/** Expresión de progreso con easing (0..1) para la variable de tiempo `T`. */
export function easeExpr(T: string, start: number, end: number, ease: ZoomMove["ease"]): string {
  const d = Math.max(1e-3, end - start);
  const P = `clip((${T}-${num(start, 4)})/${num(d, 4)},0,1)`;
  if (ease === "lineal") return P;
  if (ease === "golpe") return `(1-pow(1-${P},3))`;
  return `(${P}*${P}*(3-2*${P}))`;
}

/** Expresión del factor de zoom en el tiempo `T` (relativo al clip). */
export function zoomExpr(T: string, z: ZoomMove, clipSeconds: number): string {
  const end = z.end != null && z.end > z.start ? z.end : clipSeconds;
  if (Math.abs(z.to - z.from) < 1e-4) return num(z.from, 4);
  return `(${num(z.from, 4)}+${num(z.to - z.from, 4)}*${easeExpr(T, z.start, end, z.ease)})`;
}

/** Suaviza y reduce keyframes de "seguir" (media móvil de 3 y máx. `maxPoints`, por el límite de anidamiento de ffmpeg). */
export function smoothKeyframes(kfs: Reframe["keyframes"], maxPoints = 40): { t: number; x: number; y: number }[] {
  const sorted = [...kfs].sort((a, b) => a.t - b.t).map((k) => ({ t: k.t, x: k.x, y: k.y ?? 0.5 }));
  const sm = sorted.map((k, i) => {
    const a = sorted[Math.max(0, i - 1)]!;
    const b = sorted[Math.min(sorted.length - 1, i + 1)]!;
    return { t: k.t, x: (a.x + 2 * k.x + b.x) / 4, y: (a.y + 2 * k.y + b.y) / 4 };
  });
  if (sm.length <= maxPoints) return sm;
  const out: typeof sm = [];
  for (let i = 0; i < maxPoints; i++) out.push(sm[Math.round((i * (sm.length - 1)) / (maxPoints - 1))]!);
  return out;
}

/** Interpolación por tramos con smoothstep: valores en píxeles ya acotados. */
function piecewiseExpr(T: string, pts: { t: number; v: number }[]): string {
  if (!pts.length) return "0";
  const same = pts.every((p) => Math.abs(p.v - pts[0]!.v) < 0.5);
  if (same) return num(pts[0]!.v, 1);
  let e = num(pts[pts.length - 1]!.v, 1);
  for (let k = pts.length - 2; k >= 0; k--) {
    const a = pts[k]!;
    const b = pts[k + 1]!;
    const d = Math.max(1e-3, b.t - a.t);
    const P = `((${T}-${num(a.t, 3)})/${num(d, 3)})`;
    e = `if(lt(${T},${num(b.t, 3)}),${num(a.v, 1)}+${num(b.v - a.v, 1)}*${P}*${P}*(3-2*${P}),${e})`;
  }
  return `if(lt(${T},${num(pts[0]!.t, 3)}),${num(pts[0]!.v, 1)},${e})`;
}

// ---------------------------------------------------------------------------
// Encuadre
// ---------------------------------------------------------------------------

/** Recorte (en px de la fuente) con la proporción de salida. */
export function cropForAspect(sw: number, sh: number, W: number, H: number): { cw: number; ch: number } {
  const A = W / H;
  if (sw / sh > A) return { cw: Math.min(sw, even(sh * A)), ch: sh - (sh % 2) };
  return { cw: sw - (sw % 2), ch: Math.min(sh, even(sw / A)) };
}

const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Zoom animado: escala por fotograma (eval=frame) a W·Z × H·Z y recorta W×H hacia el foco.
 * Más barato y estable que zoompan (que redondea x/y a píxeles de la entrada y tiembla; medido:
 * zoompan desde un lienzo 2× costó 0.6 s/s contra 0.27 s/s de este método).
 */
export function zoomFilters(W: number, H: number, z: string, fx = 0.5, fy = 0.5): string[] {
  return [`scale=w='2*trunc(${W}*${z}/2)':h='2*trunc(${H}*${z}/2)':eval=frame`, `crop=${W}:${H}:'(iw-ow)*${num(fx, 4)}':'(ih-oh)*${num(fy, 4)}'`];
}

const isFlat = (z: ZoomMove | null | undefined): boolean => !z || (Math.abs(z.to - z.from) < 1e-4 && Math.abs(z.from - 1) < 1e-4);

/**
 * Filtros para llevar un cuadro (video) a W×H según el modo de reencuadre, con el zoom ya
 * integrado (en llenar/seguir se escala UNA sola vez: del recorte de la fuente al tamaño con zoom).
 */
function reframeVideo(
  g: FilterGraph,
  input: string,
  r: Reframe,
  sw: number,
  sh: number,
  spec: OutputSpec,
  color: string[],
  T: string,
  zoom: string | null,
): string {
  const { width: W, height: H } = spec;
  const out = g.label("rf");
  const z = zoom ? zoomFilters(W, H, zoom) : [];
  if (r.mode === "ajustar") {
    return g.chain([input], [...color, `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`, ...z], out);
  }
  if (r.mode === "fondo-desenfocado") {
    const base = color.length ? g.chain([input], color, g.label("col")) : input;
    const [a, b] = g.split(base, 2);
    const bw = even(W / 4);
    const bh = even(H / 4);
    const bg = g.chain([a!], [`scale=${bw}:${bh}:force_original_aspect_ratio=increase`, `crop=${bw}:${bh}`, "boxblur=10:2", `scale=${W}:${H}`, "eq=brightness=-0.08"], g.label("bg"));
    const fg = g.chain([b!], [`scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2`], g.label("fg"));
    return g.chain([bg, fg], ["overlay=(W-w)/2:(H-h)/2", ...z], out);
  }
  // llenar / seguir
  const { cw, ch } = cropForAspect(sw, sh, W, H);
  const filters: string[] = [];
  let fx = 0.5;
  let fy = 0.5;
  if (cw < sw || ch < sh) {
    if (r.mode === "seguir" && r.keyframes.length) {
      const kfs = smoothKeyframes(r.keyframes);
      const xs = kfs.map((k) => ({ t: k.t, v: clampN(k.x * sw - cw / 2, 0, sw - cw) }));
      const ys = kfs.map((k) => ({ t: k.t, v: clampN(k.y * sh - ch / 2, 0, sh - ch) }));
      filters.push(`crop=${cw}:${ch}:x='${piecewiseExpr(T, xs)}':y='${piecewiseExpr(T, ys)}'`);
    } else {
      const x = Math.round(clampN(r.focusX * sw - cw / 2, 0, sw - cw));
      const y = Math.round(clampN(r.focusY * sh - ch / 2, 0, sh - ch));
      filters.push(`crop=${cw}:${ch}:${x}:${y}`);
    }
  } else {
    // La fuente ya tiene la proporción: el zoom va hacia el foco.
    fx = r.focusX;
    fy = r.focusY;
  }
  filters.push(...color, ...(zoom ? zoomFilters(W, H, zoom, fx, fy) : [`scale=${W}:${H}`]));
  return g.chain([input], filters, out);
}

/** Lienzo W×H (una sola imagen) para una foto según el modo de reencuadre. */
function stillCanvas(g: FilterGraph, input: string, r: Reframe, spec: OutputSpec, color: string[]): string {
  const cw = spec.width;
  const ch = spec.height;
  const out = g.label("cv");
  if (r.mode === "ajustar") {
    g.chain([input], [...color, `scale=${cw}:${ch}:force_original_aspect_ratio=decrease:force_divisible_by=2`, `pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2:black`, "setsar=1"], out);
  } else if (r.mode === "fondo-desenfocado") {
    const base = color.length ? g.chain([input], color, g.label("col")) : input;
    const [a, b] = g.split(base, 2);
    const bw = even(cw / 4);
    const bh = even(ch / 4);
    const bg = g.chain([a!], [`scale=${bw}:${bh}:force_original_aspect_ratio=increase`, `crop=${bw}:${bh}`, "boxblur=10:2", `scale=${cw}:${ch}`, "eq=brightness=-0.08"], g.label("bg"));
    const fg = g.chain([b!], [`scale=${cw}:${ch}:force_original_aspect_ratio=decrease:force_divisible_by=2`], g.label("fg"));
    g.chain([bg, fg], ["overlay=(W-w)/2:(H-h)/2", "setsar=1"], out);
  } else {
    const fx = num(r.focusX, 4);
    const fy = num(r.focusY, 4);
    g.chain([input], [...color, `scale=${cw}:${ch}:force_original_aspect_ratio=increase`, `crop=${cw}:${ch}:'(iw-ow)*${fx}':'(ih-oh)*${fy}'`, "setsar=1"], out);
  }
  return out;
}

/** Zoom de Ken Burns por defecto para fotos (suave, 1 → 1.08 a lo largo del clip). */
export const DEFAULT_KEN_BURNS: ZoomMove = { from: 1, to: 1.08, start: 0, end: null, ease: "suave" };

const HDR_TONEMAP = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";

/**
 * Agrega al grafo un clip principal recortado a la ventana y devuelve la etiqueta del flujo
 * normalizado (W×H, fps de salida, yuv420p, exactamente `piece.frames` fotogramas).
 */
export function buildClipVideo(o: VideoBuildOptions, piece: WindowPiece): string {
  const { graph: g, spec } = o;
  const clip = piece.span.clip;
  const src = o.sources.get(clip.assetId);
  if (!src) throw new Error(`Falta el archivo del clip ${clip.id}`);
  const F = spec.fps;
  const N = piece.frames;
  const headSec = piece.headFrames / F;
  const clipSeconds = (piece.span.endFrame - piece.span.startFrame) / F;
  const color = colorFilters(clip.color);
  const still = src.info.isImage || clip.stillDuration != null || !src.info.hasVideo;
  const out = g.label("clip");
  // Tiempo relativo al INICIO DEL CLIP (aunque la ventana lo recorte por delante).
  const T = `(t+${num(headSec, 6)})`;

  if (!src.info.hasVideo && !src.info.isImage) {
    // Un audio puesto en la pista de video: cuadro negro.
    return g.chain([], [`color=c=black:s=${spec.width}x${spec.height}:r=${spec.fpsArg}`, `trim=end_frame=${N}`, "setsar=1", "format=yuv420p"], out);
  }

  if (still) {
    const opts = src.info.isImage ? [] : ["-ss", num(clip.sourceIn, 3)];
    if (src.info.vp9Alpha) opts.unshift("-c:v", "libvpx-vp9");
    const idx = g.addInput(opts, src.path);
    const first = g.chain([`${idx}:v`], ["trim=end_frame=1", "setpts=PTS-STARTPTS", ...(src.info.hdr && o.canTonemap ? [HDR_TONEMAP] : [])], g.label("st"));
    // El lienzo se compone UNA vez; luego se repite N veces y se anima con zoom (Ken Burns).
    const canvas = stillCanvas(g, first, clip.reframe, spec, color);
    const zoom = clip.zoom ?? DEFAULT_KEN_BURNS;
    const z = isFlat(zoom) ? [] : zoomFilters(spec.width, spec.height, zoomExpr(T, zoom, clipSeconds));
    return g.chain([canvas], ["format=yuv420p", `loop=loop=${Math.max(0, N - 1)}:size=1`, ...frameIndexPts(spec.fpsArg), ...z, "setsar=1", "format=yuv420p"], out);
  }

  // Video: búsqueda por entrada (rápida y precisa al recodificar) + un margen que se recorta por fotogramas.
  const speed = clip.speed || 1;
  const inSec = clip.sourceIn + headSec * speed;
  const needSec = (N / F) * speed + (2 / F) * speed + 0.05;
  const opts = ["-ss", num(inSec, 6), "-t", num(needSec, 6)];
  if (src.info.vp9Alpha) opts.unshift("-c:v", "libvpx-vp9");
  const idx = g.addInput(opts, src.path);
  const pre = [
    speed === 1 ? "setpts=PTS-STARTPTS" : `setpts=(PTS-STARTPTS)/${num(speed, 6)}`,
    `fps=${spec.fpsArg}`,
    `tpad=stop_mode=clone:stop_duration=${num(N / F + 1, 3)}`,
    `trim=end_frame=${N}`,
    "setpts=PTS-STARTPTS",
    ...(src.info.hdr && o.canTonemap ? [HDR_TONEMAP] : []),
  ];
  const norm = g.chain([`${idx}:v`], pre, g.label("n"));
  const sw = src.info.width ?? spec.width;
  const sh = src.info.height ?? spec.height;
  const zoom = isFlat(clip.zoom) ? null : zoomExpr(T, clip.zoom!, clipSeconds);
  const cur = reframeVideo(g, norm, clip.reframe, sw, sh, spec, color, T, zoom);
  return g.chain([cur], ["setsar=1", "format=yuv420p"], out);
}

export interface SequenceItem {
  label: string;
  frames: number;
  localStart: number;
  overlapFrames: number;
  transition: TransitionType;
}

/**
 * Encadena flujos: corridas de cortes secos → un solo concat; transiciones → xfade con
 * offset = inicio local / fps (el flujo acumulado empieza en 0 de la ventana).
 */
export function chainSequence(g: FilterGraph, items: SequenceItem[], fps: number, kind: "v" | "a", fpsArg = String(fps)): string {
  if (!items.length) throw new Error("Secuencia vacía");
  let run: string[] = [items[0]!.label];
  const flush = (): string => {
    if (run.length === 1) return run[0]!;
    const out = g.label(kind === "v" ? "cat" : "acat");
    // concat entrega base de tiempo 1/1000000: se regresa a la del fotograma (o de la muestra)
    // porque xfade/acrossfade exigen la misma base en ambas entradas.
    const tb = kind === "v" ? `settb=${frameTimebase(fpsArg)}` : "asettb=1/48000";
    g.chain(run, [`concat=n=${run.length}:v=${kind === "v" ? 1 : 0}:a=${kind === "a" ? 1 : 0}`, tb], out);
    return out;
  };
  for (let k = 1; k < items.length; k++) {
    const it = items[k]!;
    if (it.overlapFrames <= 0) {
      run.push(it.label);
      continue;
    }
    const acc = flush();
    const out = g.label(kind === "v" ? "xf" : "axf");
    const d = it.overlapFrames / fps;
    if (kind === "v") {
      g.chain([acc, it.label], `xfade=transition=${XFADE[it.transition] ?? "fade"}:duration=${num(d, 6)}:offset=${num(it.localStart / fps, 6)}`, out);
    } else {
      g.chain([acc, it.label], `acrossfade=d=${num(d, 6)}:c1=tri:c2=tri`, out);
    }
    run = [out];
  }
  return flush();
}

/** Secuencia principal de una ventana (empieza en 0 local). */
export function buildMainSequence(o: VideoBuildOptions, win: WindowPlan): string {
  const { graph: g, spec } = o;
  const frames = win.end - win.start;
  if (!win.pieces.length) {
    return g.chain([], [`color=c=black:s=${spec.width}x${spec.height}:r=${spec.fpsArg}`, `trim=end_frame=${frames}`, "setsar=1", "format=yuv420p"], g.label("negro"));
  }
  const items: SequenceItem[] = win.pieces.map((p) => ({
    label: buildClipVideo(o, p),
    frames: p.frames,
    localStart: p.localStart,
    overlapFrames: p.overlapFrames,
    transition: p.span.transition,
  }));
  return chainSequence(g, items, spec.fps, "v", spec.fpsArg);
}
