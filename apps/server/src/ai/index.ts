/**
 * IA: cerebro editor con Claude, editor demo determinista y proveedor generativo (Kie AI).
 * Las firmas de estas fábricas son el contrato que usa `services/container.ts`.
 */
import type { EditorBrain, GenerativeProvider } from "../services/types.js";
import type { AiDeps } from "./deps.js";
import { createClaudeBrain } from "./claude/editor.js";
import { createDemoBrain } from "./demo/index.js";
import { createKieProvider } from "./kie/provider.js";

export type { AiDeps } from "./deps.js";

/** Editor determinista sin IA (modo demo y respaldo). */
export function createDemoEditor(deps: AiDeps): EditorBrain {
  return createDemoBrain(deps);
}

/** Editor con Claude; devuelve null si no hay ANTHROPIC_API_KEY o está forzado el modo demo. */
export function createClaudeEditor(deps: AiDeps): EditorBrain | null {
  if (!deps.env.anthropicApiKey.trim() || deps.env.demoMode) return null;
  return createClaudeBrain(deps);
}

/** IA generativa con Kie AI (o marcadores locales en modo demo, sin llave o con DEMO_MODE). */
export function createGenerativeProvider(deps: AiDeps): GenerativeProvider {
  return createKieProvider(deps);
}
