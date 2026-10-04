/** Dependencias comunes de las fábricas de IA (configuración, llaves y log). */
import type { ModelsConfig, ProvidersConfig } from "@autoeditor/shared";
import type { Env } from "../env.js";
import type { Log } from "../services/types.js";

export interface AiDeps {
  env: Env;
  models: ModelsConfig;
  providers: ProvidersConfig;
  log: Log;
}
