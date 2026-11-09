/**
 * Motores de motion graphics:
 *  - hyperframes (por defecto): HTML + GSAP renderizado con Chrome headless en un proceso aparte.
 *  - builtin (respaldo sin navegador): las mismas plantillas con ffmpeg + libass, con alfa.
 *  - remotion (opcional, encendido en config/providers.json): las mismas plantillas dentro de una
 *    composición de Remotion, ProRes 4444 con alfa. Ver licencia en docs/research/skills-remotion-warp.md.
 *
 * Caché determinista compartida en data/motion-cache: hash(motor + plantilla + props + tamaño +
 * duración + fps) → si el clip existe se reutiliza (una corrección que no toca un gráfico no lo
 * vuelve a renderizar).
 */
import path from "node:path";
import type { ProvidersConfig } from "@autoeditor/shared";
import type { Env } from "../env.js";
import type { Log, MotionEngine, Services } from "../services/types.js";
import { createBuiltinMotionEngine } from "./builtin.js";
import { createHyperframesEngine } from "./hyperframes.js";
import { createRemotionEngine } from "./remotion.js";
import { TEMPLATES, toMotionTemplate } from "./templates.js";

export interface MotionDeps {
  env: Env;
  config: ProvidersConfig["motion"];
  log: Log;
}

export function createMotionEngines(deps: MotionDeps): Services["motion"] {
  const cacheDir = path.join(deps.env.dataDir, "motion-cache");
  const fontsCacheDir = path.join(deps.env.dataDir, "fonts-cache");
  const builtin = createBuiltinMotionEngine({ ffmpegPath: deps.env.ffmpegPath, log: deps.log, fontsCacheDir, cacheDir });
  const hyperframes = createHyperframesEngine({ config: deps.config.hyperframes, ffmpegPath: deps.env.ffmpegPath, log: deps.log, fontsCacheDir, cacheDir });
  const remotion = createRemotionEngine({ config: deps.config.remotion, log: deps.log, fontsCacheDir, cacheDir, bundleDir: path.join(deps.env.dataDir, "remotion-bundle") });
  return { hyperframes, builtin, remotion };
}

/** Plantillas de fábrica para un motor (útil para la caja de herramientas del editor). */
export function factoryTemplates(engine: "hyperframes" | "builtin" | "remotion") {
  return TEMPLATES.map((t) => toMotionTemplate(t, engine));
}

export { createBuiltinMotionEngine } from "./builtin.js";
export { createHyperframesEngine, findChrome } from "./hyperframes.js";
export { TEMPLATES } from "./templates.js";
export { createRemotionEngine, findRemotionBrowser } from "./remotion.js";
