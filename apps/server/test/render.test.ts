/**
 * Render receta → mp4 con el material de muestra real (data/muestras). Sin red ni llaves.
 * Si falta el material: node scripts/generar-material-prueba.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseRecipe, type Recipe } from "@autoeditor/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";
import { createRenderer } from "../src/render/index.js";
import { planTimeline, planWindow, segmentWindows } from "../src/render/timeline.js";
import type { Renderer } from "../src/services/types.js";
import { hasSamples, quietLog, sampleContext, sampleRecipe } from "./render-fixtures.js";

function probe(file: string): { duration: number; streams: { codec_type: string; width?: number; height?: number; pix_fmt?: string; nb_frames?: string }[] } {
  const r = spawnSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { encoding: "utf8" });
  const j = JSON.parse(r.stdout) as { format: { duration: string }; streams: { codec_type: string; width?: number; height?: number; pix_fmt?: string; nb_frames?: string }[] };
  return { duration: Number(j.format.duration), streams: j.streams };
}

/** MD5 de los fotogramas de video decodificados (no del contenedor). */
function videoMd5(file: string): string {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v", "-f", "md5", "-"], { encoding: "utf8" });
  return r.stdout.trim();
}

/** Fracción de píxeles "amarillo píldora" (#FBE88A ± tolerancia) en una zona del JPG. */
function yellowFraction(jpg: string, crop: string): number {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", jpg, "-vf", `crop=${crop}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 * 1024 * 1024 });
  const buf = r.stdout as Buffer;
  let hit = 0;
  for (let i = 0; i + 2 < buf.length; i += 3) if (buf[i]! > 215 && buf[i + 1]! > 195 && buf[i + 2]! > 90 && buf[i + 2]! < 190) hit++;
  return hit / (buf.length / 3);
}

describe("plan de la línea de tiempo (fotogramas)", () => {
  const recipe = parseRecipe({
    format: { aspect: "9:16", width: 1080, height: 1920, fps: 30 },
    tracks: {
      video: [
        { id: "a", assetId: "x", sourceIn: 0, sourceOut: 2 },
        { id: "b", assetId: "x", sourceIn: 2, sourceOut: 4, transitionIn: { type: "fundido", duration: 0.5 } },
        { id: "c", assetId: "x", sourceIn: 4, sourceOut: 5.5 },
      ],
    },
  });

  it("encadena clips con traslape exacto y duración total en fotogramas", () => {
    const plan = planTimeline(recipe);
    expect(plan.spans.map((s) => [s.startFrame, s.endFrame, s.overlapFrames])).toEqual([
      [0, 60, 0],
      [45, 105, 15],
      [105, 150, 0],
    ]);
    expect(plan.totalFrames).toBe(Math.round(recipe.duration * 30));
  });

  it("una ventana que cae en una transición se amplía para cubrirla completa", () => {
    const plan = planTimeline(recipe);
    const w = planWindow(plan, 50, 51);
    expect([w.start, w.end]).toEqual([45, 60]);
    expect(w.pieces.map((p) => p.span.clip.id)).toEqual(["a", "b"]);
    expect(w.pieces[1]!.overlapFrames).toBe(15);
    const w2 = planWindow(plan, 110, 111);
    expect([w2.start, w2.end, w2.pieces.length, w2.pieces[0]!.headFrames]).toEqual([110, 111, 1, 5]);
  });

  it("segmenta videos largos prefiriendo cortes secos", () => {
    const many = parseRecipe({
      format: { aspect: "9:16", width: 1080, height: 1920, fps: 30 },
      tracks: { video: Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, assetId: "x", sourceIn: 0, sourceOut: 1, transitionIn: i % 3 === 1 ? { type: "fundido" as const, duration: 0.2 } : { type: "corte" as const, duration: 0 } })) },
    });
    const plan = planTimeline(many);
    const segs = segmentWindows(plan, 12);
    expect(segs.length).toBeGreaterThan(1);
    expect(segs[0]![0]).toBe(0);
    expect(segs[segs.length - 1]![1]).toBe(plan.totalFrames);
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i]![0]).toBe(segs[i - 1]![1]);
      const span = plan.spans.find((s) => s.startFrame === segs[i]![0]);
      expect(span?.overlapFrames).toBe(0);
    }
  });
});

describe.skipIf(!hasSamples())("render con el material de muestra", () => {
  let tmp: string;
  let renderer: Renderer;
  let recipe: Recipe;
  const outs: string[] = [];
  const times: { what: string; renderSeconds: number; duration: number }[] = [];

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "autoeditor-render-"));
    renderer = createRenderer({ env: loadEnv({ dataDir: path.join(tmp, "data") }), log: quietLog });
    recipe = sampleRecipe();
  });
  afterAll(async () => {
    // eslint-disable-next-line no-console
    for (const t of times) console.info(`[render] ${t.what}: ${t.renderSeconds.toFixed(1)} s para ${t.duration.toFixed(1)} s de video → ${(t.renderSeconds / t.duration).toFixed(2)} s por segundo`);
    await rm(tmp, { recursive: true, force: true });
  });

  it("ffmpeg tiene lo necesario", async () => {
    const a = await renderer.available();
    expect(a.ready, a.detail).toBe(true);
  });

  it("render completo a 9:16 1080p: dura recipe.duration, mide 1080x1920 y tiene audio", async () => {
    const out = path.join(tmp, "v1.mp4");
    const res = await renderer.render(recipe, sampleContext(path.join(tmp, "work")), { outPath: out, quality: "1080", burnCaptions: true });
    outs.push(out);
    times.push({ what: "receta de muestra 1080x1920", renderSeconds: res.renderSeconds, duration: res.durationSeconds });
    expect(existsSync(out)).toBe(true);
    const p = probe(out);
    expect(Math.abs(p.duration - recipe.duration)).toBeLessThanOrEqual(0.1);
    const v = p.streams.find((s) => s.codec_type === "video")!;
    expect([v.width, v.height, v.pix_fmt]).toEqual([1080, 1920, "yuv420p"]);
    expect(p.streams.some((s) => s.codec_type === "audio")).toBe(true);
    expect(res.commands.length).toBeGreaterThanOrEqual(3);
    // Sonoridad cerca del objetivo (−14 LUFS ± 1.5).
    const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", out, "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" });
    const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(r.stderr.split("Summary:").pop() ?? "")?.[1]);
    expect(Math.abs(lufs - recipe.tracks.audio.mix.targetLufs)).toBeLessThanOrEqual(1.5);
  }, 300_000);

  it("es determinista: dos renders de la misma receta dan los mismos fotogramas", async () => {
    const out = path.join(tmp, "v1-bis.mp4");
    await renderer.render(recipe, sampleContext(path.join(tmp, "work2")), { outPath: out, quality: "1080", burnCaptions: true });
    expect(videoMd5(out)).toBe(videoMd5(outs[0]!));
  }, 300_000);

  it("renderFrame produce un JPG con el gráfico builtin superpuesto (alfa)", async () => {
    const jpg = path.join(tmp, "f.jpg");
    // 10.2 s: b-roll con zoom + gráfico "palabra-clave-pop" generado al vuelo por el motor builtin.
    await renderer.renderFrame(recipe, sampleContext(path.join(tmp, "work")), 10.2, jpg, { width: 540 });
    const p = probe(jpg);
    expect(p.streams[0]!.width).toBe(540);
    expect(p.streams[0]!.height).toBe(960);
    // La píldora amarilla ocupa el centro; si el alfa se perdiera, el cuadro saldría negro.
    expect(yellowFraction(jpg, "160:50:190:455")).toBeGreaterThan(0.3);
    expect(yellowFraction(jpg, "540:200:0:0")).toBeLessThan(0.05);
  }, 120_000);

  it("poster saca la portada del video renderizado", async () => {
    const jpg = path.join(tmp, "portada.jpg");
    await renderer.poster(outs[0]!, jpg, 1);
    const p = probe(jpg);
    expect([p.streams[0]!.width, p.streams[0]!.height]).toEqual([1080, 1920]);
  }, 60_000);

  it("captionFiles devuelve SRT, VTT y texto válidos", () => {
    const f = renderer.captionFiles(recipe);
    expect(f.srt).toMatch(/^1\n00:00:00,\d{3} --> 00:00:\d{2},\d{3}\n/);
    expect(f.srt).toContain("TRUCOS");
    expect(f.vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(f.txt).toContain("Hola, soy Ana de Zyra.");
  });

  it("funciona con 1 clip (sin audio, foto) y con 20+ clips (por segmentos)", async () => {
    const one = parseRecipe({ format: { aspect: "1:1", width: 1080, height: 1080, fps: 25 }, tracks: { video: [{ id: "f", assetId: "foto", sourceIn: 0, sourceOut: 0, stillDuration: 2 }] } });
    const o1 = path.join(tmp, "uno.mp4");
    const r1 = await renderer.render(one, sampleContext(path.join(tmp, "work")), { outPath: o1, quality: "720", burnCaptions: false });
    const p1 = probe(o1);
    expect(Math.abs(p1.duration - 2)).toBeLessThanOrEqual(0.1);
    expect(p1.streams.find((s) => s.codec_type === "video")!.width).toBe(720);
    expect(r1.durationSeconds).toBeCloseTo(2, 2);

    const assets = ["aroll", "broll1", "broll2"];
    const many = parseRecipe({
      format: { aspect: "16:9", width: 1920, height: 1080, fps: 30, platform: "youtube" },
      tracks: {
        video: Array.from({ length: 22 }, (_, i) => ({
          id: `c${i}`,
          assetId: assets[i % 3]!,
          sourceIn: (i * 0.37) % 4,
          sourceOut: ((i * 0.37) % 4) + 0.6,
          reframe: { mode: i % 4 === 0 ? ("fondo-desenfocado" as const) : ("llenar" as const), focusX: 0.5, focusY: 0.5, keyframes: [] },
          transitionIn: i % 5 === 2 ? { type: "deslizar-izq" as const, duration: 0.2 } : { type: "corte" as const, duration: 0 },
        })),
        text: [{ id: "t", kind: "etiqueta", text: "Prueba de segmentos", start: 1, end: 12 }],
        audio: { music: [{ id: "m", assetId: "musica", start: 0, gainDb: -18, duck: false }] },
      },
    });
    const o2 = path.join(tmp, "muchos.mp4");
    const r2 = await renderer.render(many, sampleContext(path.join(tmp, "work")), { outPath: o2, quality: "720", burnCaptions: false });
    times.push({ what: "22 clips 16:9 720p (segmentos)", renderSeconds: r2.renderSeconds, duration: r2.durationSeconds });
    const p2 = probe(o2);
    expect(Math.abs(p2.duration - many.duration)).toBeLessThanOrEqual(0.1);
    const v2 = p2.streams.find((s) => s.codec_type === "video")!;
    expect([v2.width, v2.height]).toEqual([1280, 720]);
    expect(Number(v2.nb_frames)).toBe(Math.round(many.duration * 30));
    expect(r2.commands.some((c) => c.includes("concat"))).toBe(true);
  }, 300_000);
});
