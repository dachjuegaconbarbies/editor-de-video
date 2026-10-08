/**
 * Render: receta → ffmpeg, determinista.
 *
 * Flujo de `render()`:
 *   1. normalizeRecipe (la verdad de los `start`) → plan en FOTOGRAMAS (timeline.ts): la duración
 *      del video es exactamente round(duración × fps) fotogramas.
 *   2. Archivos: resolveAsset + ffprobe (dimensiones rotadas, audio, alfa, HDR).
 *   3. Gráficos sin `renderedAssetId` → motor builtin al vuelo (caché por hash en ctx.workDir).
 *   4. Textos + subtítulos → un .ass (assfile.ts) con sus fuentes copiadas a la carpeta del trabajo.
 *   5. Audio → WAV masterizado (audio.ts: mezcla, ducking, SFX, loudnorm en dos pasadas).
 *   6. Video: UN grafo (video.ts + overlays.ts + ass) y una sola codificación H.264 que además
 *      mete el audio en AAC. Videos con muchos clips (>12) o largos (>24 s) se cortan en
 *      SEGMENTOS (ventanas de ≤12 clips / ~12 s, con bordes preferentemente en cortes secos)
 *      codificados con los mismos parámetros, 2 a la vez, y unidos con el demuxer concat SIN
 *      recodificar (ver la decisión abajo).
 *
 * Decisión (grafos enormes): con 20+ clips el grafo único funciona, pero cada entrada abre su
 * propio decodificador (memoria) y el grafo se vuelve difícil de depurar; además en ffmpeg 6.x el
 * filtergraph corre en UN hilo (medido: los filtros, no x264, marcan el ritmo). Por eso se
 * renderizan segmentos con el MISMO constructor de grafos (una ventana de la línea de tiempo; si
 * un borde cae en una transición, la ventana se amplía y se recorta), en paralelo, y se concatenan
 * con `-c copy`: sin pérdida adicional ni costo extra de codificación. La segmentación es función
 * pura de la receta, así que el resultado no depende de cuántos núcleos tenga la máquina.
 *
 * Determinismo: mismas entradas → mismos bytes (x264 con hilos fijos `-threads 4`, flags
 * bitexact, sin metadatos, fuentes copiadas por receta, sin nada aleatorio).
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  groupCaptionLines,
  normalizeRecipe,
  toPlainText,
  toSrt,
  toVtt,
  type ExportQuality,
  type MotionTemplate,
  type Recipe,
} from "@autoeditor/shared";
import type { Env } from "../env.js";
import { createBuiltinMotionEngine, graphicCacheKey } from "../motion/builtin.js";
import { UserFacingError, type Log, type MotionEngine, type RenderContext, type RenderOutput, type Renderer, type RunOptions } from "../services/types.js";
import { buildAss, fontLibraryFor, prepareFonts, stageAssFonts } from "./assfile.js";
import { buildAudioGraph, masterLoudness, SAMPLE_RATE } from "./audio.js";
import { ffmpegInfo, filterGraphArgs, formatCommand, runFfmpeg } from "./ffmpeg.js";
import { FilterGraph, num } from "./graph.js";
import { outputSpec, type OutputSpec } from "./layout.js";
import { applyGraphics, applyOverlays, type GraphicSource } from "./overlays.js";
import { probeSource, sourceInfoFor } from "./probe.js";
import { captionWordsWithOverrides } from "./subtitles.js";
import { DEFAULT_SEGMENTS, planTimeline, planWindow, segmentWindows, toFrame, type TimelinePlan, type WindowPlan } from "./timeline.js";
import { buildMainSequence, type SourceMap } from "./video.js";

export interface RenderDeps {
  env: Env;
  log: Log;
  /** Motor para gráficos sin `renderedAssetId` (por defecto, el builtin de ffmpeg). */
  motion?: MotionEngine | null;
  /** A partir de cuántos clips se renderiza por segmentos (por defecto 12). */
  segmentClips?: number;
  /** Segmentos que se renderizan a la vez (por defecto 2 con 4+ núcleos). No cambia el resultado. */
  segmentConcurrency?: number;
}

/** Hilos fijos del codificador: con otro número x264 produce otros bytes (media-pipeline.md §9.1). */
const ENCODER_THREADS = "4";
const REQUIRED_FILTERS = ["ass", "xfade", "acrossfade", "sidechaincompress", "loudnorm", "alimiter", "zoompan", "alphamerge", "geq", "boxblur", "tpad", "afftdn"];

function x264Args(spec: OutputSpec): string[] {
  return [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-threads",
    ENCODER_THREADS,
    "-g",
    String(Math.max(1, Math.round(spec.fps * 2))),
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    "-flags:v",
    "+bitexact",
  ];
}
const AAC_ARGS = ["-c:a", "aac", "-b:a", "192k", "-ar", String(SAMPLE_RATE), "-ac", "2", "-flags:a", "+bitexact"];
const CLEAN_ARGS = ["-fflags", "+bitexact", "-map_metadata", "-1", "-map_chapters", "-1"];
/** Para depurar: AUTOEDITOR_KEEP_RENDER_DIR=1 conserva la carpeta del trabajo (grafos, .ass, WAV). */
const keepDir = () => /^(1|true|si|sí)$/i.test(process.env.AUTOEDITOR_KEEP_RENDER_DIR ?? "");
const cleanup = async (dir: string, log: Log) => {
  if (keepDir()) log.info({ dir }, "Carpeta del render conservada (AUTOEDITOR_KEEP_RENDER_DIR)");
  else await rm(dir, { recursive: true, force: true }).catch(() => undefined);
};

/** Ejecuta tareas con un máximo de `n` simultáneas; si una falla, no lanza nuevas y propaga el error. */
async function runPool(jobs: (() => Promise<void>)[], n: number): Promise<void> {
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (next < jobs.length && failed == null) {
      const job = jobs[next++]!;
      try {
        await job();
      } catch (err) {
        failed ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
  if (failed != null) throw failed;
}

interface Prepared {
  recipe: Recipe;
  plan: TimelinePlan;
  spec: OutputSpec;
  sources: SourceMap;
  graphics: GraphicSource[];
  ass: { file: string; fontsDir: string } | null;
  reservePx: number;
  canTonemap: boolean;
}

export function createRenderer(deps: RenderDeps): Renderer {
  const { env, log } = deps;
  const ffmpeg = env.ffmpegPath;
  const ffprobe = env.ffprobePath;
  const fontsCacheDir = path.join(env.dataDir, "fonts-cache");
  const segmentClips = Math.max(2, deps.segmentClips ?? DEFAULT_SEGMENTS.clipsPerSegment);
  // Segmentos en paralelo: 2 procesos de x264 (4 hilos cada uno) si hay 4+ núcleos.
  const concurrency = Math.max(1, deps.segmentConcurrency ?? (os.availableParallelism() >= 4 ? 2 : 1));
  const fmt = (args: string[]) => formatCommand(ffmpeg, args);
  let builtin: MotionEngine | null = deps.motion ?? null;
  /** Argumentos del grafo (inline o archivo si es enorme); con AUTOEDITOR_KEEP_RENDER_DIR también se guarda. */
  const graphArgs = async (graph: string, jobDir: string, name: string): Promise<string[]> => {
    if (keepDir()) await writeFile(path.join(jobDir, name), graph, "utf8");
    return filterGraphArgs(graph, jobDir, (await ffmpegInfo(ffmpeg)).major, name);
  };
  const motionEngine = () => (builtin ??= createBuiltinMotionEngine({ ffmpegPath: ffmpeg, log, fontsCacheDir, cacheDir: null }));

  async function loadSources(recipe: Recipe, ctx: RenderContext): Promise<SourceMap> {
    const ids = new Set<string>();
    recipe.tracks.video.forEach((c) => ids.add(c.assetId));
    recipe.tracks.overlays.forEach((o) => ids.add(o.assetId));
    recipe.tracks.graphics.forEach((g) => g.renderedAssetId && ids.add(g.renderedAssetId));
    recipe.tracks.audio.music.forEach((m) => ids.add(m.assetId));
    recipe.tracks.audio.sfx.forEach((s) => ids.add(s.assetId));
    recipe.tracks.audio.voiceover.forEach((v) => ids.add(v.assetId));
    const map: SourceMap = new Map();
    for (const id of [...ids].sort()) {
      let resolved;
      try {
        resolved = await ctx.resolveAsset(id);
      } catch (err) {
        throw new UserFacingError("archivo-faltante", "Falta un archivo que usa la receta (quizá se borró). Vuelve a subirlo o quítalo de la edición.", 404, {
          assetId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!existsSync(resolved.path)) {
        throw new UserFacingError("archivo-faltante", `No encuentro el archivo «${resolved.asset.originalName}». Vuelve a subirlo.`, 404, { assetId: id });
      }
      let info;
      try {
        info = await sourceInfoFor(ffprobe, resolved.asset, resolved.path);
      } catch (err) {
        throw new UserFacingError("archivo-ilegible", `No pude leer el archivo «${resolved.asset.originalName}». Puede estar dañado o en un formato no soportado.`, 422, {
          assetId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      map.set(id, { asset: resolved.asset, path: resolved.path, info });
    }
    return map;
  }

  /** Gráficos listos para superponer: el renderizado guardado o uno nuevo con el motor builtin. */
  async function prepareGraphics(recipe: Recipe, ctx: RenderContext, spec: OutputSpec, sources: SourceMap, signal?: AbortSignal): Promise<GraphicSource[]> {
    const out: GraphicSource[] = [];
    for (const item of recipe.tracks.graphics) {
      if (item.renderedAssetId && sources.has(item.renderedAssetId)) {
        const s = sources.get(item.renderedAssetId)!;
        out.push({ item, path: s.path, vp9Alpha: s.info.vp9Alpha, width: s.info.width, height: s.info.height });
        continue;
      }
      const engine = motionEngine();
      const known = engine.builtinTemplates().find((t) => t.id === item.templateId);
      const text = item.props.text ?? item.props.texto ?? item.props.title ?? item.props.titulo;
      if (!known && text == null) {
        ctx.log.warn({ graphic: item.id, templateId: item.templateId }, "Gráfico sin render previo ni plantilla de fábrica: se omite");
        continue;
      }
      const template: MotionTemplate = known ?? { id: item.templateId, name: String(text), engine: "builtin", source: "", propsSchema: {}, defaultDuration: 3, description: "" };
      const input = { template, props: item.props, duration: item.end - item.start, width: spec.width, height: spec.height, fps: spec.fps };
      const file = path.join(ctx.workDir, "motion-cache", `builtin-${graphicCacheKey("builtin", input)}.mov`);
      if (!existsSync(file)) {
        await mkdir(path.dirname(file), { recursive: true });
        await engine.renderGraphic({ ...input, outPath: file }, { signal });
      }
      const info = await probeSource(ffprobe, file);
      out.push({ item, path: file, vp9Alpha: info.vp9Alpha, width: info.width, height: info.height });
    }
    return out;
  }

  async function prepare(recipeIn: Recipe, ctx: RenderContext, quality: ExportQuality, burnCaptions: boolean, jobDir: string, signal?: AbortSignal): Promise<Prepared> {
    const recipe = normalizeRecipe(recipeIn);
    if (!recipe.tracks.video.length) throw new UserFacingError("receta-vacia", "La edición no tiene clips en la secuencia principal: no hay nada que renderizar.", 422);
    const info = await ffmpegInfo(ffmpeg).catch(() => null);
    if (!info) throw new UserFacingError("ffmpeg-no-disponible", "No encuentro ffmpeg. Instálalo (pnpm diagnostico te dice cómo) y vuelve a intentar.", 503);
    const spec = outputSpec(recipe, quality);
    const plan = planTimeline(recipe);
    const sources = await loadSources(recipe, ctx);
    const graphics = await prepareGraphics(recipe, ctx, spec, sources, signal);
    // Textos y subtítulos.
    const fonts = await prepareFonts(recipe, fontLibraryFor(ctx, ctx.log, fontsCacheDir));
    const ass = buildAss(recipe, spec, fonts, burnCaptions);
    let assRef: Prepared["ass"] = null;
    if (ass.events > 0) {
      await writeFile(path.join(jobDir, "subs.ass"), ass.text, "utf8");
      assRef = { file: "subs.ass", fontsDir: await stageAssFonts(fonts, jobDir) };
    }
    return {
      recipe,
      plan,
      spec,
      sources,
      graphics,
      ass: assRef,
      reservePx: (ass.captionsReserve * spec.height) / spec.playResY,
      canTonemap: info.filters.has("zscale") && info.filters.has("tonemap"),
    };
  }

  /** Grafo de video de una ventana (sin audio). Termina en [vout]. */
  function videoGraph(p: Prepared, win: WindowPlan, extraTail: string[] = []): FilterGraph {
    const g = new FilterGraph();
    const F = p.spec.fps;
    let cur = buildMainSequence({ graph: g, spec: p.spec, sources: p.sources, canTonemap: p.canTonemap }, win);
    if (win.start > 0) cur = g.chain([cur], [`setpts=PTS+${num(win.start / F, 6)}/TB`], g.label("abs"));
    const lctx = { graph: g, spec: p.spec, sources: p.sources, win, captionsReservePx: p.reservePx };
    cur = applyOverlays(lctx, cur, p.recipe.tracks.overlays);
    cur = applyGraphics(lctx, cur, p.graphics);
    const tail: string[] = [];
    if (p.ass) tail.push(`ass=filename=${p.ass.file}:fontsdir=${p.ass.fontsDir}`);
    if (win.reqStart !== win.start || win.reqEnd !== win.end) tail.push(`trim=start=${num((win.reqStart - 0.5) / F, 6)}:end=${num((win.reqEnd - 0.5) / F, 6)}`);
    tail.push("setpts=PTS-STARTPTS", ...extraTail, "setsar=1", "format=yuv420p");
    g.chain([cur], tail, "vout");
    return g;
  }

  async function renderAudio(p: Prepared, jobDir: string, commands: string[], signal?: AbortSignal, onProgress?: (f: number) => void): Promise<string> {
    const { graph, out } = buildAudioGraph(p.recipe, p.plan, p.sources);
    const mixWav = path.join(jobDir, "mezcla.wav");
    const masterWav = path.join(jobDir, "master.wav");
    const total = p.plan.totalFrames / p.spec.fps;
    const args = [...graph.inputArgs(), ...(await graphArgs(graph.toString(), jobDir, "audio.txt")), "-map", `[${out}]`, "-c:a", "pcm_f32le", "-ar", String(SAMPLE_RATE), "-ac", "2", ...CLEAN_ARGS, mixWav];
    commands.push(fmt(args));
    await runFfmpeg(ffmpeg, args, { cwd: jobDir, signal, durationSeconds: total, onProgress, log, what: "mezclar el audio", timeoutMs: 30 * 60 * 1000 });
    const mix = p.recipe.tracks.audio.mix;
    await masterLoudness({ ffmpeg, inWav: mixWav, outWav: masterWav, targetLufs: mix.targetLufs, normalize: mix.normalize, signal, log, commands, fmt });
    return masterWav;
  }

  async function render(recipeIn: Recipe, ctx: RenderContext, opts: RunOptions & { outPath: string; quality: ExportQuality; burnCaptions: boolean }): Promise<RenderOutput> {
    const t0 = Date.now();
    const commands: string[] = [];
    const progress = (f: number, msg: string) => opts.onProgress?.(Math.max(0, Math.min(1, f)), msg);
    await mkdir(ctx.workDir, { recursive: true });
    const jobDir = await mkdtemp(path.join(ctx.workDir, "render-"));
    try {
      progress(0.01, "Preparando el render");
      const p = await prepare(recipeIn, ctx, opts.quality, opts.burnCaptions, jobDir, opts.signal);
      const F = p.spec.fps;
      const total = p.plan.totalFrames / F;
      progress(0.05, "Mezclando el audio");
      const master = await renderAudio(p, jobDir, commands, opts.signal, (f) => progress(0.05 + f * 0.08, "Mezclando el audio"));
      progress(0.14, "Renderizando el video");
      await mkdir(path.dirname(opts.outPath), { recursive: true });
      const partial = `${opts.outPath}.parcial.mp4`;
      const windows = segmentWindows(p.plan, { clipsPerSegment: segmentClips });
      if (windows.length === 1) {
        const g = videoGraph(p, planWindow(p.plan, 0, p.plan.totalFrames));
        const aIdx = g.addInput([], master);
        const args = [...g.inputArgs(), ...(await graphArgs(g.toString(), jobDir, "video.txt")), "-map", "[vout]", "-map", `${aIdx}:a`, ...x264Args(p.spec), ...AAC_ARGS, "-t", num(total, 6), ...CLEAN_ARGS, "-movflags", "+faststart", partial];
        commands.push(fmt(args));
        await runFfmpeg(ffmpeg, args, { cwd: jobDir, signal: opts.signal, durationSeconds: total, onProgress: (f) => progress(0.14 + f * 0.84, "Renderizando el video"), log, what: "renderizar el video", timeoutMs: 6 * 60 * 60 * 1000 });
      } else {
        // Segmentos: el audio ya está masterizado; cada segmento es video puro con los mismos
        // parámetros de x264 y se renderizan hasta `concurrency` a la vez (la segmentación no
        // depende de la máquina, así que el resultado es el mismo con 1 o con 8 núcleos).
        const list = windows.map((_, k) => `file 'segmento-${String(k).padStart(3, "0")}.mp4'`);
        const doneByWindow = windows.map(() => 0);
        const report = (k: number, f: number) => {
          doneByWindow[k] = f * ((windows[k]![1] - windows[k]![0]) / F);
          progress(0.14 + (doneByWindow.reduce((x, y) => x + y, 0) / total) * 0.8, `Renderizando ${windows.length} segmentos`);
        };
        const segArgs: string[][] = [];
        for (const [k, [a, b]] of windows.entries()) {
          const g = videoGraph(p, planWindow(p.plan, a, b));
          const seg = `segmento-${String(k).padStart(3, "0")}.mp4`;
          segArgs.push([...g.inputArgs(), ...(await graphArgs(g.toString(), jobDir, `video-${k}.txt`)), "-map", "[vout]", "-an", ...x264Args(p.spec), "-frames:v", String(b - a), ...CLEAN_ARGS, seg]);
          commands.push(fmt(segArgs[k]!));
        }
        const jobs = windows.map(([a, b], k) => async () => {
          const args = segArgs[k]!;
          await runFfmpeg(ffmpeg, args, { cwd: jobDir, signal: opts.signal, durationSeconds: (b - a) / F, onProgress: (f) => report(k, f), log, what: `renderizar el segmento ${k + 1}`, timeoutMs: 6 * 60 * 60 * 1000 });
          report(k, 1);
        });
        await runPool(jobs, concurrency);
        await writeFile(path.join(jobDir, "segmentos.txt"), list.join("\n") + "\n", "utf8");
        const args = ["-f", "concat", "-safe", "0", "-i", "segmentos.txt", "-i", master, "-map", "0:v", "-map", "1:a", "-c:v", "copy", ...AAC_ARGS, "-t", num(total, 6), ...CLEAN_ARGS, "-movflags", "+faststart", partial];
        commands.push(fmt(args));
        await runFfmpeg(ffmpeg, args, { cwd: jobDir, signal: opts.signal, log, what: "unir los segmentos", timeoutMs: 60 * 60 * 1000 });
      }
      await rename(partial, opts.outPath);
      const renderSeconds = (Date.now() - t0) / 1000;
      progress(1, "Listo");
      log.info({ seconds: renderSeconds, duration: total, perSecond: total > 0 ? renderSeconds / total : 0, quality: opts.quality, segments: windows.length }, "Render terminado");
      return { outPath: opts.outPath, durationSeconds: total, renderSeconds, commands };
    } finally {
      await cleanup(jobDir, log);
      await rm(`${opts.outPath}.parcial.mp4`, { force: true }).catch(() => undefined);
    }
  }

  async function renderFrame(recipeIn: Recipe, ctx: RenderContext, t: number, outPath: string, opts: { width?: number } = {}): Promise<void> {
    await mkdir(ctx.workDir, { recursive: true });
    const jobDir = await mkdtemp(path.join(ctx.workDir, "frame-"));
    try {
      const recipeN = normalizeRecipe(recipeIn);
      const { width, height } = recipeN.format;
      const wantW = opts.width ?? 1080;
      const short = (wantW * Math.min(width, height)) / width;
      const quality: ExportQuality = short <= 720 ? "720" : "1080";
      const p = await prepare(recipeN, ctx, quality, true, jobDir);
      const f = Math.max(0, Math.min(p.plan.totalFrames - 1, toFrame(t, p.spec.fps)));
      const scale = opts.width && opts.width !== p.spec.width ? [`scale=${Math.round(opts.width / 2) * 2}:-2`] : [];
      const g = videoGraph(p, planWindow(p.plan, f, f + 1), scale);
      const gArgs = await graphArgs(g.toString(), jobDir, "frame.txt");
      await mkdir(path.dirname(outPath), { recursive: true });
      const args = [...g.inputArgs(), ...gArgs, "-map", "[vout]", "-frames:v", "1", "-q:v", "3", "-update", "1", outPath];
      await runFfmpeg(ffmpeg, args, { cwd: jobDir, log, what: "sacar un fotograma de la edición", timeoutMs: 10 * 60 * 1000 });
    } finally {
      await cleanup(jobDir, log);
    }
  }

  async function poster(videoPath: string, outPath: string, t?: number): Promise<void> {
    const info = await probeSource(ffprobe, videoPath);
    const dur = info.duration ?? 0;
    const at = Math.max(0, Math.min(t ?? Math.min(1, dur / 3), Math.max(0, dur - 0.05)));
    await mkdir(path.dirname(outPath), { recursive: true });
    await runFfmpeg(ffmpeg, ["-ss", num(at, 3), "-i", videoPath, "-frames:v", "1", "-q:v", "2", "-update", "1", outPath], { log, what: "sacar la portada", timeoutMs: 60_000 });
  }

  function captionFiles(recipe: Recipe): { srt: string; vtt: string; txt: string } {
    const caps = recipe.tracks.captions;
    const words = captionWordsWithOverrides(recipe).filter((w) => w.text.trim());
    const lines = groupCaptionLines(words, caps.style);
    return { srt: toSrt(lines, caps.style.uppercase), vtt: toVtt(lines, caps.style.uppercase), txt: toPlainText(words) };
  }

  async function available(): Promise<{ ready: boolean; detail: string; version: string }> {
    try {
      const info = await ffmpegInfo(ffmpeg);
      const missing = REQUIRED_FILTERS.filter((f) => !info.filters.has(f));
      const enc = ["libx264", "aac", "qtrle"].filter((e) => !info.encoders.has(e));
      if (missing.length || enc.length) {
        return { ready: false, detail: `A tu ffmpeg le faltan: ${[...missing, ...enc].join(", ")}. Instala una versión completa (con libass y libx264).`, version: info.version };
      }
      return { ready: true, detail: `ffmpeg ${info.major}.x listo (libass, xfade, loudnorm, libx264).`, version: info.version };
    } catch (err) {
      return { ready: false, detail: `No encuentro ffmpeg (${err instanceof Error ? err.message : String(err)}).`, version: "" };
    }
  }

  return { available, render, renderFrame, poster, captionFiles };
}
