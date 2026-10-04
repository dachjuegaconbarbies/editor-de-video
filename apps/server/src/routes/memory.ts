/** "Lo que Claude aprendió": reglas, glosario y métricas (todo revisable, editable y borrable). */
import { GlossaryBody, GlossaryEntry, MemoryRule, RuleBody, type GlossaryResponse, type RulesResponse } from "@autoeditor/shared";
import { z } from "zod";
import { newId, nowIso } from "../db/util.js";
import { normalizeText, normalizeToken } from "../memory/index.js";
import { UserFacingError } from "../services/types.js";
import { notFound, onlySent, type RouteModule } from "./http.js";

const RuleParams = z.object({ ruleId: z.string().min(1) });
const EntryParams = z.object({ entryId: z.string().min(1) });
const RulePatch = RuleBody.partial();

export const memoryRoutes: RouteModule = (app, ctx) => {
  const { db } = ctx;
  const tags = ["Memoria"];

  app.get("/memory/rules", { schema: { tags, summary: "Reglas aprendidas (y de dónde salieron)" } }, async (request): Promise<RulesResponse> => {
    return { rules: await db.rules.list(request.ownerId, {}, { orderBy: "updatedAt", desc: true }) };
  });

  app.post("/memory/rules", { schema: { tags, summary: "Agregar una regla (o recordar la sugerida tras una corrección)", body: RuleBody } }, async (request, reply) => {
    const owner = request.ownerId;
    const body = request.body;
    if (body.scope !== "global" && !body.scopeId) throw new UserFacingError("falta-alcance", "Indica a qué marca, estilo o proyecto aplica la regla", 400);
    const scopeId = body.scope === "global" ? null : body.scopeId;
    // Si ya existe una igual en ese alcance, se refuerza.
    const same = (await db.rules.list(owner, { scope: body.scope, scopeId })).find((r) => normalizeText(r.text) === normalizeText(body.text));
    if (same) {
      const updated = await db.rules.update(owner, same.id, (r) => ({ ...r, strength: r.strength + 1, enabled: body.enabled }));
      return reply.code(200).send(updated);
    }
    const now = nowIso();
    const rule = await db.rules.create(
      owner,
      MemoryRule.parse({
        id: newId("rul"),
        ownerId: owner,
        scope: body.scope,
        scopeId,
        text: body.text.trim(),
        enabled: body.enabled,
        source: { type: "manual", refId: null, excerpt: "" },
        createdAt: now,
        updatedAt: now,
      }),
    );
    return reply.code(201).send(rule);
  });

  app.patch("/memory/rules/:ruleId", { schema: { tags, summary: "Editar, apagar o cambiar el alcance de una regla", params: RuleParams, body: RulePatch } }, async (request) => {
    const patch = onlySent(request, request.body);
    const updated = await db.rules.update(request.ownerId, request.params.ruleId, (r) => {
      const next = { ...r, ...patch, text: patch.text?.trim() ?? r.text };
      if (next.scope === "global") next.scopeId = null;
      // Se valida antes de escribir (si lanza aquí, no se guarda nada).
      if (next.scope !== "global" && !next.scopeId) throw new UserFacingError("falta-alcance", "Indica a qué marca, estilo o proyecto aplica la regla", 400);
      return next;
    });
    if (!updated) throw notFound("esa regla");
    return updated;
  });

  app.delete("/memory/rules/:ruleId", { schema: { tags, summary: "Borrar una regla", params: RuleParams } }, async (request) => {
    if (!(await db.rules.delete(request.ownerId, request.params.ruleId))) throw notFound("esa regla");
    return { ok: true };
  });

  app.get("/memory/glossary", { schema: { tags, summary: "Glosario de transcripción" } }, async (request): Promise<GlossaryResponse> => {
    const entries = await db.glossary.list(request.ownerId);
    entries.sort((a, b) => a.term.localeCompare(b.term, "es"));
    return { entries };
  });

  app.post("/memory/glossary", { schema: { tags, summary: "Agregar término al glosario (o variantes a uno existente)", body: GlossaryBody } }, async (request, reply) => {
    const owner = request.ownerId;
    const body = request.body;
    const scopeId = body.scope === "global" ? null : body.scopeId;
    const variants = [...new Set(body.variants.map((v) => v.trim()).filter((v) => v && normalizeToken(v) !== normalizeToken(body.term)))];
    const existing = (await db.glossary.list(owner, { scope: body.scope, scopeId })).find((e) => normalizeText(e.term) === normalizeText(body.term));
    if (existing) {
      const updated = await db.glossary.update(owner, existing.id, (e) => ({
        ...e,
        term: body.term.trim(),
        variants: [...e.variants, ...variants.filter((v) => !e.variants.some((x) => normalizeText(x) === normalizeText(v)))],
      }));
      return reply.code(200).send(updated);
    }
    const entry = await db.glossary.create(
      owner,
      GlossaryEntry.parse({ id: newId("gls"), ownerId: owner, term: body.term.trim(), variants, scope: body.scope, scopeId, createdAt: nowIso() }),
    );
    return reply.code(201).send(entry);
  });

  app.delete("/memory/glossary/:entryId", { schema: { tags, summary: "Borrar término del glosario", params: EntryParams } }, async (request) => {
    if (!(await db.glossary.delete(request.ownerId, request.params.entryId))) throw notFound("ese término");
    return { ok: true };
  });

  app.get("/memory/metrics", { schema: { tags, summary: "¿Cada vez necesito menos correcciones?" } }, async (request) => {
    return ctx.memory.metrics(request.ownerId);
  });
};
