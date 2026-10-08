/**
 * GENERAR (V1, V2 desde cero…): trabajo "generar" con etapas visibles.
 *
 *   analizando → transcribiendo → planeando → (esperando-aprobacion) → generando-ia → motion-graphics
 *   → render → revision-calidad → versión nueva
 *
 * - Espera el análisis y la transcripción pendientes del material. Si esos trabajos siguen en la cola
 *   (p. ej. con un solo trabajador ocupado por esta generación), los ejecuta aquí mismo para no
 *   quedarse esperando para siempre.
 * - Planea con `services.editor` (Claude si hay llave); si Claude falla, usa el editor demo y lo avisa.
 * - Con «revisar el plan» prendido guarda un Plan y deja el trabajo "esperando"; al aprobarlo se reanuda.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { diffRecipes, normalizeRecipe, Plan as PlanSchema, PublishCopy, type Asset, type Job, type Recipe, type Version } from "@autoeditor/shared";
import type { AppContext } from "../context.js";
import { newId, nowIso } from "../db/util.js";
import type { JobContext, JobOutcome } from "../jobs/queue.js";
import { UserFacingError, type EditInput, type EditPlanResult, type QaInput, type QaResult, type RunOptions } from "../services/types.js";
import { applyPatchLoose } from "../ai/shared/recipe-ops.js";
import { estimateProject, PLATFORM_DEFAULT_MAX } from "./estimate.js";
import { needsFullAnalysis, runAnalysisJob, runTranscriptionJob } from "./assets.js";
import { buildEditInput, loadProjectData, saveProjectTemplates, type ProjectData } from "./project-data.js";
import { renderPendingGraphics, renderVersionFiles, runAiRequests } from "./render-version.js";
import { computeMaterialMap, orderInRecipe, saveMaterialMap, usedOrderReason } from "./material.js";

export interface GenerateDeps {
  /** Detección de palabras clave del pipeline (se usa si aún no hay). */
  detectKeywords(ownerId: string, projectId: string): Promise<unknown>;
}

const MATERIAL_CATEGORIES = new Set<Asset["category"]>(["clip-base", "crudo-video", "crudo-foto", "crudo-voz", "ia-generado"]);
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
const shortError = (ctx: AppContext, err: unknown) => ctx.scrub(err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200);

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

export async function startGenerate(ctx: AppContext, ownerId: string, projectId: string): Promise<Job> {
  const { db, queue } = ctx;
  const project = await db.projects.get(ownerId, projectId);
  if (!project) throw new UserFacingError("proyecto-no-encontrado", "No encontré ese proyecto", 404);
  const active = (await db.jobs.list(ownerId, { projectId, type: ["generar", "corregir"], status: ["en-cola", "corriendo", "esperando"] }))[0];
  if (active) {
    throw new UserFacingError(
      "trabajo-en-curso",
      active.status === "esperando" ? "Hay un plan esperando tu aprobación: apruébalo, ajústalo o cancélalo antes de generar otra vez." : "Ya se está generando un video en este proyecto. Espera a que termine o cancélalo.",
      409,
      { jobId: active.id },
    );
  }
  const assets = await db.assets.list(ownerId, { projectId });
  const usable = assets.filter((a) => MATERIAL_CATEGORIES.has(a.category) && (a.kind === "video" || a.kind === "imagen" || a.kind === "audio"));
  if (!usable.some((a) => a.kind === "video" || a.kind === "imagen")) {
    throw new UserFacingError("sin-material", "Sube al menos un video (o fotos) para generar el video.", 409);
  }
  let estimateLines: Record<string, number> = {};
  let estimatedSeconds: number | null = null;
  try {
    const est = await estimateProject(ctx, ownerId, projectId, project.settings);
    estimateLines = Object.fromEntries(est.lines.map((l) => [l.stage, Math.round(l.seconds * 10) / 10]));
    estimatedSeconds = Math.round(est.seconds.expected);
  } catch (err) {
    ctx.log.warn({ err: shortError(ctx, err) }, "No se pudo estimar antes de generar");
  }
  const job = await queue.enqueue("generar", { projectId, estimateLines }, { ownerId, projectId, estimatedSeconds });
  const updated = await db.projects.update(ownerId, projectId, { status: "procesando" });
  if (updated) ctx.events.emit(projectId, { type: "project.updated", project: updated });
  return job;
}

// ---------------------------------------------------------------------------
// Esperar (o adelantar) análisis y transcripción pendientes
// ---------------------------------------------------------------------------

/** Contexto de un sub-trabajo (análisis/transcripción) que corre dentro de la generación. */
function subJobContext(parent: JobContext, sub: Job, progress: { from: number; to: number }): JobContext {
  const map = (p: number) => progress.from + Math.min(1, Math.max(0, p)) * (progress.to - progress.from);
  return {
    job: sub,
    signal: parent.signal,
    log: parent.log,
    stage: async (stage, p, message) => {
      if (stage === "analizando" || stage === "transcribiendo") await parent.stage(stage, p === undefined ? undefined : map(p), message);
      else await parent.progress(p === undefined ? progress.from : map(p), message);
    },
    progress: (p, message) => parent.progress(map(p), message),
    addCost: (usd) => parent.addCost(usd),
    setResult: async () => undefined,
    throwIfAborted: () => parent.throwIfAborted(),
  };
}

/**
 * Espera a que el material esté analizado y transcrito. Los trabajos "analizar"/"transcribir" que
 * siguen en la cola se toman y se ejecutan aquí (así no hay bloqueo con un solo trabajador).
 */
export async function settleMaterial(ctx: AppContext, job: JobContext, ownerId: string, projectId: string): Promise<string[]> {
  const { db } = ctx;
  const warnings: string[] = [];
  const started = Date.now();
  let idleSince: number | null = null;
  await job.stage("analizando", 0.02, "Revisando el material");
  for (;;) {
    job.throwIfAborted();
    const [assets, transcripts, jobs] = await Promise.all([
      db.assets.list(ownerId, { projectId }),
      db.transcripts.list(ownerId, { projectId }),
      db.jobs.list(ownerId, { projectId, type: ["analizar", "transcribir"], status: ["en-cola", "corriendo"] }, { orderBy: "createdAt" }),
    ]);
    const pendingAssets = assets.filter((a) => (needsFullAnalysis(a) || a.analysis.status === "analizando") && (a.analysis.status === "pendiente" || a.analysis.status === "analizando"));
    const pendingTranscripts = transcripts.filter((t) => t.status === "pendiente" || t.status === "transcribiendo");
    if (!pendingAssets.length && !pendingTranscripts.length && !jobs.length) break;

    // Adelantar el primer trabajo en cola (si nadie lo tomó todavía).
    const queued = jobs.find((j) => j.status === "en-cola");
    if (queued) {
      const claimed = await db.jobs.update(ownerId, queued.id, (cur) =>
        cur.status === "en-cola" ? { ...cur, status: "corriendo", attempts: cur.attempts + 1, startedAt: nowIso(), message: "Se procesa dentro de la generación" } : cur,
      );
      if (claimed && claimed.status === "corriendo" && claimed.message === "Se procesa dentro de la generación") {
        ctx.events.emit(projectId, { type: "job.updated", job: claimed });
        const total = Math.max(1, assets.filter((a) => needsFullAnalysis(a)).length);
        const doneCount = total - pendingAssets.length;
        const range = { from: 0.02 + (doneCount / total) * 0.16, to: 0.02 + ((doneCount + 1) / total) * 0.16 };
        try {
          const handler = claimed.type === "analizar" ? runAnalysisJob : runTranscriptionJob;
          const out = await handler(ctx, subJobContext(job, claimed, range));
          const fin = await db.jobs.update(ownerId, claimed.id, (cur) => ({ ...cur, status: "listo", stage: "listo", progress: 1, message: "Listo", result: out.result, finishedAt: nowIso() }));
          if (fin) ctx.events.emit(projectId, { type: "job.updated", job: fin });
        } catch (err) {
          job.throwIfAborted();
          const message = err instanceof UserFacingError ? err.userMessage : shortError(ctx, err);
          const fin = await db.jobs.update(ownerId, claimed.id, (cur) => ({ ...cur, status: "error", error: message, message, finishedAt: nowIso() }));
          if (fin) ctx.events.emit(projectId, { type: "job.updated", job: fin });
          warnings.push(message);
        }
        idleSince = null;
        continue;
      }
    }
    // Algo corre en otro trabajador o el archivo aún se está leyendo: esperar.
    if (!jobs.length) {
      idleSince ??= Date.now();
      // Sin trabajos activos por un rato: el archivo quedó a medias (p. ej. reinicio). Se sigue sin él.
      if (Date.now() - idleSince > 20_000) {
        for (const a of pendingAssets) warnings.push(`«${a.originalName}» no terminó de analizarse; lo usé con lo que había.`);
        break;
      }
    } else {
      idleSince = null;
    }
    if (Date.now() - started > 3 * 60 * 60 * 1000) {
      warnings.push("El análisis del material tardó demasiado; generé con lo que estaba listo.");
      break;
    }
    const name = pendingAssets[0]?.originalName;
    await job.progress(0.05, name ? `Esperando el análisis de «${name}»` : "Esperando la transcripción");
    await sleep(400, job.signal);
  }
  await job.stage("transcribiendo", 0.18, "Material analizado y transcrito");
  return warnings;
}

// ---------------------------------------------------------------------------
// Planear
// ---------------------------------------------------------------------------

/** Planea con el editor principal; si falla (y no es el demo), cae al editor demo y lo informa. */
export async function planWithFallback(ctx: AppContext, input: EditInput, opts: RunOptions): Promise<{ result: EditPlanResult; fellBack: boolean; warning: string | null }> {
  const { services } = ctx;
  try {
    return { result: await services.editor.plan(input, opts), fellBack: false, warning: null };
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    if (services.editor === services.demoEditor) throw err;
    ctx.log.warn({ err: shortError(ctx, err) }, "Falló el editor con Claude; uso el editor automático");
    const result = await services.demoEditor.plan(input, opts);
    return { result, fellBack: true, warning: `Claude no estuvo disponible (${shortError(ctx, err)}); armé esta versión con el editor automático.` };
  }
}

/** Fija la duración objetivo, valida, normaliza y materializa subtítulos. */
export function finalizeRecipe(recipe: Recipe, input: EditInput, generator: { kind: "claude" | "demo"; model: string | null }): Recipe {
  const ins = input.settings.instruction;
  const withTarget = {
    ...recipe,
    target: { duration: ins.targetDuration, mode: ins.targetDuration == null ? ("auto" as const) : ins.durationMode },
    meta: {
      ...recipe.meta,
      generator: generator.kind,
      model: generator.model,
      styleId: input.settings.style.styleId,
      styleVersion: input.settings.style.styleVersion,
    },
  };
  const valid = input.toolbox.validateRecipe(withTarget);
  if (!valid.ok) {
    throw new UserFacingError("receta-invalida", `La edición propuesta no es válida: ${valid.errors.slice(0, 3).join("; ")}`, 500);
  }
  return normalizeRecipe(input.toolbox.materializeCaptions(valid.recipe));
}

// ---------------------------------------------------------------------------
// Revisión de calidad
// ---------------------------------------------------------------------------

export async function sampleFrames(ctx: AppContext, videoPath: string, duration: number, workDir: string): Promise<QaInput["frames"]> {
  const times = [...new Set([0.4, duration * 0.25, duration * 0.5, duration * 0.75, Math.max(0.4, duration - 0.6)].map((t) => Math.round(Math.max(0, Math.min(duration - 0.05, t)) * 100) / 100))];
  const out: QaInput["frames"] = [];
  for (const t of times) {
    try {
      const file = path.join(workDir, `qa-${Math.round(t * 1000)}.jpg`);
      await ctx.services.media.frameAt(videoPath, t, file, { width: 512 });
      out.push({ t, base64: (await readFile(file)).toString("base64"), mediaType: "image/jpeg" });
    } catch {
      // Un fotograma que no sale no detiene la revisión.
    }
  }
  return out;
}
export async function reviewWithFallback(ctx: AppContext, input: QaInput, opts: RunOptions): Promise<QaResult> {
  const { services } = ctx;
  try {
    return await services.editor.review(input, opts);
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    if (services.editor !== services.demoEditor) {
      try {
        return await services.demoEditor.review(input, opts);
      } catch {
        // cae abajo
      }
    }
    ctx.log.warn({ err: shortError(ctx, err) }, "No se pudo hacer la revisión de calidad");
    return { checks: [{ check: "Revisión de calidad", ok: true, detail: "No se pudo revisar automáticamente esta vez." }], fixPatch: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, model: "ninguno" } };
  }
}

// ---------------------------------------------------------------------------
// Trabajo "generar"
// ---------------------------------------------------------------------------

export async function runGenerateJob(ctx: AppContext, deps: GenerateDeps, job: JobContext): Promise<JobOutcome> {
  const { db, services } = ctx;
  const ownerId = job.job.ownerId;
  const projectId = String(job.job.input.projectId ?? job.job.projectId ?? "");
  const project = await db.projects.get(ownerId, projectId);
  if (!project) throw new UserFacingError("proyecto-no-encontrado", "Ese proyecto ya no existe", 404);
  const prev = job.job.result ?? {};
  const planId = String(job.job.input.planId ?? prev.planId ?? "") || null;
  const work = await services.storage.tempDir("generar");
  let success = false;
  let waiting = false;
  const warnings: string[] = Array.isArray(prev.warnings) ? (prev.warnings as string[]) : [];
  try {
    if (project.status !== "procesando") {
      const p = await db.projects.update(ownerId, projectId, { status: "procesando" });
      if (p) ctx.events.emit(projectId, { type: "project.updated", project: p });
    }
    let plan = planId ? await db.plans.get(ownerId, planId) : null;

    // Ajustes al plan con texto: el editor rehace la propuesta y se vuelve a esperar la aprobación.
    const reviseFeedback = typeof job.job.input.reviseFeedback === "string" ? job.job.input.reviseFeedback : null;
    if (plan && plan.status === "ajustando" && reviseFeedback) {
      await job.stage("planeando", 0.3, "Ajustando el plan con tus indicaciones");
      const pdata = await loadProjectData(ctx, ownerId, project);
      const materialMap = await computeMaterialMap(ctx, pdata);
      const pinput = await buildEditInput(ctx, ownerId, pdata, work.path, { materialMap });
      let revised: EditPlanResult;
      let brain = services.editor;
      try {
        revised = await services.editor.revisePlan(pinput, plan.recipe, reviseFeedback, { signal: job.signal });
      } catch (err) {
        job.throwIfAborted();
        if (services.editor === services.demoEditor) throw err;
        warnings.push(`Claude no estuvo disponible (${shortError(ctx, err)}); ajusté el plan con el editor automático.`);
        brain = services.demoEditor;
        revised = await services.demoEditor.revisePlan(pinput, plan.recipe, reviseFeedback, { signal: job.signal });
      }
      await job.addCost(revised.usage.costUsd);
      await saveProjectTemplates(ctx, ownerId, projectId, revised.newTemplates);
      const recipe = finalizeRecipe(revised.recipe, pinput, { kind: brain.kind, model: brain.kind === "claude" ? brain.model : null });
      const updated = await db.plans.update(ownerId, plan.id, {
        status: "pendiente",
        recipe,
        scenes: revised.scenes,
        summary: revised.summary,
        estimatedCostUsd: Math.round(recipe.ai.reduce((sum, a) => sum + (a.costUsd ?? 0), 0) * 10000) / 10000,
        updatedAt: nowIso(),
      });
      if (updated) ctx.events.emit(projectId, { type: "plan.ready", plan: updated });
      waiting = true;
      return { status: "esperando", stage: "esperando-aprobacion", message: "Plan ajustado: esperando tu aprobación", result: { planId: plan.id, warnings } };
    }
    if (plan && plan.status !== "aprobado") plan = null;

    let data: ProjectData;
    let input: EditInput;
    let recipe: Recipe;
    let summary: string;
    let newTemplatesCount = 0;

    if (plan) {
      await job.stage("planeando", 0.45, "Plan aprobado: continúo con la edición");
      data = await loadProjectData(ctx, ownerId, project);
      input = await buildEditInput(ctx, ownerId, data, work.path);
      recipe = plan.recipe;
      summary = plan.summary;
    } else {
      warnings.push(...(await settleMaterial(ctx, job, ownerId, projectId)));
      // Palabras clave (para resaltar subtítulos y elegir frases) si todavía no hay.
      const kw = await db.keywords.get(ownerId, projectId);
      if (!kw || !kw.keywords.some((k) => k.source === "auto")) {
        try {
          await deps.detectKeywords(ownerId, projectId);
        } catch {
          // Sin transcripción o sin editor: se sigue sin palabras clave.
        }
      }
      await job.stage("planeando", 0.2, services.editor.kind === "claude" ? "Claude está planeando la edición" : "Planeando la edición");
      data = await loadProjectData(ctx, ownerId, (await db.projects.get(ownerId, projectId)) ?? project);
      // Mapa del material: columna (clips base en su orden sugerido), habla / b-roll / tomas repetidas.
      const materialMap = await computeMaterialMap(ctx, data);
      await saveMaterialMap(ctx, ownerId, projectId, { map: materialMap, usedOrder: null, usedOrderReason: null });
      await job.setResult({ material: { summary: materialMap.summary.text, order: materialMap.order.assetIds, orderReason: materialMap.order.reason } });
      if (materialMap.clips.length > 1) await job.progress(0.21, `Ordené ${materialMap.clips.length} clips ${materialMap.order.reason}`);
      // Grabación larga sin duración pedida: un video a la medida de la plataforma (no de una hora).
      const ins = data.settings.instruction;
      const platformMax = PLATFORM_DEFAULT_MAX[ins.platform] ?? 90;
      if (ins.targetDuration == null && materialMap.summary.speechSeconds > platformMax * 2.5) {
        data = { ...data, settings: { ...data.settings, instruction: { ...ins, targetDuration: platformMax, durationMode: "aproximada" } } };
        warnings.push(
          `El material es largo (${Math.round(materialMap.summary.speechSeconds / 60)} min de voz) y no pediste duración: armé un video de unos ${platformMax} s con lo mejor. Pide otra duración si la quieres.`,
        );
      }
      input = await buildEditInput(ctx, ownerId, data, work.path, { materialMap });
      const planned = await planWithFallback(ctx, input, { signal: job.signal, onProgress: (p, m) => void job.progress(0.2 + Math.min(1, Math.max(0, p)) * 0.24, m) });
      job.throwIfAborted();
      if (planned.warning) warnings.push(planned.warning);
      const brain = planned.fellBack ? services.demoEditor : services.editor;
      await job.addCost(planned.result.usage.costUsd);
      await saveProjectTemplates(ctx, ownerId, projectId, planned.result.newTemplates);
      newTemplatesCount = planned.result.newTemplates.length;
      if (newTemplatesCount) {
        data = { ...data, templates: [...planned.result.newTemplates, ...data.templates] };
        input = await buildEditInput(ctx, ownerId, data, work.path, { materialMap });
      }
      recipe = finalizeRecipe(planned.result.recipe, input, { kind: brain.kind, model: brain.kind === "claude" ? brain.model : null });
      summary = planned.result.summary;
      const used = orderInRecipe(recipe, materialMap);
      await saveMaterialMap(ctx, ownerId, projectId, { map: materialMap, usedOrder: used, usedOrderReason: used.length ? usedOrderReason(materialMap, used, recipe.meta.generator) : null });

      if (data.settings.instruction.reviewPlan) {
        const now = nowIso();
        const saved = await db.plans.create(
          ownerId,
          PlanSchema.parse({
            id: newId("pln"),
            ownerId,
            projectId,
            jobId: job.job.id,
            status: "pendiente",
            summary,
            scenes: planned.result.scenes,
            recipe,
            estimatedCostUsd: Math.round(recipe.ai.reduce((s, a) => s + (a.costUsd ?? 0), 0) * 10000) / 10000,
            createdAt: now,
            updatedAt: now,
          }),
        );
        ctx.events.emit(projectId, { type: "plan.ready", plan: saved });
        waiting = true;
        return { status: "esperando", stage: "esperando-aprobacion", message: "Esperando tu aprobación del plan", result: { planId: saved.id, warnings } };
      }
    }

    const outcome = await produceVersion(ctx, job, { ownerId, projectId, data, input, recipe, summary, warnings });
    success = true;
    return outcome;
  } finally {
    await work.cleanup();
    if (!success && !waiting) {
      // Si falló o se canceló, el proyecto vuelve a su estado anterior.
      const cur = await db.projects.get(ownerId, projectId);
      if (cur && cur.status === "procesando") {
        const restored = await db.projects.update(ownerId, projectId, { status: cur.currentVersionId ? "listo" : "borrador" });
        if (restored) ctx.events.emit(projectId, { type: "project.updated", project: restored });
      }
    }
  }
}

/** IA → motion graphics → render → revisión de calidad → versión nueva (V1, V2…). */
export async function produceVersion(
  ctx: AppContext,
  job: JobContext,
  args: {
    ownerId: string;
    projectId: string;
    data: ProjectData;
    input: EditInput;
    recipe: Recipe;
    summary: string;
    warnings: string[];
    /** Datos de corrección (V2, V3…): versión madre, texto, momento y cambios. */
    correction?: { parentId: string; text: string; at: number | null; parentRecipe: Recipe; publishCopy: Version["publishCopy"] } | null;
    /** Progreso donde empieza (las correcciones empiezan más adelante). */
    from?: number;
  },
): Promise<JobOutcome> {
  const { db, services } = ctx;
  const { ownerId, projectId, data, input, warnings } = args;
  let recipe = args.recipe;
  const work = await services.storage.tempDir("version");
  try {
    // IA generativa.
    if (recipe.ai.some((a) => a.status === "pendiente" && !a.resultAssetId)) {
      await job.stage("generando-ia", 0.46, "Generando elementos con IA");
      const ai = await runAiRequests(ctx, job, { ownerId, projectId, recipe, workDir: work.path }, { from: 0.46, to: 0.55 });
      recipe = ai.recipe;
      warnings.push(...ai.warnings);
    }
    // Motion graphics (HyperFrames con caché; builtin de respaldo).
    if (recipe.tracks.graphics.some((g) => !g.renderedAssetId && g.engine === "hyperframes")) {
      await job.stage("motion-graphics", 0.55, "Dibujando los motion graphics");
      const mg = await renderPendingGraphics(ctx, job, { ownerId, projectId, recipe, templates: data.templates, workDir: work.path }, { from: 0.55, to: 0.62 });
      recipe = mg.recipe;
      warnings.push(...mg.warnings);
    }
    const allAssets = await db.assets.list(ownerId, { projectId });
    const assets = [...allAssets, ...data.allAssets.filter((a) => a.projectId !== projectId)];

    // Render.
    await job.stage("render", 0.62, "Renderizando el video");
    const versionId = newId("ver");
    let files = await renderVersionFiles(ctx, job, { ownerId, projectId, versionId, recipe, assets, workDir: work.path }, { from: 0.62, to: 0.88 });

    // Revisión de calidad (un intento de arreglo si hay parche).
    await job.stage("revision-calidad", 0.88, "Revisando la calidad del video");
    const frames = await sampleFrames(ctx, files.localVideo, files.durationSeconds || recipe.duration, work.path);
    // En una corrección la revisión solo informa (un arreglo automático podría tocar algo que no se pidió).
    const isCorrection = !!args.correction;
    let qa = isCorrection
      ? await services.demoEditor.review({ recipe, rules: input.rules, settings: input.settings, frames }, { signal: job.signal }).catch(() => ({ checks: [], fixPatch: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, model: "demo" } }))
      : await reviewWithFallback(ctx, { recipe, rules: input.rules, settings: input.settings, frames }, { signal: job.signal });
    await job.addCost(qa.usage.costUsd);
    if (!isCorrection && qa.fixPatch?.length) {
      const fixed = applyPatchLoose(recipe, qa.fixPatch);
      const valid = fixed ? input.toolbox.validateRecipe(fixed) : null;
      if (valid?.ok) {
        const candidate = normalizeRecipe(input.toolbox.materializeCaptions(valid.recipe));
        await job.progress(0.9, "Corrigiendo lo que encontró la revisión");
        files = await renderVersionFiles(ctx, job, { ownerId, projectId, versionId, recipe: candidate, assets, workDir: work.path }, { from: 0.9, to: 0.97 });
        const before = qa.checks.filter((c) => !c.ok).map((c) => c.check);
        recipe = candidate;
        const recheck = await reviewWithFallback(ctx, { recipe, rules: input.rules, settings: input.settings, frames: [] }, { signal: job.signal });
        qa = { ...recheck, checks: recheck.checks.map((c) => (before.includes(c.check) && c.ok ? { ...c, detail: `${c.detail} (corregido automáticamente)` } : c)) };
      }
    }
    job.throwIfAborted();

    // Versión.
    const kw = await db.keywords.get(ownerId, projectId);
    const jobNow = await db.jobs.get(ownerId, job.job.id);
    const summary = [args.summary, ...warnings.map((w) => `Aviso: ${w}`)].filter(Boolean).join("\n");
    const version = await db.versions.createNext(ownerId, {
      id: versionId,
      ownerId,
      projectId,
      parentId: args.correction?.parentId ?? null,
      recipe,
      correction: args.correction?.text ?? null,
      correctionAt: args.correction?.at ?? null,
      changes: args.correction ? diffRecipes(args.correction.parentRecipe, recipe) : [],
      changeSummary: summary,
      status: "lista",
      videoKey: files.videoKey,
      posterKey: files.posterKey,
      captionsSrtKey: files.captionsSrtKey,
      captionsVttKey: files.captionsVttKey,
      publishCopy: args.correction?.publishCopy ?? kw?.publishCopy ?? PublishCopy.parse({}),
      rating: null,
      exported: false,
      qa: qa.checks.map((c) => ({ check: c.check, ok: c.ok, detail: c.detail })),
      renderSeconds: files.renderSeconds,
      costUsd: Math.round((jobNow?.costUsd ?? 0) * 1e6) / 1e6,
      createdAt: nowIso(),
    });
    ctx.events.emit(projectId, { type: "version.created", version });
    const project = await db.projects.update(ownerId, projectId, { currentVersionId: version.id, status: "listo" });
    if (project) ctx.events.emit(projectId, { type: "project.updated", project });
    if (recipe.meta.appliedRuleIds.length) await db.rules.incrementApplied(ownerId, recipe.meta.appliedRuleIds).catch(() => undefined);
    return {
      message: `V${version.number} lista`,
      result: { versionId: version.id, versionNumber: version.number, warnings, duration: recipe.duration, generator: recipe.meta.generator },
    };
  } finally {
    await work.cleanup();
  }
}
