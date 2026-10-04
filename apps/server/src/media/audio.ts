/**
 * Análisis de audio: loudness integrado (EBU R128), energía por tramos (total y banda de voz),
 * silencios con umbral adaptativo y detección de voz.
 *
 * Una sola pasada de ffmpeg mide el loudness con `ebur128` y, a la vez, entrega por stdout PCM
 * mono a 16 kHz en dos canales: el audio completo y el mismo filtrado a la banda de voz
 * (300–3400 Hz). Node calcula la energía en ventanas de 20 ms sin guardar el audio en memoria.
 *
 * ## Heurística de voz (hasSpeech y tramos de voz)
 *
 * No hay un modelo de VAD en Node, así que se combinan tres señales baratas y robustas, en
 * ventanas de 1 s (salto de 0.5 s):
 *
 * 1. **Actividad**: proporción de tramos de 20 ms por encima del piso de ruido del propio archivo
 *    (percentil 10 de la energía) + 10 dB, y nunca por debajo de −60 dBFS. El ruido ambiente
 *    bajo, el siseo y el silencio digital quedan fuera.
 * 2. **Banda de voz**: energía en 300–3400 Hz ÷ energía total de los tramos activos. La voz
 *    concentra ahí la mayor parte de su energía; el zumbido, el viento o el tráfico, no.
 * 3. **Modulación silábica**: desviación estándar (en dB) de la energía de la banda de voz dentro de
 *    la ventana. Hablar alterna sílabas y micro-pausas 3–8 veces por segundo (> 4–5 dB de
 *    variación); un tono, un zumbido, el ruido rosa o un colchón musical sostenido varían mucho
 *    menos.
 *
 * Una ventana "tiene voz" si actividad ≥ 30 %, banda de voz ≥ 35 % y modulación ≥ 4.5 dB. El clip
 * tiene voz (`hasSpeech`) si hay audio, la proporción no silenciosa es ≥ 10 % y las ventanas con
 * voz suman ≥ 1.5 s y ≥ 8 % de la duración. Además, en el conjunto de tramos activos la banda de voz
 * debe ser ≥ 30 % (descarta audio grave sin voz que module mucho).
 *
 * Limitaciones conocidas: una canción con voz cantada cuenta como voz; percusión muy marcada en la
 * banda media puede dar falsos positivos cortos (por eso el mínimo de 1.5 s); una voz susurrada o
 * muy lejana bajo música fuerte puede no detectarse. La transcripción posterior es la que confirma.
 */
import { runChecked, decodeTimeout, throwIfAborted } from "./process.js";

/** Duración de cada tramo de energía (s). */
export const FRAME_SEC = 0.02;
const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = Math.round(SAMPLE_RATE * FRAME_SEC);
/** Piso absoluto para los dB (silencio digital). */
const MIN_DB = -120;
/** 3 canales float32 por muestra. */
const BYTES_PER_SAMPLE = 12;

export interface AudioFrames {
  frameSec: number;
  /** Energía RMS total por tramo (dBFS). */
  totalDb: Float32Array;
  /** Energía RMS en la banda de voz (300–3400 Hz) por tramo (dBFS). */
  voiceDb: Float32Array;
  /** Banda 300–1000 Hz menos banda 1000–3400 Hz (dB): cambia mucho al hablar. */
  tiltDb: Float32Array;
  /** Pico absoluto por tramo (dBFS). */
  peakDb: Float32Array;
  count: number;
}

export interface AudioMeasure {
  /** Loudness integrado (LUFS); null si no se pudo medir. ≤ −70 = silencio. */
  loudness: number | null;
  frames: AudioFrames;
}

const toDb = (power: number) => (power > 1e-12 ? 10 * Math.log10(power) : MIN_DB);

/**
 * Acumulador de tramos de energía a partir de PCM f32le de 3 canales intercalados:
 * 0 = audio completo, 1 = banda 300–1000 Hz, 2 = banda 1000–3400 Hz.
 */
export class FrameAccumulator {
  private total: number[] = [];
  private voice: number[] = [];
  private tilt: number[] = [];
  private peak: number[] = [];
  private sumT = 0;
  private sumL = 0;
  private sumH = 0;
  private pk = 0;
  private n = 0;
  private leftover: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    const buf = this.leftover.length ? Buffer.concat([this.leftover, chunk]) : chunk;
    const usable = buf.length - (buf.length % BYTES_PER_SAMPLE);
    for (let off = 0; off < usable; off += BYTES_PER_SAMPLE) {
      const a = buf.readFloatLE(off);
      const l = buf.readFloatLE(off + 4);
      const h = buf.readFloatLE(off + 8);
      this.sumT += a * a;
      this.sumL += l * l;
      this.sumH += h * h;
      const abs = a < 0 ? -a : a;
      if (abs > this.pk) this.pk = abs;
      if (++this.n === FRAME_SAMPLES) this.flush();
    }
    this.leftover = usable < buf.length ? Buffer.from(buf.subarray(usable)) : Buffer.alloc(0);
  }

  private flush(): void {
    if (this.n === 0) return;
    const n = this.n;
    this.total.push(toDb(this.sumT / n));
    this.voice.push(toDb((this.sumL + this.sumH) / n));
    // Inclinación espectral: dB de la banda baja menos dB de la alta (vocales vs. consonantes).
    this.tilt.push(toDb(this.sumL / n) - toDb(this.sumH / n));
    this.peak.push(this.pk > 1e-6 ? 20 * Math.log10(this.pk) : MIN_DB);
    this.sumT = this.sumL = this.sumH = this.pk = 0;
    this.n = 0;
  }

  finish(): AudioFrames {
    // El último tramo incompleto solo cuenta si tiene al menos la mitad de muestras.
    if (this.n >= FRAME_SAMPLES / 2) this.flush();
    return {
      frameSec: FRAME_SEC,
      totalDb: Float32Array.from(this.total),
      voiceDb: Float32Array.from(this.voice),
      tiltDb: Float32Array.from(this.tilt),
      peakDb: Float32Array.from(this.peak),
      count: this.total.length,
    };
  }
}

export interface FfmpegRun {
  ffmpeg: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/** Mide loudness integrado y energía por tramos en una sola pasada. */
export async function measureAudio(run: FfmpegRun, filePath: string, durationSec: number | null): Promise<AudioMeasure> {
  throwIfAborted(run.signal);
  const acc = new FrameAccumulator();
  let loudness: number | null = null;
  let inSummary = false;
  let samples = 0;
  const graph =
    "[0:a:0]asplit=2[l][p];" +
    "[l]ebur128=framelog=quiet,anullsink;" +
    `[p]aresample=${SAMPLE_RATE},aformat=sample_fmts=flt:channel_layouts=mono,asplit=3[a][b][c];` +
    "[b]highpass=f=300,highpass=f=300,lowpass=f=1000,lowpass=f=1000[lo];" +
    "[c]highpass=f=1000,highpass=f=1000,lowpass=f=3400,lowpass=f=3400[hi];" +
    "[a][lo][hi]amerge=inputs=3[out]";
  await runChecked(
    run.ffmpeg,
    ["-hide_banner", "-nostdin", "-nostats", "-v", "info", "-i", filePath, "-vn", "-sn", "-dn", "-filter_complex", graph, "-map", "[out]", "-f", "f32le", "-c:a", "pcm_f32le", "pipe:1"],
    {
      label: "ffmpeg (audio)",
      signal: run.signal,
      timeoutMs: decodeTimeout(durationSec, 1),
      onStdoutData: (chunk) => {
        acc.push(chunk);
        samples += chunk.length / BYTES_PER_SAMPLE;
        if (run.onProgress && durationSec) run.onProgress(Math.min(1, samples / SAMPLE_RATE / durationSec));
      },
      onStderrLine: (line) => {
        if (/Summary:/.test(line)) inSummary = true;
        if (!inSummary || loudness !== null) return;
        const m = /^\s*I:\s+(-?(?:\d+(?:\.\d+)?|inf))\s+LUFS/.exec(line);
        if (m) loudness = m[1] === "-inf" || m[1] === "inf" ? -70 : Number(m[1]);
      },
      errorMessage: "No se pudo analizar el audio",
    },
  );
  return { loudness, frames: acc.finish() };
}

// ---------------------------------------------------------------------------
// Estadísticos sobre los tramos
// ---------------------------------------------------------------------------

export function percentile(values: ArrayLike<number>, p: number): number {
  if (values.length === 0) return MIN_DB;
  const arr = Array.from(values).sort((a, b) => a - b);
  const idx = Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * p)));
  return arr[idx]!;
}

export interface FrameLevels {
  /** Piso de ruido (percentil 10 de la energía RMS), dBFS. */
  floorDb: number;
  /** Nivel alto típico (percentil 95 de la energía RMS), dBFS. */
  loudDb: number;
  /** Piso de picos (percentil 10 del pico por tramo), dBFS. */
  floorPeakDb: number;
  /** Picos altos (percentil 95), dBFS. */
  loudPeakDb: number;
}

export function frameLevels(frames: AudioFrames): FrameLevels {
  return {
    floorDb: percentile(frames.totalDb, 0.1),
    loudDb: percentile(frames.totalDb, 0.95),
    floorPeakDb: percentile(frames.peakDb, 0.1),
    loudPeakDb: percentile(frames.peakDb, 0.95),
  };
}

/** Por debajo de este loudness integrado el audio se considera prácticamente mudo (LUFS). */
export const NEAR_SILENT_LUFS = -50;

/**
 * Umbral de silencedetect adaptado al loudness: I − 14 dB (−21 LUFS → −35 dB, el valor probado en
 * la investigación), acotado a [−50, −25] dB. Si el piso de picos del archivo (ruido de fondo) queda
 * por encima, se sube a piso + 3 dB, siempre que siga habiendo ≥ 10 dB de margen hasta los picos
 * altos (si no, el audio es estacionario y subirlo convertiría todo en "silencio").
 */
export function adaptiveSilenceThreshold(loudness: number | null, levels: FrameLevels | null): number {
  const base = loudness !== null && Number.isFinite(loudness) && loudness > -70 ? loudness - 14 : -35;
  let thr = Math.min(-25, Math.max(-50, base));
  if (levels && levels.floorPeakDb > MIN_DB + 1) {
    const candidate = levels.floorPeakDb + 3;
    if (candidate > thr && candidate <= levels.loudPeakDb - 10) thr = Math.min(-20, candidate);
  }
  return Math.round(thr * 10) / 10;
}

export interface SpeechWindow {
  start: number;
  end: number;
  activity: number;
  voiceRatio: number;
  modulationDb: number;
  /** Desviación de la inclinación espectral en los tramos activos (dB). */
  spectralVarDb: number;
  speech: boolean;
}

export interface SpeechAnalysis {
  hasSpeech: boolean;
  /** Tramos con voz [inicio, fin] en segundos (ventanas fusionadas). */
  speech: [number, number][];
  speechSeconds: number;
  /** Proporción de tramos activos (no silenciosos) sobre el total. */
  activeRatio: number;
  /** Proporción de energía en la banda de voz sobre los tramos activos. */
  voiceRatio: number;
  windows: SpeechWindow[];
}

export const SPEECH_RULES = {
  windowSec: 1,
  hopSec: 0.5,
  activeAboveFloorDb: 10,
  activeMinDb: -60,
  minActivity: 0.3,
  minVoiceRatio: 0.35,
  minModulationDb: 4.5,
  minSpectralVarDb: 2.5,
  minSpeechSeconds: 1.5,
  minSpeechFraction: 0.08,
  minNonSilentFraction: 0.1,
  minGlobalVoiceRatio: 0.3,
  /** Huecos entre ventanas con voz que se rellenan al fusionar (s). */
  mergeGapSec: 0.5,
};

/** Detecta voz con la heurística documentada arriba. */
export function analyzeSpeech(frames: AudioFrames, opts: { durationSec: number; silences?: [number, number][] } = { durationSec: 0 }): SpeechAnalysis {
  const R = SPEECH_RULES;
  const n = frames.count;
  const duration = opts.durationSec || n * frames.frameSec;
  const empty: SpeechAnalysis = { hasSpeech: false, speech: [], speechSeconds: 0, activeRatio: 0, voiceRatio: 0, windows: [] };
  if (n === 0) return empty;
  const levels = frameLevels(frames);
  const activeThr = Math.max(levels.floorDb + R.activeAboveFloorDb, R.activeMinDb);
  const active = new Uint8Array(n);
  let activeCount = 0;
  let sumT = 0;
  let sumV = 0;
  for (let i = 0; i < n; i++) {
    if (frames.totalDb[i]! > activeThr) {
      active[i] = 1;
      activeCount++;
      sumT += 10 ** (frames.totalDb[i]! / 10);
      sumV += 10 ** (frames.voiceDb[i]! / 10);
    }
  }
  const activeRatio = activeCount / n;
  const voiceRatio = sumT > 0 ? sumV / sumT : 0;

  const win = Math.max(1, Math.round(R.windowSec / frames.frameSec));
  const hop = Math.max(1, Math.round(R.hopSec / frames.frameSec));
  // La modulación se mide sobre la banda de voz acotada a SU propio piso (no al del audio total:
  // un zumbido grave fuerte no debe ocultar la voz).
  const clipDb = Math.max(percentile(frames.voiceDb, 0.1), -70);
  const windows: SpeechWindow[] = [];
  for (let s = 0; s < n; s += hop) {
    const e = Math.min(n, s + win);
    if (e - s < win / 2 && s > 0) break;
    let act = 0;
    let wt = 0;
    let wv = 0;
    let mean = 0;
    let tiltMean = 0;
    for (let i = s; i < e; i++) {
      const v = Math.max(frames.voiceDb[i]!, clipDb);
      mean += v;
      if (active[i]) {
        act++;
        wt += 10 ** (frames.totalDb[i]! / 10);
        wv += 10 ** (frames.voiceDb[i]! / 10);
        tiltMean += clampTilt(frames.tiltDb[i]!);
      }
    }
    const len = e - s;
    mean /= len;
    tiltMean = act > 0 ? tiltMean / act : 0;
    let variance = 0;
    let tiltVar = 0;
    for (let i = s; i < e; i++) {
      const v = Math.max(frames.voiceDb[i]!, clipDb);
      variance += (v - mean) ** 2;
      if (active[i]) tiltVar += (clampTilt(frames.tiltDb[i]!) - tiltMean) ** 2;
    }
    const modulationDb = Math.sqrt(variance / len);
    const spectralVarDb = act > 1 ? Math.sqrt(tiltVar / act) : 0;
    const activity = act / len;
    const vr = wt > 0 ? wv / wt : 0;
    windows.push({
      start: round3(s * frames.frameSec),
      end: round3(e * frames.frameSec),
      activity: round3(activity),
      voiceRatio: round3(vr),
      modulationDb: Math.round(modulationDb * 10) / 10,
      spectralVarDb: Math.round(spectralVarDb * 10) / 10,
      speech: activity >= R.minActivity && vr >= R.minVoiceRatio && modulationDb >= R.minModulationDb && spectralVarDb >= R.minSpectralVarDb,
    });
  }

  const speech = mergeIntervals(
    windows.filter((w) => w.speech).map((w) => [w.start, w.end] as [number, number]),
    R.mergeGapSec,
  );
  const speechSeconds = speech.reduce((acc, [a, b]) => acc + (b - a), 0);
  const silent = (opts.silences ?? []).reduce((acc, [a, b]) => acc + Math.max(0, b - a), 0);
  const nonSilentFraction = duration > 0 ? 1 - Math.min(1, silent / duration) : activeRatio;
  const hasSpeech =
    nonSilentFraction >= R.minNonSilentFraction &&
    voiceRatio >= R.minGlobalVoiceRatio &&
    speechSeconds >= R.minSpeechSeconds &&
    speechSeconds >= R.minSpeechFraction * duration;
  return { hasSpeech, speech: hasSpeech ? speech : [], speechSeconds: round3(speechSeconds), activeRatio: round3(activeRatio), voiceRatio: round3(voiceRatio), windows };
}

/** Acota la inclinación a ±40 dB (bandas vacías darían valores extremos). */
const clampTilt = (t: number) => Math.max(-40, Math.min(40, t));

// ---------------------------------------------------------------------------
// silencedetect
// ---------------------------------------------------------------------------

/** Silencios con silencedetect (umbral en dB, duración mínima en s). */
export async function detectSilences(run: FfmpegRun, filePath: string, opts: { thresholdDb: number; minDuration?: number; durationSec: number | null }): Promise<[number, number][]> {
  throwIfAborted(run.signal);
  const out: [number, number][] = [];
  let open: number | null = null;
  const d = opts.minDuration ?? 0.4;
  await runChecked(
    run.ffmpeg,
    ["-hide_banner", "-nostdin", "-nostats", "-v", "info", "-i", filePath, "-vn", "-sn", "-dn", "-map", "0:a:0", "-af", `silencedetect=noise=${opts.thresholdDb}dB:d=${d}`, "-f", "null", "-"],
    {
      label: "ffmpeg (silencios)",
      signal: run.signal,
      timeoutMs: decodeTimeout(opts.durationSec, 1),
      onStderrLine: (line) => {
        const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
        if (s) {
          open = Math.max(0, Number(s[1]));
          return;
        }
        const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
        if (e && open !== null) {
          out.push([round3(open), round3(Number(e[1]))]);
          open = null;
          if (run.onProgress && opts.durationSec) run.onProgress(Math.min(1, Number(e[1]) / opts.durationSec));
        }
      },
      errorMessage: "No se pudieron detectar los silencios",
    },
  );
  // Un inicio sin fin se cierra con la duración del archivo.
  if (open !== null && opts.durationSec) out.push([round3(open), round3(opts.durationSec)]);
  return out.filter(([a, b]) => b - a >= d * 0.9);
}

// ---------------------------------------------------------------------------
// Utilidades de intervalos
// ---------------------------------------------------------------------------

export const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Fusiona intervalos ordenables que se tocan o separan menos de `gap`. */
export function mergeIntervals(list: [number, number][], gap = 0): [number, number][] {
  const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out.map(([a, b]) => [round3(a), round3(b)]);
}

/** Complemento de `list` dentro de [0, total]. */
export function invertIntervals(list: [number, number][], total: number): [number, number][] {
  const merged = mergeIntervals(list);
  const out: [number, number][] = [];
  let cur = 0;
  for (const [a, b] of merged) {
    if (a > cur) out.push([round3(cur), round3(Math.min(a, total))]);
    cur = Math.max(cur, b);
  }
  if (cur < total) out.push([round3(cur), round3(total)]);
  return out.filter(([a, b]) => b - a > 1e-6);
}

/** Intersección de dos listas de intervalos. */
export function intersectIntervals(a: [number, number][], b: [number, number][]): [number, number][] {
  const A = mergeIntervals(a);
  const B = mergeIntervals(b);
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    const lo = Math.max(A[i]![0], B[j]![0]);
    const hi = Math.min(A[i]![1], B[j]![1]);
    if (hi > lo) out.push([round3(lo), round3(hi)]);
    if (A[i]![1] < B[j]![1]) i++;
    else j++;
  }
  return out;
}
