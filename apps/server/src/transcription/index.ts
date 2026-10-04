/**
 * Módulo de transcripción (faster-whisper local, API compatible o demo).
 * STUB: lo reemplaza la implementación real. La firma de la fábrica es el contrato.
 */
import type { ModelsConfig } from "@autoeditor/shared";
import type { Env } from "../env.js";
import type { Log, Transcriber } from "../services/types.js";

export interface TranscriptionDeps {
  env: Env;
  config: ModelsConfig["transcription"];
  log: Log;
}

export function createTranscriber(_deps: TranscriptionDeps): Transcriber {
  return {
    provider: "demo",
    model: "demo",
    available: async () => ({ ready: false, detail: "No implementado" }),
    transcribe: async () => {
      throw new Error("Transcripción aún no implementada");
    },
  };
}
