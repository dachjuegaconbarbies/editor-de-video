/**
 * PLAN opcional («revisar el plan antes de renderizar»): la generación guarda un Plan y queda
 * "esperando". Aprobar lo reanuda (render con la receta del plan); pedir ajustes lo reanuda en modo
 * "ajustar" (editor.revisePlan) y vuelve a esperar con el plan nuevo.
 */
import type { Job, Plan } from "@autoeditor/shared";
import type { AppContext } from "../context.js";
import { nowIso } from "../db/util.js";
import { UserFacingError } from "../services/types.js";

async function mustWaitingPlan(ctx: AppContext, ownerId: string, planId: string): Promise<{ plan: Plan; job: Job }> {
  const plan = await ctx.db.plans.get(ownerId, planId);
  if (!plan) throw new UserFacingError("plan-no-encontrado", "No encontré ese plan", 404);
  if (plan.status !== "pendiente") {
    throw new UserFacingError("plan-no-pendiente", plan.status === "aprobado" ? "Ese plan ya se aprobó" : plan.status === "ajustando" ? "Ese plan se está ajustando; espera la nueva propuesta" : "Ese plan ya no está vigente", 409);
  }
  const job = plan.jobId ? await ctx.db.jobs.get(ownerId, plan.jobId) : null;
  if (!job || job.status !== "esperando") {
    throw new UserFacingError("plan-sin-trabajo", "Ese plan ya no está esperando aprobación (¿se canceló?). Vuelve a generar.", 409);
  }
  return { plan, job };
}

export async function approvePlan(ctx: AppContext, ownerId: string, planId: string): Promise<Job> {
  const { plan, job } = await mustWaitingPlan(ctx, ownerId, planId);
  await ctx.db.plans.update(ownerId, plan.id, { status: "aprobado", updatedAt: nowIso() });
  return ctx.queue.resume(ownerId, job.id, { planId: plan.id, reviseFeedback: null });
}

export async function revisePlan(ctx: AppContext, ownerId: string, planId: string, feedback: string): Promise<Job> {
  const text = feedback.trim();
  if (!text) throw new UserFacingError("ajuste-vacio", "Escribe qué quieres ajustar del plan", 400);
  const { plan, job } = await mustWaitingPlan(ctx, ownerId, planId);
  await ctx.db.plans.update(ownerId, plan.id, (p) => ({ ...p, status: "ajustando", feedback: [...p.feedback, { text, at: nowIso() }], updatedAt: nowIso() }));
  return ctx.queue.resume(ownerId, job.id, { planId: plan.id, reviseFeedback: text });
}
