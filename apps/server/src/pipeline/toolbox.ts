/**
 * Caja de herramientas que el servidor le presta al editor (Claude o demo) y contexto de render.
 *
 *  - sourceFrame: fotograma de un archivo fuente (en caché en el almacenamiento).
 *  - previewFrame: cómo se ve la receta en un segundo (render de un solo fotograma).
 *  - validateRecipe: esquema + normalización + que todos los assetId existan en el proyecto.
 *  - materializeCaptions: subtítulos desde la transcripción y las palabras clave.
 *  - motionTemplates / hyperframesGuide: plantillas disponibles y guía de autoría.
 */
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  Asset as AssetSchema,
  materializeCaptionWords,
  parseRecipe,
  referencedAssetIds,
  type Asset,
  type Keyword,
  type MotionTemplate,
  type Recipe,
  type Transcript,
} from "@autoeditor/shared";
import type { AppContext } from "../context.js";
import { newId, nowIso } from "../db/util.js";
import { REPO_ROOT } from "../env.js";
import { highlightTerms, sourceWords } from "../ai/shared/transcript.js";
import { UserFacingError, type EditorToolbox, type RenderContext } from "../services/types.js";
import { keys, safeFileName } from "../storage/keys.js";

export interface ToolboxData {
  ownerId: string;
  projectId: string;
  assets: Asset[];
  transcripts: Transcript[];
  keywords: Keyword[];
  templates: MotionTemplate[];
}

const DEFAULT_FRAME_WIDTH = 512;

/** Contexto de render: resuelve assets del dueño (y del proyecto o biblioteca) a rutas locales. */
export async function makeRenderContext(ctx: AppContext, ownerId: string, workDir: string, assets: Asset[]): Promise<RenderContext> {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const fontsDir = path.join(workDir, "fuentes-proyecto");
  await mkdir(fontsDir, { recursive: true });
  // Fuentes subidas al proyecto (o de la marca) disponibles para textos y subtítulos.
  for (const a of assets.filter((x) => x.kind === "fuente")) {
    try {
      await copyFile(await ctx.services.storage.localPath(a.storageKey), path.join(fontsDir, `${a.id}-${safeFileName(a.originalName)}`));
    } catch {
      // Una fuente ilegible no detiene el render: se usa la de respaldo.
    }
  }
  return {
    async resolveAsset(assetId) {
      let asset = byId.get(assetId) ?? null;
      if (!asset) {
        asset = await ctx.db.assets.get(ownerId, assetId);
        if (asset) byId.set(asset.id, asset);
      }
      if (!asset) throw new UserFacingError("asset-no-encontrado", `La edición usa un archivo que ya no existe (${assetId}).`, 409);
      return { asset, path: await ctx.services.storage.localPath(asset.storageKey) };
    },
    fontsDir,
    workDir,
    log: ctx.log,
  };
}

let guideCache: string | null = null;

/** Guía de HyperFrames: la skill instalada (si existe) o un resumen de respaldo. */
export async function loadHyperframesGuide(): Promise<string> {
  if (guideCache) return guideCache;
  const candidates = [".agents/skills/hyperframes-core/SKILL.md", ".claude/skills/hyperframes-core/SKILL.md"].map((p) => path.join(REPO_ROOT, p));
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const text = await readFile(file, "utf8");
      guideCache = text.length > 16_000 ? `${text.slice(0, 16_000)}\n\n…(guía recortada)` : text;
      return guideCache;
    } catch {
      // Se intenta el siguiente.
    }
  }
  guideCache =
    "Guía breve de HyperFrames: cada plantilla es un HTML autocontenido con un elemento raíz que lleva data-composition-id, " +
    "data-width, data-height y data-duration; las animaciones van en UNA línea de tiempo GSAP pausada registrada en " +
    "window.__timelines[<id>] (sin requestAnimationFrame ni Date.now: el render la recorre fotograma a fotograma). " +
    "Usa marcadores {{prop}} para los textos y colores, fondo transparente para superponer y fuentes ya cargadas.";
  return guideCache;
}

/** Arma la caja de herramientas del editor para un proyecto. */
export function createToolbox(ctx: AppContext, data: ToolboxData, opts: { workDir: string }): EditorToolbox {
  const { services } = ctx;
  const assetIds = new Set(data.assets.map((a) => a.id));
  const words = sourceWords(data.transcripts);
  const terms = highlightTerms(data.keywords);
  let renderCtx: Promise<RenderContext> | null = null;
  const getRenderCtx = () => (renderCtx ??= makeRenderContext(ctx, data.ownerId, path.join(opts.workDir, "vista-previa"), data.assets));

  const readBase64 = async (file: string) => (await readFile(file)).toString("base64");

  return {
    async sourceFrame(assetId, t, width = DEFAULT_FRAME_WIDTH) {
      const asset = data.assets.find((a) => a.id === assetId);
      if (!asset) throw new UserFacingError("asset-no-encontrado", `No existe el archivo ${assetId} en este proyecto.`, 404);
      const w = Math.max(64, Math.min(1920, Math.round(width)));
      const time = asset.kind === "imagen" ? 0 : Math.max(0, Math.min(t, Math.max(0, (asset.probe.duration ?? t) - 0.05)));
      const key = keys.assetFrame(data.ownerId, asset.projectId, asset.id, time, w);
      if (!(await services.storage.exists(key))) {
        const tmp = await services.storage.tempDir("fotograma");
        try {
          const out = path.join(tmp.path, "frame.jpg");
          await services.media.frameAt(await services.storage.localPath(asset.storageKey), time, out, { width: w });
          await services.storage.putFile(key, out, { move: true });
        } finally {
          await tmp.cleanup();
        }
      }
      return { base64: await readBase64(await services.storage.localPath(key)), mediaType: "image/jpeg" };
    },

    async previewFrame(recipe, t, width = DEFAULT_FRAME_WIDTH) {
      const rctx = await getRenderCtx();
      const tmp = await services.storage.tempDir("vista-previa");
      try {
        const out = path.join(tmp.path, "preview.jpg");
        await services.renderer.renderFrame(recipe, rctx, Math.max(0, t), out, { width: Math.max(64, Math.min(1920, Math.round(width))) });
        return { base64: await readBase64(out), mediaType: "image/jpeg" };
      } finally {
        await tmp.cleanup();
      }
    },

    validateRecipe(input) {
      let recipe: Recipe;
      try {
        recipe = parseRecipe(input);
      } catch (err) {
        const issues = (err as { issues?: { path: (string | number)[]; message: string }[] }).issues;
        return { ok: false, errors: issues ? issues.slice(0, 10).map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`) : [err instanceof Error ? err.message : String(err)] };
      }
      const missing = referencedAssetIds(recipe).filter((id) => !assetIds.has(id));
      if (missing.length) return { ok: false, errors: missing.slice(0, 10).map((id) => `assetId «${id}» no existe en el material del proyecto`) };
      if (!recipe.tracks.video.length) return { ok: false, errors: ["tracks.video está vacío: la edición necesita al menos un clip principal"] };
      return { ok: true, recipe };
    },

    materializeCaptions(recipe) {
      return {
        ...recipe,
        tracks: {
          ...recipe.tracks,
          captions: { ...recipe.tracks.captions, words: materializeCaptionWords(recipe, words, terms, recipe.tracks.captions.overrides) },
        },
      };
    },

    motionTemplates: () => data.templates,
    hyperframesGuide: () => loadHyperframesGuide(),
  };
}

/** Agrega un archivo generado por el servidor (IA, motion graphics) como asset del proyecto. */
export async function createGeneratedAsset(
  ctx: AppContext,
  input: { ownerId: string; projectId: string; category: Asset["category"]; kind: Asset["kind"]; name: string; mimeType: string; filePath: string; note?: string },
): Promise<Asset> {
  const { services, db } = ctx;
  const id = newId("ast");
  const stored = await services.storage.putFile(keys.assetFile(input.ownerId, input.projectId, id, input.name), input.filePath);
  let probe: Asset["probe"] | undefined;
  try {
    probe = await services.media.probe(await services.storage.localPath(stored.key));
  } catch {
    probe = undefined;
  }
  const order = await db.assets.count(input.ownerId, { projectId: input.projectId, category: input.category });
  const asset = await db.assets.create(
    input.ownerId,
    AssetSchema.parse({
      id,
      ownerId: input.ownerId,
      projectId: input.projectId,
      category: input.category,
      kind: input.kind,
      originalName: input.name,
      mimeType: input.mimeType,
      sizeBytes: stored.sizeBytes,
      storageKey: stored.key,
      sha256: stored.sha256,
      ...(probe ? { probe } : {}),
      analysis: { status: "listo" },
      note: input.note ?? "",
      order,
      createdAt: nowIso(),
    }),
  );
  ctx.events.emit(input.projectId, { type: "asset.updated", asset });
  return asset;
}
