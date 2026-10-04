/**
 * Cuenta de tokens y costo en USD de las llamadas a Claude, con los precios de config/models.json.
 */
import type { ModelsConfig } from "@autoeditor/shared";
import type { Usage } from "../../services/types.js";

/** Lo que reporta la API en `message.usage` (campos opcionales para tolerar versiones). */
export interface ApiUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function emptyUsage(model: string): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, model };
}

/** Precio por millón de tokens del modelo (o del modelo editor si no está en la lista). */
export function priceFor(models: ModelsConfig, modelId: string) {
  const list = models.claude.models;
  return (
    list.find((m) => m.id === modelId) ??
    list.find((m) => modelId.startsWith(m.id)) ??
    list.find((m) => m.id === models.claude.editor) ?? { id: modelId, label: modelId, inputUsdPerMTok: 0, outputUsdPerMTok: 0, cacheReadUsdPerMTok: 0 }
  );
}

/** Costo de un uso de la API. La escritura en caché se cobra a 1.25× el precio de entrada. */
export function costOf(models: ModelsConfig, modelId: string, u: ApiUsageLike): number {
  const p = priceFor(models, modelId);
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const usd = (input * p.inputUsdPerMTok + cacheWrite * p.inputUsdPerMTok * 1.25 + cacheRead * p.cacheReadUsdPerMTok + output * p.outputUsdPerMTok) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

/** Suma un uso de la API al acumulado (devuelve un objeto nuevo). */
export function addUsage(models: ModelsConfig, acc: Usage, servedModel: string, u: ApiUsageLike | null | undefined): Usage {
  if (!u) return acc;
  return {
    inputTokens: acc.inputTokens + (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: acc.outputTokens + (u.output_tokens ?? 0),
    cacheReadTokens: acc.cacheReadTokens + (u.cache_read_input_tokens ?? 0),
    costUsd: Math.round((acc.costUsd + costOf(models, servedModel, u)) * 1e6) / 1e6,
    model: acc.model,
  };
}

export function mergeUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    costUsd: Math.round((a.costUsd + b.costUsd) * 1e6) / 1e6,
    model: a.model,
  };
}
