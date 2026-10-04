/**
 * Rostros con el worker de Python (OpenCV Haar) sobre los fotogramas clave.
 * Si Python u OpenCV no están, el análisis sigue sin rostros (no es un error fatal).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../env.js";
import { runProcess, stderrSummary } from "./process.js";

export const FACES_SCRIPT = path.join(REPO_ROOT, "workers/python/faces.py");

export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  score: number;
}

export interface FaceImageResult {
  path: string;
  width: number;
  height: number;
  faces: FaceBox[];
  error?: string;
}

export interface FacesOutcome {
  ok: boolean;
  images: FaceImageResult[];
  /** Motivo en español si no se pudo correr. */
  detail: string;
}

export async function detectFaces(python: string, images: string[], opts: { signal?: AbortSignal; timeoutMs?: number; script?: string } = {}): Promise<FacesOutcome> {
  const script = opts.script ?? FACES_SCRIPT;
  if (images.length === 0) return { ok: true, images: [], detail: "" };
  if (!existsSync(script)) return { ok: false, images: [], detail: "No se encontró workers/python/faces.py" };
  let res;
  try {
    res = await runProcess(python, [script, ...images], {
      label: "Python (rostros)",
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 60_000 + images.length * 2_000,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return { ok: false, images: [], detail: err instanceof Error ? err.message : String(err) };
  }
  const line = res.stdout
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.trim().startsWith("{"));
  if (!line) return { ok: false, images: [], detail: `El detector de rostros no respondió (${stderrSummary(res.stderr, 1) || `código ${res.code}`})` };
  try {
    const msg = JSON.parse(line) as { type: string; message?: string; images?: FaceImageResult[] };
    if (msg.type === "error") return { ok: false, images: [], detail: msg.message ?? "Error en el detector de rostros" };
    return { ok: true, images: msg.images ?? [], detail: "" };
  } catch {
    return { ok: false, images: [], detail: "Respuesta inválida del detector de rostros" };
  }
}

/** ¿Python con OpenCV (y la cascada Haar) está disponible? */
export async function facesAvailable(python: string): Promise<{ ready: boolean; detail: string }> {
  try {
    const res = await runProcess(python, ["-c", "import cv2,os;print(cv2.__version__, os.path.isfile(cv2.data.haarcascades+'haarcascade_frontalface_default.xml'))"], {
      label: "Python",
      timeoutMs: 20_000,
    });
    const out = res.stdout.trim();
    if (res.code === 0 && /True$/.test(out)) return { ready: true, detail: `OpenCV ${out.split(" ")[0]}` };
    return { ready: false, detail: "OpenCV sin clasificadores Haar (corre pnpm instalar)" };
  } catch {
    return { ready: false, detail: "Python no disponible (corre pnpm instalar)" };
  }
}
