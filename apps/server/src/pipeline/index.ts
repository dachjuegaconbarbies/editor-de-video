/**
 * PIPELINE: orquestación de trabajos (análisis al subir, generar, plan, corregir, exportar).
 *
 * Implementación inicial (ola 1):
 *  - onAssetUploaded: probe + miniatura y trabajo "analizar" (análisis A/B-roll + transcripción).
 *  - retranscribe, detectKeywords y restoreVersion.
 *  - generate / approvePlan / revisePlan / correct / exportVersion → 501 hasta la ola 2.
 */
import { normalizeText } from "../memory/index.js";
import type { AppContext, PipelineApi } from "../context.js";
import type { Keyword } from "@autoeditor/shared";
import { UserFacingError, type KeywordInput } from "../services/types.js";
import { processUploadedAsset, runAnalysisJob, runTranscriptionJob } from "./assets.js";

export { updateAsset, memoryScopeFor, transcribeAsset } from "./assets.js";

const notYet = (): never => {
  throw new UserFacingError("no-implementado", "Esta función aún no está disponible", 501);
};

export function createPipeline(ctx: AppContext): PipelineApi {
  const { db, queue, services } = ctx;

  // Handlers de la cola que pertenecen a esta etapa.
  queue.registerHandler("analizar", (job) => runAnalysisJob(ctx, job), { replace: true });
  queue.registerHandler("transcribir", (job) => runTranscriptionJob(ctx, job), { replace: true });

  async function mustProject(ownerId: string, projectId: string) {
    const project = await db.projects.get(ownerId, projectId);
    if (!project) throw new UserFacingError("proyecto-no-encontrado", "No encontré ese proyecto", 404);
    return project;
  }

  return {
    async onAssetUploaded(ownerId, asset) {
      try {
        await processUploadedAsset(ctx, ownerId, asset);
      } catch (err) {
        // Nunca romper la subida: queda registrado en el asset.
        services.log.error({ err, assetId: asset.id }, "Falló el procesamiento inicial del archivo");
        const updated = await db.assets
          .update(ownerId, asset.id, (a) => ({ ...a, analysis: { ...a.analysis, status: "error", error: "No se pudo procesar este archivo. Intenta subirlo de nuevo." } }))
          .catch(() => null);
        if (updated) ctx.events.emit(updated.projectId, { type: "asset.updated", asset: updated });
      }
    },

    async retranscribe(ownerId, assetId) {
      const asset = await db.assets.get(ownerId, assetId);
      if (!asset) throw new UserFacingError("asset-no-encontrado", "No encontré ese archivo", 404);
      if (!asset.projectId) throw new UserFacingError("sin-proyecto", "Este archivo no pertenece a un proyecto", 409);
      if (asset.kind !== "video" && asset.kind !== "audio") throw new UserFacingError("sin-audio", "Este archivo no tiene audio para transcribir", 409);
      return queue.enqueue("transcribir", { assetId }, { ownerId, projectId: asset.projectId, estimatedSeconds: Math.round(((asset.probe.duration ?? 60) / 60) * 30) });
    },

    async detectKeywords(ownerId, projectId) {
      const project = await mustProject(ownerId, projectId);
      const transcripts = (await db.transcripts.list(ownerId, { projectId, status: "listo" })).filter((t) => t.words.length > 0);
      if (transcripts.length === 0) {
        throw new UserFacingError("sin-transcripcion", "Todavía no hay una transcripción lista para buscar palabras clave", 409);
      }
      const current = await db.keywords.get(ownerId, projectId);
      const input: KeywordInput = {
        transcripts,
        settings: project.settings,
        existing: current?.keywords ?? [],
        glossary: await db.glossary.list(ownerId),
      };
      let detected: Awaited<ReturnType<typeof services.editor.detectKeywords>>;
      try {
        detected = await services.editor.detectKeywords(input);
      } catch (err) {
        if (services.editor === services.demoEditor) throw unavailable(err);
        services.log.warn({ err }, "Falló la detección con el editor principal; uso el editor demo");
        try {
          detected = await services.demoEditor.detectKeywords(input);
        } catch (err2) {
          throw unavailable(err2);
        }
      }
      // Se conservan las que agregaste tú; las automáticas se reemplazan (sin duplicar textos).
      const userKeywords = (current?.keywords ?? []).filter((k) => k.source === "usuario");
      const seen = new Set(userKeywords.map((k) => normalizeText(k.text)));
      const merged: Keyword[] = [...userKeywords];
      for (const k of detected.keywords) {
        const key = normalizeText(k.text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(k);
      }
      const saved = await db.keywords.put(ownerId, projectId, merged, detected.publishCopy);
      ctx.events.emit(projectId, { type: "keywords.updated", keywords: saved.keywords });
      return { keywords: saved.keywords, publishCopy: saved.publishCopy };
    },

    generate: async () => notYet(),
    approvePlan: async () => notYet(),
    revisePlan: async () => notYet(),
    correct: async () => notYet(),
    exportVersion: async () => notYet(),

    async restoreVersion(ownerId, versionId) {
      const version = await db.versions.get(ownerId, versionId);
      if (!version) throw new UserFacingError("version-no-encontrada", "No encontré esa versión", 404);
      const project = await db.projects.update(ownerId, version.projectId, { currentVersionId: version.id });
      if (!project) throw new UserFacingError("proyecto-no-encontrado", "No encontré ese proyecto", 404);
      ctx.events.emit(project.id, { type: "project.updated", project });
      return project;
    },
  };
}

function unavailable(err: unknown): UserFacingError {
  if (err instanceof UserFacingError) return err;
  return new UserFacingError("no-disponible", "La detección de palabras clave aún no está disponible", 501);
}
