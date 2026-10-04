/**
 * Módulo de análisis de medios (ffprobe/ffmpeg + rostros).
 * STUB: lo reemplaza la implementación real. La firma de la fábrica es el contrato.
 */
import type { Env } from "../env.js";
import type { Log, MediaAnalyzer, StorageAdapter } from "../services/types.js";

export interface MediaDeps {
  env: Env;
  storage: StorageAdapter;
  log: Log;
}

export function createMediaAnalyzer(_deps: MediaDeps): MediaAnalyzer {
  const notReady = async (): Promise<never> => {
    throw new Error("Análisis de medios aún no implementado");
  };
  return {
    available: async () => ({ ready: false, detail: "No implementado", version: "" }),
    probe: notReady,
    thumbnail: notReady,
    frameAt: notReady,
    analyze: notReady,
  };
}
