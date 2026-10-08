/**
 * Modo demo de la IA generativa: en lugar de llamar a Kie AI (sin llave o con DEMO_MODE), genera
 * MARCADORES locales con ffmpeg para que el flujo continúe sin gastar créditos:
 *  - imagen: degradado con el texto "IA DEMO" y el prompt;
 *  - video: 5 s (o la duración pedida) con un degradado en movimiento y el mismo texto;
 *  - audio: tono suave (música), barrido de ruido corto (sfx) o tonos tipo "voz" (voz en off).
 * Los resultados se marcan como demo (modelo "demo:<id>", taskId "demo-…", costo 0).
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AiRequest } from "@autoeditor/shared";
import { RESOLUTIONS } from "@autoeditor/shared";
import type { GenerationResult } from "../../services/types.js";
import { hashString } from "../shared/text.js";

export interface DemoGenerateOptions {
  ffmpegPath: string;
  outDir: string;
  aspect: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Corre ffmpeg con argumentos en arreglo, señal de cancelación y tiempo límite. */
export function runFfmpeg(ffmpegPath: string, args: string[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const child = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"], signal });
    let err = "";
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 4000) err += d.toString();
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg salió con código ${code}: ${err.trim().slice(0, 400)}`))));
  });
}

const PALETTES: [string, string][] = [
  ["0x8B7CF0", "0xEE6B6B"],
  ["0x00B4D8", "0xFFD166"],
  ["0x2EC4B6", "0xFF9F1C"],
  ["0xF72585", "0x4CC9F0"],
  ["0xFFB703", "0x023047"],
];

function sizeFor(aspect: string): { w: number; h: number } {
  const r = RESOLUTIONS[aspect as keyof typeof RESOLUTIONS] ?? RESOLUTIONS["9:16"];
  // Mitad de resolución: es un marcador, que sea rápido.
  const even = (n: number) => Math.round(n / 4) * 2;
  return { w: even(r.width), h: even(r.height) };
}

/** Texto del marcador partido en líneas cortas (drawtext no ajusta solo). */
function wrap(text: string, max = 26, lines = 6): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max) {
      if (cur) out.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
    if (out.length >= lines) break;
  }
  if (cur && out.length < lines) out.push(cur);
  return out.join("\n");
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60);

export async function demoGenerate(request: AiRequest, modelId: string, opts: DemoGenerateOptions): Promise<GenerationResult> {
  await mkdir(opts.outDir, { recursive: true });
  const seed = request.seed ?? hashString(`${request.kind}:${request.prompt}`) % 2_147_483_647;
  const [c0, c1] = PALETTES[seed % PALETTES.length]!;
  const base = path.join(opts.outDir, `${sanitize(request.id)}-demo`);
  const run = (args: string[]) => runFfmpeg(opts.ffmpegPath, args, { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 120_000 });
  const result = (filePath: string, mimeType: string): GenerationResult => ({ filePath, mimeType, costUsd: 0, model: `demo:${modelId}`, taskId: `demo-${seed.toString(36)}`, seed });

  if (request.kind === "imagen" || request.kind === "video") {
    const { w, h } = sizeFor(String(request.params.aspectRatio ?? opts.aspect));
    const isVideo = request.kind === "video";
    const seconds = Math.min(15, Math.max(2, Number(request.params.duration ?? request.params.durationSec ?? 5) || 5));
    const textFile = `${base}.txt`;
    await writeFile(textFile, `IA DEMO (${isVideo ? "video" : "imagen"})\n\n${wrap(request.prompt)}`);
    const fontSize = Math.round(w / 22);
    // Rutas para el filtro: escapar ":" y "\" (Windows) dentro de la descripción del filtro.
    const tf = textFile.replace(/\\/g, "/").replace(/:/g, "\\:");
    const gradient = `gradients=s=${w}x${h}:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=${w}:y1=${h}:speed=${isVideo ? 0.02 : 0.00001}:d=${isVideo ? seconds : 1}:r=${isVideo ? 30 : 1}:seed=${seed % 100000}`;
    const motion = isVideo ? `,zoompan=z='min(1.15,1+0.0015*on)':d=1:s=${w}x${h}:fps=30` : "";
    const text = `,drawtext=textfile='${tf}':font='DejaVu Sans':fontsize=${fontSize}:fontcolor=white:line_spacing=${Math.round(fontSize / 3)}:box=1:boxcolor=black@0.35:boxborderw=${Math.round(fontSize / 2)}:x=(w-text_w)/2:y=(h-text_h)/2`;
    const out = isVideo ? `${base}.mp4` : `${base}.png`;
    const encode = isVideo ? ["-t", String(seconds), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out] : ["-frames:v", "1", out];
    try {
      try {
        await run(["-f", "lavfi", "-i", `${gradient}${motion}${text}`, ...encode]);
      } catch {
        // Sin drawtext/fontconfig (p. ej. ffmpeg mínimo): marcador sin texto.
        await run(["-f", "lavfi", "-i", `${gradient}${motion}`, ...encode]);
      }
    } finally {
      await rm(textFile, { force: true });
    }
    return result(out, isVideo ? "video/mp4" : "image/png");
  }

  if (request.kind === "sfx") {
    const out = `${base}.wav`;
    // Barrido de ruido corto (tipo whoosh) de ~0.7 s.
    await run(["-f", "lavfi", "-i", "anoisesrc=d=0.7:c=pink:a=0.5", "-af", "highpass=f=300,lowpass=f=6000,afade=t=in:d=0.25,afade=t=out:st=0.3:d=0.4,volume=0.8", "-ar", "44100", out]);
    return result(out, "audio/wav");
  }

  if (request.kind === "voz") {
    const out = `${base}.m4a`;
    const seconds = Math.min(120, Math.max(1.5, request.prompt.length / 15));
    // Tonos que suben y bajan como entonación (marcador de voz en off).
    await run(["-f", "lavfi", "-i", `aevalsrc='0.25*sin(2*PI*(170+40*sin(2*PI*3*t))*t)*(0.6+0.4*sin(2*PI*4*t))':s=44100:d=${seconds.toFixed(2)}`, "-af", "afade=t=in:d=0.1,afade=t=out:st=" + Math.max(0, seconds - 0.3).toFixed(2) + ":d=0.3", "-c:a", "aac", "-b:a", "96k", out]);
    return result(out, "audio/mp4");
  }

  // Música: acordes suaves con pulso (duración pedida o 30 s).
  const out = `${base}.m4a`;
  const seconds = Math.min(300, Math.max(5, Number(request.params.duration ?? 30) || 30));
  const expr = "0.12*sin(2*PI*220*t)+0.09*sin(2*PI*277.18*t)+0.08*sin(2*PI*329.63*t)+0.05*sin(2*PI*110*t)*(0.5+0.5*sin(2*PI*2*t))";
  await run(["-f", "lavfi", "-i", `aevalsrc='${expr}':s=44100:d=${seconds}`, "-af", `afade=t=in:d=1,afade=t=out:st=${Math.max(0, seconds - 2)}:d=2`, "-c:a", "aac", "-b:a", "128k", out]);
  return result(out, "audio/mp4");
}
