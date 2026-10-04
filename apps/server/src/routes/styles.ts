/** Estilos guardados: listar, guardar, nuevas versiones, exportar/importar (zip con SKILL.md) y borrar. */
import { CreateStyleBody, UpdateStyleBody, type StyleDetail, type StylesResponse } from "@autoeditor/shared";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { UserFacingError } from "../services/types.js";
import { keys } from "../storage/keys.js";
import { contentDisposition, notFound, type RouteModule } from "./http.js";

const StyleParams = z.object({ styleId: z.string().min(1) });

export const styleRoutes: RouteModule = (app, ctx) => {
  const { db } = ctx;
  const tags = ["Estilos"];

  app.get("/styles", { schema: { tags, summary: "Estilos guardados" } }, async (request): Promise<StylesResponse> => {
    return { styles: await db.styles.list(request.ownerId, {}, { orderBy: "updatedAt", desc: true }) };
  });

  app.post("/styles", { schema: { tags, summary: "GUARDAR ESTILO desde una versión", body: CreateStyleBody } }, async (request, reply) => {
    const detail = await ctx.styles.create(request.ownerId, request.body);
    return reply.code(201).send(detail);
  });

  app.post(
    "/styles/import",
    { schema: { tags, summary: "Importar un estilo (zip con SKILL.md + preset.json)", consumes: ["multipart/form-data"] } },
    async (request, reply) => {
      if (!request.isMultipart()) throw new UserFacingError("multipart-requerido", "Envía el zip como multipart/form-data (campo «file»)", 415);
      const tmp = await ctx.services.storage.tempDir("importar-estilo");
      try {
        let filePath: string | null = null;
        for await (const part of request.parts()) {
          if (part.type !== "file") continue;
          if (filePath) {
            part.file.resume();
            continue;
          }
          filePath = path.join(tmp.path, "estilo.zip");
          await pipeline(part.file, createWriteStream(filePath));
          if (part.file.truncated) throw new UserFacingError("demasiado-grande", "El zip es demasiado grande", 413);
        }
        if (!filePath) throw new UserFacingError("falta-archivo", "Falta el archivo zip (campo «file»)", 400);
        const detail = await ctx.styles.importZip(request.ownerId, filePath);
        return reply.code(201).send(detail);
      } finally {
        await tmp.cleanup();
      }
    },
  );

  app.get("/styles/:styleId", { schema: { tags, summary: "Detalle del estilo con sus versiones", params: StyleParams } }, async (request): Promise<StyleDetail> => {
    const owner = request.ownerId;
    const style = await db.styles.get(owner, request.params.styleId);
    if (!style) throw notFound("ese estilo");
    const versions = await db.styleVersions.list(owner, { styleId: style.id }, { orderBy: "number" });
    return { style, versions };
  });

  app.post(
    "/styles/:styleId/versions",
    { schema: { tags, summary: "Actualizar estilo (nueva versión) o guardarlo como estilo nuevo", params: StyleParams, body: UpdateStyleBody } },
    async (request) => {
      const owner = request.ownerId;
      const style = await db.styles.get(owner, request.params.styleId);
      if (!style) throw notFound("ese estilo");
      return ctx.styles.update(owner, style.id, request.body);
    },
  );

  app.get("/styles/:styleId/export", { schema: { tags, summary: "Exportar estilo como zip (Skill de Claude)", params: StyleParams } }, async (request, reply) => {
    const owner = request.ownerId;
    const style = await db.styles.get(owner, request.params.styleId);
    if (!style) throw notFound("ese estilo");
    const { filename, stream } = await ctx.styles.exportZip(owner, style.id);
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", contentDisposition(filename));
    return reply.send(stream);
  });

  app.delete("/styles/:styleId", { schema: { tags, summary: "Borrar estilo", params: StyleParams } }, async (request) => {
    const owner = request.ownerId;
    const style = await db.styles.get(owner, request.params.styleId);
    if (!style) throw notFound("ese estilo");
    await db.styles.delete(owner, style.id);
    await ctx.services.storage.deletePrefix(keys.styleDir(owner, style.id)).catch(() => undefined);
    return { ok: true };
  });
};
