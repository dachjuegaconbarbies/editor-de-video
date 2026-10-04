/**
 * Módulo de render (receta → ffmpeg).
 * STUB: lo reemplaza la implementación real. La firma de la fábrica es el contrato.
 */
import type { Env } from "../env.js";
import type { Log, Renderer } from "../services/types.js";

export interface RenderDeps {
  env: Env;
  log: Log;
}

export function createRenderer(_deps: RenderDeps): Renderer {
  const notReady = async (): Promise<never> => {
    throw new Error("Render aún no implementado");
  };
  return {
    available: async () => ({ ready: false, detail: "No implementado", version: "" }),
    render: notReady,
    renderFrame: notReady,
    poster: notReady,
    captionFiles: () => ({ srt: "", vtt: "WEBVTT\n", txt: "" }),
  };
}
