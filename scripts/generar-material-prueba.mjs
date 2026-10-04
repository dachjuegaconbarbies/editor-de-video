#!/usr/bin/env node
/**
 * Genera material de prueba libre de derechos en data/muestras/:
 *  - a-roll.mp4      Toma horizontal (1920x1080) con voz en español (TTS local), pausas y una muletilla.
 *                    Lleva incrustados en sus metadatos los tiempos exactos por palabra, para que el
 *                    proveedor de transcripción "demo" pueda probar subtítulos sin un modelo de voz.
 *  - b-roll-1.mp4    Toma de apoyo sin voz (degradados en movimiento).
 *  - b-roll-2.mp4    Toma de apoyo sin voz (zoom de fractal).
 *  - foto.jpg        Imagen fija.
 *  - musica.m4a      Loop musical sintetizado (60 s).
 *  - whoosh.wav, golpe.wav  Efectos de sonido.
 *  - logo.png        Logo con fondo transparente.
 *  - guion.txt       Guion del a-roll.
 *
 * Voces: macOS `say`, Linux `espeak-ng`/`espeak`, Windows PowerShell (System.Speech).
 * Si no hay ninguna, usa tonos con la misma duración por palabra (los tiempos siguen siendo exactos).
 *
 * Uso: pnpm material-prueba [-- --salida ./data/muestras]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argOut = process.argv.indexOf("--salida");
const OUT = path.resolve(ROOT, argOut > -1 ? process.argv[argOut + 1] : "data/muestras");
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

const GUION = [
  "Hola, soy Ana de Zyra.",
  "Hoy te voy a enseñar tres trucos para editar videos más rápido.",
  "Primero, eh, quita los silencios largos.",
  "Segundo, usa subtítulos con palabras clave resaltadas.",
  "Y tercero, guarda tu estilo para reutilizarlo en cada video.",
  "Síguenos para más consejos.",
];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.error) throw new Error(`No se pudo ejecutar ${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} falló (${r.status}):\n${(r.stderr || "").slice(-2000)}`);
  return r.stdout;
}
const has = (cmd, args = ["--version"]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return !r.error && r.status === 0;
};
const ff = (args) => run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const durationOf = (file) => Number(run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]).trim());

function detectVoice() {
  if (process.platform === "darwin" && has("say", ["-v", "?"])) return "say";
  if (has("espeak-ng")) return "espeak-ng";
  if (has("espeak")) return "espeak";
  if (process.platform === "win32" && has("powershell", ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Speech; 'ok'"])) return "powershell";
  return null;
}

/** Sintetiza una palabra a WAV mono 48 kHz. */
function speakWord(engine, word, outWav, tmp) {
  const raw = path.join(tmp, `raw-${Math.random().toString(36).slice(2)}`);
  if (engine === "say") {
    run("say", ["-v", "Paulina", "-o", raw + ".aiff", word]);
    ff(["-i", raw + ".aiff", "-ac", "1", "-ar", "48000", outWav]);
  } else if (engine === "espeak-ng" || engine === "espeak") {
    run(engine, ["-v", "es-419", "-s", "165", "-w", raw + ".wav", word]);
    ff(["-i", raw + ".wav", "-ac", "1", "-ar", "48000", "-af", "silenceremove=start_periods=1:start_threshold=-50dB:stop_periods=1:stop_threshold=-50dB", outWav]);
  } else if (engine === "powershell") {
    const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${raw}.wav'); $s.Speak(${JSON.stringify(word)}); $s.Dispose()`;
    run("powershell", ["-NoProfile", "-Command", ps]);
    ff(["-i", raw + ".wav", "-ac", "1", "-ar", "48000", outWav]);
  } else {
    // Sin voz: tono modulado con duración proporcional a las letras.
    const d = Math.max(0.18, Math.min(0.9, word.length * 0.065));
    ff(["-f", "lavfi", "-i", `sine=frequency=${180 + (word.length % 5) * 30}:duration=${d}`, "-af", "volume=0.4,tremolo=f=9:d=0.6", "-ac", "1", "-ar", "48000", outWav]);
  }
}

function silence(outWav, seconds) {
  ff(["-f", "lavfi", "-i", `anullsrc=r=48000:cl=mono`, "-t", String(seconds), outWav]);
}

function buildVoice(tmp) {
  const engine = detectVoice();
  console.log(`• Voz: ${engine ?? "tonos (no se encontró motor de voz)"}`);
  const parts = [];
  const words = [];
  let t = 0.6; // respiración inicial
  const lead = path.join(tmp, "lead.wav");
  silence(lead, 0.6);
  parts.push(lead);
  let wi = 0;
  GUION.forEach((sentence, si) => {
    const tokens = sentence.split(/\s+/);
    tokens.forEach((tok, ti) => {
      const clean = tok.replace(/[.,;:!?¿¡]/g, "");
      const wav = path.join(tmp, `w${wi}.wav`);
      speakWord(engine, clean, wav, tmp);
      const d = durationOf(wav);
      words.push({ text: tok, start: +t.toFixed(3), end: +(t + d).toFixed(3), probability: 1 });
      parts.push(wav);
      t += d;
      // pausa entre palabras (más larga tras comas)
      const gap = /,$/.test(tok) ? 0.22 : 0.06;
      if (ti < tokens.length - 1) {
        const g = path.join(tmp, `g${wi}.wav`);
        silence(g, gap);
        parts.push(g);
        t += gap;
      }
      wi++;
    });
    // silencio entre frases: uno largo para probar "quitar silencios"
    const pause = si === 2 ? 2.2 : 0.7;
    const p = path.join(tmp, `p${si}.wav`);
    silence(p, pause);
    parts.push(p);
    t += pause;
  });
  const list = path.join(tmp, "voz.txt");
  writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  const voice = path.join(tmp, "voz.wav");
  ff(["-f", "concat", "-safe", "0", "-i", list, "-ac", "1", "-ar", "48000", voice]);
  return { voice, words, duration: durationOf(voice), engine };
}

function fontFile() {
  const candidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
  ];
  return candidates.find((f) => existsSync(f)) ?? null;
}

function drawtext(text, extra) {
  const font = fontFile();
  const esc = text.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\u2019");
  const ff = font ? `fontfile='${font.replace(/\\/g, "/").replace(/:/g, "\\:")}':` : "";
  return `drawtext=${ff}text='${esc}':${extra}`;
}

function main() {
  if (!has(FFMPEG, ["-version"])) {
    console.error("✗ No se encontró ffmpeg. Instálalo (macOS: brew install ffmpeg · Windows: winget install Gyan.FFmpeg · Linux: sudo apt install ffmpeg).");
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const tmp = path.join(os.tmpdir(), `autoeditor-muestras-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  try {
    console.log(`Generando material de prueba en ${path.relative(ROOT, OUT) || OUT} …`);

    // 1) A-roll con voz
    const { voice, words, duration, engine } = buildVoice(tmp);
    const meta = JSON.stringify({ language: "es", source: engine ?? "tonos", words });
    const aroll = path.join(OUT, "a-roll.mp4");
    const vf = [
      "format=yuv420p",
      // "persona": círculo/cabeza y hombros estilizados al centro-izquierda (para probar reencuadre)
      "drawbox=x=620:y=300:w=360:h=420:color=0xE8C4A0@1:t=fill",
      "drawbox=x=520:y=700:w=560:h=380:color=0x3A4A6B@1:t=fill",
      drawtext("A-ROLL · Ana (Zyra)", "fontsize=42:fontcolor=white:x=60:y=60:box=1:boxcolor=black@0.4:boxborderw=14"),
      drawtext("%{pts\\:hms}", "fontsize=32:fontcolor=white@0.8:x=w-tw-60:y=60"),
    ].join(",");
    ff([
      "-f", "lavfi", "-i", `gradients=s=1920x1080:c0=0x1d2b3a:c1=0x31495e:x0=0:y0=0:x1=1920:y1=1080:d=${duration.toFixed(2)}:speed=0.002,fps=30`,
      "-i", voice,
      "-filter_complex", `[0:v]${vf}[v]`,
      "-map", "[v]", "-map", "1:a",
      "-t", duration.toFixed(3),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k",
      "-metadata", `comment=${meta}`,
      "-metadata", "title=A-roll de prueba",
      aroll,
    ]);
    console.log(`  ✓ a-roll.mp4 (${duration.toFixed(1)} s, ${words.length} palabras con tiempos)`);

    // 2) B-roll sin voz
    ff(["-f", "lavfi", "-i", "gradients=s=1920x1080:c0=0xF6D5B3:c1=0x8B7CF0:c2=0xBFEFD3:n=3:speed=0.02:d=8,fps=30", "-f", "lavfi", "-i", "anoisesrc=d=8:c=pink:a=0.01",
      "-vf", drawtext("B-ROLL · ambiente", "fontsize=36:fontcolor=white:x=60:y=h-100:box=1:boxcolor=black@0.3:boxborderw=12"),
      "-t", "8", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", path.join(OUT, "b-roll-1.mp4")]);
    ff(["-f", "lavfi", "-i", "mandelbrot=s=1280x720:rate=30:end_scale=0.01:maxiter=200", "-t", "6",
      "-vf", `scale=1920:1080,${drawtext("B-ROLL · detalle", "fontsize=36:fontcolor=white:x=60:y=h-100:box=1:boxcolor=black@0.3:boxborderw=12")}`,
      "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", path.join(OUT, "b-roll-2.mp4")]);
    console.log("  ✓ b-roll-1.mp4, b-roll-2.mp4");

    // 3) Foto
    ff(["-f", "lavfi", "-i", "gradients=s=1600x1200:c0=0xFBE88A:c1=0xEE6B6B:d=1", "-frames:v", "1",
      "-vf", drawtext("FOTO de producto", "fontsize=72:fontcolor=white:x=(w-tw)/2:y=(h-th)/2"), path.join(OUT, "foto.jpg")]);

    // 4) Música: progresión de 4 acordes (C–G–Am–F) con pulso
    const chord = (f1, f2, f3, d) => `sine=f=${f1}:d=${d}[a];sine=f=${f2}:d=${d}[b];sine=f=${f3}:d=${d}[c];[a][b][c]amix=inputs=3`;
    const chords = [[261.6, 329.6, 392], [196, 246.9, 392], [220, 261.6, 329.6], [174.6, 220, 349.2]];
    const segs = [];
    for (let i = 0; i < 15; i++) {
      const [a, b, c] = chords[i % 4];
      const seg = path.join(tmp, `m${i}.wav`);
      ff(["-f", "lavfi", "-i", chord(a, b, c, 4), "-af", "volume=0.5,tremolo=f=4:d=0.35,afade=t=in:d=0.05,afade=t=out:st=3.9:d=0.1", "-ar", "48000", "-ac", "2", seg]);
      segs.push(seg);
    }
    const mlist = path.join(tmp, "m.txt");
    writeFileSync(mlist, segs.map((s) => `file '${s}'`).join("\n"));
    ff(["-f", "concat", "-safe", "0", "-i", mlist, "-af", "afade=t=out:st=57:d=3", "-c:a", "aac", "-b:a", "160k", path.join(OUT, "musica.m4a")]);
    console.log("  ✓ musica.m4a (60 s)");

    // 5) SFX
    ff(["-f", "lavfi", "-i", "anoisesrc=d=0.7:c=white:a=0.6", "-af", "highpass=f=400,lowpass=f=6000,afade=t=in:d=0.25,afade=t=out:st=0.35:d=0.35,volume=0.8", "-ar", "48000", path.join(OUT, "whoosh.wav")]);
    ff(["-f", "lavfi", "-i", "sine=f=70:d=0.4", "-af", "afade=t=out:st=0.02:d=0.38,volume=2", "-ar", "48000", path.join(OUT, "golpe.wav")]);
    console.log("  ✓ whoosh.wav, golpe.wav");

    // 6) Logo PNG transparente
    ff(["-f", "lavfi", "-i", "color=c=black@0.0:s=800x300,format=rgba", "-frames:v", "1",
      "-vf", drawtext("ZYRA", "fontsize=180:fontcolor=0x8B7CF0:x=(w-tw)/2:y=(h-th)/2"), path.join(OUT, "logo.png")]);
    console.log("  ✓ logo.png");

    // 7) Guion
    writeFileSync(path.join(OUT, "guion.txt"), GUION.join("\n") + "\n");
    console.log("  ✓ guion.txt");
    console.log(`\nListo. Arrastra estos archivos a MATERIAL en la app (${readdirSync(OUT).length} archivos).`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
