/**
 * Lógica pura de la "salida" (instrucción → plan → proceso → versiones → estilos → aprendizaje).
 * Sin React: se prueba aparte (test/salida-*.test.ts).
 */
import type { Job, MemoryRule, PipelineStage, Project, RecipeChange, StyleInclude, Version } from "@autoeditor/shared";

// ---------------------------------------------------------------------------- "Qué cambió"

export type ChangeArea = RecipeChange["area"];

export const AREA_LABELS: Record<ChangeArea, string> = {
  estilo: "Estilo",
  texto: "Textos en pantalla",
  subtitulos: "Subtítulos",
  cortes: "Cortes y ritmo",
  graficos: "Motion graphics",
  audio: "Audio",
  ia: "IA",
  formato: "Formato",
  otro: "Otros",
};

/** Orden en que se muestran las áreas (lo más visible primero). */
export const AREA_ORDER: ChangeArea[] = ["estilo", "texto", "subtitulos", "cortes", "graficos", "audio", "ia", "formato", "otro"];

export interface ChangeGroup {
  area: ChangeArea;
  label: string;
  /** Cambios pedidos (o directos). */
  direct: RecipeChange[];
  /** Consecuencias automáticas (p. ej. subtítulos recalculados por un corte): se muestran atenuadas. */
  derived: RecipeChange[];
}

/**
 * Agrupa los cambios de una versión por área. Primero las áreas con cambios directos (en el orden
 * de AREA_ORDER) y al final las que solo tienen cambios derivados.
 */
export function groupChangesByArea(changes: RecipeChange[]): ChangeGroup[] {
  const map = new Map<ChangeArea, ChangeGroup>();
  for (const c of changes) {
    const area = (AREA_ORDER as string[]).includes(c.area) ? c.area : "otro";
    let g = map.get(area);
    if (!g) {
      g = { area, label: AREA_LABELS[area], direct: [], derived: [] };
      map.set(area, g);
    }
    (c.derived ? g.derived : g.direct).push(c);
  }
  const groups = AREA_ORDER.map((a) => map.get(a)).filter((g): g is ChangeGroup => !!g);
  return [...groups.filter((g) => g.direct.length > 0), ...groups.filter((g) => g.direct.length === 0)];
}

/** Resumen corto de qué cambió (para la tarjeta en el lienzo). */
export function changeHeadline(version: Pick<Version, "changeSummary" | "changes">): string {
  if (version.changeSummary) return version.changeSummary;
  const direct = version.changes.filter((c) => !c.derived);
  if (!direct.length) return version.changes.length ? "Solo cambios recalculados automáticamente." : "Sin cambios.";
  return direct
    .slice(0, 3)
    .map((c) => c.label)
    .join(" · ");
}

// ---------------------------------------------------------------------------- Versiones

/** Versión "actual" del proyecto: la que eligió la persona (restaurar) o la más reciente. */
export function currentVersionIdOf(project: Pick<Project, "currentVersionId"> | null, versions: Pick<Version, "id" | "number">[]): string | null {
  if (!versions.length) return null;
  const chosen = project?.currentVersionId;
  if (chosen && versions.some((v) => v.id === chosen)) return chosen;
  return [...versions].sort((a, b) => b.number - a.number)[0]!.id;
}

/** Cadena de versiones desde V1 hasta `versionId` (siguiendo parentId). */
export function lineageOf(versions: Pick<Version, "id" | "parentId">[], versionId: string): string[] {
  const byId = new Map(versions.map((v) => [v.id, v]));
  const out: string[] = [];
  let cur = byId.get(versionId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out;
}

/** Par por defecto para comparar: la versión con su madre (o la anterior). */
export function defaultComparePair(versions: Pick<Version, "id" | "number" | "parentId">[], versionId: string): { a: string; b: string } | null {
  const sorted = [...versions].sort((x, y) => x.number - y.number);
  const v = sorted.find((x) => x.id === versionId);
  if (!v || sorted.length < 2) return null;
  const parent = v.parentId && sorted.find((x) => x.id === v.parentId);
  if (parent) return { a: parent.id, b: v.id };
  const i = sorted.indexOf(v);
  if (i > 0) return { a: sorted[i - 1]!.id, b: v.id };
  return { a: v.id, b: sorted[1]!.id };
}

// ---------------------------------------------------------------------------- Trabajos

const rec = (job: Job | null | undefined): Record<string, unknown> => (job?.result && typeof job.result === "object" ? (job.result as Record<string, unknown>) : {});

/** Pregunta aclaratoria que devolvió el editor (corrección ambigua). */
export function clarifyingQuestionOf(job: Job | null | undefined): string | null {
  const r = rec(job);
  const q = r.clarifyingQuestion ?? r.question ?? r.pregunta;
  return typeof q === "string" && q.trim() ? q.trim() : null;
}

/** Regla sugerida para recordar después de una corrección. */
export function ruleSuggestionOf(job: Job | null | undefined): string | null {
  const s = rec(job).ruleSuggestion;
  if (typeof s === "string" && s.trim()) return s.trim();
  if (s && typeof s === "object" && typeof (s as { text?: unknown }).text === "string") return ((s as { text: string }).text || "").trim() || null;
  return null;
}

export const isRunning = (job: Job | null | undefined): job is Job => !!job && (job.status === "corriendo" || job.status === "en-cola");
export const isActive = (job: Job | null | undefined): job is Job => !!job && (job.status === "corriendo" || job.status === "en-cola" || job.status === "esperando");

/** Tiempo transcurrido y restante (segundos) de un trabajo. */
export function jobClock(job: Pick<Job, "startedAt" | "createdAt" | "finishedAt" | "estimatedSeconds" | "progress">, now: number): { elapsed: number; remaining: number | null } {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
  const elapsed = Number.isFinite(start) ? Math.max(0, (end - start) / 1000) : 0;
  let remaining: number | null = null;
  if (job.estimatedSeconds != null && job.estimatedSeconds > 0) {
    remaining = Math.max(0, job.estimatedSeconds - elapsed);
    // Si ya pasamos el estimado, usamos el progreso para no mostrar "0 s" eternamente.
    if (remaining < 2 && job.progress > 0.05 && job.progress < 1) remaining = Math.max(2, (elapsed / job.progress) * (1 - job.progress));
  } else if (job.progress > 0.05 && job.progress < 1) {
    remaining = (elapsed / job.progress) * (1 - job.progress);
  }
  return { elapsed, remaining };
}

/** Etapas visibles del PROCESO para un trabajo (según lo prendido). */
export function pipelineStagesFor(opts: { type: Job["type"] | null; reviewPlan: boolean; kie: boolean; motion: boolean; current?: PipelineStage | null }): PipelineStage[] {
  const all: PipelineStage[] = ["analizando", "transcribiendo", "planeando", "esperando-aprobacion", "generando-ia", "motion-graphics", "render", "revision-calidad"];
  return all.filter((st) => {
    if (st === opts.current) return true;
    if (opts.type && opts.type !== "generar" && (st === "analizando" || st === "transcribiendo" || st === "esperando-aprobacion")) return false;
    if (st === "esperando-aprobacion") return opts.reviewPlan;
    if (st === "generando-ia") return opts.kie;
    if (st === "motion-graphics") return opts.motion;
    return true;
  });
}

// ---------------------------------------------------------------------------- Memoria

export interface RuleScopeContext {
  projectId: string | null;
  styleId: string | null;
  brandId: string | null;
}

/** Reglas activas que aplican a este proyecto (globales + su estilo + su marca + el proyecto). */
export function rulesThatApply(rules: MemoryRule[], ctx: RuleScopeContext): MemoryRule[] {
  return rules
    .filter((r) => {
      if (!r.enabled) return false;
      switch (r.scope) {
        case "global":
          return true;
        case "proyecto":
          return !!ctx.projectId && r.scopeId === ctx.projectId;
        case "estilo":
          return !!ctx.styleId && r.scopeId === ctx.styleId;
        case "marca":
          return !!ctx.brandId && r.scopeId === ctx.brandId;
      }
    })
    .sort((a, b) => b.strength - a.strength || b.timesApplied - a.timesApplied);
}

export const SCOPE_LABELS: Record<MemoryRule["scope"], string> = { global: "Siempre", marca: "Esta marca", estilo: "Este estilo", proyecto: "Este proyecto" };

export const SOURCE_LABELS: Record<MemoryRule["source"]["type"], string> = {
  correccion: "De una corrección",
  calificacion: "De tus 👍/👎",
  manual: "La escribiste tú",
  glosario: "Del glosario",
  "palabras-clave": "De tus palabras clave",
  plan: "De un plan que ajustaste",
  exportacion: "De lo que exportaste",
};

/** Tendencia de "correcciones por video": negativa = cada vez necesitas menos. */
export function correctionTrend(recent: number, previous: number): { direction: "baja" | "sube" | "igual"; text: string } {
  if (previous <= 0 && recent <= 0) return { direction: "igual", text: "Aún no hay suficientes videos para comparar." };
  const diff = recent - previous;
  if (Math.abs(diff) < 0.15) return { direction: "igual", text: "Igual que antes." };
  if (diff < 0) {
    const pct = previous > 0 ? Math.round((-diff / previous) * 100) : 0;
    return { direction: "baja", text: pct ? `${pct} % menos correcciones que antes.` : "Menos correcciones que antes." };
  }
  return { direction: "sube", text: "Más correcciones que antes: revisa tus reglas." };
}

// ---------------------------------------------------------------------------- Estilos

export const STYLE_INCLUDE_LABELS: { key: keyof StyleInclude; label: string; help: string }[] = [
  { key: "marca", label: "Marca", help: "Logos, cortinillas y cintillos." },
  { key: "tipografias", label: "Tipografías", help: "Títulos y subtítulos." },
  { key: "colores", label: "Colores", help: "Paleta y resaltado." },
  { key: "musica", label: "Música", help: "La misma pista de fondo." },
  { key: "transiciones", label: "Transiciones", help: "Cortes, fundidos, barridos." },
  { key: "plantillasMotion", label: "Plantillas de motion graphics", help: "Gráficos animados reutilizables." },
  { key: "ritmo", label: "Ritmo", help: "Duración promedio de cada plano." },
  { key: "subtitulos", label: "Subtítulos", help: "Estilo y palabras clave resaltadas." },
  { key: "introOutro", label: "Intro / outro", help: "Entrada y cierre." },
  { key: "herramientas", label: "Herramientas prendidas", help: "Silencios, zooms, B-roll…" },
  { key: "instruccionBase", label: "Instrucción base", help: "Lo que le pediste a Claude." },
];

/** "0:12" para el botón "Anclar a este momento". */
export function clockLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
