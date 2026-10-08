/**
 * Procesamiento de archivos subidos: probe + miniatura (inmediato) y análisis + transcripción
 * (trabajos "analizar" / "transcribir" en la cola).
 *
 * El análisis lo hace `services.media.analyze` y devuelve, entre otras cosas, el ROL de la toma
 * (a-roll = alguien habla; b-roll = toma de apoyo) y los fragmentos aprovechables como b-roll
 * (`brollSegments`), que el editor usa de fondo de las tomas o como corte sobre lo que se dice.
 */
import path from "node:path";
import { AssetAnalysis, isFiller, Transcript, type Asset, type MediaProbe, type Project } from "@autoeditor/shared";
import type { AppContext, MemoryScopeContext } from "../context.js";
import { newId, nowIso } from "../db/util.js";
import { scopeMatches } from "../memory/index.js";
import type { JobContext } from "../jobs/queue.js";
import { UserFacingError } from "../services/types.js";
import { keys } from "../storage/keys.js";

/** Actualiza un asset de forma atómica y avisa por SSE. */
export async function updateAsset(ctx: AppContext, ownerId: string, assetId: string, fn: (a: Asset) => Asset): Promise<Asset | null> {
  const updated = await ctx.db.assets.update(ownerId, assetId, fn);
  if (updated) ctx.events.emit(updated.projectId, { type: "asset.updated", asset: updated });
  return updated;
}

/** Contexto de memoria (capas) de un proyecto. */
export function memoryScopeFor(project: Project | null): MemoryScopeContext {
  return {
    projectId: project?.id ?? null,
    styleId: project?.settings.style.styleId ?? null,
    brandId: project?.settings.context.brand.enabled ? project.settings.context.brand.brandId : null,
  };
}

/** ¿Este archivo se analiza a fondo (escenas, A/B-roll, voz)? */
export function needsFullAnalysis(asset: Asset): boolean {
  if (asset.kind === "video") return asset.category !== "motion-render" && asset.category !== "render" && asset.category !== "ia-generado";
  return asset.kind === "audio" && asset.category === "crudo-voz";
}

/** ¿Tiene sentido transcribirlo? */
export function shouldTranscribe(asset: Asset, project: Project | null): boolean {
  if (project && !project.settings.transcription.enabled) return false;
  if (!needsFullAnalysis(asset)) return false;
  if (asset.kind === "audio") return true;
  return asset.probe.hasAudio && asset.analysis.hasSpeech !== false;
}

const shortError = (ctx: AppContext, err: unknown) => ctx.scrub(err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 240);

/**
 * Paso inmediato tras la subida (en segundo plano, tolerante a fallos): probe + miniatura y, si
 * aplica, encola el análisis completo. Si algo falla, el asset queda con `analysis.status = "error"`.
 */
export async function processUploadedAsset(ctx: AppContext, ownerId: string, asset: Asset): Promise<void> {
  const { services } = ctx;
  if (asset.kind === "fuente" || asset.kind === "documento" || asset.kind === "otro") {
    // Nada que analizar: queda listo.
    await updateAsset(ctx, ownerId, asset.id, (a) => ({ ...a, analysis: { ...a.analysis, status: "listo", error: null } }));
    return;
  }
  await updateAsset(ctx, ownerId, asset.id, (a) => ({ ...a, analysis: { ...a.analysis, status: "analizando", error: null } }));
  let filePath: string;
  let probe: MediaProbe;
  try {
    filePath = await services.storage.localPath(asset.storageKey);
    probe = await services.media.probe(filePath);
  } catch (err) {
    services.log.warn({ err: shortError(ctx, err), assetId: asset.id }, "No se pudo leer el archivo subido");
    await updateAsset(ctx, ownerId, asset.id, (a) => ({
      ...a,
      analysis: { ...a.analysis, status: "error", error: `No pude leer este archivo todavía (${shortError(ctx, err)}). Puedes volver a subirlo o seguir sin él.` },
    }));
    return;
  }
  let current = await updateAsset(ctx, ownerId, asset.id, (a) => ({ ...a, probe }));
  if (!current) return; // lo borraron mientras tanto

  // Miniatura (si falla, no es grave).
  if (probe.hasVideo || asset.kind === "imagen" || asset.kind === "video") {
    const tmp = await services.storage.tempDir("miniatura");
    try {
      const out = path.join(tmp.path, "thumb.jpg");
      await services.media.thumbnail(filePath, probe, out);
      const thumbKey = keys.assetThumb(ownerId, asset.projectId, asset.id);
      await services.storage.putFile(thumbKey, out, { move: true });
      current = (await updateAsset(ctx, ownerId, asset.id, (a) => ({ ...a, thumbnailKey: thumbKey }))) ?? current;
      // Primera miniatura de material en crudo = portada del proyecto.
      if (asset.projectId && (asset.category === "clip-base" || asset.category === "crudo-video" || asset.category === "crudo-foto")) {
        const project = await ctx.db.projects.update(ownerId, asset.projectId, (p) => (p.thumbnailAssetId ? p : { ...p, thumbnailAssetId: asset.id }));
        if (project && project.thumbnailAssetId === asset.id) ctx.events.emit(project.id, { type: "project.updated", project });
      }
    } catch (err) {
      services.log.warn({ err: shortError(ctx, err), assetId: asset.id }, "No se pudo generar la miniatura");
    } finally {
      await tmp.cleanup();
    }
  }

  if (needsFullAnalysis(current)) {
    await ctx.queue.enqueue("analizar", { assetId: asset.id }, { ownerId, projectId: asset.projectId, estimatedSeconds: estimateAnalysisSeconds(probe) });
    await updateAsset(ctx, ownerId, asset.id, (a) => ({ ...a, analysis: { ...a.analysis, status: "pendiente" } }));
  } else {
    await updateAsset(ctx, ownerId, asset.id, (a) => ({ ...a, analysis: { ...a.analysis, status: "listo", error: null } }));
  }
}

function estimateAnalysisSeconds(probe: MediaProbe): number {
  const minutes = (probe.duration ?? 60) / 60;
  return Math.round(10 + minutes * 36);
}

async function mustAsset(ctx: AppContext, ownerId: string, assetId: string): Promise<Asset> {
  const asset = await ctx.db.assets.get(ownerId, assetId);
  if (!asset) throw new UserFacingError("asset-no-encontrado", "Ese archivo ya no existe", 404);
  return asset;
}

/** Handler del trabajo "analizar": análisis completo (incluye A-roll/B-roll) y luego transcripción. */
export async function runAnalysisJob(ctx: AppContext, job: JobContext): Promise<{ result: Record<string, unknown> }> {
  const ownerId = job.job.ownerId;
  const assetId = String(job.job.input.assetId ?? "");
  let asset = await mustAsset(ctx, ownerId, assetId);
  const project = asset.projectId ? await ctx.db.projects.get(ownerId, asset.projectId) : null;
  const { services } = ctx;
  const filePath = await services.storage.localPath(asset.storageKey);

  await job.stage("analizando", 0.02, `Analizando «${asset.originalName}»`);
  asset = (await updateAsset(ctx, ownerId, asset.id, (a) => ({ ...a, analysis: { ...a.analysis, status: "analizando", error: null } }))) ?? asset;
  let analysis: AssetAnalysis;
  try {
    const raw = await services.media.analyze(
      {
        asset,
        filePath,
        probe: asset.probe,
        saveKeyframe: async (t, jpgPath) => {
          const key = keys.assetKeyframe(ownerId, asset.projectId, asset.id, t);
          await services.storage.putFile(key, jpgPath, { move: true });
          return key;
        },
      },
      { signal: job.signal, onProgress: (p, message) => void job.progress(0.02 + clamp(p) * 0.58, message) },
    );
    analysis = AssetAnalysis.parse({ ...raw, status: "listo", error: null });
  } catch (err) {
    job.throwIfAborted();
    const message = `No se pudo analizar «${asset.originalName}»: ${shortError(ctx, err)}`;
    await updateAsset(ctx, ownerId, asset.id, (a) => ({ ...a, analysis: { ...a.analysis, status: "error", error: message } }));
    throw new UserFacingError("analisis-fallido", message, 500);
  }
  asset = (await updateAsset(ctx, ownerId, asset.id, (a) => ({ ...a, analysis }))) ?? asset;
  const result: Record<string, unknown> = {
    assetId: asset.id,
    role: analysis.role,
    brollSegments: analysis.brollSegments.length,
    hasSpeech: analysis.hasSpeech,
  };

  if (asset.projectId && shouldTranscribe(asset, project)) {
    await job.stage("transcribiendo", 0.6, `Transcribiendo «${asset.originalName}»`);
    const transcript = await transcribeAsset(ctx, job, asset, project, 0.6);
    result.transcriptId = transcript.id;
    result.words = transcript.words.length;
  }
  return { result };
}

/** Handler del trabajo "transcribir" (volver a transcribir un archivo). */
export async function runTranscriptionJob(ctx: AppContext, job: JobContext): Promise<{ result: Record<string, unknown> }> {
  const ownerId = job.job.ownerId;
  const asset = await mustAsset(ctx, ownerId, String(job.job.input.assetId ?? ""));
  if (!asset.projectId) throw new UserFacingError("sin-proyecto", "Este archivo no pertenece a un proyecto", 409);
  const project = await ctx.db.projects.get(ownerId, asset.projectId);
  await job.stage("transcribiendo", 0.02, `Transcribiendo «${asset.originalName}»`);
  const transcript = await transcribeAsset(ctx, job, asset, project, 0.02);
  return { result: { assetId: asset.id, transcriptId: transcript.id, words: transcript.words.length } };
}

const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Transcribe un asset, aplica el glosario y guarda/actualiza su transcripción. */
export async function transcribeAsset(ctx: AppContext, job: JobContext, asset: Asset, project: Project | null, from: number): Promise<Transcript> {
  const ownerId = asset.ownerId;
  const projectId = asset.projectId!;
  const { services, db } = ctx;
  const scope = memoryScopeFor(project);
  const glossary = (await db.glossary.list(ownerId)).filter((e) => scopeMatches(e, scope));
  const settings = project?.settings.transcription;
  const now = nowIso();

  // Fila "transcribiendo" (se reutiliza la del asset si ya existía, para conservar el id).
  const existing = await db.transcripts.getByAsset(ownerId, asset.id);
  let transcript: Transcript;
  if (existing) {
    transcript = (await db.transcripts.update(ownerId, existing.id, { status: "transcribiendo", error: null }))!;
  } else {
    transcript = await db.transcripts.create(
      ownerId,
      Transcript.parse({
        id: newId("trn"),
        ownerId,
        projectId,
        assetId: asset.id,
        language: settings?.language && settings.language !== "auto" ? settings.language : "es",
        provider: services.transcriber.provider,
        model: services.transcriber.model,
        status: "transcribiendo",
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  ctx.events.emit(projectId, { type: "transcript.updated", transcript });

  try {
    const filePath = await services.storage.localPath(asset.storageKey);
    const raw = await services.transcriber.transcribe(filePath, {
      signal: job.signal,
      onProgress: (p, message) => void job.progress(from + clamp(p) * (0.98 - from), message),
      language: settings?.language ?? "auto",
      hotwords: glossary.map((g) => g.term),
      diarization: settings?.diarization ?? false,
    });
    const words = raw.words.map((w, i) => ({
      i,
      text: w.text,
      start: w.start,
      end: w.end,
      probability: clamp(w.probability),
      speaker: w.speaker ?? null,
      mark: null,
      original: null,
      filler: isFiller(w.text),
    }));
    const { words: fixed } = await ctx.memory.applyGlossary(ownerId, words, scope);
    const segments = raw.segments.map((s) => ({
      ...s,
      speaker: s.speaker ?? null,
      text: fixed.slice(s.firstWord, s.lastWord + 1).map((w) => w.text).join(" ") || s.text,
    }));
    transcript = (await db.transcripts.update(ownerId, transcript.id, {
      status: "listo",
      error: null,
      language: raw.language || transcript.language,
      provider: services.transcriber.provider,
      model: services.transcriber.model,
      words: fixed,
      segments,
    }))!;
    ctx.events.emit(projectId, { type: "transcript.updated", transcript });
    return transcript;
  } catch (err) {
    job.throwIfAborted();
    const message = `No se pudo transcribir «${asset.originalName}»: ${shortError(ctx, err)}`;
    const failed = await db.transcripts.update(ownerId, transcript.id, { status: "error", error: message });
    if (failed) ctx.events.emit(projectId, { type: "transcript.updated", transcript: failed });
    throw new UserFacingError("transcripcion-fallida", message, 500);
  }
}
