/**
 * Motores de motion graphics: HyperFrames (por defecto), builtin (ffmpeg/ASS) y Remotion (opcional, apagado).
 * STUB: lo reemplaza la implementación real. La firma de la fábrica es el contrato.
 */
import type { ProvidersConfig } from "@autoeditor/shared";
import type { Env } from "../env.js";
import type { Log, Services } from "../services/types.js";

export interface MotionDeps {
  env: Env;
  config: ProvidersConfig["motion"];
  log: Log;
}

export function createMotionEngines(_deps: MotionDeps): Services["motion"] {
  return { hyperframes: null, builtin: null, remotion: null };
}
