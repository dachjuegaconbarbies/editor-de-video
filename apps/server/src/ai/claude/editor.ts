/**
 * EDITOR CON CLAUDE: implementa `EditorBrain` con el SDK oficial.
 *
 *  - plan / revisePlan: agente con herramientas (material, transcripción, fotogramas, borrador,
 *    proponer receta, fotogramas de la propuesta, plantillas, IA generativa, terminar).
 *  - correct: agente con la REGLA DE ORO (parche mínimo verificado con diffRecipes/changesOutsideAreas,
 *    hasta 3 intentos).
 *  - review: QA con fotogramas del render y salida estructurada + verificación determinista.
 *  - detectKeywords (modelo ayudante), styleRules, analyzeReference.
 */
import type { Keyword, PublishCopy, Recipe } from "@autoeditor/shared";
import { normalizeRecipe } from "@autoeditor/shared";
import type { AiDeps } from "../deps.js";
import type { CorrectionInput, CorrectionResult, EditInput, EditorBrain, EditPlanResult, RunOptions } from "../../services/types.js";
import { UserFacingError } from "../../services/types.js";
import { deterministicChecks, deterministicFix } from "../shared/checks.js";
import { applyPatchLoose, minimalPatch, scenesFromOutline, validateWith } from "../shared/recipe-ops.js";
import { buildStyleRules } from "../shared/style-rules.js";
import { normalize } from "../shared/text.js";
import { findOccurrences, wordsByAsset } from "../shared/transcript.js";
import { keywordId } from "../demo/keywords.js";
import { SYSTEM_CORRECT, SYSTEM_KEYWORDS, SYSTEM_PLAN, SYSTEM_REFERENCE, SYSTEM_REVIEW, SYSTEM_STYLE_RULES } from "../prompts/editor.js";
import { correctionMessage, planUserMessage, revisePlanMessage } from "../prompts/context.js";
import { KeywordsOutput, keywordsContent, QaOutput, referenceContent, reviewContent, StyleRulesSchema, styleRulesContent } from "../prompts/tasks.js";
import { toPatchOps } from "../tools/common.js";
import { correctDone, correctTools, newCorrectSession } from "../tools/correct.js";
import { newPlanSession, planTools, type PlanSession } from "../tools/plan.js";
import { runAgent } from "./agent.js";
import { callStructured, callText, createRuntime, modelFor, UsageMeter, type ClaudeRuntimeOptions } from "./client.js";

/** Turnos máximos de una corrección (es una tarea acotada). */
const MAX_CORRECTION_TURNS = 16;

export function createClaudeBrain(deps: AiDeps, opts: ClaudeRuntimeOptions = {}): EditorBrain {
  const rt = createRuntime(deps, opts);
  const kie = deps.providers.kie;
  const editor = modelFor(deps.models, "editor");
  const helper = modelFor(deps.models, "helper");
  const maxTurns = deps.models.claude.maxAgentTurns;

  /** Corre la sesión de plan (nueva o ajuste) y arma el resultado. */
  async function runPlan(input: EditInput, session: PlanSession, userMessage: string, what: string, ro: RunOptions = {}): Promise<EditPlanResult> {
    const meter = new UsageMeter(deps.models, editor.model);
    const tools = planTools(input, session, { kie, model: editor.model });
    ro.onProgress?.(0.03, "Claude está revisando el material");
    const outcome = await runAgent(rt, meter, {
      system: SYSTEM_PLAN,
      tools,
      userContent: userMessage,
      maxTurns,
      isDone: () => session.done != null,
      nudge: () =>
        session.recipe
          ? "Ya tienes una propuesta válida guardada. Si está lista, llama a terminar con el resumen y las escenas; si no, corrígela con proponer_receta."
          : "Todavía no hay ninguna propuesta válida. Envía la receta completa con proponer_receta y después llama a terminar.",
      what,
      signal: ro.signal,
      onTurn: (turn) => {
        session.turn = turn;
        const label = session.recipe ? `Claude está afinando la edición (propuesta ${session.proposals})` : "Claude está armando la edición";
        ro.onProgress?.(Math.min(0.95, 0.05 + 0.9 * (turn / maxTurns)), label);
      },
    });
    const recipe = session.recipe;
    if (!recipe) {
      throw new UserFacingError(
        "claude-sin-receta",
        outcome.exhausted
          ? `Claude usó sus ${maxTurns} turnos sin llegar a una edición válida. Vuelve a intentarlo (o sube maxAgentTurns en config/models.json).`
          : "Claude terminó sin proponer una edición válida. Vuelve a intentarlo.",
        502,
      );
    }
    const summary = session.done?.summary || outcome.lastText || recipe.notes || "Edición lista.";
    const final: Recipe = { ...recipe, notes: recipe.notes || summary };
    ro.onProgress?.(1, "Plan listo");
    deps.log.info({ turns: outcome.turns, proposals: session.proposals, usage: meter.usage }, "Claude terminó el plan");
    return {
      recipe: final,
      scenes: scenesFromOutline(final, input.assets, session.done?.outline ?? []),
      summary,
      newTemplates: session.newTemplates.filter((t) => final.tracks.graphics.some((g) => g.templateId === t.id)),
      usage: meter.usage,
    };
  }

  return {
    kind: "claude",
    model: editor.model,

    async plan(input, ro) {
      return runPlan(input, newPlanSession(maxTurns), planUserMessage(input), "planear la edición", ro);
    },

    async revisePlan(input, current, feedback, ro) {
      const valid = validateWith(input.toolbox, current);
      const start = valid.ok ? input.toolbox.materializeCaptions(valid.recipe) : normalizeRecipe(current);
      return runPlan(input, newPlanSession(maxTurns, start), revisePlanMessage(input, start, feedback), "ajustar el plan", ro);
    },

    async correct(input: CorrectionInput, ro?: RunOptions): Promise<CorrectionResult> {
      const meter = new UsageMeter(deps.models, editor.model);
      const turns = Math.min(maxTurns, MAX_CORRECTION_TURNS);
      const session = newCorrectSession(turns);
      ro?.onProgress?.(0.05, "Claude está interpretando la corrección");
      await runAgent(rt, meter, {
        system: SYSTEM_CORRECT,
        tools: correctTools(input, session, { kie }),
        userContent: correctionMessage(input),
        maxTurns: turns,
        isDone: () => correctDone(session),
        nudge: () => "Envía la corrección con enviar_parche (o una pregunta_aclaratoria si de verdad es ambigua).",
        what: "corregir el video",
        signal: ro?.signal,
        onTurn: (turn) => {
          session.turn = turn;
          ro?.onProgress?.(Math.min(0.95, 0.1 + 0.85 * (turn / turns)), "Claude está aplicando la corrección");
        },
      });
      ro?.onProgress?.(1, "Corrección lista");
      const base = { newTemplates: session.newTemplates, usage: meter.usage };
      if (session.result) {
        const r = session.result;
        const used = session.newTemplates.filter((t) => r.verification.recipe.tracks.graphics.some((g) => g.templateId === t.id));
        return { patch: r.verification.patch, areas: r.areas, summary: r.summary || "Corrección aplicada.", clarifyingQuestion: null, ruleSuggestion: r.ruleSuggestion, ...base, newTemplates: used };
      }
      if (session.clarify) {
        return { patch: [], areas: [], summary: "", clarifyingQuestion: session.clarify, ruleSuggestion: null, ...base, newTemplates: [] };
      }
      const why = session.lastFailure ? ` (${session.lastFailure.split("\n")[0]})` : "";
      return {
        patch: [],
        areas: [],
        summary: "",
        clarifyingQuestion: `No logré aplicar «${input.correction.trim()}» sin cambiar otras partes del video${why}. ¿Me lo explicas con más detalle o tocas en el reproductor el momento exacto?`,
        ruleSuggestion: null,
        ...base,
        newTemplates: [],
      };
    },

    async review(input, ro) {
      const meter = new UsageMeter(deps.models, editor.model);
      const det = deterministicChecks(input.recipe, input.rules, input.settings);
      let ai: QaOutput = { checks: [], fix_patch: null };
      if (input.frames.length) {
        ai = await callStructured(rt, meter, { role: "editor", system: SYSTEM_REVIEW, content: reviewContent(input), schema: QaOutput, what: "revisar la calidad", signal: ro?.signal });
      }
      // Deterministas primero (duración objetivo y reglas con check mandan); luego lo que vio Claude.
      const seen = new Set(det.map((c) => normalize(c.check)));
      const checks = [...det, ...ai.checks.filter((c) => c.check.trim() && !seen.has(normalize(c.check)))];
      let fixed: Recipe | null = null;
      if (ai.fix_patch?.length) {
        const parsed = toPatchOps(ai.fix_patch);
        if (!parsed.errors.length) fixed = applyPatchLoose(input.recipe, parsed.ops);
      }
      const afterClaude = fixed ?? input.recipe;
      const detFix = deterministicFix(afterClaude, input.rules, deterministicChecks(afterClaude, input.rules, input.settings));
      const final = detFix ?? fixed;
      const fixPatch = final ? minimalPatch(input.recipe, final) : [];
      return { checks, fixPatch: fixPatch.length ? fixPatch : null, usage: meter.usage };
    },

    async detectKeywords(input, ro) {
      const meter = new UsageMeter(deps.models, helper.model);
      const byAsset = wordsByAsset(input.transcripts);
      if (!byAsset.size) return { keywords: [], publishCopy: { title: "", description: "", hashtags: [], coverText: "" }, usage: meter.usage };
      const out = await callStructured(rt, meter, { role: "helper", system: SYSTEM_KEYWORDS, content: keywordsContent(input), schema: KeywordsOutput, what: "detectar las palabras clave", signal: ro?.signal });
      const disabled = new Set(input.existing.filter((k) => !k.enabled).map((k) => normalize(k.text)));
      const userTexts = new Set(input.existing.filter((k) => k.source === "usuario").map((k) => normalize(k.text)));
      const seen = new Set<string>();
      const keywords: Keyword[] = [];
      for (const p of out.palabras) {
        const text = p.texto.trim().replace(/\s+/g, " ");
        const norm = normalize(text);
        if (!norm || seen.has(norm) || userTexts.has(norm)) continue;
        // Apariciones reales: búsqueda en la transcripción; si no, los índices que citó Claude (validados).
        let occurrences = findOccurrences(text, byAsset);
        if (!occurrences.length) {
          occurrences = p.apariciones.flatMap((a) => {
            const w = byAsset.get(a.asset_id)?.find((x) => x.i === a.indice_palabra);
            return w ? [{ assetId: a.asset_id, wordIndex: w.i, t: w.start }] : [];
          });
        }
        if (!occurrences.length) continue;
        seen.add(norm);
        keywords.push({
          id: keywordId(text),
          text,
          category: p.categoria,
          source: "auto",
          enabled: !disabled.has(norm),
          occurrences,
          score: Math.round(Math.max(0, Math.min(1, p.puntaje)) * 100) / 100,
        });
      }
      const pub = out.publicar;
      const publishCopy: PublishCopy = {
        title: pub.titulo.trim(),
        description: pub.descripcion.trim(),
        hashtags: [...new Set(pub.hashtags.map((h) => `#${h.trim().replace(/^#+/, "").replace(/\s+/g, "")}`).filter((h) => h.length > 1))].slice(0, 10),
        coverText: pub.portada.trim(),
      };
      return { keywords, publishCopy, usage: meter.usage };
    },

    async styleRules(input, ro) {
      const meter = new UsageMeter(deps.models, editor.model);
      const draft = buildStyleRules(input);
      const out = await callStructured(rt, meter, { role: "editor", system: SYSTEM_STYLE_RULES, content: styleRulesContent(input, draft), schema: StyleRulesSchema, what: "escribir la ficha del estilo", signal: ro?.signal });
      const rules = out.reglas.map((r) => r.trim()).filter(Boolean);
      return { rulesMarkdown: out.ficha_markdown.trim() || draft.rulesMarkdown, rules: rules.length ? rules : draft.rules, usage: meter.usage };
    },

    async analyzeReference(input, ro) {
      const meter = new UsageMeter(deps.models, editor.model);
      const analysis = await callText(rt, meter, { role: "editor", system: SYSTEM_REFERENCE, content: referenceContent(input), what: "analizar la referencia", maxTokens: rt.stream ? 16_000 : 8_000, signal: ro?.signal });
      return { analysis, usage: meter.usage };
    },
  };
}
