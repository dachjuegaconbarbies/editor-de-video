/** Estimado, generación, plan de edición y trabajos (cancelar / reintentar). */
import { GenerateBody, ProjectSettings, RevisePlanBody, type EstimateResponse } from "@autoeditor/shared";
import { z } from "zod";
import { estimateProject } from "../pipeline/estimate.js";
import { notFound, type RouteModule } from "./http.js";
import { withDerivedEngines } from "./projects.js";

const ProjectParams = z.object({ projectId: z.string().min(1) });
const PlanParams = z.object({ planId: z.string().min(1) });
const JobParams = z.object({ jobId: z.string().min(1) });
const EstimateBody = z.object({ settings: ProjectSettings.optional() }).nullish();

export const generationRoutes: RouteModule = (app, ctx) => {
  const { db } = ctx;

  app.post(
    "/projects/:projectId/estimate",
    {
      schema: {
        tags: ["Generación"],
        summary: "Tiempo y costo estimados (+ avisos antes de generar)",
        description: "Si mandas `settings`, estima con esa configuración sin guardarla (para recalcular al prender/apagar cosas).",
        params: ProjectParams,
        body: EstimateBody,
      },
    },
    async (request): Promise<EstimateResponse> => {
      const owner = request.ownerId;
      const project = await db.projects.get(owner, request.params.projectId);
      if (!project) throw notFound("ese proyecto");
      const settings = request.body?.settings ? withDerivedEngines(request.body.settings) : project.settings;
      return estimateProject(ctx, owner, project.id, settings);
    },
  );

  app.post(
    "/projects/:projectId/generate",
    { schema: { tags: ["Generación"], summary: "GENERAR: arranca la edición (V1)", params: ProjectParams, body: GenerateBody.nullish() } },
    async (request, reply) => {
      const owner = request.ownerId;
      const project = await db.projects.get(owner, request.params.projectId);
      if (!project) throw notFound("ese proyecto");
      if (request.body?.settings) {
        const updated = await db.projects.update(owner, project.id, { settings: withDerivedEngines(request.body.settings) });
        if (updated) ctx.events.emit(updated.id, { type: "project.updated", project: updated });
      }
      const job = await ctx.pipeline.generate(owner, project.id);
      return reply.code(202).send(job);
    },
  );

  app.get("/plans/:planId", { schema: { tags: ["Plan"], summary: "Plan de edición (storyboard)", params: PlanParams } }, async (request) => {
    const plan = await db.plans.get(request.ownerId, request.params.planId);
    if (!plan) throw notFound("ese plan");
    return plan;
  });

  app.post("/plans/:planId/approve", { schema: { tags: ["Plan"], summary: "Aprobar el plan y renderizar", params: PlanParams } }, async (request, reply) => {
    const job = await ctx.pipeline.approvePlan(request.ownerId, request.params.planId);
    return reply.code(202).send(job);
  });

  app.post("/plans/:planId/revise", { schema: { tags: ["Plan"], summary: "Pedir ajustes al plan con texto", params: PlanParams, body: RevisePlanBody } }, async (request, reply) => {
    const job = await ctx.pipeline.revisePlan(request.ownerId, request.params.planId, request.body.feedback);
    return reply.code(202).send(job);
  });

  app.get("/jobs/:jobId", { schema: { tags: ["Trabajos"], summary: "Estado de un trabajo", params: JobParams } }, async (request) => {
    const job = await ctx.queue.get(request.ownerId, request.params.jobId);
    if (!job) throw notFound("ese trabajo");
    return job;
  });

  app.post("/jobs/:jobId/cancel", { schema: { tags: ["Trabajos"], summary: "Cancelar un trabajo", params: JobParams } }, async (request) => {
    return ctx.queue.cancel(request.ownerId, request.params.jobId);
  });

  app.post("/jobs/:jobId/retry", { schema: { tags: ["Trabajos"], summary: "Reintentar un trabajo que falló o se canceló", params: JobParams } }, async (request, reply) => {
    const job = await ctx.queue.retry(request.ownerId, request.params.jobId);
    return reply.code(202).send(job);
  });
};
