import { Asset, AssetAnalysis, MediaProbe, ProjectSettings } from "@autoeditor/shared";
import { afterEach, describe, expect, it } from "vitest";
import { newId } from "../src/db/util.js";
import { makeApp, type TestApp } from "./helpers.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe("eventos en vivo (SSE)", () => {
  it("responde text/event-stream, manda ping y reenvía eventos del proyecto", async () => {
    t = await makeApp();
    const p = (await t.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "SSE" } })).json();
    await t.app.listen({ host: "127.0.0.1", port: 0 });
    const address = t.app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${p.id}/events`, {
      signal: controller.signal,
      headers: { origin: "http://localhost:5173" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (needle: string) => {
      const deadline = Date.now() + 3000;
      while (!text.includes(needle) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      return text.includes(needle);
    };
    expect(await readUntil('"type":"ping"')).toBe(true);
    // Un cambio en el proyecto llega por el stream.
    await t.app.inject({ method: "PATCH", url: `/api/v1/projects/${p.id}`, payload: { name: "SSE renombrado" } });
    expect(await readUntil('"type":"project.updated"')).toBe(true);
    expect(text).toContain("SSE renombrado");
    expect(t.ctx.events.listenerCount(p.id)).toBe(1);
    controller.abort();
    await reader.cancel().catch(() => undefined);
    // Al cerrar se limpian los oyentes.
    const deadline = Date.now() + 2000;
    while (t.ctx.events.listenerCount(p.id) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(t.ctx.events.listenerCount(p.id)).toBe(0);
  });

  it("acepta el dueño por ?owner= (EventSource no manda headers)", async () => {
    t = await makeApp();
    const p = (await t.app.inject({ method: "POST", url: "/api/v1/projects", headers: { "x-owner-id": "ana" }, payload: { name: "De Ana" } })).json();
    expect((await t.app.inject({ method: "GET", url: `/api/v1/projects/${p.id}` })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "GET", url: `/api/v1/projects/${p.id}?owner=ana` })).statusCode).toBe(200);
  });
});

describe("estimado de tiempo y costo", () => {
  async function addVideo(app: TestApp, projectId: string, seconds: number, analysis: Partial<AssetAnalysis> = {}) {
    const id = newId("ast");
    return app.ctx.db.assets.create(
      "local",
      Asset.parse({
        id,
        ownerId: "local",
        projectId,
        category: "crudo-video",
        kind: "video",
        originalName: `${id}.mp4`,
        mimeType: "video/mp4",
        sizeBytes: 1000,
        storageKey: `local/${projectId}/assets/${id}/v.mp4`,
        probe: MediaProbe.parse({ duration: seconds, hasAudio: true, hasVideo: true }),
        analysis: AssetAnalysis.parse({ status: "listo", hasSpeech: true, ...analysis }),
        createdAt: new Date().toISOString(),
      }),
    );
  }

  it("devuelve un rango con desglose y avisa si no hay material", async () => {
    t = await makeApp();
    const p = (await t.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Estimado" } })).json();
    const res = await t.app.inject({ method: "POST", url: `/api/v1/projects/${p.id}/estimate` });
    expect(res.statusCode).toBe(200);
    const est = res.json();
    expect(est.seconds.min).toBeGreaterThan(0);
    expect(est.seconds.max).toBeGreaterThan(est.seconds.min);
    expect(typeof est.label).toBe("string");
    expect(est.lines.length).toBeGreaterThan(0);
    expect(est.warnings.map((w: { code: string }) => w.code)).toContain("sin-material");
  });

  it("avisa si la duración pedida supera el material y si no hay b-roll", async () => {
    t = await makeApp();
    const p = (await t.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Duración" } })).json();
    await addVideo(t, p.id, 20, { role: "a-roll" });
    const settings = ProjectSettings.parse(p.settings);
    settings.instruction.targetDuration = 60;
    settings.instruction.durationMode = "exacta";
    settings.tools.broll.enabled = true;
    const est = (await t.app.inject({ method: "POST", url: `/api/v1/projects/${p.id}/estimate`, payload: { settings } })).json();
    const codes = est.warnings.map((w: { code: string }) => w.code);
    expect(codes).toContain("duracion-mayor-que-material");
    expect(codes).toContain("broll-sin-tomas");
    expect(est.material).toMatchObject({ availableSeconds: 20, brollSeconds: 0, aRollAssets: 1 });
    // El render se estima sobre la duración pedida.
    expect(est.lines.find((l: { stage: string }) => l.stage === "render").detail).toContain("60 s");

    // Con una toma de b-roll el aviso desaparece y el material sí alcanza para 30 s aproximados.
    await addVideo(t, p.id, 15, { role: "b-roll", hasSpeech: false });
    settings.instruction.targetDuration = 30;
    settings.instruction.durationMode = "aproximada";
    const est2 = (await t.app.inject({ method: "POST", url: `/api/v1/projects/${p.id}/estimate`, payload: { settings } })).json();
    const codes2 = est2.warnings.map((w: { code: string }) => w.code);
    expect(codes2).not.toContain("broll-sin-tomas");
    expect(codes2).not.toContain("duracion-mayor-que-material");
    expect(est2.material.brollSeconds).toBe(15);
    expect(est2.material.bRollAssets).toBe(1);
  });
});
