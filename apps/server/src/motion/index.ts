/**
 * Motores de motion graphics:
 *  - hyperframes (por defecto): HTML + GSAP renderizado con Chrome headless en un proceso aparte.
 *  - builtin (respaldo sin navegador): las mismas plantillas con ffmpeg + libass, con alfa.
 *  - remotion: apagado por licencia (ver docs/research/skills-remotion-warp.md); no hay dependencia.
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
import { TEMPLATES, toMotionTemplate } from "./templates.js";

export interface MotionDeps {
  env: Env;
  config: ProvidersConfig["motion"];
  log: Log;
}

const DEFAULT_REMOTION_NOTE =
  "Remotion está apagado: su licencia exige una licencia de empresa para compañías de más de 3 personas. Se puede activar en config/providers.json si tu caso lo permite.";

/** Motor Remotion: siempre no disponible (sin dependencia instalada). */
function createRemotionStub(config: ProvidersConfig["motion"]["remotion"]): MotionEngine {
  const note = config.licenseNote?.trim() || DEFAULT_REMOTION_NOTE;
  return {
    id: "remotion",
    available: async () => ({
      ready: false,
      detail: config.enabled ? `Remotion está activado en la configuración, pero este proyecto no lo incluye (no se instala por licencia). ${note}` : note,
    }),
    renderGraphic: async () => {
      throw new Error(note);
    },
    builtinTemplates: () => [],
  };
}

export function createMotionEngines(deps: MotionDeps): Services["motion"] {
  const cacheDir = path.join(deps.env.dataDir, "motion-cache");
  const fontsCacheDir = path.join(deps.env.dataDir, "fonts-cache");
  const builtin = createBuiltinMotionEngine({ ffmpegPath: deps.env.ffmpegPath, log: deps.log, fontsCacheDir, cacheDir });
  const hyperframes = createHyperframesEngine({ config: deps.config.hyperframes, ffmpegPath: deps.env.ffmpegPath, log: deps.log, fontsCacheDir, cacheDir });
  return { hyperframes, builtin, remotion: createRemotionStub(deps.config.remotion) };
}

/** Plantillas de fábrica para un motor (útil para la caja de herramientas del editor). */
export function factoryTemplates(engine: "hyperframes" | "builtin") {
  return TEMPLATES.map((t) => toMotionTemplate(t, engine));
}

export { createBuiltinMotionEngine } from "./builtin.js";
export { createHyperframesEngine, findChrome } from "./hyperframes.js";
export { TEMPLATES } from "./templates.js";
