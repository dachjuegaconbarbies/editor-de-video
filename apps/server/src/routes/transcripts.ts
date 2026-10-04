/** Transcripciones: listado por proyecto y edición de palabras (texto y marcas) con glosario. */
import { GlossaryEntry, UpdateTranscriptWordsBody, type TranscriptsResponse } from "@autoeditor/shared";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { newId, nowIso } from "../db/util.js";
import { normalizeToken, splitPunctuation } from "../memory/index.js";
import { UserFacingError } from "../services/types.js";
import { notFound, type RouteModule } from "./http.js";

const ProjectParams = z.object({ projectId: z.string().min(1) });
const TranscriptParams = z.object({ transcriptId: z.string().min(1) });

/**
 * Guarda una corrección en el glosario global: la variante errónea → el término correcto.
 * Si el término ya existe, solo agrega la variante. Devuelve true si cambió algo.
 */
export async function learnGlossaryPair(ctx: AppContext, ownerId: string, wrongRaw: string, rightRaw: string): Promise<boolean> {
  const wrong = splitPunctuation(wrongRaw)[1].trim();
  const right = splitPunctuation(rightRaw)[1].trim();
  if (!wrong || !right || wrong === right) return false;
  const entries = await ctx.db.glossary.list(ownerId, { scope: "global" });
  const existing = entries.find((e) => normalizeToken(e.term) === normalizeToken(right) && e.term === right) ?? entries.find((e) => normalizeToken(e.term) === normalizeToken(right));
  if (existing) {
    if (existing.variants.some((v) => normalizeToken(v) === normalizeToken(wrong)) && existing.term === right) return false;
    await ctx.db.glossary.update(ownerId, existing.id, (e) => ({
      ...e,
      term: right,
      variants: e.variants.some((v) => normalizeToken(v) === normalizeToken(wrong)) ? e.variants : [...e.variants, wrong],
    }));
    return true;
  }
  await ctx.db.glossary.create(
    ownerId,
    GlossaryEntry.parse({ id: newId("gls"), ownerId, term: right, variants: [wrong], scope: "global", scopeId: null, createdAt: nowIso() }),
  );
  return true;
}

export const transcriptRoutes: RouteModule = (app, ctx) => {
  const { db } = ctx;
  const tags = ["Transcripción"];

  app.get("/projects/:projectId/transcripts", { schema: { tags, summary: "Transcripciones del proyecto", params: ProjectParams } }, async (request): Promise<TranscriptsResponse> => {
    const owner = request.ownerId;
    const project = await db.projects.get(owner, request.params.projectId);
    if (!project) throw notFound("ese proyecto");
    return { transcripts: await db.transcripts.list(owner, { projectId: project.id }) };
  });

  app.patch(
    "/transcripts/:transcriptId/words",
    {
      schema: {
        tags,
        summary: "Corregir palabras y marcar frases (quitar / debe-ir / resaltar)",
        description: "Con saveToGlossary (por defecto), cada palabra corregida se guarda en tu glosario para que la siguiente transcripción ya salga bien.",
        params: TranscriptParams,
        body: UpdateTranscriptWordsBody,
      },
    },
    async (request) => {
      const owner = request.ownerId;
      const body = request.body;
      const current = await db.transcripts.get(owner, request.params.transcriptId);
      if (!current) throw notFound("esa transcripción");
      const index = new Map(current.words.map((w, idx) => [w.i, idx]));
      for (const edit of body.edits) {
        if (!index.has(edit.i)) throw new UserFacingError("palabra-inexistente", `La palabra ${edit.i} no existe en esta transcripción`, 400);
        if (edit.text !== undefined && edit.text.trim() === "") {
          throw new UserFacingError("texto-vacio", "El texto de una palabra no puede quedar vacío; márcala como «quitar»", 400);
        }
      }

      const pairs: { wrong: string; right: string }[] = [];
      const changed = new Set<number>();
      const updated = await db.transcripts.update(owner, current.id, (t) => {
        const words = t.words.map((w) => ({ ...w }));
        for (const edit of body.edits) {
          const w = words[index.get(edit.i)!]!;
          if (edit.text !== undefined && edit.text.trim() !== w.text) {
            const before = w.text;
            w.original = w.original ?? before;
            w.text = edit.text.trim();
            changed.add(w.i);
            if (body.saveToGlossary) pairs.push({ wrong: w.original, right: w.text });
          }
          if (edit.mark !== undefined) w.mark = edit.mark;
        }
        // Recalcula el texto de los segmentos con palabras cambiadas.
        const byI = new Map(words.map((w) => [w.i, w]));
        const segments = t.segments.map((s) => {
          let touched = false;
          for (let i = s.firstWord; i <= s.lastWord; i++) if (changed.has(i)) touched = true;
          if (!touched) return s;
          const text = Array.from({ length: s.lastWord - s.firstWord + 1 }, (_, k) => byI.get(s.firstWord + k)?.text ?? "")
            .filter(Boolean)
            .join(" ");
          return { ...s, text };
        });
        return { ...t, words, segments };
      });
      if (!updated) throw notFound("esa transcripción");
      for (const p of pairs) await learnGlossaryPair(ctx, owner, p.wrong, p.right);
      ctx.events.emit(updated.projectId, { type: "transcript.updated", transcript: updated });
      return updated;
    },
  );
};
