/** Palabras clave del proyecto (chips editables) y texto sugerido para publicar. */
import { PutKeywordsBody, type KeywordsResponse } from "@autoeditor/shared";
import { z } from "zod";
import { newId, nowIso } from "../db/util.js";
import { notFound, type RouteModule } from "./http.js";

const ProjectParams = z.object({ projectId: z.string().min(1) });

export const keywordRoutes: RouteModule = (app, ctx) => {
  const { db } = ctx;
  const tags = ["Palabras clave"];

  async function mustProject(ownerId: string, projectId: string) {
    const project = await db.projects.get(ownerId, projectId);
    if (!project) throw notFound("ese proyecto");
    return project;
  }

  app.get("/projects/:projectId/keywords", { schema: { tags, summary: "Palabras clave y texto para publicar", params: ProjectParams } }, async (request): Promise<KeywordsResponse> => {
    const project = await mustProject(request.ownerId, request.params.projectId);
    const rec = await db.keywords.get(request.ownerId, project.id);
    return { keywords: rec?.keywords ?? [], publishCopy: rec?.publishCopy ?? null };
  });

  app.put(
    "/projects/:projectId/keywords",
    { schema: { tags, summary: "Guardar las palabras clave (agregar, quitar, cambiar)", params: ProjectParams, body: PutKeywordsBody } },
    async (request): Promise<KeywordsResponse> => {
      const owner = request.ownerId;
      const project = await mustProject(owner, request.params.projectId);
      const before = await db.keywords.get(owner, project.id);
      const keywords = request.body.keywords.map((k) => ({ ...k, id: k.id || newId("kw") }));
      const saved = await db.keywords.put(owner, project.id, keywords);
      // Señal de aprendizaje: qué agregó o quitó la persona (la ola 2 lo convierte en reglas).
      const prev = new Set((before?.keywords ?? []).map((k) => k.text.toLowerCase()));
      const next = new Set(keywords.map((k) => k.text.toLowerCase()));
      const added = [...next].filter((t) => !prev.has(t));
      const removed = [...prev].filter((t) => !next.has(t));
      if (added.length || removed.length) {
        await db.feedback.create(owner, {
          id: newId("fbk"),
          ownerId: owner,
          projectId: project.id,
          versionId: null,
          kind: "palabras-clave",
          rating: null,
          text: "",
          data: { added, removed },
          createdAt: nowIso(),
        });
      }
      ctx.events.emit(project.id, { type: "keywords.updated", keywords: saved.keywords });
      return { keywords: saved.keywords, publishCopy: saved.publishCopy };
    },
  );

  app.post("/projects/:projectId/keywords/detect", { schema: { tags, summary: "Detectar palabras clave con Claude (o el editor demo)", params: ProjectParams } }, async (request) => {
    await mustProject(request.ownerId, request.params.projectId);
    return ctx.pipeline.detectKeywords(request.ownerId, request.params.projectId);
  });
};
