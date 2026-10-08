/**
 * CORREGIR con texto: una corrección es un PARCHE MÍNIMO sobre la receta de la versión (regla de oro).
 *
 *   editor.correct → (pregunta aclaratoria: termina sin versión) → aplicar parche + validar + normalizar
 *   + re-materializar subtítulos → verificar la regla de oro (diffRecipes + changesOutsideAreas; lo que
 *   se salga de las áreas pedidas se REVIERTE) → re-render reutilizando cachés → V(n+1) con parentId,
 *   corrección, momento y cambios → aprendizaje (regla sugerida).
 */
import { changesOutsideAreas, diffRecipes, normalizeRecipe, summarizeChanges, type Job, type Recipe, type RecipeChange } from "@autoeditor/shared";
import type { AppContext, CorrectionInput as CorrectionBodyInput } from "../context.js";
import type { JobContext, JobOutcome } from "../jobs/queue.js";
import { completeAiRequests } from "../ai/shared/ai-requests.js";
import { needsRematerialize, verifyPatch, type Area } from "../ai/shared/recipe-ops.js";
import { UserFacingError, type CorrectionInput, type CorrectionResult, type EditorToolbox } from "../services/types.js";
import { produceVersion } from "./generate.js";
import { buildEditInput, loadProjectData, saveProjectTemplates } from "./project-data.js";

const shortError = (ctx: AppContext, err: unknown) => ctx.scrub(err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200);

/** Partes de la receta que corresponden a cada área (para revertir lo que se salga de lo pedido). */
const AREA_PATHS: Record<Area, string[][]> = {
  cortes: [["tracks", "video"], ["tracks", "overlays"]],
  texto: [["tracks", "text"]],
  subtitulos: [["tracks", "captions"]],
  graficos: [["tracks", "graphics"]],
  audio: [["tracks", "audio"]],
  estilo: [["style"]],
  formato: [["format"]],
  ia: [["ai"]],
  otro: [["target"]],
};

function getIn(obj: unknown, path: string[]): unknown {
  return path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}
function setIn(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = obj;
  for (const k of path.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  cur[path[path.length - 1]!] = structuredClone(value);
}

/**
 * REGLA DE ORO: devuelve la receta corregida con las áreas no permitidas restauradas a como estaban.
 * Si los cortes no cambian, los subtítulos se quedan con sus palabras (solo cambian si se pidió).
 */
export function enforceGoldenRule(current: Recipe, candidate: Recipe, areas: Area[], toolbox: EditorToolbox): { recipe: Recipe; changes: RecipeChange[]; reverted: RecipeChange[] } {
  let changes = diffRecipes(current, candidate);
  const outside = changesOutsideAreas(changes, areas);
  if (!outside.length) return { recipe: candidate, changes, reverted: [] };
  const fixed = structuredClone(candidate) as unknown as Record<string, unknown>;
  for (const area of new Set(outside.map((c) => c.area))) {
    for (const path of AREA_PATHS[area]) setIn(fixed, path, getIn(current, path));
  }
  let recipe = normalizeRecipe(fixed as unknown as Recipe);
  // Si se pidió tocar subtítulos pero se revirtieron los cortes (o al revés), las palabras se recalculan.
  if (needsRematerialize(current, recipe) || (areas.includes("subtitulos") && !areas.includes("cortes"))) recipe = toolbox.materializeCaptions(recipe);
  changes = diffRecipes(current, recipe);
  return { recipe, changes, reverted: outside };
}

export async function startCorrect(ctx: AppContext, ownerId: string, versionId: string, body: CorrectionBodyInput): Promise<Job> {
  const { db, queue } = ctx;
  const version = await db.versions.get(ownerId, versionId);
  if (!version) throw new UserFacingError("version-no-encontrada", "No encontré esa versión", 404);
  if (version.status !== "lista") throw new UserFacingError("version-no-lista", "Esa versión todavía no está lista para corregirla", 409);
  const active = (await db.jobs.list(ownerId, { projectId: version.projectId, type: ["generar", "corregir"], status: ["en-cola", "corriendo", "esperando"] }))[0];
  if (active) throw new UserFacingError("trabajo-en-curso", "Ya hay una edición en curso en este proyecto. Espera a que termine o cancélala.", 409, { jobId: active.id });
  const text = body.text.trim();
  if (!text) throw new UserFacingError("correccion-vacia", "Escribe qué quieres cambiar", 400);
  const job = await queue.enqueue(
    "corregir",
    { versionId, text, at: body.at ?? null, remember: body.remember ?? null },
    { ownerId, projectId: version.projectId, estimatedSeconds: Math.round(20 + version.recipe.duration * 1.5) },
  );
  const project = await db.projects.update(ownerId, version.projectId, { status: "procesando" });
  if (project) ctx.events.emit(project.id, { type: "project.updated", project });
  return job;
}

/** Corrige con el editor principal; si falla (y no es el demo), con el demo. */
async function correctWithFallback(ctx: AppContext, input: CorrectionInput, job: JobContext): Promise<{ res: CorrectionResult; warning: string | null }> {
  const { services } = ctx;
  const opts = { signal: job.signal, onProgress: (p: number, m?: string) => void job.progress(0.05 + Math.min(1, Math.max(0, p)) * 0.3, m) };
  try {
    return { res: await services.editor.correct(input, opts), warning: null };
  } catch (err) {
    job.throwIfAborted();
    if (services.editor === services.demoEditor) throw err;
    ctx.log.warn({ err: shortError(ctx, err) }, "Falló la corrección con Claude; uso el editor automático");
    return { res: await services.demoEditor.correct(input, opts), warning: `Claude no estuvo disponible (${shortError(ctx, err)}); apliqué la corrección con el editor automático.` };
  }
}

export async function runCorrectJob(ctx: AppContext, job: JobContext): Promise<JobOutcome> {
  const { db, services } = ctx;
  const ownerId = job.job.ownerId;
  const versionId = String(job.job.input.versionId ?? "");
  const text = String(job.job.input.text ?? "").trim();
  const at = typeof job.job.input.at === "number" ? job.job.input.at : null;
  const remember = (job.job.input.remember ?? null) as CorrectionBodyInput["remember"];
  const parent = await db.versions.get(ownerId, versionId);
  if (!parent) throw new UserFacingError("version-no-encontrada", "Esa versión ya no existe", 404);
  const project = await db.projects.get(ownerId, parent.projectId);
  if (!project) throw new UserFacingError("proyecto-no-encontrado", "Ese proyecto ya no existe", 404);
  const work = await services.storage.tempDir("corregir");
  let success = false;
  try {
    await job.stage("planeando", 0.03, "Interpretando tu corrección");
    let data = await loadProjectData(ctx, ownerId, project);
    let input = await buildEditInput(ctx, ownerId, data, work.path);
    const versions = await db.versions.list(ownerId, { projectId: project.id }, { orderBy: "number" });
    const history = versions.filter((v) => v.correction && v.number <= parent.number).map((v) => ({ correction: v.correction!, summary: v.changeSummary.split("\n")[0] ?? "" }));
    const current = normalizeRecipe(parent.recipe);
    const { res, warning } = await correctWithFallback(ctx, { ...input, current, correction: text, at, history }, job);
    job.throwIfAborted();
    await job.addCost(res.usage.costUsd);

    if (res.clarifyingQuestion) {
      success = true;
      return { message: "Necesito una aclaración", result: { question: res.clarifyingQuestion, versionId: null, parentVersionId: parent.id } };
    }
    if (res.newTemplates.length) {
      await saveProjectTemplates(ctx, ownerId, project.id, res.newTemplates);
      data = { ...data, templates: [...res.newTemplates, ...data.templates] };
      input = await buildEditInput(ctx, ownerId, data, work.path);
    }

    // Aplicar, validar, normalizar y re-materializar; luego la regla de oro.
    const areas = (res.areas.length ? res.areas : []) as Area[];
    const verified = verifyPatch(current, res.patch, areas, input.toolbox, { postProcess: (r) => completeAiRequests(r, ctx.config.providers.kie) });
    if (!verified.recipe) {
      throw new UserFacingError("correccion-invalida", `No pude aplicar esa corrección (${verified.errors[0] ?? "el cambio no es válido"}). Prueba a decirlo de otra forma.`, 422);
    }
    const golden = enforceGoldenRule(current, verified.recipe, areas, input.toolbox);
    const warnings: string[] = warning ? [warning] : [];
    if (golden.reverted.length) {
      warnings.push(`Dejé igual ${golden.reverted.length} cambio(s) que no pediste (${[...new Set(golden.reverted.map((c) => c.area))].join(", ")}).`);
    }
    if (!golden.changes.some((c) => !c.derived)) {
      throw new UserFacingError("correccion-sin-cambios", "No encontré qué cambiar con esa corrección. ¿Puedes decirme qué elemento y cómo?", 422);
    }
    const recipe = { ...golden.recipe, notes: [parent.recipe.notes.split("\nCorrección:")[0], `Corrección: ${res.summary}`].filter(Boolean).join("\n") };
    const summary = res.summary || summarizeChanges(golden.changes);

    const outcome = await produceVersion(ctx, job, {
      ownerId,
      projectId: project.id,
      data,
      input,
      recipe,
      summary,
      warnings,
      correction: { parentId: parent.id, text, at, parentRecipe: current, publishCopy: parent.publishCopy },
    });
    const newVersionId = String(outcome.result?.versionId ?? "");
    // Aprendizaje: regla sugerida ("¿lo recuerdo?") o guardada según lo que eligió la persona.
    if (newVersionId) {
      try {
        await ctx.memory.learnFromCorrection(ownerId, {
          projectId: project.id,
          versionId: newVersionId,
          correction: text,
          remember,
          suggestion: res.ruleSuggestion,
          styleId: project.settings.style.styleId,
          brandId: project.settings.context.brand.enabled ? project.settings.context.brand.brandId : null,
        });
      } catch (err) {
        ctx.log.warn({ err: shortError(ctx, err) }, "No se pudo guardar el aprendizaje de la corrección");
      }
    }
    success = true;
    return { ...outcome, result: { ...outcome.result, parentVersionId: parent.id, areas, changes: golden.changes.filter((c) => !c.derived).length } };
  } finally {
    await work.cleanup();
    const cur = await db.projects.get(ownerId, project.id);
    if (cur && cur.status === "procesando" && !success) {
      const restored = await db.projects.update(ownerId, project.id, { status: cur.currentVersionId ? "listo" : "borrador" });
      if (restored) ctx.events.emit(project.id, { type: "project.updated", project: restored });
    } else if (cur && cur.status === "procesando" && success) {
      const restored = await db.projects.update(ownerId, project.id, { status: "listo" });
      if (restored) ctx.events.emit(project.id, { type: "project.updated", project: restored });
    }
  }
}
