/**
 * Análisis de medios con ffmpeg real (sin red ni llaves): probe, miniaturas, fotogramas y analyze()
 * sobre el material de prueba de data/muestras (se genera con `pnpm material-prueba`).
 * Imprime los segundos de análisis por minuto de material (dato para config/estimator.json).
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Asset, type AssetAnalysis, type MediaKind, type MediaProbe } from "@autoeditor/shared";
import { REPO_ROOT, loadEnv } from "../src/env.js";
import { createMediaAnalyzer, keyframeTimes } from "../src/media/index.js";
import { adaptiveSilenceThreshold, analyzeSpeech, invertIntervals, mergeIntervals, type AudioFrames } from "../src/media/audio.js";
import { classifyClip, splitByCuts } from "../src/media/broll.js";
import { detectFaces, facesAvailable } from "../src/media/faces.js";
import { runChecked } from "../src/media/process.js";
import { parseProbe } from "../src/media/probe.js";
import { cutsFromScores } from "../src/media/video.js";
import { createLocalStorage } from "../src/storage/local.js";
import type { Log, MediaAnalyzer, StorageAdapter } from "../src/services/types.js";

const SAMPLES = path.join(REPO_ROOT, "data/muestras");
const haveSamples = existsSync(path.join(SAMPLES, "a-roll.mp4")) && existsSync(path.join(SAMPLES, "b-roll-2.mp4"));
const log: Log = { info() {}, warn() {}, error() {}, debug() {} };

let tmp: string;
let storage: StorageAdapter;
let media: MediaAnalyzer;
const env = loadEnv({ anthropicApiKey: "", kieApiKey: "", demoMode: true });
const timings: { name: string; duration: number; ms: number }[] = [];

function asset(name: string, kind: MediaKind, probe: MediaProbe): Asset {
  return Asset.parse({
    id: `ast_${name.replace(/\W/g, "")}`,
    ownerId: "local",
    projectId: "prj_media",
    category: kind === "imagen" ? "crudo-foto" : kind === "audio" ? "musica" : "crudo-video",
    kind,
    originalName: name,
    mimeType: kind === "imagen" ? "image/jpeg" : kind === "audio" ? "audio/mp4" : "video/mp4",
    sizeBytes: 1,
    storageKey: `local/prj_media/assets/${name}`,
    probe,
    createdAt: new Date().toISOString(),
  });
}

async function analyzeSample(name: string, kind: MediaKind = "video"): Promise<{ analysis: AssetAnalysis; probe: MediaProbe; progress: number[] }> {
  const file = path.join(SAMPLES, name);
  const probe = await media.probe(file);
  const progress: number[] = [];
  const started = Date.now();
  const analysis = await media.analyze(
    {
      asset: asset(name, kind, probe),
      filePath: file,
      probe,
      saveKeyframe: async (t, jpg) => {
        const key = storage.key("local", "prj_media", "keyframes", name.replace(/\W/g, "_"), `${t.toFixed(2)}.jpg`);
        await storage.putFile(key, jpg);
        return key;
      },
    },
    { onProgress: (p) => progress.push(p) },
  );
  timings.push({ name, duration: probe.duration ?? 0, ms: Date.now() - started });
  return { analysis, probe, progress };
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "autoeditor-media-"));
  storage = await createLocalStorage({ dataDir: path.join(tmp, "data") });
  media = createMediaAnalyzer({ env, storage, log });
});

afterAll(async () => {
  const withDur = timings.filter((t) => t.duration > 0);
  if (withDur.length) {
    const totalMin = withDur.reduce((a, t) => a + t.duration, 0) / 60;
    const totalSec = withDur.reduce((a, t) => a + t.ms, 0) / 1000;
    // Dato para el estimador: segundos de análisis por minuto de material.
    console.log(
      `[media] analyze: ${withDur.map((t) => `${t.name} ${t.duration.toFixed(1)} s → ${(t.ms / 1000).toFixed(2)} s`).join(" · ")} | ${(totalSec / totalMin).toFixed(1)} s por minuto de material`,
    );
  }
  await rm(tmp, { recursive: true, force: true });
});

describe("media: funciones puras", () => {
  it("parseProbe corrige la resolución por rotación y detecta VFR", () => {
    const p = parseProbe({
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "12.5" },
      streams: [
        { codec_type: "video", codec_name: "hevc", width: 1920, height: 1080, r_frame_rate: "30/1", avg_frame_rate: "125/7", side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] },
        { codec_type: "audio", codec_name: "aac" },
      ],
    });
    expect(p).toMatchObject({ width: 1080, height: 1920, rotation: -90, hasAudio: true, hasVideo: true, variableFrameRate: true, duration: 12.5 });
  });

  it("parseProbe trata las imágenes como no-video", () => {
    const p = parseProbe({ format: { format_name: "image2" }, streams: [{ codec_type: "video", codec_name: "mjpeg", width: 800, height: 600 }] });
    expect(p).toMatchObject({ width: 800, height: 600, hasVideo: false, duration: null, fps: null });
  });

  it("umbral de silencio adaptativo al loudness", () => {
    expect(adaptiveSilenceThreshold(-21, null)).toBe(-35);
    expect(adaptiveSilenceThreshold(-10, null)).toBe(-25);
    expect(adaptiveSilenceThreshold(-45, null)).toBe(-50);
    expect(adaptiveSilenceThreshold(null, null)).toBe(-35);
  });

  it("intervalos y cortes", () => {
    expect(mergeIntervals([[0, 1], [1.2, 2], [5, 6]], 0.3)).toEqual([[0, 2], [5, 6]]);
    expect(invertIntervals([[1, 2]], 4)).toEqual([[0, 1], [2, 4]]);
    expect(splitByCuts([[0, 10]], [3, 7])).toEqual([[0, 3], [3, 7], [7, 10]]);
    const cuts = cutsFromScores(
      [
        { t: 0.1, value: 0.9 },
        { t: 2, value: 0.5 },
        { t: 2.2, value: 0.8 },
        { t: 5, value: 0.1 },
        { t: 6, value: 0.4 },
      ],
      0.3,
      0.5,
      10,
    );
    expect(cuts).toEqual([2.2, 6]);
  });

  it("fotogramas clave: cortes + periódicos, máximo 24", () => {
    const t = keyframeTimes(600, Array.from({ length: 80 }, (_, i) => i * 7 + 1));
    expect(t.length).toBeLessThanOrEqual(24);
    expect([...t].sort((a, b) => a - b)).toEqual(t);
    expect(keyframeTimes(8, [])).toEqual(expect.arrayContaining([expect.any(Number)]));
  });

  it("heurística de voz: un tono constante no es voz", () => {
    const n = 500; // 10 s
    const flat: AudioFrames = {
      frameSec: 0.02,
      totalDb: new Float32Array(n).fill(-20),
      voiceDb: new Float32Array(n).fill(-22),
      tiltDb: new Float32Array(n).fill(3),
      peakDb: new Float32Array(n).fill(-17),
      count: n,
    };
    expect(analyzeSpeech(flat, { durationSec: 10 }).hasSpeech).toBe(false);
  });

  it("clasificación: foto = b-roll con un fragmento; video sin audio = b-roll", () => {
    const base = { durationSec: 6, hasAudio: false, hasVideo: true, isImage: false, speech: null, silences: [], cuts: [], freezes: [], blacks: [], motion: [], detail: [], faces: [], keyframeTimes: [1, 3, 5] };
    expect(classifyClip({ ...base, isImage: true, hasVideo: false, durationSec: 0 }).brollSegments).toHaveLength(1);
    const r = classifyClip({ ...base, cuts: [3] });
    expect(r.role).toBe("b-roll");
    expect(r.brollSegments.map((s) => [s.start, s.end])).toEqual([
      [0, 3],
      [3, 6],
    ]);
  });
});

describe.skipIf(!haveSamples)("media: ffmpeg real", () => {
  it("available() informa la versión de ffmpeg", async () => {
    const a = await media.available();
    expect(a.ready).toBe(true);
    expect(a.version).toMatch(/\d/);
  });

  it("probe de un video rotado (iPhone) y de uno VFR", async () => {
    const base = path.join(tmp, "base.mp4");
    await runChecked(env.ffmpegPath, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", base]);
    const rot = path.join(tmp, "rot.mp4");
    await runChecked(env.ffmpegPath, ["-v", "error", "-y", "-display_rotation:v:0", "90", "-i", base, "-c", "copy", rot]);
    const p = await media.probe(rot);
    expect(p).toMatchObject({ width: 180, height: 320, rotation: 90, hasVideo: true, hasAudio: false, variableFrameRate: false });
    const vfr = path.join(tmp, "vfr.mp4");
    await runChecked(env.ffmpegPath, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=3", "-vf", "select='lt(n\\,30)+not(mod(n\\,3))'", "-fps_mode", "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p", vfr]);
    expect((await media.probe(vfr)).variableFrameRate).toBe(true);
    // La miniatura del rotado sale vertical (ffmpeg autorrota).
    const thumb = path.join(tmp, "rot.jpg");
    await media.thumbnail(rot, p, thumb);
    const tp = await media.probe(thumb);
    expect(tp.height!).toBeGreaterThan(tp.width!);
  });

  it("miniaturas: video a 480 px, imagen con alfa y forma de onda de audio", async () => {
    const vProbe = await media.probe(path.join(SAMPLES, "a-roll.mp4"));
    expect(vProbe).toMatchObject({ width: 1920, height: 1080, hasAudio: true, hasVideo: true });
    const vt = path.join(tmp, "thumbs", "a-roll.jpg");
    await media.thumbnail(path.join(SAMPLES, "a-roll.mp4"), vProbe, vt);
    expect((await media.probe(vt)).width).toBe(480);

    const logo = path.join(SAMPLES, "logo.png");
    const lp = await media.probe(logo);
    expect(lp.hasVideo).toBe(false);
    const lt = path.join(tmp, "thumbs", "logo.jpg");
    await media.thumbnail(logo, lp, lt);
    expect((await stat(lt)).size).toBeGreaterThan(500);

    const music = path.join(SAMPLES, "musica.m4a");
    const mp = await media.probe(music);
    expect(mp).toMatchObject({ hasAudio: true, hasVideo: false });
    const mt = path.join(tmp, "thumbs", "musica.png");
    await media.thumbnail(music, mp, mt);
    const mtp = await media.probe(mt);
    expect(mtp).toMatchObject({ width: 480, height: 160 });
    const mj = path.join(tmp, "thumbs", "musica.jpg");
    await media.thumbnail(music, mp, mj);
    expect((await stat(mj)).size).toBeGreaterThan(500);
  });

  it("frameAt con ancho opcional y tiempo pasado el final", async () => {
    const out = path.join(tmp, "frames", "f.jpg");
    await media.frameAt(path.join(SAMPLES, "b-roll-1.mp4"), 3.5, out, { width: 320 });
    expect((await media.probe(out)).width).toBe(320);
    const late = path.join(tmp, "frames", "late.jpg");
    await media.frameAt(path.join(SAMPLES, "b-roll-1.mp4"), 999, late);
    expect((await stat(late)).size).toBeGreaterThan(500);
  });

  it("analyze del a-roll: voz, pausa de ~2.2 s, a-roll", async () => {
    const { analysis, progress } = await analyzeSample("a-roll.mp4");
    expect(analysis.status).toBe("listo");
    expect(analysis.hasSpeech).toBe(true);
    expect(analysis.role).toBe("a-roll");
    expect(analysis.loudness).not.toBeNull();
    const pause = analysis.silences.find(([a, b]) => b - a > 1.8 && b - a < 2.8);
    expect(pause, `silencios: ${JSON.stringify(analysis.silences)}`).toBeTruthy();
    expect(analysis.keyframes.length).toBeGreaterThan(0);
    expect(analysis.keyframes.length).toBeLessThanOrEqual(24);
    expect(await storage.exists(analysis.keyframes[0]!.key)).toBe(true);
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1]! - 1e-9)).toBe(true);
  }, 120_000);

  it.each(["b-roll-1.mp4", "b-roll-2.mp4"])("analyze de %s: b-roll con fragmentos", async (name) => {
    const { analysis, probe } = await analyzeSample(name);
    expect(analysis.hasSpeech).toBe(false);
    expect(analysis.role).toBe("b-roll");
    expect(analysis.brollSegments.length).toBeGreaterThan(0);
    for (const s of analysis.brollSegments) {
      expect(s.end - s.start).toBeGreaterThanOrEqual(1.5);
      expect(s.end).toBeLessThanOrEqual((probe.duration ?? 0) + 0.01);
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
      expect(s.tags.length).toBeGreaterThan(0);
    }
  }, 120_000);

  it("analyze de a-roll + b-roll pegados: mixto, con el tramo sin voz como fragmento", async () => {
    const out = path.join(tmp, "mixto.mp4");
    const graph =
      "[0:v]scale=426:240,setsar=1,fps=24[v0];[1:v]scale=426:240,setsar=1,fps=24[v1];" +
      "[0:a]aresample=48000,aformat=channel_layouts=stereo[a0];[1:a]aresample=48000,aformat=channel_layouts=stereo[a1];" +
      "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]";
    await runChecked(env.ffmpegPath, ["-v", "error", "-y", "-i", path.join(SAMPLES, "a-roll.mp4"), "-i", path.join(SAMPLES, "b-roll-1.mp4"), "-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", out], { timeoutMs: 120_000 });
    const probe = await media.probe(out);
    const analysis = await media.analyze({ asset: asset("mixto.mp4", "video", probe), filePath: out, probe, saveKeyframe: async (t) => `kf/${t}` });
    expect(analysis.hasSpeech).toBe(true);
    expect(analysis.role).toBe("mixto");
    expect(analysis.scenes.some((t) => Math.abs(t - 24.25) < 0.3)).toBe(true);
    // El b-roll pegado (desde ~24.2 s hasta el final) aparece como fragmento aprovechable.
    expect(analysis.brollSegments.some((s) => s.start >= 23.5 && s.start <= 24.5 && s.end - s.start >= 7)).toBe(true);
  }, 180_000);

  it("analyze de una foto: b-roll con un fragmento", async () => {
    const { analysis } = await analyzeSample("foto.jpg", "imagen");
    expect(analysis.role).toBe("b-roll");
    expect(analysis.brollSegments).toHaveLength(1);
    expect(analysis.hasSpeech).toBe(false);
    expect(analysis.keyframes).toHaveLength(1);
  }, 60_000);

  it("analyze respeta la cancelación", async () => {
    const file = path.join(SAMPLES, "a-roll.mp4");
    const probe = await media.probe(file);
    const ctrl = new AbortController();
    ctrl.abort(new Error("cancelado por la prueba"));
    await expect(media.analyze({ asset: asset("a-roll.mp4", "video", probe), filePath: file, probe, saveKeyframe: async () => "x" }, { signal: ctrl.signal })).rejects.toThrow(/cancelado/);
  });
});

describe("media: rostros con el worker de Python", () => {
  it("faces.py corre sobre una imagen (si el venv existe)", async (ctx) => {
    const fa = await facesAvailable(env.pythonPath);
    if (!fa.ready) {
      console.warn(`[media] se salta la prueba de rostros: ${fa.detail}`);
      ctx.skip();
      return;
    }
    const img = path.join(tmp, "face-test.jpg");
    await runChecked(env.ffmpegPath, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=1", "-frames:v", "1", img]);
    const res = await detectFaces(env.pythonPath, [img]);
    expect(res.ok, res.detail).toBe(true);
    expect(res.images).toHaveLength(1);
    expect(res.images[0]).toMatchObject({ width: 640, height: 360 });
    expect(Array.isArray(res.images[0]!.faces)).toBe(true);
  }, 60_000);
});
