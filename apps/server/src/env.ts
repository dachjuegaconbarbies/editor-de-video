/**
 * Variables de entorno del servidor. Se leen de `.env` en la raíz del monorepo (si existe).
 * Las llaves (ANTHROPIC_API_KEY, KIE_API_KEY…) solo viven aquí: nunca se envían al navegador.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Raíz del monorepo (apps/server/src → ../../..). */
export const REPO_ROOT = path.resolve(here, "../../..");

let loaded = false;
function loadDotEnv() {
  if (loaded) return;
  loaded = true;
  const file = path.join(REPO_ROOT, ".env");
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      // .env mal formado: seguimos con el entorno del proceso.
    }
  }
}

const str = (v: string | undefined, d = "") => (v === undefined || v.trim() === "" ? d : v.trim());
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v.trim() !== "" ? n : d;
};
const bool = (v: string | undefined, d = false) => (v === undefined || v.trim() === "" ? d : /^(1|true|si|sí|yes|on)$/i.test(v.trim()));

export interface Env {
  nodeEnv: "development" | "production" | "test";
  port: number;
  host: string;
  /** Carpeta de datos absoluta. */
  dataDir: string;
  configDir: string;
  maxUploadBytes: number;
  jobConcurrency: number;
  ffmpegPath: string;
  ffprobePath: string;
  pythonPath: string;
  anthropicApiKey: string;
  kieApiKey: string;
  transcriptionApiKey: string;
  /** Modo demo forzado o por falta de llave de Claude. */
  demoMode: boolean;
  ownerHeader: string;
  corsOrigins: string[];
  /** Carpeta de la interfaz compilada (se sirve en producción). */
  webDist: string;
}

export function loadEnv(overrides: Partial<Env> = {}): Env {
  loadDotEnv();
  const e = process.env;
  const dataDir = path.resolve(REPO_ROOT, str(e.DATA_DIR, "./data"));
  const anthropicApiKey = str(e.ANTHROPIC_API_KEY);
  const venvPython = path.join(REPO_ROOT, "workers/python/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const env: Env = {
    nodeEnv: (str(e.NODE_ENV, "development") as Env["nodeEnv"]) ?? "development",
    port: num(e.PORT, 4000),
    host: str(e.HOST, "127.0.0.1"),
    dataDir,
    configDir: path.resolve(REPO_ROOT, str(e.CONFIG_DIR, "./config")),
    maxUploadBytes: num(e.MAX_UPLOAD_MB, 4096) * 1024 * 1024,
    jobConcurrency: Math.max(1, num(e.JOB_CONCURRENCY, 1)),
    ffmpegPath: str(e.FFMPEG_PATH, "ffmpeg"),
    ffprobePath: str(e.FFPROBE_PATH, "ffprobe"),
    pythonPath: str(e.PYTHON_PATH, existsSync(venvPython) ? venvPython : process.platform === "win32" ? "python" : "python3"),
    anthropicApiKey,
    kieApiKey: str(e.KIE_API_KEY),
    transcriptionApiKey: str(e.TRANSCRIPTION_API_KEY),
    demoMode: bool(e.DEMO_MODE, false) || anthropicApiKey === "",
    ownerHeader: str(e.OWNER_HEADER, "x-owner-id").toLowerCase(),
    corsOrigins: str(e.CORS_ORIGINS, "http://localhost:5173")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    webDist: path.resolve(REPO_ROOT, "apps/web/dist"),
    ...overrides,
  };
  return env;
}
