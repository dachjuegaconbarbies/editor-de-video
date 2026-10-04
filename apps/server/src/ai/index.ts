/**
 * IA: cerebro editor con Claude, editor demo determinista y proveedor generativo (Kie AI).
 * STUB: lo reemplaza la implementación real. Las firmas de las fábricas son el contrato.
 */
import type { ModelsConfig, ProvidersConfig } from "@autoeditor/shared";
import type { Env } from "../env.js";
import type { EditorBrain, GenerativeProvider, Log } from "../services/types.js";

export interface AiDeps {
  env: Env;
  models: ModelsConfig;
  providers: ProvidersConfig;
  log: Log;
}

const notReady = async (): Promise<never> => {
  throw new Error("Editor aún no implementado");
};

/** Editor determinista sin IA (modo demo y respaldo). */
export function createDemoEditor(_deps: AiDeps): EditorBrain {
  return {
    kind: "demo",
    model: "demo",
    plan: notReady,
    revisePlan: notReady,
    correct: notReady,
    review: notReady,
    detectKeywords: notReady,
    styleRules: notReady,
    analyzeReference: notReady,
  };
}

/** Editor con Claude; devuelve null si no hay ANTHROPIC_API_KEY o está forzado el modo demo. */
export function createClaudeEditor(_deps: AiDeps): EditorBrain | null {
  return null;
}

export function createGenerativeProvider(deps: AiDeps): GenerativeProvider {
  return {
    id: "kie",
    status: () => ({ configured: deps.env.kieApiKey !== "", demo: true, detail: "No implementado" }),
    models: () => deps.providers.kie.models,
    credits: async () => null,
    generate: async () => {
      throw new Error("Generación con IA aún no implementada");
    },
  };
}
