#!/usr/bin/env node
/**
 * Instalación y diagnóstico del Autoeditor (multiplataforma: macOS, Linux, Windows).
 *
 *   pnpm instalar                 Instala todo lo necesario para correr en tu computadora.
 *   pnpm instalar -- --modelo small   Además descarga el modelo de transcripción (tiny|base|small|medium|large-v3|turbo).
 *   pnpm instalar -- --sin-python     Omite el worker de Python (la transcripción quedará en modo demo).
 *   pnpm instalar -- --e2e            Instala Chromium para las pruebas de interfaz (Playwright).
 *   pnpm diagnostico                Solo diagnostica (no instala nada).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const CHECK_ONLY = args.includes("--check");
const NO_PYTHON = args.includes("--sin-python");
const WITH_E2E = args.includes("--e2e");
const modelIdx = args.indexOf("--modelo");
const MODEL = modelIdx > -1 ? args[modelIdx + 1] : null;
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

const c = {
  ok: (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`),
  warn: (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`),
  bad: (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`),
  title: (s) => console.log(`\n\x1b[1m${s}\x1b[0m`),
  info: (s) => console.log(`    ${s}`),
};
let problems = 0;

function run(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, { encoding: "utf8", shell: isWin && !cmd.includes(path.sep), ...opts });
}
function ok(cmd, cmdArgs) {
  const r = run(cmd, cmdArgs);
  return !r.error && r.status === 0 ? (r.stdout || r.stderr || "").trim() : null;
}

function readEnv() {
  const file = path.join(ROOT, ".env");
  const env = {};
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

// ---------------------------------------------------------------------------
c.title("1. Node y pnpm");
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj > 22 || (maj === 22 && min >= 13)) c.ok(`Node ${process.versions.node}`);
else {
  c.bad(`Node ${process.versions.node} — se necesita 22.13 o más nuevo (usa nvm/fnm o https://nodejs.org).`);
  problems++;
}
const pnpmV = ok("pnpm", ["--version"]);
if (pnpmV) c.ok(`pnpm ${pnpmV}`);
else {
  c.bad("pnpm no encontrado. Actívalo con: corepack enable");
  problems++;
}

if (!CHECK_ONLY && pnpmV) {
  c.info("Instalando dependencias de JavaScript (pnpm install)…");
  const r = run("pnpm", ["install"], { cwd: ROOT, stdio: "inherit" });
  if (r.status === 0) c.ok("Dependencias instaladas");
  else {
    c.bad("pnpm install falló");
    problems++;
  }
}

// ---------------------------------------------------------------------------
c.title("2. ffmpeg (render)");
const env = readEnv();
const ffmpeg = env.FFMPEG_PATH || "ffmpeg";
const ffv = ok(ffmpeg, ["-version"]);
if (ffv) {
  c.ok(ffv.split("\n")[0]);
  const filters = ok(ffmpeg, ["-hide_banner", "-filters"]) || "";
  for (const f of ["subtitles", "ass", "drawtext", "xfade", "sidechaincompress", "loudnorm", "zoompan"]) {
    if (new RegExp(`\\s${f}\\s`).test(filters)) c.ok(`filtro ${f}`);
    else {
      c.warn(`ffmpeg sin el filtro "${f}" — instala una versión completa de ffmpeg.`);
    }
  }
  if (!ok(env.FFPROBE_PATH || "ffprobe", ["-version"])) {
    c.bad("ffprobe no encontrado (viene con ffmpeg).");
    problems++;
  }
} else {
  c.bad("ffmpeg no encontrado.");
  c.info(isMac ? "Instálalo con: brew install ffmpeg" : isWin ? "Instálalo con: winget install Gyan.FFmpeg" : "Instálalo con: sudo apt install ffmpeg");
  problems++;
}

// ---------------------------------------------------------------------------
c.title("3. Python (transcripción local con faster-whisper)");
const venvDir = path.join(ROOT, "workers/python/.venv");
const venvPy = path.join(venvDir, isWin ? "Scripts/python.exe" : "bin/python");
const req = path.join(ROOT, "workers/python/requirements.txt");
if (NO_PYTHON) {
  c.warn("Omitido (--sin-python). La transcripción usará el modo demo.");
} else {
  const sysPy = ["python3", "python"].map((p) => ({ p, v: ok(p, ["--version"]) })).find((x) => x.v);
  if (!sysPy) {
    c.bad("Python 3.9+ no encontrado. Instálalo desde https://www.python.org (o brew install python).");
    problems++;
  } else {
    c.ok(sysPy.v);
    if (!CHECK_ONLY && existsSync(req)) {
      if (!existsSync(venvPy)) {
        c.info("Creando entorno virtual en workers/python/.venv …");
        const uv = ok("uv", ["--version"]);
        const r = uv ? run("uv", ["venv", venvDir], { stdio: "inherit" }) : run(sysPy.p, ["-m", "venv", venvDir], { stdio: "inherit" });
        if (r.status !== 0) {
          c.bad("No se pudo crear el entorno virtual.");
          problems++;
        }
      }
      if (existsSync(venvPy)) {
        c.info("Instalando dependencias de Python (faster-whisper, OpenCV)…");
        const uv = ok("uv", ["--version"]);
        const r = uv
          ? run("uv", ["pip", "install", "--python", venvPy, "-r", req], { stdio: "inherit" })
          : run(venvPy, ["-m", "pip", "install", "-r", req], { stdio: "inherit" });
        if (r.status === 0) c.ok("Worker de Python listo");
        else {
          c.bad("Falló la instalación de dependencias de Python.");
          problems++;
        }
      }
    }
    if (existsSync(venvPy)) {
      const fw = ok(venvPy, ["-c", "import faster_whisper, sys; print(faster_whisper.__version__)"]);
      if (fw) c.ok(`faster-whisper ${fw}`);
      else c.warn("faster-whisper no está instalado en el entorno (corre pnpm instalar).");
      if (MODEL && !CHECK_ONLY) {
        c.info(`Descargando modelo de transcripción "${MODEL}" (solo la primera vez)…`);
        const r = run(venvPy, [path.join(ROOT, "workers/python/transcribe.py"), "--download-only", "--model", MODEL], { stdio: "inherit" });
        if (r.status === 0) c.ok(`Modelo ${MODEL} listo`);
        else c.warn("No se pudo descargar el modelo; se descargará al transcribir por primera vez.");
      }
    } else if (CHECK_ONLY) {
      c.warn("No existe workers/python/.venv — corre pnpm instalar para crearlo.");
    }
  }
}

// ---------------------------------------------------------------------------
c.title("4. Archivo .env y carpetas");
const envFile = path.join(ROOT, ".env");
if (!existsSync(envFile)) {
  if (!CHECK_ONLY) {
    copyFileSync(path.join(ROOT, ".env.example"), envFile);
    c.ok("Se creó .env a partir de .env.example — agrega tus llaves ahí.");
  } else c.warn("No existe .env (se creará con pnpm instalar).");
} else c.ok(".env existe");
const e2 = readEnv();
if (e2.ANTHROPIC_API_KEY) c.ok("ANTHROPIC_API_KEY configurada (Claude editará tus videos)");
else c.warn("Sin ANTHROPIC_API_KEY → MODO DEMO (editor automático sin IA). Agrégala en .env para que Claude edite.");
if (e2.KIE_API_KEY) c.ok("KIE_API_KEY configurada (imágenes/video/sfx/voz con IA)");
else c.warn("Sin KIE_API_KEY → la IA generativa usará marcadores de prueba.");
if (!CHECK_ONLY) {
  for (const d of ["data", "data/storage", "data/tmp"]) mkdirSync(path.join(ROOT, d), { recursive: true });
  c.ok("Carpetas de datos listas (data/)");
}

// ---------------------------------------------------------------------------
c.title("5. Skills para agentes (HyperFrames, Kie AI) — Claude Code y Warp");
// Claude Code solo lee .claude/skills/; Warp lee .agents/skills/ y .claude/skills/.
// `skills add … -a claude-code -a warp` deja la copia en .agents/skills y un enlace en .claude/skills
// (en Windows se copia, porque los enlaces simbólicos suelen fallar).
const claudeSkill = path.join(ROOT, ".claude/skills/hyperframes-core/SKILL.md");
const agentsSkill = path.join(ROOT, ".agents/skills/hyperframes-core/SKILL.md");
const skillAgents = ["-a", "claude-code", "-a", "warp", ...(isWin ? ["--copy"] : [])];
const skillsOk = () => existsSync(claudeSkill) && existsSync(agentsSkill);
if (skillsOk()) c.ok("Skills de HyperFrames instaladas (Claude Code y Warp)");
else if (!CHECK_ONLY) {
  if (maj === 22 && min < 20) c.warn("El instalador de skills pide Node 22.20 o más nuevo; si falla, actualiza Node.");
  c.info("Instalando las skills de HyperFrames (un solo git clone)…");
  run("npx", ["-y", "skills", "add", "heygen-com/hyperframes", "--full-depth", ...skillAgents, "-y"], { cwd: ROOT, stdio: "inherit" });
  if (skillsOk()) c.ok("Skills de HyperFrames instaladas (Claude Code y Warp)");
  else c.warn("No se pudieron instalar las skills de HyperFrames (requiere git y acceso a GitHub). Puedes correr: npx skills add heygen-com/hyperframes --full-depth -a claude-code -a warp");
  const kie = run("npx", ["-y", "skills", "add", "https://kie.ai", ...skillAgents, "-y"], { cwd: ROOT, stdio: "inherit" });
  if (kie.status === 0) c.ok("Skill de Kie AI instalada");
  else c.warn("No se pudo instalar la skill de Kie AI (opcional). Puedes correr: npx skills add https://kie.ai -a claude-code -a warp");
} else {
  if (!existsSync(agentsSkill)) c.warn("Skills de HyperFrames no instaladas (pnpm instalar las instala).");
  else c.warn("Las skills están en .agents/skills (Warp) pero no en .claude/skills (Claude Code); corre pnpm instalar.");
}

// ---------------------------------------------------------------------------
c.title("6. HyperFrames (motion graphics)");
const hfBin = path.join(ROOT, "apps/server/node_modules/.bin", isWin ? "hyperframes.cmd" : "hyperframes");
if (existsSync(hfBin)) {
  const v = ok(hfBin, ["--version"]);
  if (v) c.ok(`hyperframes ${v.split("\n")[0]}`);
  else c.warn("hyperframes instalado pero no responde; corre: npx hyperframes doctor");
  const hfEnv = { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", HYPERFRAMES_NO_UPDATE_CHECK: "1", HYPERFRAMES_NO_AUTO_INSTALL: "1" };
  if (e2.HYPERFRAMES_BROWSER_PATH) {
    c.ok(`Navegador para HyperFrames: ${e2.HYPERFRAMES_BROWSER_PATH}`);
  } else {
    const path0 = run(hfBin, ["browser", "path"], { env: hfEnv });
    if (path0.status === 0 && (path0.stdout || "").trim()) c.ok("Navegador para HyperFrames listo (chrome-headless-shell)");
    else if (!CHECK_ONLY) {
      c.info("Descargando el navegador que usa HyperFrames para renderizar (una sola vez, ~120 MB)…");
      const r = run(hfBin, ["browser", "ensure"], { env: hfEnv, stdio: "inherit" });
      if (r.status === 0) c.ok("Navegador para HyperFrames instalado");
      else c.warn("No se pudo descargar el navegador de HyperFrames; los motion graphics usarán el motor básico (ffmpeg).");
    } else c.warn("Falta el navegador de HyperFrames (pnpm instalar lo descarga).");
  }
} else c.warn("hyperframes no está instalado (corre pnpm install).");

if (WITH_E2E && !CHECK_ONLY) {
  c.title("7. Chromium para pruebas de interfaz");
  const r = run("pnpm", ["--filter", "@autoeditor/web", "exec", "playwright", "install", "chromium"], { cwd: ROOT, stdio: "inherit" });
  if (r.status === 0) c.ok("Chromium instalado");
  else c.warn("No se pudo instalar Chromium para Playwright.");
}

// ---------------------------------------------------------------------------
console.log("");
if (problems === 0) {
  console.log("\x1b[32m\x1b[1mTodo listo.\x1b[0m");
  console.log("  Arranca con:   pnpm dev     → abre http://localhost:5173");
  console.log("  Material de prueba: pnpm material-prueba  (se guarda en data/muestras)");
} else {
  console.log(`\x1b[31m\x1b[1m${problems} problema(s) por resolver\x1b[0m (arriba están las instrucciones).`);
  process.exitCode = 1;
}
