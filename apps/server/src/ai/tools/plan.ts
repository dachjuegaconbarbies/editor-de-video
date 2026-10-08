/**
 * Herramientas de la sesión de PLAN (y de ajuste del plan): borrador automático, proponer receta,
 * ver fotogramas de la propuesta, pedir generaciones con IA y terminar. Más las comunes (material,
 * transcripción, fotogramas, plantillas). El orden de la lista es fijo para que la caché funcione.
 */
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaToolResultContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { AiRequest, RESOLUTIONS, type ProvidersConfig, type Recipe } from "@autoeditor/shared";
import type { EditInput } from "../../services/types.js";
import { buildDemoPlan } from "../demo/planner.js";
import { buildKieRequestCost, completeAiRequests } from "../shared/ai-requests.js";
import { compactRecipe, recipeMetrics, validateWith, type SceneOutline } from "../shared/recipe-ops.js";
import { round2 } from "../shared/text.js";
import { FRAME_WIDTH, imageBlock, materialTools, strictTool, templateTools, type SessionCommon, type ToolOutput } from "./common.js";
import { aiAllowance, materialErrors, proposalReport } from "./recipe-checks.js";

export interface PlanSession extends SessionCommon {
  /** Última propuesta VÁLIDA (normalizada y con subtítulos materializados). */
  recipe: Recipe | null;
  proposals: number;
  /** Pedidos de IA creados con pedir_generacion_ia (se agregan solos a cada propuesta). */
  aiRequests: AiRequest[];
  done: { summary: string; outline: SceneOutline[] } | null;
  finishAttempts: number;
  /** Turno actual y máximo (para recordarle a Claude que termine a tiempo). */
  turn: number;
  maxTurns: number;
}

export function newPlanSession(maxTurns: number, start: Recipe | null = null): PlanSession {
  return { newTemplates: [], recipe: start, proposals: 0, aiRequests: [], done: null, finishAttempts: 0, turn: 0, maxTurns };
}

export interface PlanToolsContext {
  kie: ProvidersConfig["kie"];
  /** Modelo de Claude que firma la receta (meta.model). */
  model: string;
}

const MAX_PREVIEW_FRAMES = 6;

/** Recordatorio de turnos cuando quedan pocos. */
export function turnReminder(s: Pick<PlanSession, "turn" | "maxTurns">): string {
  const left = s.maxTurns - s.turn;
  return left <= 3 ? `\n\nAVISO: quedan ${Math.max(0, left)} turnos: propón la receta final y llama a terminar ya.` : "";
}

/** Completa lo que el servidor fija en toda propuesta: formato, objetivo, metadatos, pedidos de IA; quita lo materializado. */
export function prepareProposal(data: unknown, input: EditInput, session: PlanSession, ctx: PlanToolsContext): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const ins = input.settings.instruction;
  const r = structuredClone(data) as Record<string, unknown> & { tracks?: { captions?: Record<string, unknown> }; ai?: unknown[] };
  if (!r.format) r.format = { aspect: ins.format, ...RESOLUTIONS[ins.format], fps: 30, platform: ins.platform };
  r.target = ins.targetDuration != null ? { duration: ins.targetDuration, mode: ins.durationMode } : { duration: null, mode: "auto" };
  r.meta = {
    generator: "claude",
    model: ctx.model,
    styleId: input.settings.style.styleId,
    styleVersion: input.settings.style.styleVersion,
    appliedRuleIds: input.rules.filter((x) => x.enabled).map((x) => x.id),
  };
  if (r.tracks?.captions) r.tracks.captions.words = [];
  const ai = Array.isArray(r.ai) ? [...r.ai] : [];
  const ids = new Set(ai.map((a) => (a && typeof a === "object" ? (a as { id?: unknown }).id : null)));
  for (const req of session.aiRequests) if (!ids.has(req.id)) ai.push(req);
  r.ai = ai;
  return r;
}

export function planTools(input: EditInput, session: PlanSession, ctx: PlanToolsContext) {
  const { verMaterial, leerTranscripcion, verFotogramas } = materialTools(input);
  const { listarPlantillas, guiaHyperframes, escribirPlantilla } = templateTools(input, session);

  const borrador = strictTool(
    betaZodTool({
      name: "borrador_automatico",
      description:
        "Borrador determinista de la edición hecho por el servidor (quita silencios y muletillas sin cortar palabras, respeta la duración objetivo, reencuadra, agrega b-roll, títulos, subtítulos y música según las herramientas). Úsalo como punto de partida y mejóralo con criterio editorial.",
      inputSchema: z.object({}),
      run: async () => {
        try {
          const draft = buildDemoPlan(input, { kie: ctx.kie });
          return `Borrador (${draft.summary})\nMétricas: ${JSON.stringify(recipeMetrics(draft.recipe))}\nReceta:\n${JSON.stringify(compactRecipe(draft.recipe))}`;
        } catch (err) {
          return `No se pudo armar el borrador: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  );

  const proponer = strictTool(
    betaZodTool({
      name: "proponer_receta",
      description:
        "Propone la receta COMPLETA (JSON según el esquema). El servidor la valida, fija formato/objetivo/metadatos, agrega los pedidos de IA, materializa los subtítulos y devuelve errores (corrígelos y vuelve a proponer) o métricas y avisos editoriales. La última propuesta válida es la que se entrega.",
      inputSchema: z.object({
        receta_json: z.string().describe("La receta completa como JSON (sin tracks.captions.words)"),
        notas: z.string().describe("Resumen editorial breve: qué hiciste y por qué (va en recipe.notes)"),
      }),
      run: async ({ receta_json, notas }) => {
        session.proposals++;
        let data: unknown;
        try {
          data = JSON.parse(receta_json);
        } catch (err) {
          return `receta_json no es JSON válido: ${err instanceof Error ? err.message : String(err)}. Vuelve a enviarla completa.${turnReminder(session)}`;
        }
        const prepared = prepareProposal(data, input, session, ctx) as Record<string, unknown>;
        if (notas.trim() && prepared && typeof prepared === "object") prepared.notes = notas.trim();
        const valid = validateWith(input.toolbox, prepared);
        if (!valid.ok) return `La receta no es válida:\n- ${valid.errors.join("\n- ")}\nCorrige y vuelve a proponer.${turnReminder(session)}`;
        let recipe = completeAiRequests(valid.recipe, ctx.kie);
        const errors = materialErrors(recipe, input, session.newTemplates);
        if (errors.length) return `La receta tiene errores:\n- ${errors.join("\n- ")}\nCorrige y vuelve a proponer.${turnReminder(session)}`;
        recipe = input.toolbox.materializeCaptions(recipe);
        session.recipe = recipe;
        const report = proposalReport(recipe, input);
        return `Propuesta #${session.proposals} válida y guardada.\n${report.text}\nSi todo está bien, revisa fotogramas con ver_fotogramas_propuesta y llama a terminar.${turnReminder(session)}`;
      },
    }),
  );

  const verPropuesta = strictTool(
    betaZodTool({
      name: "ver_fotogramas_propuesta",
      description: `Fotogramas de cómo se ve la última propuesta válida (con textos, subtítulos, gráficos y b-roll) en segundos de la línea de tiempo FINAL (máximo ${MAX_PREVIEW_FRAMES}). Úsalo para revisar el gancho, la legibilidad y el encuadre.`,
      inputSchema: z.object({ tiempos: z.array(z.number()).describe("Segundos del video final") }),
      run: async ({ tiempos }): Promise<ToolOutput> => {
        const recipe = session.recipe;
        if (!recipe) return "Todavía no hay una propuesta válida: usa proponer_receta primero.";
        const blocks: BetaToolResultContentBlockParam[] = [];
        for (const t of tiempos.slice(0, MAX_PREVIEW_FRAMES)) {
          const tt = Math.max(0, Math.min(t, Math.max(0, recipe.duration - 0.05)));
          const frame = await input.toolbox.previewFrame(recipe, tt, FRAME_WIDTH);
          blocks.push({ type: "text", text: `Video final @ ${round2(tt)} s` }, imageBlock(frame.base64, frame.mediaType));
        }
        return blocks;
      },
    }),
  );

  const pedirIa = strictTool(
    betaZodTool({
      name: "pedir_generacion_ia",
      description:
        "Crea un pedido de generación con IA (Kie AI): imagen o video de b-roll, efecto de sonido, voz o música. El servidor elige el modelo (o usa el indicado), calcula el costo, respeta los máximos de las herramientas y lo agrega solo a la receta. No agregues overlays para el pedido: el resultado se coloca en placeAt (desde–hasta en el video final) cuando esté listo.",
      inputSchema: z.object({
        tipo: z.enum(["imagen", "video", "sfx", "voz", "musica"]),
        prompt: z.string().describe("Descripción visual/sonora concreta (en inglés o español), sin texto en pantalla"),
        prompt_negativo: z.string().nullable(),
        modelo: z.string().nullable().describe("Id del modelo (de la lista de modelos disponibles) o null para el de por defecto"),
        uso: z.enum(["broll", "fondo", "portada", "sfx", "voz", "musica"]),
        desde: z.number().nullable().describe("Segundo del video final donde se coloca (null si no aplica)"),
        hasta: z.number().nullable(),
        duracion: z.number().nullable().describe("Solo video/música: segundos a generar"),
      }),
      run: async (a) => {
        const allow = aiAllowance(input.settings)[a.tipo];
        if (!allow.allowed) return `No se puede pedir ${a.tipo} con IA: la herramienta está apagada (${allow.why}).`;
        const existing = [...session.aiRequests, ...(session.recipe?.ai ?? [])].filter((x, i, all) => all.findIndex((y) => y.id === x.id) === i);
        const count = existing.filter((x) => x.kind === a.tipo && x.usage !== "portada" && !x.resultAssetId).length;
        if (a.uso !== "portada" && count >= allow.max) return `Ya hay ${count} pedidos de ${a.tipo}: el máximo de las herramientas es ${allow.max}.`;
        if (a.modelo && !input.aiModels.some((m) => m.id === a.modelo && m.kind === a.tipo && m.enabled)) {
          return `El modelo ${a.modelo} no está disponible para ${a.tipo}. Modelos: ${input.aiModels.filter((m) => m.kind === a.tipo && m.enabled).map((m) => m.id).join(", ") || "(ninguno)"}.`;
        }
        const aspect = input.settings.instruction.format;
        const params: Record<string, unknown> = { aspectRatio: aspect };
        if (a.duracion != null && (a.tipo === "video" || a.tipo === "musica")) params.duration = a.duracion;
        else if (a.tipo === "video") params.duration = input.settings.tools.aiVideos.duration;
        const resolved = buildKieRequestCost(ctx.kie, a.tipo, a.modelo, { prompt: a.prompt, params });
        if (!resolved) return `No hay ningún modelo de IA configurado para ${a.tipo}.`;
        const placeAt = a.desde != null && a.hasta != null && a.hasta > a.desde ? { start: round2(a.desde), end: round2(a.hasta) } : null;
        const req = AiRequest.parse({
          id: `ia-${a.tipo}-${existing.length + 1}`,
          kind: a.tipo,
          provider: "kie",
          model: resolved.model,
          prompt: a.prompt,
          negativePrompt: a.prompt_negativo ?? "",
          params,
          usage: a.uso,
          placeAt,
          costUsd: resolved.costUsd,
        });
        session.aiRequests.push(req);
        return `Pedido creado: ${JSON.stringify(req)}\nSe agregará solo a la próxima propuesta (costo estimado US$${resolved.costUsd}).`;
      },
    }),
  );

  const terminar = strictTool(
    betaZodTool({
      name: "terminar",
      description: "Entrega la edición: requiere una propuesta válida. Incluye un resumen breve para el usuario (qué hiciste y por qué) y las escenas del storyboard en orden (título, inicio y fin en el video final, notas).",
      inputSchema: z.object({
        resumen: z.string(),
        escenas: z.array(z.object({ titulo: z.string(), inicio: z.number(), fin: z.number(), notas: z.string() })),
      }),
      run: async ({ resumen, escenas }) => {
        if (!session.recipe) return "No hay ninguna propuesta válida todavía: usa proponer_receta antes de terminar.";
        session.finishAttempts++;
        const report = proposalReport(session.recipe, input);
        if (!report.durationOk && session.finishAttempts < 2) {
          return `La propuesta no cumple la duración objetivo (${session.recipe.duration} s). Ajusta los cortes y vuelve a proponer; si de verdad no se puede, llama a terminar otra vez explicando por qué.`;
        }
        session.done = { summary: resumen.trim(), outline: escenas.map((e) => ({ title: e.titulo, start: e.inicio, end: e.fin, notes: e.notas })) };
        return "Listo: edición entregada.";
      },
    }),
  );

  // Orden FIJO (prefijo cacheado).
  return [verMaterial, leerTranscripcion, verFotogramas, borrador, proponer, verPropuesta, listarPlantillas, guiaHyperframes, escribirPlantilla, pedirIa, terminar];
}
