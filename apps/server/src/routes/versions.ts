/** Versiones (V1, V2…): ver, reproducir, corregir, calificar, comparar, exportar, descargar y restaurar. */
import {
  CorrectionBody,
  ExportBody,
  ExportQuality,
  RatingBody,
  diffRecipes,
  groupCaptionLines,
  summarizeChanges,
  toPlainText,
  toSrt,
  toVtt,
  type CompareResponse,
  type PublishCopy,
  type Recipe,
  type Version,
  type VersionsResponse,
} from "@autoeditor/shared";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { newId, nowIso } from "../db/util.js";
import { UserFacingError } from "../services/types.js";
import { keys } from "../storage/keys.js";
import { contentDisposition, notFound, readableName, sendStorageFile, type RouteModule } from "./http.js";

const ProjectParams = z.object({ projectId: z.string().min(1) });
const VersionParams = z.object({ versionId: z.string().min(1) });
const CompareQuery = z.object({ a: z.string().min(1), b: z.string().min(1) });
const DownloadQuery = z.object({
  type: z.enum(["mp4", "srt", "vtt", "txt", "copy"]).default("mp4"),
  quality: ExportQuality.optional(),
});

/** Archivos de subtítulos de una receta (usa el render si los da; si no, los arma aquí). */
export function captionTexts(ctx: AppContext, recipe: Recipe): { srt: string; vtt: string; txt: string } {
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

/** Texto listo para pegar al publicar (título, descripción, hashtags y texto de portada). */
export function publishCopyText(copy: PublishCopy): string {
  const parts = [
    copy.title ? `TÍTULO\n${copy.title}` : "",
    copy.description ? `DESCRIPCIÓN\n${copy.description}` : "",
    copy.hashtags.length ? `HASHTAGS\n${copy.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}` : "",
    copy.coverText ? `TEXTO DE PORTADA\n${copy.coverText}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("\n\n") + "\n" : "Aún no hay texto sugerido para publicar.\n";
}

export const versionRoutes: RouteModule = (app, ctx) => {
  const { db, services } = ctx;
  const tags = ["Versiones"];

  async function mustVersion(ownerId: string, versionId: string): Promise<Version> {
    const version = await db.versions.get(ownerId, versionId);
    if (!version) throw notFound("esa versión");
    return version;
  }

  async function baseName(ownerId: string, version: Version): Promise<string> {
    const project = await db.projects.get(ownerId, version.projectId);
    return `${readableName(project?.name ?? "video")}-v${version.number}`;
  }

  app.get("/projects/:projectId/versions", { schema: { tags, summary: "Versiones del proyecto", params: ProjectParams } }, async (request): Promise<VersionsResponse> => {
    const owner = request.ownerId;
    const project = await db.projects.get(owner, request.params.projectId);
    if (!project) throw notFound("ese proyecto");
    return { versions: await db.versions.list(owner, { projectId: project.id }, { orderBy: "number" }) };
  });

  // Ruta estática antes que /versions/:versionId (Fastify prioriza las estáticas de todos modos).
  app.get("/versions/compare", { schema: { tags, summary: "Comparar dos versiones (qué cambió)", querystring: CompareQuery } }, async (request): Promise<CompareResponse> => {
    const owner = request.ownerId;
    const [a, b] = await Promise.all([mustVersion(owner, request.query.a), mustVersion(owner, request.query.b)]);
    if (a.projectId !== b.projectId) throw new UserFacingError("proyectos-distintos", "Solo se pueden comparar versiones del mismo proyecto", 400);
    const changes = diffRecipes(a.recipe, b.recipe);
    return { a, b, changes, summary: summarizeChanges(changes) };
  });

  app.get("/versions/:versionId", { schema: { tags, summary: "Detalle de una versión (con su receta)", params: VersionParams } }, async (request) => {
    return mustVersion(request.ownerId, request.params.versionId);
  });

  app.get("/versions/:versionId/video", { schema: { tags, summary: "Video de la versión (soporta Range)", params: VersionParams } }, async (request, reply) => {
    const version = await mustVersion(request.ownerId, request.params.versionId);
    if (!version.videoKey) throw new UserFacingError("sin-video", version.status === "renderizando" ? "La versión todavía se está renderizando" : "Esta versión no tiene video", 404);
    return sendStorageFile(ctx, request, reply, version.videoKey, { contentType: "video/mp4", cacheSeconds: 3600 });
  });

  app.get("/versions/:versionId/poster", { schema: { tags, summary: "Portada de la versión (JPG)", params: VersionParams } }, async (request, reply) => {
    const version = await mustVersion(request.ownerId, request.params.versionId);
    if (!version.posterKey) throw new UserFacingError("sin-portada", "Esta versión aún no tiene portada", 404);
    return sendStorageFile(ctx, request, reply, version.posterKey, { contentType: "image/jpeg", cacheSeconds: 3600 });
  });

  app.post(
    "/versions/:versionId/corrections",
    { schema: { tags, summary: "CORRECCIÓN con texto (general o anclada a un momento) → nueva versión", params: VersionParams, body: CorrectionBody } },
    async (request, reply) => {
      await mustVersion(request.ownerId, request.params.versionId);
      const job = await ctx.pipeline.correct(request.ownerId, request.params.versionId, request.body);
      return reply.code(202).send(job);
    },
  );

  app.post("/versions/:versionId/rating", { schema: { tags, summary: "Calificar una versión (arriba / abajo)", params: VersionParams, body: RatingBody } }, async (request) => {
    const owner = request.ownerId;
    const version = await mustVersion(owner, request.params.versionId);
    const { rating, comment } = request.body;
    const updated = await db.versions.update(owner, version.id, { rating });
    await db.feedback.create(owner, {
      id: newId("fbk"),
      ownerId: owner,
      projectId: version.projectId,
      versionId: version.id,
      kind: "calificacion",
      rating,
      text: comment ?? "",
      data: {},
      createdAt: nowIso(),
    });
    await ctx.memory.onRating(owner, { projectId: version.projectId, versionId: version.id, rating, ...(comment !== undefined ? { comment } : {}) });
    if (updated) ctx.events.emit(updated.projectId, { type: "version.updated", version: updated });
    return updated ?? version;
  });

  app.post("/versions/:versionId/export", { schema: { tags, summary: "EXPORTAR (calidad, subtítulos aparte)", params: VersionParams, body: ExportBody } }, async (request, reply) => {
    await mustVersion(request.ownerId, request.params.versionId);
    const job = await ctx.pipeline.exportVersion(request.ownerId, request.params.versionId, request.body);
    return reply.code(202).send(job);
  });

  app.get(
    "/versions/:versionId/download",
    { schema: { tags, summary: "Descargar mp4, subtítulos (.srt/.vtt), transcripción (.txt) o texto para publicar", params: VersionParams, querystring: DownloadQuery } },
    async (request, reply) => {
      const owner = request.ownerId;
      const version = await mustVersion(owner, request.params.versionId);
      const name = await baseName(owner, version);
      const { type, quality } = request.query;
      if (type === "mp4") {
        let key = version.videoKey;
        if (quality) {
          const exportKey = keys.versionExport(owner, version.projectId, version.id, quality);
          if (await services.storage.exists(exportKey)) key = exportKey;
        }
        if (!key) throw new UserFacingError("sin-video", "Esta versión todavía no tiene video para descargar", 404);
        return sendStorageFile(ctx, request, reply, key, { contentType: "video/mp4", downloadName: `${name}${quality ? `-${quality}p` : ""}.mp4` });
      }
      if (type === "srt" && version.captionsSrtKey && (await services.storage.exists(version.captionsSrtKey))) {
        return sendStorageFile(ctx, request, reply, version.captionsSrtKey, { contentType: "application/x-subrip; charset=utf-8", downloadName: `${name}.srt` });
      }
      if (type === "vtt" && version.captionsVttKey && (await services.storage.exists(version.captionsVttKey))) {
        return sendStorageFile(ctx, request, reply, version.captionsVttKey, { contentType: "text/vtt; charset=utf-8", downloadName: `${name}.vtt` });
      }
      let body: string;
      let contentType: string;
      let ext: string;
      if (type === "copy") {
        const rec = await db.keywords.get(owner, version.projectId);
        const copy = version.publishCopy.title || version.publishCopy.description ? version.publishCopy : (rec?.publishCopy ?? version.publishCopy);
        body = publishCopyText(copy);
        contentType = "text/plain; charset=utf-8";
        ext = "publicacion.txt";
      } else {
        const texts = captionTexts(ctx, version.recipe);
        body = type === "srt" ? texts.srt : type === "vtt" ? texts.vtt : texts.txt;
        contentType = type === "srt" ? "application/x-subrip; charset=utf-8" : type === "vtt" ? "text/vtt; charset=utf-8" : "text/plain; charset=utf-8";
        ext = type === "txt" ? "transcripcion.txt" : type;
      }
      reply.header("Content-Type", contentType);
      reply.header("Content-Disposition", contentDisposition(`${name}.${ext}`));
      return reply.send(body);
    },
  );

  app.post("/versions/:versionId/restore", { schema: { tags, summary: "Volver a esta versión", params: VersionParams } }, async (request) => {
    return ctx.pipeline.restoreVersion(request.ownerId, request.params.versionId);
  });
};
