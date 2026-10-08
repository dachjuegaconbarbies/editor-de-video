/**
 * Render de una receta al almacenamiento: video (mp4), portada y subtítulos sueltos (srt/vtt/txt),
 * más los motion graphics pendientes (HyperFrames con caché) y la colocación de lo generado con IA.
 */
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  groupCaptionLines,
  normalizeRecipe,
  toPlainText,
  toSrt,
  toVtt,
  type AiRequest,
  type Asset,
  type ExportQuality,
  type MotionTemplate,
  type Recipe,
} from "@autoeditor/shared";
import type { AppContext } from "../context.js";
import type { JobContext } from "../jobs/queue.js";
import { graphicCacheKey } from "../motion/builtin.js";
import { findTemplateDef } from "../motion/templates.js";
import { keys } from "../storage/keys.js";
import { createGeneratedAsset, makeRenderContext } from "./toolbox.js";

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const shortError = (ctx: AppContext, err: unknown) => ctx.scrub(err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200);

/** Archivos de subtítulos de una receta (los del render si los da; si no, con @autoeditor/shared). */
export function captionTextsFor(ctx: AppContext, recipe: Recipe): { srt: string; vtt: string; txt: string } {
  let fromRenderer: { srt: string; vtt: string; txt: string } | null = null;
  try {
    fromRenderer = ctx.services.renderer.captionFiles(recipe);
  } catch {
    fromRenderer = null;
  }
  const words = recipe.tracks.captions.words;
  const lines = groupCaptionLines(words, recipe.tracks.captions.style);
  const upper = recipe.tracks.captions.style.uppercase;
  return {
    srt: fromRenderer?.srt?.trim() ? fromRenderer.srt : toSrt(lines, upper),
    vtt: fromRenderer?.vtt?.trim() && fromRenderer.vtt.trim() !== "WEBVTT" ? fromRenderer.vtt : toVtt(lines, upper),
    txt: fromRenderer?.txt?.trim() ? fromRenderer.txt : toPlainText(words),
  };
}

export interface RenderedVersion {
  videoKey: string;
  posterKey: string | null;
  captionsSrtKey: string | null;
  captionsVttKey: string | null;
  renderSeconds: number;
  durationSeconds: number;
  /** Ruta local del video recién renderizado (válida mientras exista `workDir`). */
  localVideo: string;
}

/** Renderiza la receta y guarda video, portada y subtítulos de la versión. */
export async function renderVersionFiles(
  ctx: AppContext,
  job: JobContext,
  input: { ownerId: string; projectId: string; versionId: string; recipe: Recipe; assets: Asset[]; workDir: string },
  opts: { from: number; to: number; quality?: ExportQuality; outKey?: string; extras?: boolean; burnCaptions?: boolean } = { from: 0.6, to: 0.9 },
): Promise<RenderedVersion> {
  const { services } = ctx;
  const { ownerId, projectId, versionId, recipe } = input;
  const dir = path.join(input.workDir, `render-${versionId}-${opts.quality ?? "1080"}`);
  await mkdir(dir, { recursive: true });
  const rctx = await makeRenderContext(ctx, ownerId, path.join(dir, "trabajo"), input.assets);
  const outPath = path.join(dir, "video.mp4");
  const captions = recipe.tracks.captions;
  const out = await services.renderer.render(recipe, rctx, {
    outPath,
    quality: opts.quality ?? "1080",
    burnCaptions: opts.burnCaptions ?? (captions.enabled && captions.burnIn),
    signal: job.signal,
    onProgress: (p, message) => void job.progress(opts.from + clamp01(p) * (opts.to - opts.from), message ?? "Renderizando el video"),
  });
  job.throwIfAborted();
  const videoKey = opts.outKey ?? keys.versionVideo(ownerId, projectId, versionId);
  await services.storage.putFile(videoKey, out.outPath);
  const result: RenderedVersion = {
    videoKey,
    posterKey: null,
    captionsSrtKey: null,
    captionsVttKey: null,
    renderSeconds: Math.round(out.renderSeconds * 100) / 100,
    durationSeconds: out.durationSeconds,
    localVideo: out.outPath,
  };
  if (opts.extras === false) return result;

  // Portada (si falla, la versión sigue siendo válida).
  try {
    const posterPath = path.join(dir, "poster.jpg");
    await services.renderer.poster(out.outPath, posterPath, Math.min(1, Math.max(0, out.durationSeconds / 3)));
    const posterKey = keys.versionPoster(ownerId, projectId, versionId);
    await services.storage.putFile(posterKey, posterPath, { move: true });
    result.posterKey = posterKey;
  } catch (err) {
    ctx.log.warn({ err: shortError(ctx, err), versionId }, "No se pudo generar la portada");
  }

  // Subtítulos sueltos para descargar.
  if (captions.enabled && captions.words.length) {
    const texts = captionTextsFor(ctx, recipe);
    for (const ext of ["srt", "vtt", "txt"] as const) {
      const file = path.join(dir, `captions.${ext}`);
      await writeFile(file, texts[ext], "utf8");
      const key = keys.versionCaptions(ownerId, projectId, versionId, ext);
      await services.storage.putFile(key, file, { move: true });
      if (ext === "srt") result.captionsSrtKey = key;
      if (ext === "vtt") result.captionsVttKey = key;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// IA generativa: ejecutar pedidos pendientes y colocar los resultados
// ---------------------------------------------------------------------------

/** Coloca el resultado de un pedido de IA en la receta (overlay, SFX, voz o música). */
export function placeAiResult(recipe: Recipe, req: AiRequest, assetId: string): Recipe {
  const r = structuredClone(recipe);
  const at = req.placeAt;
  const id = `ia-${req.id}`;
  if ((req.kind === "imagen" || req.kind === "video") && (req.usage === "broll" || req.usage === "fondo") && at && at.end > at.start) {
    if (!r.tracks.overlays.some((o) => o.id === id)) {
      r.tracks.overlays.push({
        id,
        kind: req.kind === "video" ? "ia-video" : "ia-imagen",
        assetId,
        start: at.start,
        end: at.end,
        sourceIn: 0,
        layout: req.usage === "fondo" ? "fondo-con-orador" : "pantalla-completa",
        opacity: 1,
        kenBurns: req.kind === "imagen",
        transition: { type: "fundido", duration: 0.25 },
        reason: `Generado con IA: ${req.prompt.slice(0, 120)}`,
      });
    }
  } else if (req.kind === "sfx") {
    if (!r.tracks.audio.sfx.some((s) => s.id === id)) r.tracks.audio.sfx.push({ id, assetId, at: at?.start ?? 0, gainDb: -6, kind: "otro", origin: "ia" });
  } else if (req.kind === "voz") {
    if (!r.tracks.audio.voiceover.some((v) => v.id === id)) r.tracks.audio.voiceover.push({ id, assetId, start: at?.start ?? 0, gainDb: 0, text: req.prompt });
  } else if (req.kind === "musica") {
    if (!r.tracks.audio.music.length) r.tracks.audio.music.push({ id, assetId, start: 0, end: null, sourceIn: 0, gainDb: -16, fadeIn: 0.5, fadeOut: 1.5, duck: true });
  }
  return normalizeRecipe(r);
}

const kindFromMime = (mime: string): Asset["kind"] => (mime.startsWith("video/") ? "video" : mime.startsWith("image/") ? "imagen" : mime.startsWith("audio/") ? "audio" : "otro");

/** Ejecuta los pedidos de IA pendientes. Los que fallan quedan "fallido" y se avisa (no detienen el video). */
export async function runAiRequests(
  ctx: AppContext,
  job: JobContext,
  input: { ownerId: string; projectId: string; recipe: Recipe; workDir: string },
  progress: { from: number; to: number },
): Promise<{ recipe: Recipe; warnings: string[]; costUsd: number }> {
  const { services } = ctx;
  let recipe = input.recipe;
  const warnings: string[] = [];
  let costUsd = 0;
  const pending = recipe.ai.filter((a) => a.status === "pendiente" && !a.resultAssetId);
  const outDir = path.join(input.workDir, "ia");
  await mkdir(outDir, { recursive: true });
  let done = 0;
  for (const req of pending) {
    job.throwIfAborted();
    const update = (patch: Partial<AiRequest>) => {
      recipe = { ...recipe, ai: recipe.ai.map((a) => (a.id === req.id ? { ...a, ...patch } : a)) };
    };
    try {
      await job.progress(progress.from + (done / pending.length) * (progress.to - progress.from), `Generando con IA (${done + 1} de ${pending.length})`);
      const res = await services.generative.generate(req, {
        outDir,
        aspect: recipe.format.aspect,
        signal: job.signal,
        onProgress: (p) => void job.progress(progress.from + ((done + clamp01(p)) / pending.length) * (progress.to - progress.from)),
      });
      const asset = await createGeneratedAsset(ctx, {
        ownerId: input.ownerId,
        projectId: input.projectId,
        category: "ia-generado",
        kind: kindFromMime(res.mimeType),
        name: `ia-${req.kind}-${req.id}${path.extname(res.filePath) || ""}`,
        mimeType: res.mimeType,
        filePath: res.filePath,
        note: req.prompt.slice(0, 500),
      });
      update({ status: "listo", resultAssetId: asset.id, costUsd: res.costUsd, model: res.model, seed: res.seed, error: null });
      recipe = placeAiResult(recipe, { ...req, status: "listo" }, asset.id);
      costUsd += res.costUsd;
      await job.addCost(res.costUsd);
    } catch (err) {
      job.throwIfAborted();
      const msg = shortError(ctx, err);
      update({ status: "fallido", error: msg });
      warnings.push(`No se pudo generar «${req.prompt.slice(0, 60)}» con IA (${msg}); seguí sin ese elemento.`);
    }
    done++;
  }
  return { recipe, warnings, costUsd };
}

// ---------------------------------------------------------------------------
// Motion graphics: render previo con HyperFrames (con caché); builtin como respaldo
// ---------------------------------------------------------------------------

export async function renderPendingGraphics(
  ctx: AppContext,
  job: JobContext,
  input: { ownerId: string; projectId: string; recipe: Recipe; templates: MotionTemplate[]; workDir: string },
  progress: { from: number; to: number },
): Promise<{ recipe: Recipe; warnings: string[] }> {
  const { services, db } = ctx;
  const warnings: string[] = [];
  const recipe = structuredClone(input.recipe);
  const pending = recipe.tracks.graphics.filter((g) => !g.renderedAssetId && g.engine === "hyperframes");
  if (!pending.length) return { recipe: input.recipe, warnings };
  const hf = services.motion.hyperframes;
  const ready = hf ? (await hf.available().catch(() => ({ ready: false, detail: "" }))).ready : false;
  const outDir = path.join(input.workDir, "motion");
  await mkdir(outDir, { recursive: true });
  let done = 0;
  for (const g of pending) {
    job.throwIfAborted();
    await job.progress(progress.from + (done / pending.length) * (progress.to - progress.from), `Motion graphics (${done + 1} de ${pending.length})`);
    const template = input.templates.find((t) => t.id === g.templateId) ?? null;
    const builtinFallback = () => {
      if (findTemplateDef(g.templateId)) {
        g.engine = "builtin";
        return true;
      }
      return false;
    };
    if (!hf || !ready || !template) {
      if (!builtinFallback()) warnings.push(`No encontré cómo dibujar el gráfico «${g.templateId}»; se omitió.`);
      done++;
      continue;
    }
    const renderInput = {
      template,
      props: g.props,
      duration: Math.max(0.5, g.end - g.start),
      width: recipe.format.width,
      height: recipe.format.height,
      fps: recipe.format.fps,
    };
    const cacheKey = `motion-render:${graphicCacheKey("hyperframes", renderInput)}`;
    try {
      const cachedId = await db.kv.get<string>(input.ownerId, cacheKey);
      const cached = cachedId ? await db.assets.get(input.ownerId, cachedId) : null;
      if (cached && (await services.storage.exists(cached.storageKey))) {
        g.renderedAssetId = cached.id;
      } else {
        const outPath = path.join(outDir, `${g.id}.mov`);
        const res = await hf.renderGraphic({ ...renderInput, outPath }, { signal: job.signal });
        const asset = await createGeneratedAsset(ctx, {
          ownerId: input.ownerId,
          projectId: input.projectId,
          category: "motion-render",
          kind: "video",
          name: `motion-${g.templateId}${path.extname(res.path) || ".mov"}`,
          mimeType: res.path.endsWith(".webm") ? "video/webm" : res.path.endsWith(".mp4") ? "video/mp4" : "video/quicktime",
          filePath: res.path,
        });
        await db.kv.set(input.ownerId, cacheKey, asset.id);
        g.renderedAssetId = asset.id;
      }
    } catch (err) {
      job.throwIfAborted();
      const msg = shortError(ctx, err);
      if (builtinFallback()) warnings.push(`HyperFrames no pudo dibujar «${g.templateId}» (${msg}); usé el motor integrado.`);
      else warnings.push(`No se pudo dibujar el gráfico «${g.templateId}» (${msg}); se omitió.`);
    }
    done++;
  }
  // Los gráficos que no se pudieron dibujar con ningún motor se quitan para que el render no falle.
  recipe.tracks.graphics = recipe.tracks.graphics.filter((g) => g.renderedAssetId || g.engine !== "hyperframes");
  return { recipe: normalizeRecipe(recipe), warnings };
}
