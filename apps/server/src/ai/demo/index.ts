/**
 * EDITOR DEMO (determinista, sin IA): es lo que ve el usuario sin ANTHROPIC_API_KEY y el respaldo
 * cuando Claude no está disponible. Implementa el contrato `EditorBrain` completo.
 */
import type { Recipe } from "@autoeditor/shared";
import { normalizeRecipe } from "@autoeditor/shared";
import type { AiDeps } from "../deps.js";
import type { CorrectionInput, EditInput, EditorBrain, EditPlanResult } from "../../services/types.js";
import { deterministicChecks, deterministicFix } from "../shared/checks.js";
import { buildScenes, minimalPatch, verifyPatch } from "../shared/recipe-ops.js";
import { buildStyleRules } from "../shared/style-rules.js";
import { emptyUsage } from "../shared/usage.js";
import { interpretCorrection } from "./corrections.js";
import { detectKeywordsHeuristic } from "./keywords.js";
import { buildDemoPlan } from "./planner.js";

const MODEL = "demo";

export function createDemoBrain(deps: AiDeps): EditorBrain {
  const kie = deps.providers.kie;
  const usage = () => emptyUsage(MODEL);

  async function plan(input: EditInput): Promise<EditPlanResult> {
    const out = buildDemoPlan(input, { kie });
    return { recipe: out.recipe, scenes: out.scenes, summary: out.summary, newTemplates: [], usage: usage() };
  }

  return {
    kind: "demo",
    model: MODEL,
    plan: async (input, opts) => {
      opts?.onProgress?.(0.1, "Armando la edición (modo demo)");
      const res = await plan(input);
      opts?.onProgress?.(1, "Plan listo");
      return res;
    },

    async revisePlan(input, current, feedback) {
      // Los ajustes al plan son correcciones sobre la receta propuesta.
      const correctionInput: CorrectionInput = { ...input, current, correction: feedback, at: null, history: [] };
      const res = interpretCorrection(correctionInput, { kie, log: deps.log });
      let recipe: Recipe = normalizeRecipe(current);
      let summary: string;
      if (res.clarifyingQuestion || !res.patch.length) {
        summary = `Mantuve el plan: ${res.clarifyingQuestion ?? res.summary}`;
      } else {
        const verified = verifyPatch(current, res.patch, res.areas, input.toolbox);
        if (verified.recipe) recipe = verified.recipe;
        summary = `Ajusté el plan: ${res.summary}`;
      }
      recipe = { ...recipe, notes: [recipe.notes, summary].filter(Boolean).join(" ") };
      return { recipe, scenes: buildScenes(recipe, input.assets), summary, newTemplates: [], usage: usage() };
    },

    async correct(input) {
      const res = interpretCorrection(input, { kie, log: deps.log });
      return { ...res, usage: usage() };
    },

    async review(input) {
      const checks = deterministicChecks(input.recipe, input.rules, input.settings);
      const fixed = deterministicFix(input.recipe, input.rules, checks);
      const fixPatch = fixed ? minimalPatch(input.recipe, fixed) : null;
      return { checks, fixPatch: fixPatch && fixPatch.length ? fixPatch : null, usage: usage() };
    },

    async detectKeywords(input) {
      const res = detectKeywordsHeuristic(input);
      return { ...res, usage: usage() };
    },

    async styleRules(input) {
      return { ...buildStyleRules(input), usage: usage() };
    },

    async analyzeReference(input) {
      const likes = input.likes.trim();
      return {
        analysis:
          "El análisis de referencias visuales necesita a Claude: agrega ANTHROPIC_API_KEY en el archivo .env del servidor para activarlo. " +
          (likes ? `Mientras tanto, anoté lo que te gusta de esta referencia: «${likes}», y lo tomo en cuenta como instrucción.` : "Mientras tanto, describe en «qué me gusta de esto» lo que quieres tomar de la referencia."),
        usage: usage(),
      };
    },
  };
}
