/**
 * Motor HyperFrames (por defecto): plantilla HTML + GSAP → composición → render con Chrome headless
 * en un PROCESO APARTE (hyperframes-worker.mjs, vía child_process.fork) → secuencia PNG RGBA →
 * ffmpeg la empaqueta en un MOV qtrle con alfa listo para superponer.
 *
 * Por qué png-sequence: es el intermedio más rápido (sin codificar VP9/ProRes dentro del motor;
 * hyperframes.md §11: 4.9 s contra 10.5 s de ProRes y 12.8 s de WebM para 3 s a 1080x1920) y
 * sin pérdida. Empaquetarlo en qtrle cuesta ~1 s.
 *
 * Reglas aplicadas (docs/research/hyperframes.md y skill hyperframes-core):
 *  - GSAP se VENDORIZA en cada proyecto (vendor/gsap.min.js): el CDN puede estar bloqueado y el
 *    compilador lo necesita local; las URLs de CDN de GSAP en plantillas propias se reescriben.
 *  - Las fuentes van como @font-face con archivos locales dentro del proyecto (el compilador las
 *    incrusta); así una fuente de marca sale igual en ffmpeg/ASS y en HyperFrames.
 *  - Chrome: HYPERFRAMES_BROWSER_PATH / PRODUCER_HEADLESS_SHELL_PATH (headless shell con
 *    BeginFrame), o el que HyperFrames descargó (`npx hyperframes browser ensure`).
 *  - Los props se validan aquí (la API no tiene modo estricto) y se escapan para HTML.
 */
import { fork } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MotionTemplate, ProvidersConfig } from "@autoeditor/shared";
import { formatCommand, runFfmpeg } from "../render/ffmpeg.js";
import { FontLibrary, type ResolvedFont } from "../render/fonts.js";
import { num } from "../render/graph.js";
import { UserFacingError, type Availability, type Log, type MotionEngine, type MotionRenderInput, type RunOptions } from "../services/types.js";
import { atomicCopy, graphicCacheKey } from "./builtin.js";
import { findTemplateDef, resolveProps, TEMPLATES, toMotionTemplate, type PropValue } from "./templates.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const WORKER = path.join(here, "hyperframes-worker.mjs");
/** Sube este número si cambia cómo se arma el proyecto (invalida la caché). */
const HF_VERSION = 1;

export interface HyperframesDeps {
  config: ProvidersConfig["motion"]["hyperframes"];
  ffmpegPath: string;
  log: Log;
  fontsCacheDir: string | null;
  cacheDir: string | null;
  /** Hilos de captura de Chrome (por defecto 2; cada uno es un Chrome de ~256 MB). */
  workers?: number;
}

/** Ruta de Chrome headless: variables de entorno o la caché de HyperFrames / Puppeteer. */
export function findChrome(): { path: string | null; source: string } {
  for (const key of ["PRODUCER_HEADLESS_SHELL_PATH", "HYPERFRAMES_BROWSER_PATH"]) {
    const v = process.env[key]?.trim();
    if (v) return existsSync(v) ? { path: v, source: key } : { path: null, source: `${key} apunta a un archivo que no existe (${v})` };
  }
  const roots = [path.join(os.homedir(), ".cache/hyperframes/chrome"), path.join(os.homedir(), ".cache/puppeteer/chrome-headless-shell")];
  const names = new Set(["chrome-headless-shell", "chrome-headless-shell.exe", "headless_shell"]);
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 4 || !existsSync(dir)) return null;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isFile() && names.has(e.name)) return p;
      if (e.isDirectory()) {
        const hit = walk(p, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  for (const r of roots) {
    const hit = walk(r, 0);
    if (hit) return { path: hit, source: "caché" };
  }
  return { path: null, source: "no encontrado" };
}

/** Carpeta de un paquete en node_modules (los paquetes solo-ESM no se pueden resolver con require). */
export function findPackageDir(name: string, from = here): string | null {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return path.dirname(candidate);
    if (path.dirname(dir) === dir) return null;
  }
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Sustituye {{marcadores}}: props (escapados), reservados del motor y vacía los desconocidos. */
export function fillTemplate(html: string, props: Record<string, PropValue>, reserved: Record<string, string>): string {
  let out = html.replace(/<script[^>]+src=["'][^"']*gsap[^"']*\.js["'][^>]*>\s*<\/script>/gi, '<script src="vendor/gsap.min.js"></script>');
  out = out.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, key: string) => {
    if (key in reserved) return reserved[key]!;
    const v = props[key];
    if (v == null) return "";
    return typeof v === "string" ? escHtml(v) : String(v);
  });
  return out;
}

export function createHyperframesEngine(deps: HyperframesDeps): MotionEngine {
  const fonts = new FontLibrary({ log: deps.log, googleCacheDir: deps.fontsCacheDir });
  const templates = TEMPLATES.map((t) => toMotionTemplate(t, "hyperframes"));
  let lastFailure: string | null = null;

  function staticCheck(): Availability & { chrome: string | null } {
    if (!deps.config.enabled) return { ready: false, detail: "HyperFrames está apagado en config/providers.json (motion.hyperframes.enabled).", chrome: null };
    if (!findPackageDir("@hyperframes/producer")) {
      return { ready: false, detail: "Falta el paquete @hyperframes/producer (corre pnpm instalar).", chrome: null };
    }
    try {
      require.resolve("gsap/dist/gsap.min.js");
    } catch {
      return { ready: false, detail: "Falta el paquete gsap (corre pnpm instalar).", chrome: null };
    }
    const chrome = findChrome();
    if (!chrome.path) {
      return { ready: false, detail: `No encuentro Chrome headless para HyperFrames (${chrome.source}). Corre: npx hyperframes browser ensure, o define HYPERFRAMES_BROWSER_PATH en .env.`, chrome: null };
    }
    return { ready: true, detail: `HyperFrames listo (Chrome: ${chrome.source}).`, chrome: chrome.path };
  }

  async function fontFaces(family: string, projectDir: string, given: MotionRenderInput["fonts"]): Promise<string> {
    const files: ResolvedFont[] = [];
    const custom = (given ?? []).filter((f) => f.family.toLowerCase() === family.toLowerCase());
    if (custom.length) {
      const lib = new FontLibrary({ log: deps.log, dirs: [...new Set(custom.map((f) => path.dirname(f.path)))], googleCacheDir: null });
      for (const w of [400, 600, 800, 900]) files.push(await lib.resolve({ family, weight: w }));
    } else {
      for (const w of [400, 500, 600, 700, 800, 900]) files.push(await fonts.resolve({ family, weight: w, googleFont: family, assetId: null }));
    }
    await mkdir(path.join(projectDir, "fonts"), { recursive: true });
    const seen = new Set<string>();
    const rules: string[] = [];
    for (const f of files) {
      if (seen.has(f.file)) continue;
      seen.add(f.file);
      const name = `f${seen.size}${path.extname(f.file).toLowerCase()}`;
      await copyFile(f.file, path.join(projectDir, "fonts", name));
      // La familia CSS es la pedida (aunque haya caído a Inter), así el HTML siempre la encuentra.
      rules.push(`@font-face { font-family: "${family.replace(/"/g, "")}"; src: url("fonts/${name}") format("${name.endsWith(".otf") ? "opentype" : "truetype"}"); font-weight: ${f.weight}; font-style: normal; }`);
    }
    return rules.join("\n");
  }

  function runWorker(msg: Record<string, unknown>, opts: RunOptions): Promise<{ frames: number | null; warnings: string[] }> {
    return new Promise((resolve, reject) => {
      const child = fork(WORKER, [], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        execArgv: [],
        env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", HYPERFRAMES_NO_UPDATE_CHECK: "1", HYPERFRAMES_NO_AUTO_INSTALL: "1", NO_COLOR: "1" },
      });
      let tail = "";
      const keep = (b: Buffer) => {
        tail = (tail + b.toString()).slice(-6000);
      };
      child.stdout?.on("data", keep);
      child.stderr?.on("data", keep);
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const kill = () => {
        try {
          child.send({ type: "abort" });
        } catch {
          // ya cerró
        }
        setTimeout(() => child.kill("SIGKILL"), 3000).unref();
      };
      const onAbort = () => {
        kill();
        finish(() => reject(opts.signal?.reason instanceof Error ? opts.signal.reason : new UserFacingError("cancelado", "Se canceló el render del gráfico", 409)));
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        kill();
        finish(() => reject(new UserFacingError("tiempo-agotado", "HyperFrames tardó demasiado en renderizar el gráfico", 504, { tail: tail.slice(-1500) })));
      }, deps.config.timeoutMs);
      child.on("message", (m: { type: string; progress?: number; message?: string; frames?: number | null; warnings?: string[]; name?: string; status?: string; outcome?: string }) => {
        if (m.type === "progress") opts.onProgress?.(Math.max(0, Math.min(1, (m.progress ?? 0) / 100)), "Renderizando el gráfico con HyperFrames");
        else if (m.type === "done") {
          if (m.status === "complete" || m.outcome === "completed" || m.outcome === "completed_with_warnings") finish(() => resolve({ frames: m.frames ?? null, warnings: m.warnings ?? [] }));
          else finish(() => reject(new Error(`HyperFrames terminó con estado ${m.status ?? "?"}`)));
        } else if (m.type === "error") {
          finish(() => reject(Object.assign(new Error(`${m.name ?? "Error"}: ${m.message ?? ""}`), { tail })));
        }
      });
      child.on("error", (err) => finish(() => reject(err)));
      child.on("exit", (code) => finish(() => reject(Object.assign(new Error(`El proceso de HyperFrames terminó (código ${code}) sin respuesta`), { tail }))));
      child.send(msg);
    });
  }

  async function render(input: MotionRenderInput, opts: RunOptions = {}): Promise<{ path: string; hasAlpha: boolean; seconds: number }> {
    const t0 = Date.now();
    const check = staticCheck();
    if (!check.ready) throw new UserFacingError("hyperframes-no-disponible", check.detail, 503);
    const def = findTemplateDef(input.template.id);
    const source = input.template.source?.trim() ? input.template.source : def?.html;
    if (!source) throw new UserFacingError("plantilla-sin-html", `La plantilla «${input.template.name}» no tiene HTML para HyperFrames.`, 422);
    const schema: MotionTemplate["propsSchema"] = Object.keys(input.template.propsSchema ?? {}).length ? input.template.propsSchema : (def?.propsSchema ?? {});
    const props = resolveProps(schema, input.props);
    const key = graphicCacheKey("hyperframes", { ...input, props }, HF_VERSION);
    const cached = deps.cacheDir ? path.join(deps.cacheDir, `hf-${key}.mov`) : null;
    if (cached && existsSync(cached)) {
      await atomicCopy(cached, input.outPath);
      return { path: input.outPath, hasAlpha: true, seconds: (Date.now() - t0) / 1000 };
    }
    const { width: W, height: H, fps } = input;
    const vertical = H > W;
    const duration = Math.max(0.2, Math.round(input.duration * 1000) / 1000);
    const baseDir = deps.cacheDir ?? path.dirname(input.outPath);
    await mkdir(baseDir, { recursive: true });
    const projectDir = path.join(baseDir, `.hf-${key}-${process.pid}-${Date.now()}`);
    try {
      await mkdir(path.join(projectDir, "vendor"), { recursive: true });
      await copyFile(require.resolve("gsap/dist/gsap.min.js"), path.join(projectDir, "vendor", "gsap.min.js"));
      const family = String(props.fontFamily ?? "Inter") || "Inter";
      const pos = String(props.position ?? "centro");
      const reserved: Record<string, string> = {
        width: String(W),
        height: String(H),
        duration: num(duration, 3),
        unit: num(Math.min(W, H) / 1080, 5),
        padTop: String(Math.round(H * (vertical ? 0.12 : 0.08))),
        padBottom: String(Math.round(H * (vertical ? 0.22 : 0.1))),
        padX: String(Math.round(W * (vertical ? 0.07 : 0.06))),
        fontFamily: escHtml(family),
        fontFaces: await fontFaces(family, projectDir, input.fonts),
        justify: pos === "arriba" ? "flex-start" : pos === "abajo" ? "flex-end" : "center",
        bgOpacity: props.showBackground === false ? "0" : "1",
      };
      await writeFile(path.join(projectDir, "index.html"), fillTemplate(source, props, reserved), "utf8");
      const seqDir = path.join(projectDir, "out-seq");
      try {
        await runWorker({ type: "render", projectDir, outputPath: seqDir, fps, format: "png-sequence", quality: "standard", workers: deps.workers ?? 2, chromePath: check.chrome }, {
          signal: opts.signal,
          onProgress: opts.onProgress ? (f, m) => opts.onProgress!(f * 0.9, m) : undefined,
        });
      } catch (err) {
        const tail = (err as { tail?: string }).tail ?? "";
        lastFailure = err instanceof Error ? err.message : String(err);
        deps.log.warn({ err: lastFailure, tail: tail.slice(-800) }, "HyperFrames falló");
        if (err instanceof UserFacingError) throw err;
        throw new UserFacingError("hyperframes-fallo", `HyperFrames no pudo renderizar el gráfico: ${lastFailure}`, 500, { tail: tail.slice(-1500) });
      }
      const pngs = (await readdir(seqDir)).filter((f) => f.endsWith(".png")).sort();
      if (!pngs.length) throw new UserFacingError("hyperframes-fallo", "HyperFrames no produjo fotogramas.", 500);
      const m = /^(.*?)(\d+)\.png$/.exec(pngs[0]!);
      const pattern = m ? `${m[1]}%0${m[2]!.length}d.png` : "frame_%06d.png";
      const startNumber = m ? Number(m[2]) : 1;
      const frames = Math.max(1, Math.round(duration * fps));
      const target = cached ?? input.outPath;
      const partial = path.join(projectDir, "out.mov");
      const args = ["-framerate", num(fps, 6), "-start_number", String(startNumber), "-i", path.join(seqDir, pattern), "-frames:v", String(frames), "-c:v", "qtrle", "-pix_fmt", "argb", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-map_metadata", "-1", partial];
      deps.log.debug({ cmd: formatCommand(deps.ffmpegPath, args) }, "HyperFrames → MOV");
      await runFfmpeg(deps.ffmpegPath, args, { signal: opts.signal, timeoutMs: 5 * 60 * 1000, log: deps.log, what: "empaquetar el gráfico de HyperFrames" });
      await atomicCopy(partial, target);
      if (cached) await atomicCopy(cached, input.outPath);
      lastFailure = null;
      opts.onProgress?.(1, "Gráfico listo");
    } finally {
      await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return { path: input.outPath, hasAlpha: true, seconds: (Date.now() - t0) / 1000 };
  }

  return {
    id: "hyperframes",
    async available() {
      const c = staticCheck();
      if (!c.ready) return { ready: false, detail: c.detail };
      if (lastFailure) return { ready: false, detail: `El último render de HyperFrames falló: ${lastFailure}` };
      return { ready: true, detail: c.detail };
    },
    renderGraphic: render,
    builtinTemplates: () => templates.map((t) => ({ ...t, propsSchema: { ...t.propsSchema } })),
  };
}
