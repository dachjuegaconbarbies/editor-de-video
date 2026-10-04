/**
 * MEMORIA: lo que la app aprende de ti (reglas cortas y verificables + glosario + métricas).
 *
 * Capas: global (siempre) → marca → estilo → proyecto. Nada se aprende sin que lo puedas revisar en
 * el panel "Lo que Claude aprendió" (rutas /memory/*).
 *
 * Implementación inicial (ola 1): reglas por contexto, glosario, métricas y "recordar" una corrección.
 * La ola 2 completa el aprendizaje automático (correcciones repetidas, 👍/👎, planes aprobados…).
 */
import type { GlossaryEntry, LearningMetrics, MemoryRule } from "@autoeditor/shared";
import { MemoryRule as MemoryRuleSchema } from "@autoeditor/shared";
import type { AppContext, GlossaryWord, LearnFromCorrectionInput, MemoryApi, MemoryScopeContext, RatingInput } from "../context.js";
import { newId, nowIso } from "../db/util.js";

// ---------------------------------------------------------------------------
// Utilidades puras (exportadas para pruebas y para el pipeline)
// ---------------------------------------------------------------------------

/** ¿La regla/entrada aplica a este contexto? */
export function scopeMatches(item: { scope: MemoryRule["scope"]; scopeId: string | null }, ctx: MemoryScopeContext): boolean {
  switch (item.scope) {
    case "global":
      return true;
    case "marca":
      return !!ctx.brandId && item.scopeId === ctx.brandId;
    case "estilo":
      return !!ctx.styleId && item.scopeId === ctx.styleId;
    case "proyecto":
      return !!ctx.projectId && item.scopeId === ctx.projectId;
    default:
      return false;
  }
}

/** Normaliza para comparar: minúsculas, sin acentos ni puntuación. */
export function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function normalizeText(s: string): string {
  return s
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean)
    .join(" ");
}

/** Separa la puntuación pegada a una palabra: "¿Sira," → ["¿", "Sira", ","]. */
export function splitPunctuation(text: string): [string, string, string] {
  const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su.exec(text);
  return m ? [m[1] ?? "", m[2] ?? "", m[3] ?? ""] : ["", text, ""];
}

interface CompiledEntry {
  entry: GlossaryEntry;
  variant: string[];
  term: string[];
}

/**
 * Aplica el glosario a una lista de palabras (sin tocar la base). Soporta variantes de una palabra
 * (→ término de una o varias palabras) y variantes de varias palabras con el mismo número de palabras
 * que el término. Conserva la puntuación y guarda el texto previo en `original`.
 */
export function applyGlossaryEntries<T extends GlossaryWord>(words: T[], entries: GlossaryEntry[]): { words: T[]; counts: Record<string, number> } {
  const compiled: CompiledEntry[] = [];
  for (const entry of entries) {
    const termTokens = entry.term.trim().split(/\s+/).filter(Boolean);
    if (termTokens.length === 0) continue;
    for (const v of entry.variants) {
      const variant = v.trim().split(/\s+/).map(normalizeToken).filter(Boolean);
      if (variant.length === 0) continue;
      if (variant.length > 1 && variant.length !== termTokens.length) continue;
      compiled.push({ entry, variant, term: termTokens });
    }
  }
  // Primero las variantes más largas (más específicas).
  compiled.sort((a, b) => b.variant.length - a.variant.length);
  const counts: Record<string, number> = {};
  const out = words.map((w) => ({ ...w }));
  const norms = out.map((w) => normalizeToken(w.text));
  for (let i = 0; i < out.length; i++) {
    for (const c of compiled) {
      const n = c.variant.length;
      if (i + n > out.length) continue;
      let match = true;
      for (let j = 0; j < n; j++) if (norms[i + j] !== c.variant[j]) match = false;
      if (!match) continue;
      let changed = false;
      for (let j = 0; j < n; j++) {
        const word = out[i + j]!;
        const [pre, core, post] = splitPunctuation(word.text);
        const replacement = n === 1 ? c.term.join(" ") : c.term[j]!;
        if (core === replacement) continue;
        word.original = word.original ?? word.text;
        word.text = `${pre}${replacement}${post}`;
        norms[i + j] = normalizeToken(word.text);
        changed = true;
      }
      if (changed) counts[c.entry.id] = (counts[c.entry.id] ?? 0) + 1;
      i += n - 1;
      break;
    }
  }
  return { words: out, counts };
}

function average(xs: number[]): number {
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : 0;
}

// ---------------------------------------------------------------------------
// MemoryApi
// ---------------------------------------------------------------------------

export function createMemoryApi(ctx: AppContext): MemoryApi {
  const { db } = ctx;

  async function rulesFor(ownerId: string, scope: MemoryScopeContext): Promise<MemoryRule[]> {
    const rules = await db.rules.list(ownerId, { enabled: true });
    return rules.filter((r) => scopeMatches(r, scope)).sort((a, b) => b.strength - a.strength || b.updatedAt.localeCompare(a.updatedAt));
  }

  async function applyGlossary<T extends GlossaryWord>(ownerId: string, words: T[], scopes: MemoryScopeContext) {
    const entries = (await db.glossary.list(ownerId)).filter((e) => scopeMatches(e, scopes));
    if (entries.length === 0 || words.length === 0) return { words, replacements: 0 };
    const { words: out, counts } = applyGlossaryEntries(words, entries);
    await db.glossary.incrementApplied(ownerId, counts);
    return { words: out, replacements: Object.values(counts).reduce((a, b) => a + b, 0) };
  }

  async function learnFromCorrection(ownerId: string, input: LearnFromCorrectionInput): Promise<MemoryRule | null> {
    if (!input.suggestion || !input.suggestion.text.trim()) return null;
    if (input.remember == null) {
      // Se pregunta con un toque: "¿Lo recuerdo? Solo este proyecto / este estilo / siempre".
      ctx.events.emit(input.projectId, {
        type: "rule.suggested",
        suggestion: { text: input.suggestion.text, versionId: input.versionId, correction: input.correction },
      });
      return null;
    }
    if (input.remember === "no") return null;
    const scope = input.remember === "siempre" ? "global" : input.remember === "estilo" && input.styleId ? "estilo" : "proyecto";
    const scopeId = scope === "global" ? null : scope === "estilo" ? input.styleId : input.projectId;
    // Si ya existe una regla equivalente, se refuerza en lugar de duplicarla.
    const existing = (await db.rules.list(ownerId, { scope, scopeId })).find((r) => normalizeText(r.text) === normalizeText(input.suggestion!.text));
    if (existing) {
      return db.rules.update(ownerId, existing.id, (r) => ({ ...r, strength: r.strength + 1, enabled: true, check: r.check ?? input.suggestion!.check }));
    }
    const now = nowIso();
    const rule = MemoryRuleSchema.parse({
      id: newId("rul"),
      ownerId,
      scope,
      scopeId,
      text: input.suggestion.text.trim().slice(0, 500),
      check: input.suggestion.check,
      source: { type: "correccion", refId: input.versionId, excerpt: input.correction.slice(0, 200) },
      createdAt: now,
      updatedAt: now,
    });
    return db.rules.create(ownerId, rule);
  }

  async function onRating(_ownerId: string, _input: RatingInput): Promise<void> {
    // La ruta ya guardó la calificación en `feedback`. El aprendizaje a partir de 👍/👎
    // (reforzar reglas aplicadas, detectar patrones en lo que no gustó) lo completa la ola 2.
  }

  async function metrics(ownerId: string): Promise<LearningMetrics> {
    const [projects, stats, rules, glossaryTerms] = await Promise.all([
      db.projects.list(ownerId, {}, { orderBy: "createdAt" }),
      db.versions.statsByProject(ownerId),
      db.rules.count(ownerId, { enabled: true }),
      db.glossary.count(ownerId),
    ]);
    const correctionsPerVideo = projects
      .filter((p) => (stats[p.id]?.versions ?? 0) > 0)
      .map((p) => ({ projectId: p.id, name: p.name, corrections: stats[p.id]?.corrections ?? 0, createdAt: p.createdAt }));
    const counts = correctionsPerVideo.map((c) => c.corrections);
    const recent = counts.slice(-5);
    const previous = counts.slice(-10, -5);
    return {
      projects: projects.length,
      versions: Object.values(stats).reduce((s, x) => s + x.versions, 0),
      correctionsPerVideo,
      averageCorrectionsRecent: average(recent),
      averageCorrectionsPrevious: average(previous),
      rules,
      glossaryTerms,
    };
  }

  return { rulesFor, learnFromCorrection, onRating, applyGlossary, metrics };
}
