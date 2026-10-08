/** Utilidades de las pruebas del pipeline: subir muestras, crear proyecto, esperar trabajos, ffprobe. */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Asset, Job, Project, Version } from "@autoeditor/shared";
import { expect } from "vitest";
import { multipartBody, waitFor, type TestApp } from "./helpers.js";

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

