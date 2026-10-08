/**
 * Pipeline de punta a punta con servicios reales (ffmpeg, análisis, transcripción demo con los tiempos
 * que trae el a-roll de muestra) y el editor demo: subir → generar → V1 → corregir → exportar.
 * Sin red ni llaves.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Asset, Job, Project, Version } from "@autoeditor/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/env.js";
import { makeApp, type TestApp } from "./helpers.js";
import { createProject, ffprobe, getVersion, uploadFile, waitJob } from "./pipeline-helpers.js";

const SAMPLES = path.join(REPO_ROOT, "data/muestras");
const hasSamples = ["a-roll.mp4", "b-roll-1.mp4", "musica.m4a"].every((f) => existsSync(path.join(SAMPLES, f)));
const H = { "x-owner-id": "local" };

describe.skipIf(!hasSamples)("pipeline: generar de punta a punta", () => {
  let t: TestApp;
  let project: Project;
  let v1: Version;

  beforeAll(async () => {
    t = await makeApp({ env: { jobConcurrency: 1 } });
    project = await createProject(t, { instruction: { targetDuration: 15, durationMode: "exacta", format: "9:16", platform: "tiktok" } });
    await uploadFile(t, project.id, path.join(SAMPLES, "a-roll.mp4"), "clip-base");
    await uploadFile(t, project.id, path.join(SAMPLES, "b-roll-1.mp4"), "crudo-video");
    await uploadFile(t, project.id, path.join(SAMPLES, "musica.m4a"), "musica");
  }, 60_000);

  afterAll(async () => {
    await t?.close();
  });

  it("genera V1 reproducible (1080x1920, con audio y subtítulos) con la duración exacta pedida", async () => {
    const res = await t.app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/generate`, headers: H, payload: {} });
    expect(res.statusCode, res.body).toBe(202);
    const job = await waitJob(t, (res.json() as Job).id);
    expect(job.error, job.error ?? "").toBeNull();
    expect(job.status).toBe("listo");
    for (const stage of ["analizando", "transcribiendo", "planeando", "render", "revision-calidad"]) expect(Object.keys(job.stageTimings)).toContain(stage);
    v1 = await getVersion(t, String(job.result?.versionId));
    expect(v1.number).toBe(1);
    expect(v1.status).toBe("lista");
    expect(v1.recipe.target).toEqual({ duration: 15, mode: "exacta" });
    expect(Math.abs(v1.recipe.duration - 15)).toBeLessThanOrEqual(0.5);
    expect(v1.recipe.tracks.captions.words.length).toBeGreaterThan(5);
    expect(v1.captionsSrtKey).toBeTruthy();
    // El clip base es la columna del video.
    const base = (await t.app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/assets`, headers: H })).json().assets.find((a: Asset) => a.category === "clip-base") as Asset;
    expect(v1.recipe.tracks.video.filter((c) => c.assetId === base.id).length).toBeGreaterThan(0);

    const file = path.join(t.dataDir, "storage", v1.videoKey!);
    const local = existsSync(file) ? file : path.join(t.dataDir, v1.videoKey!);
    const info = ffprobe(local);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.hasAudio).toBe(true);
    expect(Math.abs(info.duration - v1.recipe.duration)).toBeLessThan(0.25);

    const p = (await t.app.inject({ method: "GET", url: `/api/v1/projects/${project.id}`, headers: H })).json() as { project?: Project } & Project;
    expect((p.project ?? p).currentVersionId).toBe(v1.id);

    // Se puede ver (Range) y descargar con nombre legible.
    const part = await t.app.inject({ method: "GET", url: `/api/v1/versions/${v1.id}/video`, headers: { ...H, range: "bytes=0-99" } });
    expect(part.statusCode).toBe(206);
    const dl = await t.app.inject({ method: "GET", url: `/api/v1/versions/${v1.id}/download?type=mp4`, headers: H });
    expect(dl.statusCode).toBe(200);
    expect(String(dl.headers["content-disposition"])).toMatch(/attachment;.*mi-video-de-prueba-v1\.mp4/i);
    const srt = await t.app.inject({ method: "GET", url: `/api/v1/versions/${v1.id}/download?type=srt`, headers: H });
    expect(srt.statusCode).toBe(200);
    expect(srt.body).toMatch(/00:00:0\d,\d{3} --> /);

    // El mapa del material quedó guardado para la interfaz.
    const mat = (await t.app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/material`, headers: H })).json();
    expect(mat.map.base).toBe("clip-base");
    expect(mat.map.summary.text).toMatch(/^1 clip · /);
    expect(mat.usedOrder).toEqual([base.id]);
  }, 300_000);

  it("corrige «cambia la tipografía por una más bonita» → V2 que solo cambia estilo/subtítulos/texto", async () => {
    expect(v1).toBeTruthy();
    const res = await t.app.inject({ method: "POST", url: `/api/v1/versions/${v1.id}/corrections`, headers: H, payload: { text: "cambia la tipografía por una más bonita" } });
    expect(res.statusCode, res.body).toBe(202);
    const job = await waitJob(t, (res.json() as Job).id);
    expect(job.error, job.error ?? "").toBeNull();
    expect(job.status).toBe("listo");
    expect(job.result?.question ?? null).toBeNull();
    const v2 = await getVersion(t, String(job.result?.versionId));
    expect(v2.number).toBe(2);
    expect(v2.parentId).toBe(v1.id);
    expect(v2.correction).toBe("cambia la tipografía por una más bonita");
    const direct = v2.changes.filter((c) => !c.derived);
    expect(direct.length).toBeGreaterThan(0);
    for (const c of direct) expect(["estilo", "subtitulos", "texto"]).toContain(c.area);
    // REGLA DE ORO: cortes, audio, b-roll y duración idénticos.
    expect(v2.recipe.tracks.video).toEqual(v1.recipe.tracks.video);
    expect(v2.recipe.tracks.overlays).toEqual(v1.recipe.tracks.overlays);
    expect(v2.recipe.tracks.audio).toEqual(v1.recipe.tracks.audio);
    expect(v2.recipe.duration).toBe(v1.recipe.duration);
    expect(v2.videoKey).toBeTruthy();
    const p = (await t.app.inject({ method: "GET", url: `/api/v1/projects/${project.id}`, headers: H })).json() as { project?: Project } & Project;
    expect((p.project ?? p).currentVersionId).toBe(v2.id);
  }, 300_000);

  it("exporta en 720p y vuelve a V1", async () => {
    const res = await t.app.inject({ method: "POST", url: `/api/v1/versions/${v1.id}/export`, headers: H, payload: { quality: "720" } });
    expect(res.statusCode, res.body).toBe(202);
    const job = await waitJob(t, (res.json() as Job).id);
    expect(job.error, job.error ?? "").toBeNull();
    const dl = await t.app.inject({ method: "GET", url: `/api/v1/versions/${v1.id}/download?type=mp4&quality=720`, headers: H });
    expect(dl.statusCode).toBe(200);
    expect(String(dl.headers["content-disposition"])).toMatch(/mi-video-de-prueba-v1-720p\.mp4/);
    const tmpFile = path.join(t.dataDir, "export-720.mp4");
    await writeFile(tmpFile, dl.rawPayload);
    const info = ffprobe(tmpFile);
    expect(info.width).toBe(720);
    expect(info.height).toBe(1280);
    expect((await getVersion(t, v1.id)).exported).toBe(true);

    const restored = await t.app.inject({ method: "POST", url: `/api/v1/versions/${v1.id}/restore`, headers: H });
    expect(restored.statusCode).toBe(200);
    expect((restored.json() as Project).currentVersionId).toBe(v1.id);
  }, 300_000);
});
