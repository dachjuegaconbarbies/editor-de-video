/**
 * Mensajes de usuario y esquemas de salida estructurada de las tareas cortas de Claude:
 * revisión de calidad, palabras clave + texto para publicar, ficha de reglas del estilo y referencia visual.
 */
import type { BetaContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { KeywordCategory, PLATFORM_LABELS, SAFE_ZONES } from "@autoeditor/shared";
import type { KeywordInput, QaInput, StyleRulesInput } from "../../services/types.js";
import type { StyleRulesOutput } from "../shared/style-rules.js";
import { round2 } from "../shared/text.js";
import { wordsByAsset } from "../shared/transcript.js";
import { PatchOpInput } from "../tools/common.js";
import { describeTools, recipeOutline } from "./context.js";

// ---------------------------------------------------------------------------
// Revisión de calidad
// ---------------------------------------------------------------------------

export const QaOutput = z.object({
  checks: z.array(z.object({ check: z.string(), ok: z.boolean(), detail: z.string() })),
  fix_patch: z.array(PatchOpInput).nullable(),
});
export type QaOutput = z.infer<typeof QaOutput>;

export function reviewContent(input: QaInput): BetaContentBlockParam[] {
  const platform = input.settings.instruction.platform;
  const safe = SAFE_ZONES[platform];
  const rules = input.rules.filter((r) => r.enabled);
  const blocks: BetaContentBlockParam[] = [
    {
      type: "text",
      text:
        `Plataforma: ${PLATFORM_LABELS[platform]} (zona segura: arriba ${safe.top}, abajo ${safe.bottom}, izquierda ${safe.left}, derecha ${safe.right} del cuadro).\n` +
        `Receta (resumen con rutas para el parche):\n${JSON.stringify(recipeOutline(input.recipe))}\n\n` +
        `Reglas del usuario:\n${rules.length ? rules.map((r) => `- ${r.text}`).join("\n") : "(ninguna)"}\n\n` +
        `Fotogramas del render (${input.frames.length}):`,
    },
  ];
  for (const f of input.frames) {
    blocks.push({ type: "text", text: `Segundo ${round2(f.t)}` }, { type: "image", source: { type: "base64", media_type: f.mediaType, data: f.base64 } });
  }
  blocks.push({ type: "text", text: "Devuelve las comprobaciones y, si hace falta, el parche de arreglo." });
  return blocks;
}

// ---------------------------------------------------------------------------
// Palabras clave y texto para publicar
// ---------------------------------------------------------------------------

export const KeywordsOutput = z.object({
  palabras: z.array(
    z.object({
      texto: z.string(),
      categoria: KeywordCategory,
      puntaje: z.number().describe("De 0 a 1"),
      apariciones: z.array(z.object({ asset_id: z.string(), indice_palabra: z.number().int() })),
    }),
  ),
  publicar: z.object({ titulo: z.string(), descripcion: z.string(), hashtags: z.array(z.string()), portada: z.string() }),
});
export type KeywordsOutput = z.infer<typeof KeywordsOutput>;

/** Transcripción compacta con índices: "[i]palabra" (para que Claude cite apariciones reales). */
export function indexedTranscript(input: Pick<KeywordInput, "transcripts">): string {
  const byAsset = wordsByAsset(input.transcripts);
  return [...byAsset.entries()].map(([assetId, words]) => `### ${assetId}\n${words.map((w) => `[${w.i}]${w.text}`).join(" ")}`).join("\n\n");
}

export function keywordsContent(input: KeywordInput): string {
  const user = input.existing.filter((k) => k.source === "usuario");
  const off = input.existing.filter((k) => !k.enabled);
  return [
    `Instrucción del video: ${input.settings.instruction.text.trim() || "(sin instrucción)"}; plataforma ${PLATFORM_LABELS[input.settings.instruction.platform]}, tono ${input.settings.instruction.tone}.`,
    input.glossary.length ? `Glosario (así se escriben): ${input.glossary.map((g) => g.term).join(", ")}` : "",
    user.length ? `Palabras clave que agregó el usuario (no las repitas): ${user.map((k) => k.text).join(", ")}` : "",
    off.length ? `Palabras que el usuario descartó (no las propongas): ${off.map((k) => k.text).join(", ")}` : "",
    `Transcripción (índice entre corchetes):\n${indexedTranscript(input)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Ficha de reglas del estilo
// ---------------------------------------------------------------------------

export const StyleRulesSchema = z.object({
  ficha_markdown: z.string().describe("Ficha de reglas del estilo en markdown"),
  reglas: z.array(z.string()).describe("Reglas sueltas, una frase cada una"),
});

export function styleRulesContent(input: StyleRulesInput, draft: StyleRulesOutput): string {
  const r = input.recipe;
  return [
    `Nombre del estilo: ${input.name}`,
    `Herramientas usadas:\n${describeTools(input.settings.tools)}`,
    `Receta final (resumen):\n${JSON.stringify(recipeOutline(r))}`,
    `Estilo de la receta: ${JSON.stringify(r.style)}`,
    `Correcciones que pidió el usuario (en orden):\n${input.corrections.length ? input.corrections.map((c, i) => `${i + 1}. «${c.correction}» → ${c.summary}`).join("\n") : "(ninguna)"}`,
    `Reglas aprendidas vigentes:\n${input.rules.filter((x) => x.enabled).map((x) => `- ${x.text}`).join("\n") || "(ninguna)"}`,
    `Borrador automático de la ficha (valores medidos de la receta; mejóralo y complétalo):\n${draft.rulesMarkdown}`,
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Referencia visual
// ---------------------------------------------------------------------------

export function referenceContent(input: { imageBase64: string; mediaType: "image/jpeg" | "image/png"; likes: string }): BetaContentBlockParam[] {
  return [
    { type: "image", source: { type: "base64", media_type: input.mediaType, data: input.imageBase64 } },
    { type: "text", text: `Lo que le gusta al usuario de esta referencia: ${input.likes.trim() || "(no lo dijo: deduce lo más aprovechable)"}` },
  ];
}
