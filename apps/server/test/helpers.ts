/** Utilidades de prueba: app con DATA_DIR temporal, espera activa, multipart a mano y video de prueba. */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp, type BuildAppOptions, type BuiltApp } from "../src/app.js";

export interface TestApp extends BuiltApp {
  dataDir: string;
  close(): Promise<void>;
}

/** Arma la app con una carpeta de datos temporal propia, sin llaves y sin logs. */
export async function makeApp(opts: BuildAppOptions = {}): Promise<TestApp> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "autoeditor-test-"));
  const built = await buildApp({
    ...opts,
    logger: false,
    serveWeb: opts.serveWeb ?? false,
    env: {
      dataDir,
      anthropicApiKey: "",
      kieApiKey: "",
      transcriptionApiKey: "",
      demoMode: true,
      jobConcurrency: 1,
      corsOrigins: ["http://localhost:5173"],
      ...opts.env,
    },
  });
  return {
    ...built,
    dataDir,
    async close() {
      await built.app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Espera hasta que `fn` devuelva algo "verdadero" (o falla al pasar el tiempo). */
export async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 8000, label = "condición"): Promise<T> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v as T;
      last = v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Se agotó el tiempo esperando ${label} (último valor: ${String(last)})`);
}

/** Cuerpo multipart/form-data hecho a mano (sin dependencias). */
export function multipartBody(fields: Record<string, string>, file?: { field?: string; filename: string; contentType: string; data: Buffer }): { body: Buffer; contentType: string } {
  const boundary = `----autoeditor${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (file) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? "file"}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`),
    );
    chunks.push(file.data);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Genera un mp4 de prueba (video + tono) con ffmpeg. */
export async function makeTestVideo(outPath: string, seconds = 1): Promise<void> {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  await new Promise<void>((resolve, reject) => {
    const p = spawn(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `testsrc=duration=${seconds}:size=320x240:rate=30`,
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=440:duration=${seconds}`,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        outPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg salió con ${code}: ${err}`))));
  });
}
