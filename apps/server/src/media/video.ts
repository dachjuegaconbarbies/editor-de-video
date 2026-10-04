/**
 * Análisis visual en UNA pasada de decodificación (ffmpeg), con tres ramas del mismo video:
 *
 * a) Cambios de escena: `select='gte(scene,0)'` a resolución completa e imprime el puntaje de cada
 *    fotograma; un corte es un puntaje > 0.3 (el umbral probado en la investigación) con escenas de
 *    al menos 0.5 s (evita destellos).
 * b) Movimiento, congelados y negros: copia en gris de 160 px → `blackdetect` (tramos en negro ≥ 1 s),
 *    `freezedetect` (tramos congelados ≥ 1.5 s) y
 *    `tblend=difference` + `signalstats` (diferencia media entre fotogramas, 0–255). El puntaje de
 *    escena de ffmpeg NO sirve como medida de movimiento: mide cambios de movimiento, no movimiento.
 * c) Detalle: 2 fotogramas por segundo a 320 px → `edgedetect` + `signalstats` (densidad de bordes,
 *    0–255), una medida simple de textura/detalle visual.
 *
 * Las ramas escriben su metadata en archivos de una carpeta temporal que se usa como directorio de
 * trabajo de ffmpeg: así los nombres son relativos y no hay que escapar rutas dentro del grafo.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { decodeTimeout, runChecked, throwIfAborted } from "./process.js";
import { round3 } from "./audio.js";

export const SCENE_THRESHOLD = 0.3;
export const MIN_SCENE_SEC = 0.5;
/** Tramos congelados más cortos que esto no se informan. */
export const FREEZE_MIN_SEC = 1.5;

export interface VideoSample {
  t: number;
  value: number;
}

export interface VideoAnalysis {
  /** Tiempos de corte de escena (s). */
  cuts: number[];
  /** Puntaje de escena por fotograma. */
  sceneScores: VideoSample[];
  /** Diferencia media entre fotogramas consecutivos (0–255) por fotograma. */
  motion: VideoSample[];
  /** Densidad de bordes (0–255) a 2 fps. */
  detail: VideoSample[];
  /** Tramos congelados [inicio, fin] (freezedetect). */
  freezes: [number, number][];
  /** Tramos en negro [inicio, fin] (blackdetect). */
  blacks: [number, number][];
}

export interface VideoRun {
  ffmpeg: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  /** Carpeta temporal propia (se usa como cwd de ffmpeg). */
  workDir: string;
}

/** Parsea la salida de `metadata=print` (pares "frame:… pts_time:T" + "clave=valor"). */
export function parseMetadataPrint(text: string, key: string): VideoSample[] {
  const out: VideoSample[] = [];
  let t: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /pts_time:\s*(-?[\d.]+(?:e-?\d+)?)/.exec(line);
    if (m) {
      t = Number(m[1]);
      continue;
    }
    if (t !== null && line.startsWith(key + "=")) {
      const v = Number(line.slice(key.length + 1));
      if (Number.isFinite(v)) out.push({ t: round3(t), value: v });
      t = null;
    }
  }
  return out;
}

/** Cortes de escena a partir de los puntajes (umbral + duración mínima de escena). */
export function cutsFromScores(scores: VideoSample[], threshold = SCENE_THRESHOLD, minScene = MIN_SCENE_SEC, duration?: number | null): number[] {
  const cuts: { t: number; v: number }[] = [];
  for (const s of scores) {
    if (s.value <= threshold || s.t < minScene) continue;
    if (duration && s.t > duration - minScene * 0.5) continue;
    const last = cuts[cuts.length - 1];
    if (last && s.t - last.t < minScene) {
      // Dos cortes muy seguidos (destello): se queda el de mayor puntaje.
      if (s.value > last.v) cuts[cuts.length - 1] = { t: s.t, v: s.value };
      continue;
    }
    cuts.push({ t: s.t, v: s.value });
  }
  return cuts.map((c) => c.t);
}

export async function analyzeVideo(run: VideoRun, filePath: string, durationSec: number | null): Promise<VideoAnalysis> {
  throwIfAborted(run.signal);
  const graph =
    "[0:v:0]split=3[a][b][c];" +
    "[a]select='gte(scene,0)',metadata=print:key=lavfi.scene_score:file=scene.txt[ao];" +
    `[b]scale=160:-2:flags=fast_bilinear,format=gray,blackdetect=d=1:pix_th=0.1,freezedetect=n=-60dB:d=${FREEZE_MIN_SEC},tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=motion.txt[bo];` +
    "[c]fps=2,scale=320:-2:flags=fast_bilinear,format=gray,edgedetect=low=0.08:high=0.2,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=detail.txt[co]";
  const freezes: [number, number][] = [];
  const blacks: [number, number][] = [];
  let freezeStart: number | null = null;
  await runChecked(
    run.ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-nostats",
      "-v",
      "info",
      "-progress",
      "pipe:1",
      "-i",
      path.resolve(filePath),
      "-an",
      "-sn",
      "-dn",
      "-filter_complex",
      graph,
      "-map",
      "[ao]",
      "-f",
      "null",
      "-",
      "-map",
      "[bo]",
      "-f",
      "null",
      "-",
      "-map",
      "[co]",
      "-f",
      "null",
      "-",
    ],
    {
      label: "ffmpeg (escenas)",
      cwd: run.workDir,
      signal: run.signal,
      timeoutMs: decodeTimeout(durationSec, 3),
      onStdoutLine: (line) => {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && run.onProgress && durationSec) run.onProgress(Math.min(1, Number(m[1]) / 1e6 / durationSec));
      },
      onStderrLine: (line) => {
        const b = /black_start:\s*(-?[\d.]+)\s+black_end:\s*(-?[\d.]+)/.exec(line);
        if (b) {
          blacks.push([round3(Number(b[1])), round3(Number(b[2]))]);
          return;
        }
        const s = /freezedetect\.freeze_start:\s*(-?[\d.]+)/.exec(line);
        if (s) {
          freezeStart = Number(s[1]);
          return;
        }
        const e = /freezedetect\.freeze_end:\s*(-?[\d.]+)/.exec(line);
        if (e && freezeStart !== null) {
          freezes.push([round3(freezeStart), round3(Number(e[1]))]);
          freezeStart = null;
        }
      },
      errorMessage: "No se pudo analizar el video",
    },
  );
  // Un congelado que llega al final del archivo no emite freeze_end.
  if (freezeStart !== null && durationSec && durationSec - freezeStart >= FREEZE_MIN_SEC) freezes.push([round3(freezeStart), round3(durationSec)]);

  const read = async (name: string) => {
    try {
      return await readFile(path.join(run.workDir, name), "utf8");
    } catch {
      return "";
    }
  };
  const sceneScores = parseMetadataPrint(await read("scene.txt"), "lavfi.scene_score");
  const motion = parseMetadataPrint(await read("motion.txt"), "lavfi.signalstats.YAVG");
  const detail = parseMetadataPrint(await read("detail.txt"), "lavfi.signalstats.YAVG");
  return { cuts: cutsFromScores(sceneScores, SCENE_THRESHOLD, MIN_SCENE_SEC, durationSec), sceneScores, motion, detail, freezes, blacks };
}

/** Densidad de bordes de una imagen fija (para fotos). */
export async function imageDetail(run: VideoRun, filePath: string): Promise<number | null> {
  await runChecked(
    run.ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-i",
      path.resolve(filePath),
      "-frames:v",
      "1",
      "-vf",
      "scale=320:-2:flags=fast_bilinear,format=gray,edgedetect=low=0.08:high=0.2,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=detail.txt",
      "-f",
      "null",
      "-",
    ],
    { label: "ffmpeg (detalle)", cwd: run.workDir, signal: run.signal, timeoutMs: 60_000, errorMessage: "No se pudo analizar la imagen" },
  );
  let text = "";
  try {
    text = await readFile(path.join(run.workDir, "detail.txt"), "utf8");
  } catch {
    return null;
  }
  const v = parseMetadataPrint(text, "lavfi.signalstats.YAVG")[0];
  return v ? v.value : null;
}

/** Promedio de las muestras dentro de [a, b). */
export function meanIn(samples: VideoSample[], a: number, b: number): number | null {
  let sum = 0;
  let n = 0;
  for (const s of samples) {
    if (s.t >= a && s.t < b) {
      sum += s.value;
      n++;
    }
  }
  return n ? sum / n : null;
}

/** Mediana de las muestras dentro de [a, b) (robusta al fotograma del corte). */
export function medianIn(samples: VideoSample[], a: number, b: number): number | null {
  const vals = samples.filter((s) => s.t >= a && s.t < b).map((s) => s.value);
  if (!vals.length) return null;
  vals.sort((x, y) => x - y);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid]! : (vals[mid - 1]! + vals[mid]!) / 2;
}
