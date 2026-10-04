import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Job, type ServerEvent } from "@autoeditor/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteDb, type SqliteDb } from "../src/db/index.js";
import { EventBus } from "../src/events/bus.js";
import { JobQueue, RESTART_MESSAGE } from "../src/jobs/queue.js";
import { waitFor } from "./helpers.js";

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let db: SqliteDb;
let bus: EventBus;
let queue: JobQueue;
let events: ServerEvent[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "autoeditor-queue-"));
  db = createSqliteDb({ dataDir: dir });
  bus = new EventBus();
  events = [];
  // Proyecto real (las llaves foráneas lo exigen).
  const now = new Date().toISOString();
  await db.projects.create("ana", {
    id: "prj_test",
    ownerId: "ana",
    name: "Cola",
    settings: (await import("@autoeditor/shared")).defaultProjectSettings(),
    status: "borrador",
    currentVersionId: null,
    thumbnailAssetId: null,
    createdAt: now,
    updatedAt: now,
  });
  bus.subscribe("prj_test", (e) => events.push(e));
  queue = new JobQueue({ db, events: bus, log: silent, concurrency: 1, pollMs: 50 });
});

afterEach(async () => {
  await queue.stop({ timeoutMs: 500 });
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

const status = async (id: string) => (await db.jobs.get("ana", id))!;

describe("cola de trabajos", () => {
  it("pasa por etapas, mide tiempos, emite eventos y calibra", async () => {
    queue.registerHandler("re-render", async (ctx) => {
      await ctx.stage("planeando", 0.1, "Planeando");
      await sleep(60);
      await ctx.progress(0.3, "a medias");
      await ctx.stage("render", 0.5);
      await sleep(60);
      await ctx.addCost(0.25);
      return { result: { ok: true } };
    });
    await queue.start();
    const job = await queue.enqueue("re-render", { estimateLines: { planeando: 0.05, render: 0.05 } }, { ownerId: "ana", projectId: "prj_test", estimatedSeconds: 1 });
    expect(job.status).toBe("en-cola");
    const done = await waitFor(async () => ((await status(job.id)).status === "listo" ? status(job.id) : null), 5000, "listo");
    expect(done).toMatchObject({ status: "listo", stage: "listo", progress: 1, costUsd: 0.25, result: { ok: true }, attempts: 1 });
    expect(done.stageTimings.planeando).toBeGreaterThan(0.04);
    expect(done.stageTimings.render).toBeGreaterThan(0.04);
    expect(events.some((e) => e.type === "job.stage" && e.stage === "render")).toBe(true);
    expect(events.filter((e) => e.type === "job.updated").length).toBeGreaterThan(2);
    // Los tiempos reales alimentan la calibración del estimador.
    const cal = await db.calibration.get("ana");
    expect(cal.render?.samples).toBe(1);
    expect(cal.planeando?.factor).toBeGreaterThan(0);
    // También la del servidor (otro dueño nuevo la hereda).
    expect((await db.calibration.get("beto")).render?.samples).toBe(1);
  });

  it("se cancela (AbortController) y se reintenta", async () => {
    let attempts = 0;
    queue.registerHandler("exportar", async (ctx) => {
      attempts++;
      await ctx.stage("render", 0.2);
      if (attempts === 1) {
        // Primer intento: espera hasta que lo cancelen.
        await new Promise<void>((resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
          setTimeout(resolve, 5000);
        });
      }
      return { result: { attempt: attempts } };
    });
    await queue.start();
    const job = await queue.enqueue("exportar", {}, { ownerId: "ana", projectId: "prj_test" });
    await waitFor(async () => (await status(job.id)).stage === "render", 3000, "corriendo en render");
    const cancelled = await queue.cancel("ana", job.id);
    expect(cancelled.status).toBe("cancelado");
    await waitFor(() => queue.runningCount() === 0, 3000, "liberar el lugar");
    expect((await status(job.id)).status).toBe("cancelado");

    // Otro dueño no puede tocarlo.
    await expect(queue.retry("beto", job.id)).rejects.toMatchObject({ status: 404 });

    const retried = await queue.retry("ana", job.id);
    expect(retried.status).toBe("en-cola");
    const done = await waitFor(async () => ((await status(job.id)).status === "listo" ? status(job.id) : null), 3000, "listo tras reintento");
    expect(done.attempts).toBe(2);
    expect(done.result).toMatchObject({ attempt: 2 });
    // Un trabajo listo no se reintenta.
    await expect(queue.retry("ana", job.id)).rejects.toMatchObject({ status: 409 });
  });

  it("un error queda legible y reintentable", async () => {
    let n = 0;
    queue.registerHandler("corregir", async (ctx) => {
      n++;
      await ctx.stage("planeando", 0.1);
      if (n === 1) throw new Error("falló algo en /home/alguien/secreto/archivo.mp4");
      return {};
    });
    await queue.start();
    const job = await queue.enqueue("corregir", {}, { ownerId: "ana", projectId: "prj_test" });
    const failed = await waitFor(async () => ((await status(job.id)).status === "error" ? status(job.id) : null), 3000, "error");
    expect(failed.error).toMatch(/Planeando edición/);
    expect(failed.error).toMatch(/reintentar/);
    await queue.retry("ana", job.id);
    await waitFor(async () => (await status(job.id)).status === "listo", 3000, "listo");
  });

  it("puede quedar esperando (aprobación del plan) y reanudarse", async () => {
    queue.registerHandler("generar", async (ctx) => {
      if (!ctx.job.input.approved) {
        await ctx.stage("planeando", 0.2);
        await ctx.setResult({ planId: "pln_1" });
        return { status: "esperando", stage: "esperando-aprobacion", message: "Revisa el plan" };
      }
      await ctx.stage("render", 0.6);
      return { result: { rendered: true } };
    });
    await queue.start();
    const job = await queue.enqueue("generar", {}, { ownerId: "ana", projectId: "prj_test" });
    const waiting = await waitFor(async () => ((await status(job.id)).status === "esperando" ? status(job.id) : null), 3000, "esperando");
    expect(waiting).toMatchObject({ stage: "esperando-aprobacion", message: "Revisa el plan", result: { planId: "pln_1" } });
    // Un trabajo esperando cuenta como activo del proyecto.
    expect((await db.jobs.activeForProject("ana", "prj_test"))?.id).toBe(job.id);
    await queue.resume("ana", job.id, { approved: true });
    const done = await waitFor(async () => ((await status(job.id)).status === "listo" ? status(job.id) : null), 3000, "listo");
    expect(done.result).toMatchObject({ planId: "pln_1", rendered: true });
  });

  it("al arrancar, lo que estaba corriendo queda con error por reinicio", async () => {
    const now = new Date().toISOString();
    await db.jobs.create(
      "ana",
      Job.parse({ id: "job_viejo", ownerId: "ana", projectId: "prj_test", type: "generar", status: "corriendo", createdAt: now, startedAt: now }),
    );
    await queue.start();
    const job = await status("job_viejo");
    expect(job.status).toBe("error");
    expect(job.error).toBe(RESTART_MESSAGE);
  });

  it("respeta la concurrencia", async () => {
    let active = 0;
    let maxActive = 0;
    queue.registerHandler("analizar", async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(40);
      active--;
      return {};
    });
    await queue.start();
    const jobs = await Promise.all([1, 2, 3].map(() => queue.enqueue("analizar", {}, { ownerId: "ana", projectId: "prj_test" })));
    for (const j of jobs) await waitFor(async () => (await status(j.id)).status === "listo", 3000, "listo");
    expect(maxActive).toBe(1);
  });
});
