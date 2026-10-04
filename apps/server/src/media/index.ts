/**
 * Módulo de análisis de medios (ffprobe/ffmpeg + rostros con Python/OpenCV).
 *
 * - `probe`: inventario con ffprobe (resolución corregida por rotación, fps, VFR, códecs).
 * - `thumbnail`: miniatura JPG (video: fotograma al ~10 %; imagen: escalada; audio: forma de onda).
 * - `frameAt`: fotograma en el segundo t (búsqueda rápida por entrada, ancho opcional).
 * - `analyze`: loudness, silencios (umbral adaptativo), voz, escenas, movimiento, fotogramas clave,
 *   rostros y la clasificación A-roll / B-roll con sus fragmentos aprovechables.
 *
 * Tiempos medidos en el contenedor de desarrollo (4 vCPU): ver la prueba `media.test.ts`, que
 * imprime los segundos de análisis por minuto de material (alimenta el estimador).
 */
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { AssetAnalysis, type MediaProbe } from "@autoeditor/shared";
import type { Env } from "../env.js";
import { UserFacingError, type Log, type MediaAnalyzer, type ProgressFn, type StorageAdapter } from "../services/types.js";
import { adaptiveSilenceThreshold, analyzeSpeech, detectSilences, frameLevels, measureAudio, NEAR_SILENT_LUFS, round3, type SpeechAnalysis } from "./audio.js";
import { classifyClip, type FaceSample } from "./broll.js";
import { detectFaces, facesAvailable } from "./faces.js";
import { decodeTimeout, mapLimit, runChecked, runProcess, stderrSummary, throwIfAborted } from "./process.js";
import { ffprobeJson, isImageFormat, parseProbe } from "./probe.js";
import { analyzeVideo, imageDetail, type VideoAnalysis } from "./video.js";

export interface MediaDeps {
  env: Env;
  storage: StorageAdapter;
  log: Log;
}

/** Color de la marca para la forma de onda de los audios. */
export const BRAND_WAVE_COLOR = "0x8B7CF0";
export const THUMB_WIDTH = 480;
export const KEYFRAME_WIDTH = 640;
export const MAX_KEYFRAMES = 24;

/** Tiempos de los fotogramas clave: cortes de escena (+0.3 s) y uno cada N s, máximo `max`. */
export function keyframeTimes(duration: number, cuts: number[], max = MAX_KEYFRAMES): number[] {
  if (!(duration > 0)) return [0];
  const interval = Math.min(60, Math.max(2, duration / 12));
  const minGap = Math.min(1, interval / 2);
  const last = Math.max(0, duration - 0.05);
  const clampT = (t: number) => round3(Math.min(last, Math.max(0, t)));
  const fromCuts = cuts.map((c) => clampT(c + 0.3));
  const periodic: number[] = [];
  for (let t = Math.min(interval / 2, duration / 2); t < duration; t += interval) periodic.push(clampT(t));
  const kept: number[] = [];
  const tryAdd = (t: number) => {
    if (kept.every((k) => Math.abs(k - t) >= minGap)) kept.push(t);
  };
  // Prioridad: cortes (hasta 2/3 del máximo), luego periódicos.
  const cutBudget = Math.ceil((max * 2) / 3);
  const cutStep = fromCuts.length > cutBudget ? fromCuts.length / cutBudget : 1;
  for (let i = 0; i < fromCuts.length && kept.length < cutBudget; i += cutStep) tryAdd(fromCuts[Math.floor(i)]!);
  const remaining = max - kept.length;
  const perStep = periodic.length > remaining ? periodic.length / remaining : 1;
  for (let i = 0; i < periodic.length && kept.length < max; i += perStep) tryAdd(periodic[Math.floor(i)]!);
  if (kept.length === 0) kept.push(clampT(duration / 2));
  return kept.sort((a, b) => a - b);
}

export function createMediaAnalyzer(deps: MediaDeps): MediaAnalyzer {
  const { env, storage, log } = deps;
  const ffmpeg = env.ffmpegPath;
  const ffprobe = env.ffprobePath;
  let facesStatus: { ready: boolean; detail: string; at: number } | null = null;

  const ffArgs = (...args: string[]) => ["-hide_banner", "-nostdin", "-y", "-v", "error", ...args];

  async function ensureOutput(outPath: string): Promise<boolean> {
    try {
      const s = await stat(outPath);
      return s.size > 0;
    } catch {
      return false;
    }
  }

  /** Extrae un fotograma JPG; con t null no busca (imágenes). */
  async function grabFrame(filePath: string, t: number | null, outPath: string, width: number | null, signal?: AbortSignal): Promise<boolean> {
    await mkdir(path.dirname(outPath), { recursive: true });
    const vf = width ? [`scale=w='min(${width},iw)':h=-2:flags=bicubic`] : [];
    const args = ffArgs(
      ...(t !== null && t > 0 ? ["-ss", t.toFixed(3)] : []),
      "-i",
      filePath,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      ...(vf.length ? ["-vf", vf.join(",")] : []),
      "-q:v",
      "3",
      "-f",
      "image2",
      "-update",
      "1",
      outPath,
    );
    const res = await runProcess(ffmpeg, args, { label: "ffmpeg (fotograma)", signal, timeoutMs: 60_000 });
    return res.code === 0 && (await ensureOutput(outPath));
  }

  async function frameAt(filePath: string, t: number, outPath: string, opts?: { width?: number }): Promise<void> {
    const width = opts?.width && opts.width > 0 ? Math.round(opts.width) : null;
    const time = Number.isFinite(t) && t > 0 ? t : 0;
    if (await grabFrame(filePath, time, outPath, width)) return;
    // Pasado el final (o una imagen fija): se intenta un poco antes y, si no, sin buscar.
    if (time > 0 && (await grabFrame(filePath, Math.max(0, time - 1), outPath, width))) return;
    if (await grabFrame(filePath, null, outPath, width)) return;
    throw new UserFacingError("fotograma-no-disponible", `No se pudo extraer un fotograma en el segundo ${time.toFixed(2)}.`, 422);
  }

  async function thumbnail(filePath: string, probe: MediaProbe, outPath: string): Promise<void> {
    await mkdir(path.dirname(outPath), { recursive: true });
    const isPng = /\.png$/i.test(outPath);
    if (probe.hasVideo) {
      const d = probe.duration ?? 0;
      const t = d > 0 ? Math.min(Math.max(0, d * 0.1), Math.max(0, d - 0.1)) : 0;
      if (await grabFrame(filePath, t, outPath, THUMB_WIDTH)) return;
      if (await grabFrame(filePath, null, outPath, THUMB_WIDTH)) return;
      throw new UserFacingError("miniatura-fallida", "No se pudo generar la miniatura del video.", 422);
    }
    if (probe.width && probe.height) {
      // Imagen: se escala y, si tiene transparencia, se apoya sobre blanco (JPG no tiene alfa).
      const graph = isPng
        ? `[0:v]scale=w='min(${THUMB_WIDTH},iw)':h=-2:flags=bicubic[out]`
        : `[0:v]scale=w='min(${THUMB_WIDTH},iw)':h=-2:flags=bicubic,format=rgba,split[fg][bg0];[bg0]drawbox=x=0:y=0:w=iw:h=ih:color=white@1:t=fill:replace=1[bg];[bg][fg]overlay=format=auto,format=yuvj420p[out]`;
      await runChecked(ffmpeg, ffArgs("-i", filePath, "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", ...(isPng ? [] : ["-q:v", "3"]), "-f", "image2", "-update", "1", outPath), {
        label: "ffmpeg (miniatura)",
        timeoutMs: 60_000,
        errorMessage: "No se pudo generar la miniatura de la imagen",
      });
      return;
    }
    if (probe.hasAudio) {
      // Audio: forma de onda en el color de la marca, sobre blanco (JPG) o transparente (PNG).
      const size = `${THUMB_WIDTH}x160`;
      // dynaudnorm + escala raíz: que se vea la forma aunque el audio sea bajo.
      const wave = `[0:a:0]aformat=channel_layouts=mono,dynaudnorm=f=200:g=11:p=0.9,showwavespic=s=${size}:colors=${BRAND_WAVE_COLOR}:scale=sqrt:draw=full:filter=peak`;
      const graph = isPng ? `${wave}[out]` : `${wave}[w];color=c=white:s=${size}[bg];[bg][w]overlay=format=auto:shortest=1,format=yuvj420p[out]`;
      await runChecked(ffmpeg, ffArgs("-i", filePath, "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", ...(isPng ? [] : ["-q:v", "3"]), "-f", "image2", "-update", "1", outPath), {
        label: "ffmpeg (forma de onda)",
        timeoutMs: decodeTimeout(probe.duration, 0.5),
        errorMessage: "No se pudo dibujar la forma de onda",
      });
      return;
    }
    throw new UserFacingError("miniatura-no-aplica", "Este archivo no tiene imagen ni audio para hacer una miniatura.", 422);
  }

  async function checkFaces(): Promise<{ ready: boolean; detail: string }> {
    if (facesStatus && Date.now() - facesStatus.at < 5 * 60_000) return facesStatus;
    const s = await facesAvailable(env.pythonPath);
    facesStatus = { ...s, at: Date.now() };
    return s;
  }

  return {
    async available() {
      try {
        const res = await runProcess(ffmpeg, ["-hide_banner", "-version"], { label: "ffmpeg", timeoutMs: 15_000 });
        if (res.code !== 0) return { ready: false, detail: `ffmpeg no respondió (${stderrSummary(res.stderr, 1)})`, version: "" };
        const version = /ffmpeg version (\S+)/.exec(res.stdout)?.[1] ?? "";
        const probeRes = await runProcess(ffprobe, ["-hide_banner", "-version"], { label: "ffprobe", timeoutMs: 15_000 }).catch(() => null);
        if (!probeRes || probeRes.code !== 0) return { ready: false, detail: "Falta ffprobe (viene con ffmpeg). Revisa FFPROBE_PATH.", version };
        const faces = await checkFaces();
        return { ready: true, detail: `ffmpeg ${version} listo · rostros: ${faces.ready ? faces.detail : "no disponible"}`, version };
      } catch {
        return { ready: false, detail: "No se encontró ffmpeg. Instálalo o define FFMPEG_PATH (corre «pnpm diagnostico»).", version: "" };
      }
    },

    async probe(filePath) {
      return parseProbe(await ffprobeJson(ffprobe, filePath));
    },

    thumbnail,
    frameAt,

    async analyze(input, opts = {}) {
      const { signal } = opts;
      const started = Date.now();
      const report: ProgressFn = (p, message) => {
        try {
          opts.onProgress?.(Math.max(0, Math.min(1, p)), message);
        } catch {
          // el progreso nunca rompe el análisis
        }
      };
      throwIfAborted(signal);
      const filePath = input.filePath;
      if (!existsSync(filePath)) throw new UserFacingError("archivo-no-encontrado", "No encontré el archivo para analizarlo.", 404);
      const probe = input.probe;
      const raw = await ffprobeJson(ffprobe, filePath, signal);
      const isImage = isImageFormat(raw) || input.asset.kind === "imagen";
      const duration = probe.duration ?? parseProbe(raw).duration ?? 0;
      const tmp = await storage.tempDir("analisis");
      const timings: Record<string, number> = {};
      const lap = (name: string, from: number) => (timings[name] = Date.now() - from);
      try {
        report(0.02, "Preparando el análisis");

        // 1) Audio: loudness + energía por tramos, silencios con umbral adaptativo y voz.
        let loudness: number | null = null;
        let silences: [number, number][] = [];
        let speech: SpeechAnalysis | null = null;
        if (probe.hasAudio && !isImage && duration > 0) {
          let t0 = Date.now();
          report(0.03, "Midiendo el audio");
          const measured = await measureAudio({ ffmpeg, signal, onProgress: (f) => report(0.03 + f * 0.17, "Midiendo el audio") }, filePath, duration);
          loudness = measured.loudness;
          lap("audio", t0);
          t0 = Date.now();
          report(0.2, "Buscando silencios");
          if (loudness === null || loudness <= NEAR_SILENT_LUFS) {
            // Prácticamente mudo (ruido de fondo muy bajo): todo es silencio.
            silences = [[0, round3(duration)]];
          } else {
            const threshold = adaptiveSilenceThreshold(loudness, frameLevels(measured.frames));
            silences = await detectSilences({ ffmpeg, signal, onProgress: (f) => report(0.2 + f * 0.05, "Buscando silencios") }, filePath, { thresholdDb: threshold, durationSec: duration });
          }
          lap("silencios", t0);
          speech = analyzeSpeech(measured.frames, { durationSec: duration, silences });
          if (loudness !== null && loudness <= NEAR_SILENT_LUFS) speech = { ...speech, hasSpeech: false, speech: [] };
        }
        throwIfAborted(signal);

        // 2) Video: escenas, movimiento, congelados, negros y detalle (una sola decodificación).
        let video: VideoAnalysis = { cuts: [], sceneScores: [], motion: [], detail: [], freezes: [], blacks: [] };
        let stillDetail: number | null = null;
        const workDir = path.join(tmp.path, "video");
        await mkdir(workDir, { recursive: true });
        if (probe.hasVideo && !isImage && duration > 0) {
          const t0 = Date.now();
          report(0.25, "Detectando cambios de escena");
          video = await analyzeVideo({ ffmpeg, signal, workDir, onProgress: (f) => report(0.25 + f * 0.45, "Detectando cambios de escena") }, filePath, duration);
          lap("video", t0);
        } else if (isImage) {
          stillDetail = await imageDetail({ ffmpeg, signal, workDir }, filePath).catch(() => null);
        }
        throwIfAborted(signal);

        // 3) Fotogramas clave (cortes + periódicos, máximo 24).
        let t0 = Date.now();
        report(0.7, "Extrayendo fotogramas clave");
        const times = probe.hasVideo || isImage ? (isImage ? [0] : keyframeTimes(duration, video.cuts)) : [];
        const kfDir = path.join(tmp.path, "keyframes");
        await mkdir(kfDir, { recursive: true });
        let done = 0;
        const frames = await mapLimit(times, 3, async (t, i) => {
          throwIfAborted(signal);
          const out = path.join(kfDir, `kf-${String(i).padStart(3, "0")}.jpg`);
          const ok = (await grabFrame(filePath, isImage ? null : t, out, KEYFRAME_WIDTH, signal)) || (!isImage && (await grabFrame(filePath, Math.max(0, t - 0.5), out, KEYFRAME_WIDTH, signal)));
          done++;
          report(0.7 + (done / Math.max(1, times.length)) * 0.15, "Extrayendo fotogramas clave");
          return ok ? { t, path: out } : null;
        });
        const extracted = frames.filter((f): f is { t: number; path: string } => f !== null);
        lap("fotogramas", t0);
        throwIfAborted(signal);

        // 4) Rostros (worker de Python) sobre los fotogramas clave, ANTES de moverlos al almacenamiento.
        t0 = Date.now();
        report(0.86, "Buscando rostros");
        const faces: FaceSample[] = [];
        if (extracted.length) {
          const fs = await checkFaces();
          if (fs.ready) {
            const res = await detectFaces(
              env.pythonPath,
              extracted.map((f) => f.path),
              { signal },
            );
            if (!res.ok) log.warn({ detail: res.detail }, "No se pudieron detectar rostros; el análisis sigue sin ellos");
            res.images.forEach((img, i) => {
              const best = img.faces[0];
              const frame = extracted[i];
              if (best && frame) faces.push({ t: frame.t, x: best.x, y: best.y, size: best.size });
            });
          } else {
            log.debug({ detail: fs.detail }, "Detección de rostros no disponible");
          }
        }
        lap("rostros", t0);
        throwIfAborted(signal);

        // 5) Guardar los fotogramas clave.
        report(0.95, "Guardando fotogramas clave");
        const keyframes: { t: number; key: string }[] = [];
        for (const f of extracted) {
          const key = await input.saveKeyframe(f.t, f.path);
          keyframes.push({ t: f.t, key });
        }

        // 6) Clasificación A-roll / B-roll y fragmentos aprovechables.
        report(0.97, "Clasificando la toma");
        const cls = classifyClip({
          durationSec: duration,
          hasAudio: probe.hasAudio,
          hasVideo: probe.hasVideo,
          isImage,
          speech,
          silences,
          cuts: video.cuts,
          freezes: video.freezes,
          blacks: video.blacks,
          motion: video.motion,
          detail: video.detail,
          faces,
          keyframeTimes: extracted.map((f) => f.t),
          imageDetail: stillDetail,
        });
        const hasSpeech = isImage || !probe.hasAudio ? false : !!speech?.hasSpeech;
        const elapsed = Date.now() - started;
        log.info(
          {
            assetId: input.asset.id,
            role: cls.role,
            reason: cls.reason,
            hasSpeech,
            durationSec: duration,
            analyzeMs: elapsed,
            secondsPerMinute: duration > 0 ? Math.round((elapsed / 1000 / (duration / 60)) * 100) / 100 : null,
            timings,
          },
          "Análisis de medios terminado",
        );
        report(1, "Análisis listo");
        return AssetAnalysis.parse({
          status: "listo",
          error: null,
          scenes: video.cuts,
          silences,
          loudness: loudness === null ? null : Math.round(loudness * 10) / 10,
          keyframes,
          faces,
          description: "",
          hasSpeech,
          role: cls.role,
          brollSegments: cls.brollSegments,
        });
      } finally {
        await tmp.cleanup().catch(() => undefined);
      }
    },
  };
}
