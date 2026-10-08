/**
 * Escenarios reales del "usuario solo sube" (servicios reales + editor demo, sin red ni llaves):
 *  - un clip base que mezcla a-roll + b-roll + a-roll (la columna usa solo lo hablado, una toma por frase);
 *  - una grabación larga sin cortar (el a-roll 3 veces seguidas: la misma frase dicha varias veces);
 *  - 3 clips base subidos al revés (se ordenan solos: por el guion subido como archivo o por lo que se dice);
 *  - plan para aprobar (ajustar con texto y aprobar) y cancelar a media generación.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Asset, Job, Plan, Project, Version } from "@autoeditor/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/env.js";
import { makeApp, waitFor, type TestApp } from "./helpers.js";
import { createProject, getVersion, uploadFile, waitJob } from "./pipeline-helpers.js";

const SAMPLES = path.join(REPO_ROOT, "data/muestras");
const hasSamples = ["a-roll.mp4", "b-roll-1.mp4", "guion.txt"].every((f) => existsSync(path.join(SAMPLES, f)));
const H = { "x-owner-id": "local" };

interface W {
  text: string;
  start: number;
  end: number;
  probability: number;
}

function probeJson(file: string): { duration: number; words: W[] } {
  const res = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:format_tags=comment", "-of", "json", file], { encoding: "utf8" });
  const j = JSON.parse(res.stdout) as { format: { duration: string; tags?: { comment?: string } } };
  const words = j.format.tags?.comment ? ((JSON.parse(j.format.tags.comment) as { words: W[] }).words ?? []) : [];
  return { duration: Number(j.format.duration), words };
}

function ffmpeg(args: string[]): void {
  const res = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`ffmpeg falló: ${res.stderr}`);
}

const comment = (words: W[]) => JSON.stringify({ language: "es", source: "prueba", words: words.map((w) => ({ ...w, start: Math.round(w.start * 1000) / 1000, end: Math.round(w.end * 1000) / 1000 })) });
const shift = (words: W[], dt: number) => words.map((w) => ({ ...w, start: w.start + dt, end: w.end + dt }));
const V = "scale=640:360,fps=30,format=yuv420p,setsar=1";
const ENC = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-c:a", "aac", "-ar", "48000", "-ac", "1"];

/** a-roll (voz) + b-roll mudo + a-roll. */
function makeMixed(out: string, aroll: string, broll: string, a: { duration: number; words: W[] }, brollDur: number): W[] {
  const words = [...a.words, ...shift(a.words, a.duration + brollDur)];
  ffmpeg([
    "-i", aroll, "-i", broll, "-f", "lavfi", "-t", String(brollDur), "-i", "anullsrc=r=48000:cl=mono",
    "-filter_complex",
    `[0:v]${V},split=2[v0][v2];[0:a]aformat=sample_rates=48000:channel_layouts=mono,asplit=2[a0][a2];[1:v]${V},trim=0:${brollDur},setpts=PTS-STARTPTS[v1];[2:a]aformat=sample_rates=48000:channel_layouts=mono[a1];[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v][a]`,
    "-map", "[v]", "-map", "[a]", ...ENC, "-metadata", `comment=${comment(words)}`, out,
  ]);
  return words;
}

/** El a-roll N veces seguidas (la misma frase dicha varias veces). */
function makeRepeated(out: string, aroll: string, a: { duration: number; words: W[] }, n: number): W[] {
  const words = Array.from({ length: n }, (_, k) => shift(a.words, a.duration * k)).flat();
  const chains = Array.from({ length: n }, (_, k) => `[v${k}][a${k}]`).join("");
  ffmpeg([
    "-i", aroll, "-filter_complex",
    `[0:v]${V},split=${n}${Array.from({ length: n }, (_, k) => `[v${k}]`).join("")};[0:a]aformat=sample_rates=48000:channel_layouts=mono,asplit=${n}${Array.from({ length: n }, (_, k) => `[a${k}]`).join("")};${chains}concat=n=${n}:v=1:a=1[v][a]`,
    "-map", "[v]", "-map", "[a]", ...ENC, "-metadata", `comment=${comment(words)}`, out,
  ]);
  return words;
}

/** Un tramo del a-roll (con sus palabras llevadas a 0). */
function makePart(out: string, aroll: string, a: { words: W[] }, from: number, to: number): void {
  const words = shift(a.words.filter((w) => w.start >= from && w.start < to), -from);
  ffmpeg(["-ss", String(from), "-to", String(to), "-i", aroll, "-vf", V, ...ENC, "-metadata", `comment=${comment(words)}`, out]);
}

async function waitAnalyzed(t: TestApp, projectId: string): Promise<Asset[]> {
  return waitFor(
    async () => {
      const assets = (await t.app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/assets`, headers: H })).json().assets as Asset[];
      const jobs = (await t.app.inject({ method: "GET", url: `/api/v1/projects/${projectId}`, headers: H })).json() as { activeJob?: Job | null };
      return assets.every((a) => a.analysis.status === "listo" || a.analysis.status === "error") && !jobs.activeJob ? assets : null;
    },
    180_000,
    "el análisis del material",
  );
}

async function generate(t: TestApp, projectId: string): Promise<Job> {
  const res = await t.app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/generate`, headers: H, payload: {} });
  expect(res.statusCode, res.body).toBe(202);
  return res.json() as Job;
}

const firstSeen = (v: Version) => {
  const seen: string[] = [];
  for (const c of v.recipe.tracks.video) if (!seen.includes(c.assetId)) seen.push(c.assetId);
  return seen;
};

describe.skipIf(!hasSamples)("pipeline: el usuario solo sube (escenarios reales)", () => {
  let t: TestApp;
  let tmp: string;
  let aroll: { duration: number; words: W[] };
  const files = { mixed: "", long: "", p1: "", p2: "", p3: "" };
  const BROLL = 8;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "autoeditor-escenarios-"));
    const src = path.join(SAMPLES, "a-roll.mp4");
    aroll = probeJson(src);
    files.mixed = path.join(tmp, "grabacion-mixta.mp4");
    makeMixed(files.mixed, src, path.join(SAMPLES, "b-roll-1.mp4"), aroll, BROLL);
    files.long = path.join(tmp, "grabacion-larga.mp4");
    makeRepeated(files.long, src, aroll, 3);
    files.p1 = path.join(tmp, "p1.mp4");
    files.p2 = path.join(tmp, "p2.mp4");
    files.p3 = path.join(tmp, "p3.mp4");
    makePart(files.p1, src, aroll, 0, 13);
    makePart(files.p2, src, aroll, 13, 17.9);
    makePart(files.p3, src, aroll, 17.9, aroll.duration);
    t = await makeApp({ env: { jobConcurrency: 1 } });
  }, 120_000);

  afterAll(async () => {
    await t?.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("clip base mixto (a-roll + b-roll + a-roll): columna con lo hablado, b-roll del propio clip de apoyo", async () => {
    const project = await createProject(t, { tools: { broll: { enabled: true, source: "material", frequency: "alta", layout: "auto" }, music: { enabled: false } } });
    const clip = await uploadFile(t, project.id, files.mixed, "clip-base");
    const job = await waitJob(t, (await generate(t, project.id)).id);
    expect(job.error, job.error ?? "").toBeNull();
    const v1 = await getVersion(t, String(job.result?.versionId));
    const brollFrom = aroll.duration + 0.3;
    const brollTo = aroll.duration + BROLL - 0.3;
    // Nunca un tramo del b-roll mudo en la columna.
    for (const c of v1.recipe.tracks.video.filter((x) => x.assetId === clip.id)) expect(c.sourceOut <= brollFrom || c.sourceIn >= brollTo).toBe(true);
    // Lo hablado está, una sola vez por frase (la toma repetida se descartó).
    const said = v1.recipe.tracks.captions.words.map((w) => w.text).join(" ");
    for (const phrase of ["Hola", "Primero", "Segundo", "tercero", "Síguenos"]) expect(said.match(new RegExp(phrase, "g"))?.length ?? 0).toBe(1);
    const mat = (await t.app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/material`, headers: H })).json();
    expect(mat.map.summary.repeatedTakes).toBeGreaterThan(0);
    const insideBroll = mat.map.fragments.filter((f: { kind: string; start: number; end: number }) => f.kind === "b-roll" && f.start >= aroll.duration - 0.5 && f.end <= aroll.duration + BROLL + 0.5);
    // El análisis detectó el b-roll dentro del clip y se usa como apoyo sobre lo que se dice.
    expect(insideBroll.length).toBeGreaterThan(0);
    expect(v1.recipe.tracks.overlays.some((o) => o.assetId === clip.id && o.sourceIn >= aroll.duration - 0.5 && o.sourceIn < aroll.duration + BROLL)).toBe(true);
  }, 400_000);

  it("grabación larga con tomas repetidas: queda una toma por frase y dura como una sola pasada", async () => {
    const project = await createProject(t, { tools: { music: { enabled: false } } });
    await uploadFile(t, project.id, files.long, "clip-base");
    const job = await waitJob(t, (await generate(t, project.id)).id);
    expect(job.error, job.error ?? "").toBeNull();
    const v1 = await getVersion(t, String(job.result?.versionId));
    const said = v1.recipe.tracks.captions.words.map((w) => w.text).join(" ");
    expect(said.match(/Síguenos/g)?.length ?? 0).toBe(1);
    expect(said.match(/Hola/g)?.length ?? 0).toBe(1);
    expect(v1.recipe.duration).toBeLessThan(aroll.duration + 1);
    expect(v1.recipe.duration).toBeGreaterThan(10);
    expect(v1.changeSummary).toMatch(/toma\(s\) repetida\(s\)/);
    const mat = (await t.app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/material`, headers: H })).json();
    expect(mat.map.takes.length).toBeGreaterThanOrEqual(5);
    expect(mat.map.summary.text).toMatch(/1 clip · \d+ tomas repetidas/);
  }, 400_000);

  it("3 clips base subidos al revés: se ordenan solos (por el guion subido o por lo que se dice)", async () => {
    // Sin guion: por el sentido de lo que se dice.
    const a = await createProject(t, { tools: { music: { enabled: false }, broll: { enabled: false } } });
    const up = async (projectId: string) => {
      const c = await uploadFile(t, projectId, files.p3, "clip-base", "toma-c.mp4");
      const b = await uploadFile(t, projectId, files.p2, "clip-base", "toma-b.mp4");
      const first = await uploadFile(t, projectId, files.p1, "clip-base", "toma-a.mp4");
      return { first, b, c };
    };
    const ids = await up(a.id);
    await waitAnalyzed(t, a.id);
    const mat = (await t.app.inject({ method: "GET", url: `/api/v1/projects/${a.id}/material`, headers: H })).json();
    expect(mat.map.order.assetIds).toEqual([ids.first.id, ids.b.id, ids.c.id]);
    expect(mat.map.order.source).toBe("contenido");
    expect(mat.map.clips.map((c: { orderReason: string }) => c.orderReason).join(" ")).toMatch(/saludo/);

    // Con el guion subido como archivo (el usuario solo sube): «según el guion», y la V1 sale en orden.
    const b = await createProject(t, { tools: { music: { enabled: false }, broll: { enabled: false } } });
    const ids2 = await up(b.id);
    await uploadFile(t, b.id, path.join(SAMPLES, "guion.txt"), "guion");
    await waitAnalyzed(t, b.id);
    const mat2 = (await t.app.inject({ method: "GET", url: `/api/v1/projects/${b.id}/material`, headers: H })).json();
    expect(mat2.map.order).toMatchObject({ assetIds: [ids2.first.id, ids2.b.id, ids2.c.id], source: "guion", reason: "según el guion" });
    const job = await waitJob(t, (await generate(t, b.id)).id);
    expect(job.error, job.error ?? "").toBeNull();
    const v1 = await getVersion(t, String(job.result?.versionId));
    expect(firstSeen(v1)).toEqual([ids2.first.id, ids2.b.id, ids2.c.id]);
    expect(job.result?.material).toMatchObject({ orderReason: "según el guion" });
  }, 400_000);

  it("plan para aprobar: ajustar con texto y aprobar → V1", async () => {
    const project = await createProject(t, { instruction: { reviewPlan: true }, tools: { music: { enabled: false }, broll: { enabled: false } } });
    await uploadFile(t, project.id, files.p1, "clip-base", "intro.mp4");
    const job = await waitJob(t, (await generate(t, project.id)).id);
    expect(job.status).toBe("esperando");
    expect(job.stage).toBe("esperando-aprobacion");
    const planId = String(job.result?.planId);
    const plan = (await t.app.inject({ method: "GET", url: `/api/v1/plans/${planId}`, headers: H })).json() as Plan;
    expect(plan.status).toBe("pendiente");
    expect(plan.recipe.tracks.video.length).toBeGreaterThan(0);

    const rev = await t.app.inject({ method: "POST", url: `/api/v1/plans/${planId}/revise`, headers: H, payload: { feedback: "cambia la tipografía por una más bonita" } });
    expect(rev.statusCode, rev.body).toBe(202);
    const afterRevise = await waitFor(async () => {
      const j = (await t.app.inject({ method: "GET", url: `/api/v1/jobs/${job.id}`, headers: H })).json() as Job;
      const p = (await t.app.inject({ method: "GET", url: `/api/v1/plans/${planId}`, headers: H })).json() as Plan;
      return j.status === "esperando" && p.status === "pendiente" ? p : j.status === "error" ? (() => { throw new Error(j.error ?? "error"); })() : null;
    }, 120_000, "el plan ajustado");
    expect(afterRevise.feedback).toHaveLength(1);

    const ok = await t.app.inject({ method: "POST", url: `/api/v1/plans/${planId}/approve`, headers: H });
    expect(ok.statusCode, ok.body).toBe(202);
    const done = await waitJob(t, job.id);
    expect(done.error, done.error ?? "").toBeNull();
    expect(done.status).toBe("listo");
    const v1 = await getVersion(t, String(done.result?.versionId));
    expect(v1.recipe.tracks.video).toEqual(afterRevise.recipe.tracks.video);
  }, 400_000);

  it("cancelar a media generación: sin versión nueva y el proyecto vuelve a su estado", async () => {
    const project = await createProject(t, { tools: { music: { enabled: false } } });
    await uploadFile(t, project.id, files.p1, "clip-base");
    const job = await generate(t, project.id);
    await waitFor(async () => {
      const j = (await t.app.inject({ method: "GET", url: `/api/v1/jobs/${job.id}`, headers: H })).json() as Job;
      return j.stage === "planeando" || j.stage === "render" || j.status !== "en-cola" && j.status !== "corriendo" ? j : null;
    }, 120_000, "que la generación avance");
    const cancelled = await t.app.inject({ method: "POST", url: `/api/v1/jobs/${job.id}/cancel`, headers: H });
    expect(cancelled.statusCode).toBe(200);
    const fin = await waitJob(t, job.id);
    expect(fin.status).toBe("cancelado");
    const versions = (await t.app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/versions`, headers: H })).json().versions as Version[];
    expect(versions).toHaveLength(0);
    const p = await waitFor(async () => {
      const r = (await t.app.inject({ method: "GET", url: `/api/v1/projects/${project.id}`, headers: H })).json() as { project?: Project } & Project;
      const pr = r.project ?? r;
      return pr.status !== "procesando" ? pr : null;
    }, 30_000, "que el proyecto deje de procesar");
    expect(p.status).toBe("borrador");
  }, 300_000);
});
