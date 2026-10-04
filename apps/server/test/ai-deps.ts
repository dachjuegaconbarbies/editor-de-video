/** Dependencias de IA para las pruebas: configuración real de /config, sin llaves y sin logs. */
import { loadConfig } from "../src/config/index.js";
import { loadEnv, REPO_ROOT } from "../src/env.js";
import type { AiDeps } from "../src/ai/index.js";
import type { Log } from "../src/services/types.js";
import path from "node:path";

export const silentLog: Log = { info() {}, warn() {}, error() {}, debug() {} };

export function testDeps(over: Partial<AiDeps["env"]> = {}): AiDeps {
  const env = loadEnv({ anthropicApiKey: "", kieApiKey: "", demoMode: true, configDir: path.join(REPO_ROOT, "config"), ...over });
  const config = loadConfig(env);
  if (config.warnings.length) throw new Error(`Configuración inválida: ${config.warnings.join("; ")}`);
  return { env, models: config.models, providers: config.providers, log: silentLog };
}
