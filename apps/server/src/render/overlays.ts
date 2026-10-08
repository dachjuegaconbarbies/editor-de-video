/**
 * Capas encima de la secuencia principal, ya en tiempo ABSOLUTO de la línea final (el flujo base
 * se desplaza con `setpts=PTS+inicio/TB` antes de llegar aquí):
 *
 *  - Overlays (b-roll, imágenes, IA, logo) con su layout, opacidad, transición de entrada/salida y
 *    Ken Burns en imágenes. "fondo-con-orador": el b-roll ocupa el cuadro y la persona del clip
 *    principal va en un recuadro redondeado con borde.
 *  - Gráficos (clips con alfa ya renderizados por un motor de motion graphics).
 *
 * Cada capa entra como su propia entrada de ffmpeg recortada a la ventana (`-ss`/`-t`), así un
 * segmento o un fotograma suelto solo decodifica lo necesario.
 */
import type { GraphicItem, OverlayItem, Transition } from "@autoeditor/shared";
import { even, frameIndexPts, num, type FilterGraph } from "./graph.js";
import type { OutputSpec } from "./layout.js";
import { toFrame, type WindowPlan } from "./timeline.js";
import { zoomExpr, zoomFilters, type LoadedSource, type SourceMap } from "./video.js";

export interface LayerContext {
  graph: FilterGraph;
  spec: OutputSpec;
  sources: SourceMap;
  win: WindowPlan;
  /** Alto (px de salida) reservado abajo para subtítulos: los PIP de abajo no los tapan. */
  captionsReservePx: number;
}

interface Span {
  /** Inicio/fin dentro de la ventana efectiva (segundos absolutos, alineados a fotogramas). */
  S: number;
  E: number;
  frames: number;
  /** Segundos desde el inicio del ítem hasta S (para el `-ss` de la entrada). */
  offset: number;
}

/** Intersección de [start, end) con la ventana efectiva, alineada a fotogramas. */
function spanInWindow(start: number, end: number, win: WindowPlan): Span | null {
  const F = win.fps;
  const sf = Math.max(toFrame(start, F), win.start);
  const ef = Math.min(toFrame(end, F), win.end);
  if (ef <= sf) return null;
  return { S: sf / F, E: ef / F, frames: ef - sf, offset: Math.max(0, sf / F - start) };
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Llenar la caja recortando (true) o caber completo conservando proporción (false). */
  cover: boolean;
  /** Radio de esquinas redondeadas en px (0 = rectas). */
  radius: number;
}

function sourceAspect(src: LoadedSource): number {
  const w = src.info.width ?? 16;
  const h = src.info.height ?? 9;
  return w / Math.max(1, h);
}

/** Geometría de un overlay según su layout. */
export function overlayBox(item: Pick<OverlayItem, "kind" | "layout">, aspect: number, spec: OutputSpec, captionsReservePx: number): Box {
  const { width: W, height: H } = spec;
  const vertical = W < H;
  if (item.kind === "logo") {
    const full = item.layout === "pantalla-completa";
    const w = even(W * (full ? 0.5 : vertical ? 0.26 : 0.16));
    const h = even(Math.min(H * (full ? 0.4 : 0.14), w / aspect));
    const ww = even(Math.min(w, h * aspect));
    if (full) return { x: Math.round((W - ww) / 2), y: Math.round((H - h) / 2), w: ww, h, cover: false, radius: 0 };
    return { ...pipPosition(item.layout, ww, h, spec, captionsReservePx), w: ww, h, cover: false, radius: 0 };
  }
  switch (item.layout) {
    case "mitad-superior":
      return { x: 0, y: 0, w: W, h: even(H / 2), cover: true, radius: 0 };
    case "mitad-inferior":
      return { x: 0, y: H - even(H / 2), w: W, h: even(H / 2), cover: true, radius: 0 };
    case "pip-arriba-der":
    case "pip-arriba-izq":
    case "pip-abajo-der":
    case "pip-abajo-izq": {
      const w = even(W * (vertical ? 0.46 : 0.32));
      const h = even(Math.min(H * 0.38, w / aspect));
      const ww = even(Math.min(w, h * aspect));
      return { ...pipPosition(item.layout, ww, h, spec, captionsReservePx), w: ww, h, cover: true, radius: Math.round(Math.min(ww, h) * 0.08) };
    }
    default:
      return { x: 0, y: 0, w: W, h: H, cover: true, radius: 0 };
  }
}

function pipPosition(layout: OverlayItem["layout"], w: number, h: number, spec: OutputSpec, reserve: number): { x: number; y: number } {
  const { width: W, height: H, safe } = spec;
  const left = Math.round(W * safe.left);
  const right = Math.round(W * (1 - safe.right) - w);
  const top = Math.round(H * safe.top);
  const bottom = Math.round(H * (1 - safe.bottom) - h - reserve);
  switch (layout) {
    case "pip-arriba-izq":
      return { x: left, y: top };
    case "pip-abajo-izq":
      return { x: left, y: Math.max(top, bottom) };
    case "pip-abajo-der":
      return { x: right, y: Math.max(top, bottom) };
    default:
      return { x: right, y: top };
  }
}

/** Recuadro de "fondo-con-orador": la persona en un recuadro vertical arriba a la izquierda (zona segura). */
export function speakerBox(spec: OutputSpec): Box {
  const { width: W, height: H, safe } = spec;
  const vertical = W < H;
  const w = even(W * (vertical ? 0.44 : 0.26));
  const h = even(w * 1.25);
  return { x: Math.round(W * safe.left), y: Math.round(H * safe.top), w, h, cover: true, radius: Math.round(w * 0.07) };
}

/** Máscara de esquinas redondeadas (gris) de `frames` fotogramas: se calcula UNA vez y se repite. */
function roundedMask(g: FilterGraph, w: number, h: number, r: number, frames: number, spec: OutputSpec): string {
  const R = Math.max(1, Math.round(r));
  const expr = `if(lte(pow(max(max(${R}-X\\,X-(W-1-${R}))\\,0)\\,2)+pow(max(max(${R}-Y\\,Y-(H-1-${R}))\\,0)\\,2)\\,${R * R})\\,255\\,0)`;
  return g.chain(
    [],
    [`color=c=black:s=${w}x${h}:r=${spec.fpsArg}`, "format=gray", "trim=end_frame=1", `geq=lum='${expr}'`, `loop=loop=${Math.max(0, frames - 1)}:size=1`, ...frameIndexPts(spec.fpsArg)],
    g.label("mask"),
  );
}

/** Filtros de entrada/salida (fundido con alfa) en tiempo absoluto. */
function fadeFilters(t: Transition, start: number, end: number): string[] {
  if (t.type === "corte" || t.duration <= 0) return [];
  const d = Math.min(t.duration, (end - start) / 2);
  if (d <= 0.001) return [];
  return [`fade=t=in:st=${num(start, 4)}:d=${num(d, 4)}:alpha=1`, `fade=t=out:st=${num(end - d, 4)}:d=${num(d, 4)}:alpha=1`];
}

/** Expresión de x con deslizamiento de entrada/salida (deslizar-izq/der). */
function slideX(t: Transition, x: number, w: number, start: number, end: number, W: number): string {
  if (t.type !== "deslizar-izq" && t.type !== "deslizar-der") return String(x);
  const d = Math.max(0.05, Math.min(t.duration || 0.3, (end - start) / 2));
  const dist = t.type === "deslizar-izq" ? W - x : -(x + w);
  const pin = `(1-clip((t-${num(start, 4)})/${num(d, 4)},0,1))`;
  const pout = `clip((t-${num(end - d, 4)})/${num(d, 4)},0,1)`;
  return `'${x}+${num(dist, 1)}*(${pin}*${pin})-${num(dist, 1)}*(${pout}*${pout})'`;
}

/** Fuente del overlay → flujo w×h yuva420p con `span.frames` fotogramas (tiempo local desde 0). */
function overlaySourceStream(ctx: LayerContext, src: LoadedSource, item: OverlayItem, span: Span, box: Box): string {
  const g = ctx.graph;
  const { spec } = ctx;
  const N = span.frames;
  const fit = box.cover
    ? [`scale=${box.w}:${box.h}:force_original_aspect_ratio=increase`, `crop=${box.w}:${box.h}`]
    : [`scale=${box.w}:${box.h}:force_original_aspect_ratio=decrease:force_divisible_by=2`, `pad=${box.w}:${box.h}:(ow-iw)/2:(oh-ih)/2:color=black@0`];
  if (src.info.isImage || !src.info.hasVideo) {
    const idx = g.addInput([], src.path);
    // La imagen se ajusta UNA vez a la caja, se repite N veces y (si aplica) se anima con zoom.
    const kb =
      item.kenBurns && item.kind !== "logo"
        ? zoomFilters(box.w, box.h, zoomExpr(`(t+${num(span.offset, 6)})`, { from: 1, to: 1.1, start: 0, end: null, ease: "suave" }, item.end - item.start))
        : [];
    return g.chain(
      [`${idx}:v`],
      ["trim=end_frame=1", "setpts=PTS-STARTPTS", "format=yuva444p", ...fit, "setsar=1", "format=yuva420p", `loop=loop=${Math.max(0, N - 1)}:size=1`, ...frameIndexPts(spec.fpsArg), ...kb, "format=yuva420p"],
      g.label("ovi"),
    );
  }
  const opts = ["-ss", num(item.sourceIn + span.offset, 6), "-t", num(N / spec.fps + 0.1, 6)];
  if (src.info.vp9Alpha) opts.unshift("-c:v", "libvpx-vp9");
  const idx = g.addInput(opts, src.path);
  return g.chain(
    [`${idx}:v`],
    ["setpts=PTS-STARTPTS", `fps=${spec.fpsArg}`, `tpad=stop_mode=clone:stop_duration=${num(N / spec.fps + 1, 3)}`, `trim=end_frame=${N}`, "setpts=PTS-STARTPTS", ...fit, "setsar=1", "format=yuva420p"],
    g.label("ovv"),
  );
}

/** Aplica redondeo, opacidad y desplaza el flujo a tiempo absoluto con sus fundidos. */
function finishLayer(ctx: LayerContext, stream: string, box: Box, span: Span, item: { start: number; end: number; opacity: number; transition: Transition }, border = 0): string {
  const g = ctx.graph;
  let cur = stream;
  let w = box.w;
  let h = box.h;
  if (border > 0) {
    cur = g.chain([cur], [`pad=${w + 2 * border}:${h + 2 * border}:${border}:${border}:color=white`], g.label("brd"));
    w += 2 * border;
    h += 2 * border;
  }
  if (box.radius > 0) {
    const mask = roundedMask(g, w, h, box.radius + border, span.frames, ctx.spec);
    cur = g.chain([cur, mask], ["alphamerge"], g.label("rnd"));
  }
  const filters: string[] = [];
  if (item.opacity < 0.999) filters.push(`lut=a='val*${num(Math.max(0, item.opacity), 3)}'`);
  filters.push(`setpts=PTS+${num(span.S, 6)}/TB`);
  if (item.transition.type !== "deslizar-izq" && item.transition.type !== "deslizar-der") filters.push(...fadeFilters(item.transition, item.start, item.end));
  return g.chain([cur], filters, g.label("lay"));
}

function overlayOnto(ctx: LayerContext, base: string, layer: string, x: string | number, y: number, span: Span): string {
  return ctx.graph.chain([base, layer], [`overlay=x=${x}:y=${y}:eof_action=pass:format=auto:enable='between(t,${num(span.S - 0.0005, 4)},${num(span.E - 0.0005, 4)})'`], ctx.graph.label("ov"));
}

/** Overlays de tracks.overlays (en orden: b-roll/imágenes primero, logos al final). */
export function applyOverlays(ctx: LayerContext, base: string, items: OverlayItem[]): string {
  let cur = base;
  const ordered = [...items.filter((o) => o.kind !== "logo"), ...items.filter((o) => o.kind === "logo")];
  for (const item of ordered) {
    const span = spanInWindow(item.start, item.end, ctx.win);
    if (!span) continue;
    const src = ctx.sources.get(item.assetId);
    if (!src) continue;
    const g = ctx.graph;
    const W = ctx.spec.width;
    if (item.layout === "fondo-con-orador" && item.kind !== "logo") {
      // 1) b-roll a pantalla completa
      const full: Box = { x: 0, y: 0, w: W, h: ctx.spec.height, cover: true, radius: 0 };
      const [main, pers] = g.split(cur, 2);
      const broll = finishLayer(ctx, overlaySourceStream(ctx, src, item, span, full), full, span, item);
      let comp = overlayOnto(ctx, main!, broll, 0, 0, span);
      // 2) la persona (del flujo principal) en un recuadro redondeado con borde
      const box = speakerBox(ctx.spec);
      const { width: SW, height: SH } = ctx.spec;
      const ch = even(Math.min(SH * 0.72, SW * 0.8 * (box.h / box.w)));
      const cw = even(ch * (box.w / box.h));
      const cx = Math.round(Math.max(0, Math.min(SW - cw, SW / 2 - cw / 2)));
      const cy = Math.round(Math.max(0, Math.min(SH - ch, SH * 0.42 - ch / 2)));
      const person = g.chain(
        [pers!],
        [`trim=start=${num(span.S - 0.0005, 6)}:end=${num(span.E - 0.0005, 6)}`, "setpts=PTS-STARTPTS", `crop=${cw}:${ch}:${cx}:${cy}`, `scale=${box.w}:${box.h}`, "format=yuva420p"],
        g.label("pers"),
      );
      const border = Math.max(2, Math.round(Math.min(SW, SH) * 0.006));
      const pl = finishLayer(ctx, person, box, span, { ...item, opacity: 1 }, border);
      comp = overlayOnto(ctx, comp, pl, box.x - border, box.y - border, span);
      cur = comp;
      continue;
    }
    const box = overlayBox(item, sourceAspect(src), ctx.spec, ctx.captionsReservePx);
    const layer = finishLayer(ctx, overlaySourceStream(ctx, src, item, span, box), box, span, item);
    const x = slideX(item.transition, box.x, box.w, item.start, item.end, W);
    cur = overlayOnto(ctx, cur, layer, x, box.y, span);
  }
  return cur;
}

export interface GraphicSource {
  item: GraphicItem;
  path: string;
  /** VP9 con alfa: decodificar con libvpx-vp9. */
  vp9Alpha: boolean;
  width: number | null;
  height: number | null;
}

/** Gráficos (clips con alfa) a cuadro completo en su rango. */
export function applyGraphics(ctx: LayerContext, base: string, graphics: GraphicSource[]): string {
  let cur = base;
  const g = ctx.graph;
  const { width: W, height: H } = ctx.spec;
  for (const gr of graphics) {
    const span = spanInWindow(gr.item.start, gr.item.end, ctx.win);
    if (!span) continue;
    const opts = ["-ss", num(span.offset, 6), "-t", num(span.frames / ctx.spec.fps + 0.1, 6)];
    if (gr.vp9Alpha) opts.unshift("-c:v", "libvpx-vp9");
    const idx = g.addInput(opts, gr.path);
    const scale = gr.width === W && gr.height === H ? [] : [`scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0`];
    const layer = g.chain(
      [`${idx}:v`],
      ["setpts=PTS-STARTPTS", `fps=${ctx.spec.fpsArg}`, `trim=end_frame=${span.frames}`, "format=yuva420p", ...scale, `setpts=PTS+${num(span.S, 6)}/TB`],
      g.label("gfx"),
    );
    cur = overlayOnto(ctx, cur, layer, 0, 0, span);
  }
  return cur;
}
