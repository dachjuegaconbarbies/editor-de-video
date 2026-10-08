/**
 * Piezas del pipeline sin render completo: regla de oro, motion graphics con caché (motor falso),
 * colocación de lo generado con IA y orden usado en la receta.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseRecipe, type Job, type MotionTemplate, type Recipe } from "@autoeditor/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMaterialMap } from "../src/ai/shared/material-map.js";
import type { JobContext } from "../src/jobs/queue.js";
import { factoryTemplates } from "../src/motion/index.js";
import { enforceGoldenRule } from "../src/pipeline/correct.js";
import { orderInRecipe, usedOrderReason } from "../src/pipeline/material.js";
import { placeAiResult, renderPendingGraphics } from "../src/pipeline/render-version.js";
import type { MotionEngine } from "../src/services/types.js";
import { makeToolbox } from "./ai-fixtures.js";
import { makeApp, type TestApp } from "./helpers.js";

function recipe(overAll: Record<string, unknown> = {}): Recipe {
  const { tracks: extraTracks, ...over } = overAll;
  return parseRecipe({
    format: { aspect: "9:16", width: 1080, height: 1920, fps: 30 },
    tracks: {
      video: [
        { id: "c1", assetId: "a1", sourceIn: 0, sourceOut: 4 },
        { id: "c2", assetId: "a2", sourceIn: 1, sourceOut: 3 },
      ],
      text: [{ id: "t1", kind: "titulo", text: "Tres trucos", start: 0.5, end: 2 }],
      ...((extraTracks as object) ?? {}),
    },
    ...over,
  });
}

function fakeJob(): JobContext {
  const job = { id: "job_x", ownerId: "local", projectId: null, type: "generar", status: "corriendo", input: {}, result: null } as unknown as Job;
  return {
    job,
    signal: new AbortController().signal,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    stage: async () => undefined,
    progress: async () => undefined,
    addCost: async () => undefined,
    setResult: async () => undefined,
    throwIfAborted: () => undefined,
  };
}

describe("regla de oro", () => {
  it("revierte lo que se sale de las áreas pedidas y conserva lo pedido", () => {
    const current = recipe();
    const candidate = structuredClone(current);
    candidate.style.titleFont = { ...candidate.style.titleFont, family: "Montserrat", googleFont: "Montserrat" };
    candidate.tracks.video[1]!.sourceOut = 2.5; // no se pidió
    const res = enforceGoldenRule(current, parseRecipe(candidate), ["estilo"], makeToolbox([]));
    expect(res.recipe.style.titleFont.family).toBe("Montserrat");
    expect(res.recipe.tracks.video).toEqual(current.tracks.video);
    expect(res.reverted.map((c) => c.area)).toEqual(["cortes"]);
    expect(res.changes.filter((c) => !c.derived).every((c) => c.area === "estilo")).toBe(true);
  });
});

describe("IA generativa y orden", () => {
  it("coloca una imagen de IA como overlay en su lugar y un SFX en su momento", () => {
    const r = recipe();
    const withImg = placeAiResult(r, { id: "ia1", kind: "imagen", provider: "kie", model: "m", prompt: "playa", negativePrompt: "", params: {}, seed: null, status: "listo", resultAssetId: null, error: null, costUsd: 0.01, usage: "broll", placeAt: { start: 1, end: 2.5 } }, "ast_img");
    expect(withImg.tracks.overlays).toEqual([expect.objectContaining({ id: "ia-ia1", kind: "ia-imagen", assetId: "ast_img", start: 1, end: 2.5, layout: "pantalla-completa" })]);
    const withSfx = placeAiResult(withImg, { ...withImg.ai[0]!, id: "ia2", kind: "sfx", usage: "sfx", placeAt: { start: 3, end: 3.5 } } as never, "ast_sfx");
    expect(withSfx.tracks.audio.sfx).toEqual([expect.objectContaining({ assetId: "ast_sfx", at: 3, origin: "ia" })]);
  });

  it("orden usado en la receta y su motivo", () => {
    const mk = (id: string, createdAt: string) => ({
      id, ownerId: "local", projectId: "p", category: "clip-base" as const, kind: "video" as const, originalName: `${id}.mp4`, mimeType: "video/mp4", sizeBytes: 1, storageKey: id,
      probe: { duration: 5, width: 1920, height: 1080, fps: 30, rotation: 0, videoCodec: null, audioCodec: null, hasAudio: true, hasVideo: true, variableFrameRate: false },
      analysis: { status: "listo" as const, error: null, scenes: [], silences: [], loudness: null, keyframes: [], faces: [], description: "", hasSpeech: true, role: "a-roll" as const, brollSegments: [] },
      thumbnailKey: null, priority: "opcional" as const, note: "", order: 0, sha256: null, createdAt,
    });
    const map = buildMaterialMap({ assets: [mk("a1", "2026-01-01T00:00:00Z"), mk("a2", "2026-01-01T00:00:01Z")], transcripts: [] });
    expect(orderInRecipe(recipe(), map)).toEqual(["a1", "a2"]);
    expect(usedOrderReason(map, ["a1", "a2"], "demo")).toBe(map.order.reason);
    expect(usedOrderReason(map, ["a2", "a1"], "claude")).toBe("orden narrativo elegido por Claude");
  });
});

describe("motion graphics con HyperFrames (motor falso)", () => {
  let t: TestApp;
  let calls = 0;
  let fail = false;
  const engine: MotionEngine = {
    id: "hyperframes",
    available: async () => ({ ready: true, detail: "falso" }),
    renderGraphic: async (input) => {
      calls++;
      if (fail) throw new Error("Chrome no arrancó");
      await writeFile(input.outPath, Buffer.from("no es un video real"));
      return { path: input.outPath, hasAlpha: true, seconds: 0.1 };
    },
    builtinTemplates: () => [],
  };

  beforeAll(async () => {
    t = await makeApp({ services: { motion: { hyperframes: engine, builtin: null, remotion: null } } });
  });
  afterAll(async () => {
    await t?.close();
  });

  it("dibuja lo pendiente una vez (caché), y si HyperFrames falla usa el motor integrado", async () => {
    const project = (await t.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Motion" } })).json() as { id: string };
    const templates: MotionTemplate[] = factoryTemplates("hyperframes");
    const tpl = templates[0]!;
    const r = recipe({ tracks: { graphics: [{ id: "g1", templateId: tpl.id, engine: "hyperframes", props: { text: "Hola" }, start: 1, end: 2.5 }] } });
    const workDir = path.join(t.dataDir, "trabajo");
    const input = { ownerId: "local", projectId: project.id, recipe: r, templates, workDir };
    const first = await renderPendingGraphics(t.ctx, fakeJob(), input, { from: 0, to: 1 });
    const id = first.recipe.tracks.graphics[0]!.renderedAssetId;
    expect(id).toBeTruthy();
    expect((await t.ctx.db.assets.get("local", id!))?.category).toBe("motion-render");
    const second = await renderPendingGraphics(t.ctx, fakeJob(), input, { from: 0, to: 1 });
    expect(second.recipe.tracks.graphics[0]!.renderedAssetId).toBe(id);
    expect(calls).toBe(1);

    fail = true;
    const other = recipe({ tracks: { graphics: [{ id: "g2", templateId: tpl.id, engine: "hyperframes", props: { text: "Otro" }, start: 1, end: 2 }] } });
    const res = await renderPendingGraphics(t.ctx, fakeJob(), { ...input, recipe: other }, { from: 0, to: 1 });
    expect(res.recipe.tracks.graphics[0]).toMatchObject({ engine: "builtin", renderedAssetId: null });
    expect(res.warnings[0]).toMatch(/motor integrado/);
  });
});
