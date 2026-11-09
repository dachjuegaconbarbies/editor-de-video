/**
 * Motor Remotion (opcional): la misma plantilla HTML + GSAP de los otros motores se carga en una
 * composición de Remotion (motion/remotion/Root.js) que coloca la timeline en el fotograma exacto.
 * Se renderiza en un PROCESO APARTE (remotion-worker.mjs) a ProRes 4444 con canal alfa (.mov).
 *
 * Licencia: Remotion es gratis para individuos y equipos de hasta 3 personas; con 4 o más hace
 * falta Company License (ver docs/research/skills-remotion-warp.md). Se activa en
 * config/providers.json (motion.remotion.enabled).
 *
 * Chrome: REMOTION_BROWSER_PATH, o el de Playwright (/opt/pw-browsers/chromium), o el headless
 * shell de HyperFrames; si no hay ninguno, Remotion descarga el suyo.
 */
import { fork } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MotionTemplate, ProvidersConfig } from "@autoeditor/shared";
import { FontLibrary, type ResolvedFont } from "../render/fonts.js";
import { num } from "../render/graph.js";
import { UserFacingError, type Availability, type Log, type MotionEngine, type MotionRenderInput, type RunOptions } from "../services/types.js";
import { atomicCopy, graphicCacheKey } from "./builtin.js";
import { fillTemplate, findChrome, findPackageDir } from "./hyperframes.js";
import { findTemplateDef, resolveProps, TEMPLATES, toMotionTemplate } from "./templates.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const WORKER = path.join(here, "remotion-worker.mjs");
const ENTRY = path.join(here, "remotion", "index.js");
/** Sube este número si cambia la composición o cómo se arma el HTML (invalida caché y bundle). */
const REMOTION_VERSION = 1;

const DEFAULT_NOTE =
  "Remotion requiere Company License para equipos de 4 o más personas y compra de «Renders» para renders automatizados (ver docs/research/skills-remotion-warp.md).";

export interface RemotionDeps {
  config: ProvidersConfig["motion"]["remotion"];
  log: Log;
  fontsCacheDir: string | null;
  cacheDir: string | null;
  /** Carpeta del bundle de webpack (se reutiliza entre renders). */
  bundleDir: string;
  concurrency?: number;
}

interface BrowserChoice {
  path: string | null;
  mode: "chrome-for-testing" | "headless-shell" | null;
  source: string;
}

/** Elige el Chrome para Remotion. `path: null` = que Remotion descargue el suyo. */
export function findRemotionBrowser(): BrowserChoice {
  const env = process.env.REMOTION_BROWSER_PATH?.trim();
  if (env) return existsSync(env) ? { path: env, mode: "chrome-for-testing", source: "REMOTION_BROWSER_PATH" } : { path: null, mode: null, source: `REMOTION_BROWSER_PATH apunta a un archivo que no existe (${env})` };
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() || "/opt/pw-browsers";
  const pwChrome = path.join(pw, "chromium");
  if (existsSync(pwChrome)) return { path: pwChrome, mode: "chrome-for-testing", source: "Chromium de Playwright" };
  if (existsSync(pw)) {
    for (const e of readdirSync(pw)) {
      const p = path.join(pw, e, "chrome-linux64", "chrome");
      if (e.startsWith("chromium-") && existsSync(p)) return { path: p, mode: "chrome-for-testing", source: "Chromium de Playwright" };
    }
  }
  const hf = findChrome();
  if (hf.path) return { path: hf.path, mode: "headless-shell", source: `headless shell (${hf.source})` };
  return { path: null, mode: null, source: "Remotion descargará su propio Chrome" };
}

const b64 = async (file: string) => (await readFile(file)).toString("base64");

export function createRemotionEngine(deps: RemotionDeps): MotionEngine {
  const fonts = new FontLibrary({ log: deps.log, googleCacheDir: deps.fontsCacheDir });
  const templates = TEMPLATES.map((t) => toMotionTemplate(t, "remotion"));
  const note = deps.config.licenseNote?.trim() || DEFAULT_NOTE;
  let lastFailure: string | null = null;

  function staticCheck(): Availability & { browser: BrowserChoice } {
    const browser = findRemotionBrowser();
    if (!deps.config.enabled) return { ready: false, detail: `Remotion está apagado en config/providers.json (motion.remotion.enabled). ${note}`, browser };
    for (const pkg of ["remotion", "@remotion/renderer", "@remotion/bundler", "react", "react-dom"]) {
      if (!findPackageDir(pkg)) return { ready: false, detail: `Falta el paquete ${pkg} (corre pnpm instalar).`, browser };
    }
    try {
      require.resolve("gsap/dist/gsap.min.js");
    } catch {
      return { ready: false, detail: "Falta el paquete gsap (corre pnpm instalar).", browser };
    }
    return { ready: true, detail: `Remotion listo (Chrome: ${browser.source}). ${note}`, browser };
  }

  /** @font-face con las fuentes incrustadas en base64 (el HTML va en un iframe srcDoc, sin archivos). */
  async function fontFaces(family: string, given: MotionRenderInput["fonts"]): Promise<string> {
    const files: ResolvedFont[] = [];
    const custom = (given ?? []).filter((f) => f.family.toLowerCase() === family.toLowerCase());
    if (custom.length) {
      const lib = new FontLibrary({ log: deps.log, dirs: [...new Set(custom.map((f) => path.dirname(f.path)))], googleCacheDir: null });
      for (const w of [400, 600, 800, 900]) files.push(await lib.resolve({ family, weight: w }));
    } else {
      for (const w of [400, 500, 600, 700, 800, 900]) files.push(await fonts.resolve({ family, weight: w, googleFont: family, assetId: null }));
    }
    const seen = new Set<string>();
    const rules: string[] = [];
    for (const f of files) {
      if (seen.has(f.file)) continue;
      seen.add(f.file);
      const otf = f.file.toLowerCase().endsWith(".otf");
      rules.push(
        `@font-face { font-family: "${family.replace(/"/g, "")}"; src: url("data:font/${otf ? "otf" : "ttf"};base64,${await b64(f.file)}") format("${otf ? "opentype" : "truetype"}"); font-weight: ${f.weight}; font-style: normal; }`,
      );
    }
    return rules.join("\n");
  }

  function runWorker(msg: Record<string, unknown>, opts: RunOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = fork(WORKER, [], { stdio: ["ignore", "pipe", "pipe", "ipc"], execArgv: [], env: { ...process.env, NO_COLOR: "1" } });
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
        finish(() => reject(new UserFacingError("tiempo-agotado", "Remotion tardó demasiado en renderizar el gráfico", 504, { tail: tail.slice(-1500) })));
      }, 10 * 60 * 1000);
      child.on("message", (m: { type: string; progress?: number; message?: string; name?: string }) => {
        if (m.type === "progress") opts.onProgress?.(Math.max(0, Math.min(1, (m.progress ?? 0) / 100)), m.message ?? "Renderizando el gráfico con Remotion");
        else if (m.type === "done") finish(resolve);
        else if (m.type === "error") finish(() => reject(Object.assign(new Error(`${m.name ?? "Error"}: ${m.message ?? ""}`), { tail })));
      });
      child.on("error", (err) => finish(() => reject(err)));
      child.on("exit", (code) => finish(() => reject(Object.assign(new Error(`El proceso de Remotion terminó (código ${code}) sin respuesta`), { tail }))));
      child.send(msg);
    });
  }

  async function render(input: MotionRenderInput, opts: RunOptions = {}): Promise<{ path: string; hasAlpha: boolean; seconds: number }> {
    const t0 = Date.now();
    const check = staticCheck();
    if (!check.ready) throw new UserFacingError("remotion-no-disponible", check.detail, 503);
    const def = findTemplateDef(input.template.id);
    const source = input.template.source?.trim() ? input.template.source : def?.html;
    if (!source) throw new UserFacingError("plantilla-sin-html", `La plantilla «${input.template.name}» no tiene HTML para Remotion.`, 422);
    const schema: MotionTemplate["propsSchema"] = Object.keys(input.template.propsSchema ?? {}).length ? input.template.propsSchema : (def?.propsSchema ?? {});
    const props = resolveProps(schema, input.props);
    const key = graphicCacheKey("remotion", { ...input, props }, REMOTION_VERSION);
    const cached = deps.cacheDir ? path.join(deps.cacheDir, `rm-${key}.mov`) : null;
    if (cached && existsSync(cached)) {
      await atomicCopy(cached, input.outPath);
      return { path: input.outPath, hasAlpha: true, seconds: (Date.now() - t0) / 1000 };
    }
    const { width: W, height: H, fps } = input;
    const vertical = H > W;
    const duration = Math.max(0.2, Math.round(input.duration * 1000) / 1000);
    const family = String(props.fontFamily ?? "Inter") || "Inter";
    const pos = String(props.position ?? "centro");
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
    const reserved: Record<string, string> = {
      width: String(W),
      height: String(H),
      duration: num(duration, 3),
      unit: num(Math.min(W, H) / 1080, 5),
      padTop: String(Math.round(H * (vertical ? 0.12 : 0.08))),
      padBottom: String(Math.round(H * (vertical ? 0.22 : 0.1))),
      padX: String(Math.round(W * (vertical ? 0.07 : 0.06))),
      fontFamily: esc(family),
      fontFaces: await fontFaces(family, input.fonts),
      justify: pos === "arriba" ? "flex-start" : pos === "abajo" ? "flex-end" : "center",
      bgOpacity: props.showBackground === false ? "0" : "1",
    };
    // GSAP incrustado (el iframe es srcDoc, no tiene carpeta) y window.__timelines inicializado.
    const gsap = await readFile(require.resolve("gsap/dist/gsap.min.js"), "utf8");
    const html = fillTemplate(source, props, reserved).replace('<script src="vendor/gsap.min.js"></script>', () => `<script>window.__timelines = window.__timelines || {};</script><script>${gsap}</script>`);

    const baseDir = deps.cacheDir ?? path.dirname(input.outPath);
    await mkdir(baseDir, { recursive: true });
    await mkdir(path.dirname(deps.bundleDir), { recursive: true });
    const bundleDir = `${deps.bundleDir}-v${REMOTION_VERSION}`;
    const partial = path.join(baseDir, `.rm-${key}-${process.pid}-${Date.now()}.mov`);
    try {
      await runWorker(
        {
          type: "render",
          bundleDir,
          entry: ENTRY,
          inputProps: { html, durationSeconds: duration, fps, width: W, height: H },
          outputPath: partial,
          browserExecutable: check.browser.path,
          chromeMode: check.browser.mode,
          concurrency: deps.concurrency ?? 2,
        },
        { signal: opts.signal, onProgress: opts.onProgress ? (f, m) => opts.onProgress!(f * 0.95, m) : undefined },
      );
      if (!existsSync(partial) || (await stat(partial)).size === 0) throw new UserFacingError("remotion-fallo", "Remotion no produjo el clip.", 500);
      await atomicCopy(partial, cached ?? input.outPath);
      if (cached) await atomicCopy(cached, input.outPath);
      lastFailure = null;
      opts.onProgress?.(1, "Gráfico listo");
    } catch (err) {
      if (err instanceof UserFacingError) throw err;
      const tail = (err as { tail?: string }).tail ?? "";
      lastFailure = err instanceof Error ? err.message : String(err);
      deps.log.warn({ err: lastFailure, tail: tail.slice(-800) }, "Remotion falló");
      throw new UserFacingError("remotion-fallo", `Remotion no pudo renderizar el gráfico: ${lastFailure}`, 500, { tail: tail.slice(-1500) });
    } finally {
      await rm(partial, { force: true }).catch(() => undefined);
    }
    return { path: input.outPath, hasAlpha: true, seconds: (Date.now() - t0) / 1000 };
  }

  return {
    id: "remotion",
    async available() {
      const c = staticCheck();
      if (!c.ready) return { ready: false, detail: c.detail };
      if (lastFailure) return { ready: false, detail: `El último render de Remotion falló: ${lastFailure}` };
      return { ready: true, detail: c.detail };
    },
    renderGraphic: render,
    builtinTemplates: () => templates.map((t) => ({ ...t, propsSchema: { ...t.propsSchema } })),
  };
}
