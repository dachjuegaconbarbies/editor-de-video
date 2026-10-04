/**
 * Pedidos de IA generativa dentro de la receta: elige el modelo de la configuración y calcula su costo.
 * Lo usan el editor demo, la herramienta "pedir generación con IA" de Claude y la verificación de parches.
 */
import type { AiRequest, ProvidersConfig, Recipe } from "@autoeditor/shared";
import { estimateKieCostUsd, resolveKieModel } from "../kie/params.js";

/** Modelo y costo estimado para un pedido (null si no hay modelo de ese tipo). */
export function buildKieRequestCost(
  kie: ProvidersConfig["kie"],
  kind: AiRequest["kind"],
  explicitModel: string | null,
  req: Pick<AiRequest, "prompt" | "params">,
): { model: string; costUsd: number } | null {
  const m = resolveKieModel(kie, kind, explicitModel);
  if (!m) return null;
  return { model: m.id, costUsd: estimateKieCostUsd(m, req, kie.usdPerCredit) };
}

/**
 * Completa los pedidos de IA de una receta: modelo válido (o el de por defecto) y costo estimado.
 * No toca los pedidos que ya tienen resultado.
 */
export function completeAiRequests(recipe: Recipe, kie: ProvidersConfig["kie"]): Recipe {
  const ai = recipe.ai.map((a) => {
    if (a.resultAssetId) return a;
    const resolved = buildKieRequestCost(kie, a.kind, a.model || null, a);
    if (!resolved) return a;
    return { ...a, provider: a.provider || "kie", model: resolved.model, costUsd: a.costUsd ?? resolved.costUsd };
  });
  return { ...recipe, ai };
}

/** Cuántos pedidos de cada tipo hay (para respetar los máximos de las herramientas). */
export function countAi(recipe: Pick<Recipe, "ai">, kind: AiRequest["kind"]): number {
  return recipe.ai.filter((a) => a.kind === kind && a.usage !== "portada").length;
}
