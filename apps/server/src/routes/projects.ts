/** Proyectos: CRUD, detalle y autoguardado de la configuración del diagrama. */
import {
  CreateProjectBody,
  Project,
  ProjectSettings,
  UpdateProjectBody,
  deriveEngines,
  type ProjectDetail,
  type ProjectListItem,
  type ProjectsResponse,
} from "@autoeditor/shared";
import { z } from "zod";
import { newId, nowIso } from "../db/util.js";
import { keys } from "../storage/keys.js";
import { notFound, onlySent, type RouteModule } from "./http.js";

const ProjectParams = z.object({ projectId: z.string().min(1) });

/** Aplica las reglas del lado servidor (p. ej. IA prendida → Kie AI prendido en motores). */
export function withDerivedEngines(settings: ProjectSettings): ProjectSettings {
  return { ...settings, engines: deriveEngines(settings) };
}

export const projectRoutes: RouteModule = (app, ctx) => {
  const { db } = ctx;
  const tags = ["Proyectos"];

  app.get("/projects", { schema: { tags, summary: "Lista de proyectos (recientes primero)" } }, async (request): Promise<ProjectsResponse> => {
    const owner = request.ownerId;
    const [projects, stats, assets] = await Promise.all([
      db.projects.list(owner, {}, { orderBy: "updatedAt", desc: true }),
      db.versions.statsByProject(owner),
      db.assets.list(owner),
    ]);
    const byProject = new Map<string, typeof assets>();
    for (const a of assets) {
      if (!a.projectId) continue;
      const list = byProject.get(a.projectId) ?? [];
      list.push(a);
      byProject.set(a.projectId, list);
    }
    const items: ProjectListItem[] = projects.map((p) => {
      const list = byProject.get(p.id) ?? [];
      const cover = p.thumbnailAssetId ?? list.find((a) => a.thumbnailKey && (a.category === "crudo-video" || a.category === "crudo-foto"))?.id ?? null;
      return { ...p, assetCount: list.length, versionCount: stats[p.id]?.versions ?? 0, coverAssetId: cover };
    });
    return { projects: items };
  });

  app.post("/projects", { schema: { tags, summary: "Crear proyecto (desde cero o desde un estilo)", body: CreateProjectBody } }, async (request, reply) => {
    const owner = request.ownerId;
    const body = request.body;
    let base: ProjectSettings = ProjectSettings.parse({});
    if (body.styleId) base = (await ctx.styles.settingsForNewProject(owner, body.styleId)).settings;
    // Solo las secciones de settings que mandó el cliente (para no pisar las del estilo con valores por defecto).
    const overrides = body.settings ? onlySent(request, body.settings, "settings") : {};
    const settings = withDerivedEngines(ProjectSettings.parse({ ...base, ...overrides }));
    const now = nowIso();
    const project = await db.projects.create(
      owner,
      Project.parse({ id: newId("prj"), ownerId: owner, name: body.name, settings, status: "borrador", createdAt: now, updatedAt: now }),
    );
    return reply.code(201).send(project);
  });

  app.get("/projects/:projectId", { schema: { tags, summary: "Detalle del proyecto", params: ProjectParams } }, async (request): Promise<ProjectDetail> => {
    const owner = request.ownerId;
    const project = await db.projects.get(owner, request.params.projectId);
    if (!project) throw notFound("ese proyecto");
    const [assets, versions, activeJob, plans] = await Promise.all([
      db.assets.list(owner, { projectId: project.id }, { orderBy: "order" }),
      db.versions.list(owner, { projectId: project.id }, { orderBy: "number" }),
      db.jobs.activeForProject(owner, project.id),
      db.plans.list(owner, { projectId: project.id, status: ["pendiente", "ajustando"] }, { orderBy: "createdAt", desc: true, limit: 1 }),
    ]);
    return { project, assets, versions, activeJob, pendingPlan: plans[0] ?? null };
  });

  app.patch(
    "/projects/:projectId",
    { schema: { tags, summary: "Actualizar proyecto (autoguardado de la configuración)", params: ProjectParams, body: UpdateProjectBody } },
    async (request) => {
      const owner = request.ownerId;
      const body = request.body;
      if (body.currentVersionId) {
        const version = await db.versions.get(owner, body.currentVersionId);
        if (!version || version.projectId !== request.params.projectId) throw notFound("esa versión en este proyecto");
      }
      const updated = await db.projects.update(owner, request.params.projectId, (p) => ({
        ...p,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.settings !== undefined ? { settings: withDerivedEngines(body.settings) } : {}),
        ...(body.currentVersionId !== undefined ? { currentVersionId: body.currentVersionId } : {}),
      }));
      if (!updated) throw notFound("ese proyecto");
      ctx.events.emit(updated.id, { type: "project.updated", project: updated });
      return updated;
    },
  );

  app.delete("/projects/:projectId", { schema: { tags, summary: "Borrar proyecto y sus archivos", params: ProjectParams } }, async (request) => {
    const owner = request.ownerId;
    const project = await db.projects.get(owner, request.params.projectId);
    if (!project) throw notFound("ese proyecto");
    // Cancela lo que esté corriendo antes de borrar.
    const active = await db.jobs.list(owner, { projectId: project.id, status: ["en-cola", "corriendo", "esperando"] });
    for (const job of active) await ctx.queue.cancel(owner, job.id).catch(() => undefined);
    await db.projects.delete(owner, project.id);
    await ctx.services.storage.deletePrefix(keys.projectRoot(owner, project.id)).catch((err) => ctx.log.warn({ err }, "No se pudieron borrar los archivos del proyecto"));
    return { ok: true };
  });
};
