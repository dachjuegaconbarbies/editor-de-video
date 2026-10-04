import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AssetAnalysis, MediaProbe, type Asset } from "@autoeditor/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MediaAnalyzer, Transcriber } from "../src/services/types.js";
import { makeApp, makeTestVideo, multipartBody, waitFor, type TestApp } from "./helpers.js";

let t: TestApp | null = null;
let tmp: string;
let video: Buffer;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "autoeditor-video-"));
  const file = path.join(tmp, "clip de prueba.mp4");
  await makeTestVideo(file, 1);
  video = await readFile(file);
}, 60_000);

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

afterEach(async () => {
  await t?.close();
  t = null;
});

const JPG = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");

async function upload(app: TestApp, projectId: string, fields: Record<string, string> = { category: "crudo-video" }, filename = "clip de prueba.mp4", contentType = "video/mp4") {
  const mp = multipartBody(fields, { filename, contentType, data: video });
  return app.app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/assets`, headers: { "content-type": mp.contentType }, payload: mp.body });
}

describe("material: subida y descarga", () => {
  it("sube un mp4 en streaming, calcula sha256 y lo sirve con Range (206)", async () => {
    t = await makeApp();
    const p = (await t.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Subida" } })).json();
    const res = await upload(t, p.id);
    expect(res.statusCode).toBe(201);
    const asset = res.json() as Asset;
    expect(asset).toMatchObject({ kind: "video", category: "crudo-video", mimeType: "video/mp4", originalName: "clip de prueba.mp4", sizeBytes: video.length });
    expect(asset.sha256).toBe(createHash("sha256").update(video).digest("hex"));
    expect(asset.storageKey).toMatch(/^local\/prj_[a-z0-9]+\/assets\/ast_[a-z0-9]+\/clip-de-prueba\.mp4$/);

    // Completo
    const full = await t.app.inject({ method: "GET", url: `/api/v1/assets/${asset.id}/file` });
    expect(full.statusCode).toBe(200);
    expect(full.headers["accept-ranges"]).toBe("bytes");
    expect(full.headers["content-type"]).toBe("video/mp4");
    expect(full.rawPayload.length).toBe(video.length);

    // Parcial
    const part = await t.app.inject({ method: "GET", url: `/api/v1/assets/${asset.id}/file`, headers: { range: "bytes=10-109" } });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 10-109/${video.length}`);
    expect(part.headers["content-length"]).toBe("100");
    expect(Buffer.compare(part.rawPayload, video.subarray(10, 110))).toBe(0);

    // Sufijo y rango inválido
    const suffix = await t.app.inject({ method: "GET", url: `/api/v1/assets/${asset.id}/file`, headers: { range: "bytes=-50" } });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.rawPayload.length).toBe(50);
    const invalid = await t.app.inject({ method: "GET", url: `/api/v1/assets/${asset.id}/file`, headers: { range: `bytes=${video.length + 10}-` } });
    expect(invalid.statusCode).toBe(416);

    // Con los análisis aún sin implementar (stubs), la subida NO se rompe: el asset queda con error o pendiente.
    const settled = await waitFor(async () => {
      const a = (await t!.app.inject({ method: "GET", url: `/api/v1/projects/${p.id}/assets` })).json().assets[0] as Asset;
      // Con stubs: el probe falla → "error". Con el análisis real: el probe llena la duración.
      return a.analysis.status === "error" || a.probe.duration != null ? a : null;
    });
    expect(settled.analysis.status === "error" ? settled.analysis.error : "ok").toBeTruthy();

    // Editar y borrar
    const patched = await t.app.inject({ method: "PATCH", url: `/api/v1/assets/${asset.id}`, payload: { note: "abre con este", priority: "debe-aparecer", role: "b-roll" } });
    expect(patched.json()).toMatchObject({ note: "abre con este", priority: "debe-aparecer", analysis: { role: "b-roll" } });
    expect((await t.app.inject({ method: "DELETE", url: `/api/v1/assets/${asset.id}` })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: `/api/v1/assets/${asset.id}/file` })).statusCode).toBe(404);
    expect(await t.ctx.services.storage.exists(asset.storageKey)).toBe(false);
  });

  it("valida la subida: categoría inválida, sin archivo, otro dueño", async () => {
    t = await makeApp();
    const p = (await t.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Validación" } })).json();
    const bad = await upload(t, p.id, { category: "no-existe" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("categoria-invalida");
    const mp = multipartBody({ category: "crudo-video" });
    const noFile = await t.app.inject({ method: "POST", url: `/api/v1/projects/${p.id}/assets`, headers: { "content-type": mp.contentType }, payload: mp.body });
    expect(noFile.statusCode).toBe(400);
    const mp2 = multipartBody({ category: "crudo-video" }, { filename: "x.mp4", contentType: "video/mp4", data: video });
    const other = await t.app.inject({ method: "POST", url: `/api/v1/projects/${p.id}/assets`, headers: { "content-type": mp2.contentType, "x-owner-id": "otro" }, payload: mp2.body });
    expect(other.statusCode).toBe(404);
    // Sin category: se infiere por el tipo (octet-stream + .mov → video).
    const inferred = await upload(t, p.id, {}, "IMG_0001.MOV", "application/octet-stream");
    expect(inferred.statusCode).toBe(201);
    expect(inferred.json()).toMatchObject({ kind: "video", category: "crudo-video", mimeType: "video/quicktime" });
  });

  it("límite de tamaño → 413 y no deja archivos", async () => {
    t = await makeApp({ env: { maxUploadBytes: 1024 } });
    const p = (await t.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Grande" } })).json();
    const res = await upload(t, p.id);
    expect(res.statusCode).toBe(413);
    expect(res.json().message).toMatch(/límite/);
    const assets = (await t.app.inject({ method: "GET", url: `/api/v1/projects/${p.id}/assets` })).json().assets;
    expect(assets).toHaveLength(0);
  });
});

describe("pipeline al subir (con análisis y transcripción simulados)", () => {
  const fakeMedia: MediaAnalyzer = {
    available: async () => ({ ready: true, detail: "falso", version: "prueba" }),
    probe: async () => MediaProbe.parse({ duration: 1, width: 320, height: 240, fps: 30, hasAudio: true, hasVideo: true, videoCodec: "h264", audioCodec: "aac" }),
    thumbnail: async (_f, _p, out) => writeFile(out, JPG),
    frameAt: async (_f, _t, out) => writeFile(out, JPG),
    analyze: async () =>
      AssetAnalysis.parse({
        status: "listo",
        hasSpeech: true,
        role: "mixto",
        brollSegments: [{ start: 0.2, end: 0.8, score: 0.9, description: "detalle del producto", tags: ["producto"] }],
      }),
  };
  const fakeTranscriber: Transcriber = {
    provider: "falso",
    model: "prueba",
    available: async () => ({ ready: true, detail: "" }),
    transcribe: async () => ({
      language: "es",
      words: [
        { text: "Hola,", start: 0, end: 0.2, probability: 0.9 },
        { text: "soy", start: 0.2, end: 0.3, probability: 0.9 },
        { text: "sira", start: 0.3, end: 0.5, probability: 0.7 },
        { text: "y", start: 0.5, end: 0.6, probability: 0.9 },
        { text: "kafe.", start: 0.6, end: 0.8, probability: 0.6 },
        { text: "eh", start: 0.8, end: 0.9, probability: 0.9 },
      ],
      segments: [{ start: 0, end: 0.9, text: "Hola, soy sira y kafe. eh", firstWord: 0, lastWord: 5 }],
    }),
  };

  it("probe + miniatura + análisis A/B-roll + transcripción con glosario; corregir palabras alimenta el glosario", async () => {
    t = await makeApp({ services: { media: fakeMedia, transcriber: fakeTranscriber } });
    const app = t.app;
    // Glosario previo: "Sira" → "Zyra".
    const g = await app.inject({ method: "POST", url: "/api/v1/memory/glossary", payload: { term: "Zyra", variants: ["Sira"] } });
    expect(g.statusCode).toBe(201);
    const p = (await app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Pipeline" } })).json();
    const asset = (await upload(t, p.id)).json() as Asset;

    const analyzed = await waitFor(async () => {
      const a = (await app.inject({ method: "GET", url: `/api/v1/projects/${p.id}/assets` })).json().assets[0] as Asset;
      return a.analysis.status === "listo" && a.thumbnailKey ? a : null;
    }, 8000, "análisis listo");
    expect(analyzed.probe.duration).toBe(1);
    expect(analyzed.analysis.role).toBe("mixto");
    expect(analyzed.analysis.brollSegments).toHaveLength(1);

    const thumb = await app.inject({ method: "GET", url: `/api/v1/assets/${asset.id}/thumbnail` });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers["content-type"]).toBe("image/jpeg");
    const frame = await app.inject({ method: "GET", url: `/api/v1/assets/${asset.id}/frame?t=0.5&w=320` });
    expect(frame.statusCode).toBe(200);

    // Portada del proyecto = primera miniatura.
    const detail = (await app.inject({ method: "GET", url: `/api/v1/projects/${p.id}` })).json();
    expect(detail.project.thumbnailAssetId).toBe(asset.id);

    const transcript = await waitFor(async () => {
      const list = (await app.inject({ method: "GET", url: `/api/v1/projects/${p.id}/transcripts` })).json().transcripts;
      return list[0]?.status === "listo" ? list[0] : null;
    }, 8000, "transcripción");
    expect(transcript.words.map((w: { text: string }) => w.text)).toEqual(["Hola,", "soy", "Zyra", "y", "kafe.", "eh"]);
    expect(transcript.words[2].original).toBe("sira");
    expect(transcript.words[5].filler).toBe(true);

    // Corrijo "kafe." → "Café." y marco la muletilla para quitar.
    const edit = await app.inject({
      method: "PATCH",
      url: `/api/v1/transcripts/${transcript.id}/words`,
      payload: { edits: [{ i: 4, text: "Café." }, { i: 5, mark: "quitar" }] },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().words[4]).toMatchObject({ text: "Café.", original: "kafe." });
    expect(edit.json().words[5].mark).toBe("quitar");
    expect(edit.json().segments[0].text).toContain("Café.");
    const glossary = (await app.inject({ method: "GET", url: "/api/v1/memory/glossary" })).json().entries;
    expect(glossary.find((e: { term: string }) => e.term === "Café")).toMatchObject({ variants: ["kafe"] });

    // La siguiente transcripción ya lo escribe bien.
    const job = await app.inject({ method: "POST", url: `/api/v1/assets/${asset.id}/transcribe` });
    expect(job.statusCode).toBe(202);
    const redone = await waitFor(async () => {
      const j = (await app.inject({ method: "GET", url: `/api/v1/jobs/${job.json().id}` })).json();
      return j.status === "listo" ? j : null;
    }, 8000, "re-transcripción");
    expect(redone.result.transcriptId).toBe(transcript.id);
    const after = (await app.inject({ method: "GET", url: `/api/v1/projects/${p.id}/transcripts` })).json().transcripts[0];
    expect(after.words[4].text).toBe("Café.");

    // El estimado ya ve el b-roll detectado y el material analizado.
    const est = (await app.inject({ method: "POST", url: `/api/v1/projects/${p.id}/estimate` })).json();
    expect(est.material.brollSeconds).toBeCloseTo(0.6, 5);
    expect(est.material.aRollAssets).toBe(1);
    expect(est.material.unanalyzedMinutes).toBe(0);
    expect(est.material.speechMinutesPending).toBe(0);

    const metrics = (await app.inject({ method: "GET", url: "/api/v1/memory/metrics" })).json();
    expect(metrics.glossaryTerms).toBe(2);
  });
});
