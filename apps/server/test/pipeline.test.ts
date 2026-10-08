/**
 * Pipeline de punta a punta con servicios reales (ffmpeg, análisis, transcripción demo con los tiempos
 * que trae el a-roll de muestra) y el editor demo: subir → generar → V1 → corregir → exportar.
 * Sin red ni llaves.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Asset, Job, Project, Version } from "@autoeditor/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/env.js";
import { makeApp, multipartBody, waitFor, type TestApp } from "./helpers.js";

const SAMPLES = path.join(REPO_ROOT, "data/muestras");
const hasSamples = ["a-roll.mp4", "b-roll-1.mp4", "musica.m4a"].every((f) => existsSync(path.join(SAMPLES, f)));
const H = { "x-owner-id": "local" };

export function ffprobe(file: string): { duration: number; width: number; height: number; hasAudio: boolean } {
  const res = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file], { encoding: "utf8" });
  const j = JSON.parse(res.stdout) as { format: { duration: string }; streams: { codec_type: string; width?: number; height?: number }[] };
  const v = j.streams.find((s) => s.codec_type === "video");
  return { duration: Number(j.format.duration), width: v?.width ?? 0, height: v?.height ?? 0, hasAudio: j.streams.some((s) => s.codec_type === "audio") };
}

export async function uploadFile(t: TestApp, projectId: string, file: string, category: string, name = path.basename(file)): Promise<Asset> {
  const data = await readFile(file);
  const ext = path.extname(file).toLowerCase();
  const contentType = ext === ".mp4" ? "video/mp4" : ext === ".m4a" ? "audio/mp4" : ext === ".jpg" ? "image/jpeg" : ext === ".png" ? "image/png" : ext === ".txt" ? "text/plain" : "application/octet-stream";
  const mp = multipartBody({ category }, { filename: name, contentType, data });
  const res = await t.app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/assets`, headers: { ...H, "content-type": mp.contentType }, payload: mp.body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Asset;
}

export async function createProject(t: TestApp, settings: Record<string, unknown> = {}): Promise<Project> {
  const res = await t.app.inject({ method: "POST", url: "/api/v1/projects", headers: H, payload: { name: "Mi video de prueba", settings } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Project;
}

export async function waitJob(t: TestApp, jobId: string, timeoutMs = 240_000): Promise<Job> {
  return waitFor(
    async () => {
      const job = (await t.app.inject({ method: "GET", url: `/api/v1/jobs/${jobId}`, headers: H })).json() as Job;
      return job.status === "listo" || job.status === "error" || job.status === "cancelado" || job.status === "esperando" ? job : null;
    },
    timeoutMs,
    `el trabajo ${jobId}`,
  );
}

export async function getVersion(t: TestApp, id: string): Promise<Version> {
  return (await t.app.inject({ method: "GET", url: `/api/v1/versions/${id}`, headers: H })).json() as Version;
}

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
  }, 300_000);
});
