/**
 * Herramientas de la sesión de CORRECCIÓN (regla de oro): ver la receta por secciones, ver fotogramas
 * del video, consultar material/transcripción/plantillas y enviar el parche RFC 6902 con sus áreas.
 *
 * Al enviar el parche el servidor lo aplica a una COPIA, valida, normaliza, re-materializa subtítulos y
 * verifica con diffRecipes + changesOutsideAreas. Si toca algo fuera de lo pedido, le devuelve el detalle
 * a Claude para que lo corrija (máximo 3 intentos).
 */
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaToolResultContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { RuleCheck, summarizeChanges, type ProvidersConfig, type Recipe } from "@autoeditor/shared";
import type { CorrectionInput, CorrectionResult } from "../../services/types.js";
import { completeAiRequests } from "../shared/ai-requests.js";
import { ALL_AREAS, compactRecipe, describeOutside, verifyPatch, type Area, type PatchVerification } from "../shared/recipe-ops.js";
import { round2 } from "../shared/text.js";
import { recipeOutline } from "../prompts/context.js";
import { FRAME_WIDTH, imageBlock, materialTools, PatchOpInput, strictTool, templateTools, toPatchOps, type SessionCommon, type ToolOutput } from "./common.js";
import { materialErrors } from "./recipe-checks.js";

export const MAX_PATCH_ATTEMPTS = 3;

export interface CorrectSession extends SessionCommon {
  attempts: number;
  result: {
    verification: PatchVerification & { recipe: Recipe };
    areas: Area[];
    summary: string;
    ruleSuggestion: CorrectionResult["ruleSuggestion"];
  } | null;
  clarify: string | null;
  lastFailure: string | null;
  turn: number;
  maxTurns: number;
}

export function newCorrectSession(maxTurns: number): CorrectSession {
  return { newTemplates: [], attempts: 0, result: null, clarify: null, lastFailure: null, turn: 0, maxTurns };
}

export function correctDone(s: CorrectSession): boolean {
  return s.result != null || s.clarify != null || s.attempts >= MAX_PATCH_ATTEMPTS;
}

const SECTIONS = ["resumen", "formato", "estilo", "video", "overlays", "texto", "graficos", "subtitulos", "audio", "ia", "todo"] as const;

/** Una sección de la receta con su ruta base (JSON Pointer) para armar el parche. */
export function recipeSection(recipe: Recipe, section: (typeof SECTIONS)[number]): Record<string, unknown> {
  const t = recipe.tracks;
  const indexed = <T>(items: T[]) => items.map((it, i) => ({ indice: i, ...(it as object) }));
  switch (section) {
    case "resumen":
      return recipeOutline(recipe);
    case "formato":
      return { rutas: { format: "/format", target: "/target" }, format: recipe.format, target: recipe.target, duration: recipe.duration };
    case "estilo":
      return { ruta: "/style", style: recipe.style };
    case "video":
      return { ruta: "/tracks/video", elementos: indexed(t.video) };
    case "overlays":
      return { ruta: "/tracks/overlays", elementos: indexed(t.overlays) };
    case "texto":
      return { ruta: "/tracks/text", elementos: indexed(t.text) };
    case "graficos":
      return { ruta: "/tracks/graphics", elementos: indexed(t.graphics) };
    case "subtitulos": {
      const { words, ...rest } = t.captions;
      return {
        ruta: "/tracks/captions",
        ...rest,
        palabras: `${words.length} palabras materializadas (no se editan; para corregir texto usa /tracks/captions/overrides con el índice)`,
        muestra: words.slice(0, 60).map((w, i) => `${i}: ${round2(w.start)} ${w.text}${w.highlight ? " *" : ""}`),
      };
    }
    case "audio":
      return { ruta: "/tracks/audio", audio: t.audio };
    case "ia":
      return { ruta: "/ai", elementos: indexed(recipe.ai) };
    case "todo":
      return compactRecipe(recipe);
  }
}

export function correctTools(input: CorrectionInput, session: CorrectSession, ctx: { kie: ProvidersConfig["kie"] }) {
  const { verMaterial, leerTranscripcion, verFotogramas } = materialTools(input);
  const { listarPlantillas, guiaHyperframes, escribirPlantilla } = templateTools(input, session);
  const current = input.current;

  const verReceta = strictTool(
    betaZodTool({
      name: "ver_receta",
      description: "Muestra una sección de la receta ACTUAL con su ruta JSON Pointer e índices, para armar el parche exacto.",
      inputSchema: z.object({ seccion: z.enum(SECTIONS) }),
      run: async ({ seccion }) => JSON.stringify(recipeSection(current, seccion)),
    }),
  );

  const verVideo = strictTool(
    betaZodTool({
      name: "ver_fotogramas_video",
      description: "Fotogramas de la versión ACTUAL del video (con textos, subtítulos y gráficos) en segundos del video final (máximo 6).",
      inputSchema: z.object({ tiempos: z.array(z.number()) }),
      run: async ({ tiempos }): Promise<ToolOutput> => {
        const blocks: BetaToolResultContentBlockParam[] = [];
        for (const t of tiempos.slice(0, 6)) {
          const tt = Math.max(0, Math.min(t, Math.max(0, current.duration - 0.05)));
          const frame = await input.toolbox.previewFrame(current, tt, FRAME_WIDTH);
          blocks.push({ type: "text", text: `Video actual @ ${round2(tt)} s` }, imageBlock(frame.base64, frame.mediaType));
        }
        return blocks;
      },
    }),
  );

  const enviarParche = strictTool(
    betaZodTool({
      name: "enviar_parche",
      description:
        "Envía la corrección como parche RFC 6902 sobre la receta ACTUAL, con las áreas que toca, un resumen corto para el usuario y opcionalmente una regla para recordar. El servidor lo aplica a una copia y verifica la regla de oro; si algo falla te dice qué corregir. Para preguntar en vez de cambiar, envía operaciones vacías y pregunta_aclaratoria.",
      inputSchema: z.object({
        operaciones: z.array(PatchOpInput),
        areas: z.array(z.enum(ALL_AREAS as [Area, ...Area[]])).describe("Áreas que la corrección tiene permitido cambiar"),
        resumen: z.string().describe("Qué cambiaste, en una frase para el usuario"),
        regla_sugerida: z
          .object({
            texto: z.string().describe('Preferencia a recordar, p. ej. "Títulos siempre en Montserrat"'),
            check_json: z.string().nullable().describe('Comprobación verificable en JSON (p. ej. {"type":"fuente-titulos","family":"Montserrat"}) o null'),
          })
          .nullable(),
        pregunta_aclaratoria: z.string().nullable(),
      }),
      run: async (args) => {
        if (args.pregunta_aclaratoria?.trim() && args.operaciones.length === 0) {
          session.clarify = args.pregunta_aclaratoria.trim();
          return "Pregunta enviada al usuario.";
        }
        if (session.attempts >= MAX_PATCH_ATTEMPTS) return "Ya no quedan intentos para esta corrección.";
        session.attempts++;
        const left = MAX_PATCH_ATTEMPTS - session.attempts;
        const fail = (msg: string) => {
          session.lastFailure = msg;
          return `${msg}\n${left > 0 ? `Te quedan ${left} intento(s): envía un parche nuevo sobre la receta ORIGINAL.` : "No quedan intentos."}`;
        };
        const parsed = toPatchOps(args.operaciones);
        if (parsed.errors.length) return fail(`El parche tiene errores:\n- ${parsed.errors.join("\n- ")}`);
        if (!parsed.ops.length) return fail("El parche no tiene operaciones. Si no sabes qué cambiar, envía una pregunta_aclaratoria.");
        const areas = [...new Set(args.areas)];
        const v = verifyPatch(current, parsed.ops, areas, input.toolbox, { postProcess: (r) => completeAiRequests(r, ctx.kie) });
        if (!v.recipe) return fail(`No se pudo aplicar el parche:\n- ${v.errors.join("\n- ")}`);
        const refErrors = materialErrors(v.recipe, input, session.newTemplates).filter((e) => !materialErrors(current, input, session.newTemplates).includes(e));
        if (refErrors.length) return fail(`La receta corregida tiene errores:\n- ${refErrors.join("\n- ")}`);
        if (!v.changes.length) return fail("El parche no cambia nada en la receta. Revisa las rutas y los valores (ver_receta).");
        if (!v.ok) return fail(describeOutside(v.outside, areas));
        let ruleSuggestion: CorrectionResult["ruleSuggestion"] = null;
        if (args.regla_sugerida?.texto.trim()) {
          let check: RuleCheck | null = null;
          if (args.regla_sugerida.check_json) {
            try {
              const r = RuleCheck.safeParse(JSON.parse(args.regla_sugerida.check_json));
              check = r.success ? r.data : null;
            } catch {
              check = null;
            }
          }
          ruleSuggestion = { text: args.regla_sugerida.texto.trim(), check };
        }
        session.result = { verification: { ...v, recipe: v.recipe }, areas, summary: args.resumen.trim(), ruleSuggestion };
        const notes = v.notes.length ? `\nNotas: ${v.notes.join(" ")}` : "";
        return `Parche verificado y aplicado. Cambios: ${summarizeChanges(v.changes)}.${notes}`;
      },
    }),
  );

  // Orden FIJO (prefijo cacheado).
  return [verReceta, verVideo, verMaterial, leerTranscripcion, verFotogramas, listarPlantillas, guiaHyperframes, escribirPlantilla, enviarParche];
}
