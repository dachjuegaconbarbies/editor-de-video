/**
 * Material (assets): subida multipart en streaming, listado, edición, borrado y entrega de archivos
 * (original con Range para reproducir en el navegador, miniatura y fotogramas en caché).
 */
import path from "node:path";
import { Asset, AssetCategory, UpdateAssetBody, type AssetsResponse } from "@autoeditor/shared";
import { z } from "zod";
import { newId, nowIso } from "../db/util.js";
import { UserFacingError, type StoredFile } from "../services/types.js";
import { keys } from "../storage/keys.js";
import { defaultCategory, detectMedia } from "./media-types.js";
import { notFound, readableName, sendStorageFile, type RouteModule } from "./http.js";

const ProjectParams = z.object({ projectId: z.string().min(1) });
const AssetParams = z.object({ assetId: z.string().min(1) });
const FrameQuery = z.object({
  t: z.coerce.number().min(0).max(24 * 3600),
  w: z.coerce.number().int().min(64).max(1920).optional(),
});

const CATEGORY_ORDER = AssetCategory.options;

export const assetRoutes: RouteModule = (app, ctx) => {
  const { db, services } = ctx;
  const tags = ["Material"];
  const maxMb = Math.round(ctx.env.maxUploadBytes / (1024 * 1024));

  async function mustAsset(ownerId: string, assetId: string) {
    const asset = await db.assets.get(ownerId, assetId);
    if (!asset) throw notFound("ese archivo");
    return asset;
  }

  app.post(
    "/projects/:projectId/assets",
    {
      schema: {
        tags,
        summary: "Subir un archivo (multipart: file, category, note?, priority?)",
        description: `Se guarda en streaming (sin cargarlo en memoria), límite ${maxMb} MB. Responde de inmediato; el análisis (miniatura, A-roll/B-roll, transcripción) sigue en segundo plano y se avisa por SSE (asset.updated).`,
        params: ProjectParams,
        consumes: ["multipart/form-data"],
      },
    },
    async (request, reply) => {
      const owner = request.ownerId;
      const project = await db.projects.get(owner, request.params.projectId);
      if (!project) throw notFound("ese proyecto");
      if (!request.isMultipart()) throw new UserFacingError("multipart-requerido", "Envía el archivo como multipart/form-data (campo «file»)", 415);

      const assetId = newId("ast");
      const assetDir = keys.assetDir(owner, project.id, assetId);
      const fields: Record<string, string> = {};
      let stored: StoredFile | null = null;
      let originalName = "";
      let browserMime: string | undefined;
      let truncated = false;
      try {
        for await (const part of request.parts()) {
          if (part.type === "file") {
            if (stored) {
              // Solo un archivo por petición: el resto se descarta.
              part.file.resume();
              continue;
            }
            originalName = (part.filename || "archivo").slice(0, 255);
            browserMime = part.mimetype;
            stored = await services.storage.put(keys.assetFile(owner, project.id, assetId, originalName), part.file);
            if (part.file.truncated) truncated = true;
          } else if (typeof part.value === "string" || typeof part.value === "number" || typeof part.value === "boolean") {
            fields[part.fieldname] = String(part.value).slice(0, 4000);
          }
        }
      } catch (err) {
        await services.storage.deletePrefix(assetDir).catch(() => undefined);
        throw err;
      }
      if (truncated) {
        await services.storage.deletePrefix(assetDir).catch(() => undefined);
        throw new UserFacingError("demasiado-grande", `El archivo supera el límite de ${maxMb} MB`, 413);
      }
      if (!stored) throw new UserFacingError("falta-archivo", "Falta el archivo (campo «file»)", 400);
      if (stored.sizeBytes === 0) {
        await services.storage.deletePrefix(assetDir).catch(() => undefined);
        throw new UserFacingError("archivo-vacio", "El archivo está vacío", 400);
      }

      const { kind, mimeType } = detectMedia(originalName, browserMime);
      const category = AssetCategory.safeParse(fields.category || defaultCategory(kind));
      if (!category.success) {
        await services.storage.deletePrefix(assetDir).catch(() => undefined);
        throw new UserFacingError("categoria-invalida", "La categoría del archivo no es válida", 400, { allowed: CATEGORY_ORDER });
      }
      const priority = fields.priority === "debe-aparecer" ? "debe-aparecer" : "opcional";
      const order = await db.assets.count(owner, { projectId: project.id, category: category.data });
      const asset = await db.assets.create(
        owner,
        Asset.parse({
          id: assetId,
          ownerId: owner,
          projectId: project.id,
          category: category.data,
          kind,
          originalName,
          mimeType,
          sizeBytes: stored.sizeBytes,
          storageKey: stored.key,
          sha256: stored.sha256,
          priority,
          note: fields.note ?? "",
          order,
          createdAt: nowIso(),
        }),
      );
      ctx.events.emit(project.id, { type: "asset.updated", asset });
      // El análisis sigue en segundo plano; la subida ya terminó.
      setImmediate(() => {
        void ctx.pipeline.onAssetUploaded(owner, asset).catch((err) => ctx.log.error({ err }, "Falló el análisis en segundo plano"));
      });
      return reply.code(201).send(asset);
    },
  );

  app.get("/projects/:projectId/assets", { schema: { tags, summary: "Material del proyecto", params: ProjectParams } }, async (request): Promise<AssetsResponse> => {
    const owner = request.ownerId;
    const project = await db.projects.get(owner, request.params.projectId);
    if (!project) throw notFound("ese proyecto");
    const assets = await db.assets.list(owner, { projectId: project.id }, { orderBy: "order" });
    assets.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.order - b.order || a.createdAt.localeCompare(b.createdAt));
    return { assets };
  });

  app.patch("/assets/:assetId", { schema: { tags, summary: "Editar nota, prioridad, orden, categoría o rol (A-roll / B-roll)", params: AssetParams, body: UpdateAssetBody } }, async (request) => {
    const owner = request.ownerId;
    const body = request.body;
    const updated = await db.assets.update(owner, request.params.assetId, (a) => ({
      ...a,
      ...(body.note !== undefined ? { note: body.note } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.order !== undefined ? { order: body.order } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
      // Corrección manual de A-roll/B-roll: manda sobre lo que detectó el análisis.
      ...(body.role !== undefined ? { analysis: { ...a.analysis, role: body.role } } : {}),
    }));
    if (!updated) throw notFound("ese archivo");
    ctx.events.emit(updated.projectId, { type: "asset.updated", asset: updated });
    return updated;
  });

  app.delete("/assets/:assetId", { schema: { tags, summary: "Borrar un archivo", params: AssetParams } }, async (request) => {
    const owner = request.ownerId;
    const asset = await mustAsset(owner, request.params.assetId);
    await db.assets.delete(owner, asset.id);
    await services.storage.deletePrefix(keys.assetDir(owner, asset.projectId, asset.id)).catch(() => undefined);
    // Por si guardó el archivo con otra convención de claves.
    await services.storage.delete(asset.storageKey).catch(() => undefined);
    if (asset.projectId) {
      const project = await db.projects.update(owner, asset.projectId, (p) => (p.thumbnailAssetId === asset.id ? { ...p, thumbnailAssetId: null } : p));
      if (project && project.thumbnailAssetId === null) ctx.events.emit(project.id, { type: "project.updated", project });
    }
    return { ok: true };
  });

  app.get(
    "/assets/:assetId/file",
    { schema: { tags, summary: "Archivo original (soporta Range para reproducir/adelantar)", params: AssetParams, querystring: z.object({ download: z.enum(["0", "1", "true", "false"]).optional() }) } },
    async (request, reply) => {
      const asset = await mustAsset(request.ownerId, request.params.assetId);
      return sendStorageFile(ctx, request, reply, asset.storageKey, {
        contentType: asset.mimeType || "application/octet-stream",
        cacheSeconds: 86400,
        ...(request.query.download === "1" || request.query.download === "true" ? { downloadName: asset.originalName || readableName(asset.id, "archivo") } : {}),
      });
    },
  );

  app.get("/assets/:assetId/thumbnail", { schema: { tags, summary: "Miniatura JPG", params: AssetParams } }, async (request, reply) => {
    const asset = await mustAsset(request.ownerId, request.params.assetId);
    if (asset.thumbnailKey && (await services.storage.exists(asset.thumbnailKey))) {
      return sendStorageFile(ctx, request, reply, asset.thumbnailKey, { contentType: "image/jpeg", cacheSeconds: 3600 });
    }
    // Una imagen sin miniatura todavía: se sirve la original (si el navegador la sabe mostrar).
    if (asset.kind === "imagen" && /^image\/(jpeg|png|webp|gif|avif|svg\+xml)$/.test(asset.mimeType)) {
      return sendStorageFile(ctx, request, reply, asset.storageKey, { contentType: asset.mimeType, cacheSeconds: 600 });
    }
    throw new UserFacingError("sin-miniatura", "Aún no hay miniatura para este archivo", 404);
  });

  app.get("/assets/:assetId/frame", { schema: { tags, summary: "Fotograma JPG en el segundo t (en caché)", params: AssetParams, querystring: FrameQuery } }, async (request, reply) => {
    const owner = request.ownerId;
    const asset = await mustAsset(owner, request.params.assetId);
    if (asset.kind !== "video" && asset.kind !== "imagen") throw new UserFacingError("sin-imagen", "Este archivo no tiene imagen", 409);
    const width = request.query.w ?? 720;
    const duration = asset.probe.duration;
    const t = duration && duration > 0 ? Math.min(request.query.t, Math.max(0, duration - 0.05)) : request.query.t;
    const key = keys.assetFrame(owner, asset.projectId, asset.id, t, width);
    if (!(await services.storage.exists(key))) {
      const tmp = await services.storage.tempDir("fotograma");
      try {
        const out = path.join(tmp.path, "frame.jpg");
        await services.media.frameAt(await services.storage.localPath(asset.storageKey), t, out, { width });
        await services.storage.putFile(key, out, { move: true });
      } catch (err) {
        ctx.log.warn({ err: ctx.scrub(err instanceof Error ? err.message : String(err)) }, "No se pudo extraer el fotograma");
        throw new UserFacingError("fotograma-no-disponible", "No se pudo extraer ese fotograma", 503);
      } finally {
        await tmp.cleanup();
      }
    }
    return sendStorageFile(ctx, request, reply, key, { contentType: "image/jpeg", cacheSeconds: 86400 });
  });

  app.post("/assets/:assetId/transcribe", { schema: { tags: ["Transcripción"], summary: "Volver a transcribir un archivo", params: AssetParams } }, async (request, reply) => {
    const job = await ctx.pipeline.retranscribe(request.ownerId, request.params.assetId);
    return reply.code(202).send(job);
  });
};
