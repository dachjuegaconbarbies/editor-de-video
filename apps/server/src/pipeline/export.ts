/**
 * EXPORTAR una versión a 720 / 1080 / 2160 (con o sin subtítulos quemados) y dejar los subtítulos
 * sueltos listos. El video queda en `keys.versionExport` y se descarga con
 * GET /versions/:id/download?type=mp4&quality=<q>.
 */
import type { Job } from "@autoeditor/shared";
import type { AppContext, ExportInput } from "../context.js";
import type { JobContext, JobOutcome } from "../jobs/queue.js";
import { UserFacingError } from "../services/types.js";
import { keys } from "../storage/keys.js";
import { loadProjectData } from "./project-data.js";
import { renderVersionFiles } from "./render-version.js";

const ESTIMATE_FACTOR: Record<ExportInput["quality"], number> = { "720": 0.6, "1080": 1, "2160": 3.5 };

export async function startExport(ctx: AppContext, ownerId: string, versionId: string, body: ExportInput): Promise<Job> {
  const version = await ctx.db.versions.get(ownerId, versionId);
  if (!version) throw new UserFacingError("version-no-encontrada", "No encontré esa versión", 404);
  if (version.status !== "lista") throw new UserFacingError("version-no-lista", "Esa versión todavía no está lista para exportar", 409);
  return ctx.queue.enqueue(
    "exportar",
    { versionId, quality: body.quality, includeSrt: body.includeSrt, includeVtt: body.includeVtt, burnCaptions: body.burnCaptions },
    { ownerId, projectId: version.projectId, estimatedSeconds: Math.round(5 + version.recipe.duration * 1.2 * ESTIMATE_FACTOR[body.quality]) },
  );
}

export async function runExportJob(ctx: AppContext, job: JobContext): Promise<JobOutcome> {
  const { db, services } = ctx;
  const ownerId = job.job.ownerId;
  const versionId = String(job.job.input.versionId ?? "");
  const quality = String(job.job.input.quality ?? "1080") as ExportInput["quality"];
  const burnCaptions = job.job.input.burnCaptions !== false;
  const version = await db.versions.get(ownerId, versionId);
  if (!version) throw new UserFacingError("version-no-encontrada", "Esa versión ya no existe", 404);
  const project = await db.projects.get(ownerId, version.projectId);
  if (!project) throw new UserFacingError("proyecto-no-encontrado", "Ese proyecto ya no existe", 404);
  const captions = version.recipe.tracks.captions;
  const sameAsVersion = quality === "1080" && burnCaptions === (captions.enabled && captions.burnIn) && !!version.videoKey && (await services.storage.exists(version.videoKey));

  await job.stage("render", 0.05, `Exportando en ${quality}p`);
  const exportKey = keys.versionExport(ownerId, version.projectId, version.id, quality);
  if (sameAsVersion) {
    // El video de la versión ya está en 1080 con los mismos subtítulos: no hace falta volver a renderizar.
    await services.storage.delete(exportKey).catch(() => undefined);
  } else {
    const work = await services.storage.tempDir("exportar");
    try {
      const data = await loadProjectData(ctx, ownerId, project);
      await renderVersionFiles(
        ctx,
        job,
        { ownerId, projectId: project.id, versionId: version.id, recipe: version.recipe, assets: data.allAssets, workDir: work.path },
        { from: 0.05, to: 0.95, quality, outKey: exportKey, extras: false, burnCaptions },
      );
    } finally {
      await work.cleanup();
    }
  }
  job.throwIfAborted();
  const updated = await db.versions.update(ownerId, version.id, { exported: true });
  if (updated) ctx.events.emit(version.projectId, { type: "version.updated", version: updated });
  const base = `/api/v1/versions/${version.id}/download`;
  const hasCaptions = captions.enabled && captions.words.length > 0;
  return {
    message: `Exportado en ${quality}p`,
    result: {
      versionId: version.id,
      quality,
      burnCaptions,
      downloads: {
        mp4: `${base}?type=mp4&quality=${quality}`,
        ...(hasCaptions && job.job.input.includeSrt !== false ? { srt: `${base}?type=srt` } : {}),
        ...(hasCaptions && job.job.input.includeVtt !== false ? { vtt: `${base}?type=vtt` } : {}),
        copy: `${base}?type=copy`,
      },
    },
  };
}
