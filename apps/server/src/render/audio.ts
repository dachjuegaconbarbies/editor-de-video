/**
 * Audio del render: se "masteriza" PRIMERO a un WAV y luego el render de video solo lo codifica a
 * AAC (media-pipeline.md §7.3: así nunca se renderiza el video dos veces).
 *
 * Mezcla (una pasada, solo audio):
 *   diálogo = audio original de los clips (volume, velocidad con atempo encadenado, acrossfade en
 *             transiciones, silencio en fotos o clips sin audio) + voz en off (adelay)
 *             → limpieza opcional (highpass + afftdn + compresor suave) si mix.voiceEnhance
 *   música  = cada pista con gainDb, fades y su inicio; las marcadas con `duck` pasan por
 *             sidechaincompress usando el diálogo como llave (umbral LINEAL; la razón se calcula
 *             para acercarse a mix.duckingDb)
 *   SFX     = adelay=…:all=1 con su ganancia
 *   amix normalize=0 (con normalize=1 la mezcla queda ~8 dB más baja) y duration=first (manda el
 *   diálogo, que dura exactamente lo mismo que el video).
 *
 * Sonoridad (sobre el WAV, pasadas baratas): si mix.normalize → loudnorm en dos pasadas a
 * mix.targetLufs (TP −1.5); si la ganancia necesaria haría pasar el pico, un limitador previo
 * (sobremuestreado a 192 kHz, level=disabled) mantiene loudnorm en modo LINEAL. Sin normalize:
 * solo un limitador de seguridad. Salida: PCM 48 kHz estéreo.
 */
import type { Recipe } from "@autoeditor/shared";
import { runFfmpeg } from "./ffmpeg.js";
import { FilterGraph, num } from "./graph.js";
import { planWindow, type TimelinePlan } from "./timeline.js";
import { chainSequence, type SequenceItem, type SourceMap } from "./video.js";
import type { Log } from "../services/types.js";

export const SAMPLE_RATE = 48000;
const AFMT = `aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;

/** atempo encadenado (cada etapa entre 0.5 y 2 para no perder calidad). */
export function atempoChain(speed: number): string[] {
  if (Math.abs(speed - 1) < 1e-6) return [];
  const out: string[] = [];
  let s = speed;
  while (s > 2) {
    out.push("atempo=2");
    s /= 2;
  }
  while (s < 0.5) {
    out.push("atempo=0.5");
    s /= 0.5;
  }
  out.push(`atempo=${num(s, 6)}`);
  return out;
}

/** Razón del compresor para que la música baje ≈ duckingDb cuando hay voz (voz ≈ 16 dB sobre el umbral). */
export function duckRatio(duckingDb: number): number {
  const over = 16;
  const d = Math.min(Math.abs(duckingDb), over - 0.5);
  return Math.max(1, Math.min(20, over / (over - d)));
}

export interface AudioGraph {
  graph: FilterGraph;
  out: string;
  totalSamples: number;
}

export function buildAudioGraph(recipe: Recipe, plan: TimelinePlan, sources: SourceMap): AudioGraph {
  const g = new FilterGraph();
  const F = plan.fps;
  const total = plan.totalFrames / F;
  const totalSamples = Math.round(total * SAMPLE_RATE);
  const samplesOf = (frames: number) => Math.round((frames / F) * SAMPLE_RATE);
  const { audio } = recipe.tracks;

  // 1) Audio de los clips principales.
  const win = planWindow(plan, 0, plan.totalFrames);
  const items: SequenceItem[] = win.pieces.map((p) => {
    const clip = p.span.clip;
    const src = sources.get(clip.assetId);
    const samples = samplesOf(p.frames);
    const still = !src || src.info.isImage || clip.stillDuration != null || !src.info.hasAudio;
    let label: string;
    if (still) {
      label = g.chain([], [`anullsrc=r=${SAMPLE_RATE}:cl=stereo`, AFMT, `atrim=end_sample=${samples}`, "asetpts=PTS-STARTPTS"], g.label("sil"));
    } else {
      const speed = clip.speed || 1;
      const inSec = clip.sourceIn + (p.headFrames / F) * speed;
      const needSec = (p.frames / F) * speed + 0.1;
      const idx = g.addInput(["-vn", "-ss", num(inSec, 6), "-t", num(needSec, 6)], src.path);
      label = g.chain(
        [`${idx}:a`],
        ["asetpts=PTS-STARTPTS", ...atempoChain(speed), AFMT, "apad", `atrim=end_sample=${samples}`, "asetpts=PTS-STARTPTS", ...(Math.abs(clip.volume - 1) > 1e-4 ? [`volume=${num(clip.volume, 4)}`] : [])],
        g.label("ca"),
      );
    }
    return { label, frames: p.frames, localStart: p.localStart, overlapFrames: p.overlapFrames, transition: p.span.transition };
  });
  let dialog = items.length
    ? chainSequence(g, items, F, "a")
    : g.chain([], [`anullsrc=r=${SAMPLE_RATE}:cl=stereo`, AFMT, `atrim=end_sample=${totalSamples}`], g.label("sil"));

  // 2) Voz en off.
  const vo = audio.voiceover
    .filter((v) => v.start < total && sources.has(v.assetId))
    .map((v) => {
      const idx = g.addInput(["-vn"], sources.get(v.assetId)!.path);
      return g.chain([`${idx}:a`], ["asetpts=PTS-STARTPTS", AFMT, `volume=${num(v.gainDb, 2)}dB`, `adelay=delays=${Math.round(v.start * 1000)}:all=1`], g.label("vo"));
    });
  if (vo.length) dialog = g.chain([dialog, ...vo], `amix=inputs=${vo.length + 1}:duration=first:dropout_transition=0:normalize=0`, g.label("dlg"));

  if (audio.mix.voiceEnhance) {
    dialog = g.chain([dialog], ["highpass=f=80", "afftdn=nf=-25", "acompressor=threshold=0.125:ratio=3:attack=10:release=200:makeup=1.5"], g.label("enh"));
  }

  // 3) Música.
  const music = audio.music
    .filter((m) => sources.has(m.assetId) && m.start < total)
    .map((m) => {
      const end = Math.min(total, m.end ?? total);
      const len = end - m.start;
      return { m, len };
    })
    .filter(({ len }) => len > 0.05);
  const ducked: string[] = [];
  const plain: string[] = [];
  for (const { m, len } of music) {
    const idx = g.addInput(["-vn", "-stream_loop", "-1", "-ss", num(m.sourceIn, 6), "-t", num(len, 6)], sources.get(m.assetId)!.path);
    const fi = Math.min(m.fadeIn, len / 2);
    const fo = Math.min(m.fadeOut, len / 2);
    const label = g.chain(
      [`${idx}:a`],
      [
        "asetpts=PTS-STARTPTS",
        AFMT,
        `atrim=duration=${num(len, 6)}`,
        `volume=${num(m.gainDb, 2)}dB`,
        ...(fi > 0.01 ? [`afade=t=in:st=0:d=${num(fi, 3)}`] : []),
        ...(fo > 0.01 ? [`afade=t=out:st=${num(len - fo, 3)}:d=${num(fo, 3)}`] : []),
        ...(m.start > 0 ? [`adelay=delays=${Math.round(m.start * 1000)}:all=1`] : []),
      ],
      g.label("mus"),
    );
    (m.duck ? ducked : plain).push(label);
  }
  const bus: string[] = [];
  if (ducked.length) {
    const mus = ducked.length === 1 ? ducked[0]! : g.chain(ducked, `amix=inputs=${ducked.length}:duration=longest:dropout_transition=0:normalize=0`, g.label("musd"));
    const [main, key] = g.split(dialog, 2, "a");
    dialog = main!;
    const ratio = duckRatio(audio.mix.duckingDb);
    bus.push(g.chain([mus, key!], `sidechaincompress=threshold=0.02:ratio=${num(ratio, 3)}:attack=15:release=350:makeup=1:knee=4`, g.label("duck")));
  }
  bus.push(...plain);

  // 4) Efectos de sonido.
  for (const s of audio.sfx) {
    const src = sources.get(s.assetId);
    if (!src || s.at >= total) continue;
    const idx = g.addInput(["-vn"], src.path);
    bus.push(g.chain([`${idx}:a`], ["asetpts=PTS-STARTPTS", AFMT, `volume=${num(s.gainDb, 2)}dB`, `adelay=delays=${Math.round(s.at * 1000)}:all=1`], g.label("sfx")));
  }

  const mixed = bus.length ? g.chain([dialog, ...bus], `amix=inputs=${bus.length + 1}:duration=first:dropout_transition=0:normalize=0`, g.label("mix")) : dialog;
  const out = g.chain([mixed], ["apad", `atrim=end_sample=${totalSamples}`, "asetpts=PTS-STARTPTS"], "aout");
  return { graph: g, out, totalSamples };
}

// ---------------------------------------------------------------------------
// Sonoridad
// ---------------------------------------------------------------------------

export interface LoudnormMeasure {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
  normalization_type?: string;
}

/** Último bloque JSON de loudnorm en stderr. */
export function parseLoudnormJson(stderr: string): LoudnormMeasure | null {
  const end = stderr.lastIndexOf("}");
  const start = stderr.lastIndexOf("{", end);
  if (start < 0 || end < 0) return null;
  try {
    const raw = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
    const n = (k: string) => Number(raw[k]);
    const m = { input_i: n("input_i"), input_tp: n("input_tp"), input_lra: n("input_lra"), input_thresh: n("input_thresh"), target_offset: n("target_offset"), normalization_type: raw.normalization_type };
    return Number.isFinite(m.input_i) ? m : null;
  } catch {
    return null;
  }
}

export interface MasterOptions {
  ffmpeg: string;
  inWav: string;
  outWav: string;
  targetLufs: number;
  normalize: boolean;
  signal?: AbortSignal;
  log?: Log;
  commands: string[];
  fmt: (args: string[]) => string;
}

const TP_TARGET = -1.5;
const LRA_TARGET = 11;

/** Normaliza el WAV de la mezcla. Devuelve la medición final (o null si era silencio / sin normalize). */
export async function masterLoudness(o: MasterOptions): Promise<{ measured: LoudnormMeasure | null; limiter: number | null }> {
  const run = async (args: string[], what: string) => {
    o.commands.push(o.fmt(args));
    return runFfmpeg(o.ffmpeg, args, { signal: o.signal, log: o.log, what, timeoutMs: 20 * 60 * 1000 });
  };
  const outFmt = ["-c:a", "pcm_s16le", "-ar", String(SAMPLE_RATE), "-ac", "2", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1"];
  const safetyLimiter = "alimiter=limit=0.891:attack=1:release=60:level=disabled";
  if (!o.normalize) {
    await run(["-i", o.inWav, "-af", `aresample=192000,${safetyLimiter},aresample=${SAMPLE_RATE}`, ...outFmt, o.outWav], "limitar el audio");
    return { measured: null, limiter: 0.891 };
  }
  const T = o.targetLufs;
  const ln = `loudnorm=I=${T}:TP=${TP_TARGET}:LRA=${LRA_TARGET}:print_format=json`;
  const m1 = parseLoudnormJson((await run(["-i", o.inWav, "-af", ln, "-f", "null", "-"], "medir la sonoridad")).stderr);
  if (!m1 || m1.input_i < -60) {
    // Silencio (o casi): no hay nada que normalizar.
    await run(["-i", o.inWav, ...outFmt, o.outWav], "copiar el audio");
    return { measured: m1, limiter: null };
  }
  let pre = "";
  let limit: number | null = null;
  const gain = T - m1.input_i;
  if (m1.input_tp + gain > TP_TARGET) {
    const limitDb = Math.max(-24, Math.min(0, TP_TARGET - gain - 1));
    limit = Math.pow(10, limitDb / 20);
    pre = `aresample=192000,alimiter=limit=${num(limit, 5)}:attack=1:release=60:level=disabled,aresample=${SAMPLE_RATE},`;
  }
  const m2 = pre ? parseLoudnormJson((await run(["-i", o.inWav, "-af", `${pre}${ln}`, "-f", "null", "-"], "medir la sonoridad")).stderr) ?? m1 : m1;
  const apply =
    `${pre}loudnorm=I=${T}:TP=${TP_TARGET}:LRA=${LRA_TARGET}:measured_I=${num(m2.input_i, 2)}:measured_TP=${num(m2.input_tp, 2)}:` +
    `measured_LRA=${num(m2.input_lra, 2)}:measured_thresh=${num(m2.input_thresh, 2)}:offset=${num(m2.target_offset, 2)}:linear=true:print_format=summary,aresample=${SAMPLE_RATE}`;
  await run(["-i", o.inWav, "-af", apply, ...outFmt, o.outWav], "normalizar el audio");
  return { measured: m2, limiter: limit };
}
