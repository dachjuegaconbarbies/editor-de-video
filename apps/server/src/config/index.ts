/**
 * Carga y valida los archivos editables de /config (models.json, providers.json, estimator.json).
 * Si un archivo falta o es inválido, se usa un valor por defecto y se avisa en el log.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { EstimatorCoefficients, ModelsConfig, ProvidersConfig } from "@autoeditor/shared";
import type { Env } from "../env.js";

export interface AppConfig {
  models: ModelsConfig;
  providers: ProvidersConfig;
  estimator: EstimatorCoefficients;
  /** Problemas encontrados al cargar (se muestran en /config y en `pnpm doctor`). */
  warnings: string[];
}

function readJson(file: string): unknown {
  const raw = readFileSync(file, "utf8");
  const data = JSON.parse(raw) as Record<string, unknown>;
  delete data.$comment;
  return data;
}

const FALLBACK_MODELS: ModelsConfig = ModelsConfig.parse({
  claude: {
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", inputUsdPerMTok: 4, outputUsdPerMTok: 20, cacheReadUsdPerMTok: 0.2 },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", inputUsdPerMTok: 2, outputUsdPerMTok: 10, cacheReadUsdPerMTok: 0.2 },
    ],
  },
  transcription: {},
});

const FALLBACK_PROVIDERS: ProvidersConfig = ProvidersConfig.parse({
  kie: { defaults: { imagen: "", video: "", musica: "", voz: "", sfx: "" }, models: [] },
  motion: { hyperframes: {}, remotion: {} },
});

export function loadConfig(env: Pick<Env, "configDir">): AppConfig {
  const warnings: string[] = [];
  const load = <T>(name: string, schema: { safeParse: (d: unknown) => { success: true; data: T } | { success: false; error: { message: string } } }, fallback: T): T => {
    const file = path.join(env.configDir, name);
    if (!existsSync(file)) {
      warnings.push(`No existe config/${name}; se usan valores por defecto.`);
      return fallback;
    }
    try {
      const parsed = schema.safeParse(readJson(file));
      if (parsed.success) return parsed.data;
      warnings.push(`config/${name} no es válido: ${parsed.error.message}`);
    } catch (err) {
      warnings.push(`No se pudo leer config/${name}: ${(err as Error).message}`);
    }
    return fallback;
  };
  return {
    models: load("models.json", ModelsConfig, FALLBACK_MODELS),
    providers: load("providers.json", ProvidersConfig, FALLBACK_PROVIDERS),
    estimator: load("estimator.json", EstimatorCoefficients, EstimatorCoefficients.parse({})),
    warnings,
  };
}
