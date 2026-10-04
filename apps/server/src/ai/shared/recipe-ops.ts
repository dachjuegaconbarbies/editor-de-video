/**
 * Operaciones sobre recetas que comparten el editor demo y el editor con Claude:
 *  - aplicar un parche RFC 6902 a una copia, validar, normalizar, re-materializar subtítulos y
 *    verificar la REGLA DE ORO (diffRecipes + changesOutsideAreas);
 *  - calcular el parche mínimo entre dos recetas;
 *  - armar las escenas del storyboard;
 *  - resumir la receta para los prompts (sin las palabras de subtítulos).
 */
import jsonpatch, { type Operation } from "fast-json-patch";
import type { Asset, PlanScene, Recipe, RecipeChange } from "@autoeditor/shared";
import { changesOutsideAreas, clipDuration, deepEqual, diffRecipes } from "@autoeditor/shared";
import type { CorrectionResult, EditorToolbox } from "../../services/types.js";
import { round3 } from "./text.js";

export type PatchOp = CorrectionResult["patch"][number];
export type Area = RecipeChange["area"];

export const ALL_AREAS: Area[] = ["cortes", "texto", "subtitulos", "graficos", "audio", "estilo", "formato", "ia", "otro"];

/** Rutas que calcula el servidor: un parche no debe tocarlas (se recalculan solas). */
const SERVER_MANAGED = [/^\/tracks\/captions\/words(\/|$)/, /^\/duration$/, /^\/schemaVersion$/];

export interface PatchVerification {
  ok: boolean;
  /** Receta resultante (validada y normalizada) o null si el parche no se pudo aplicar. */
  recipe: Recipe | null;
  /** Parche mínimo de la receta actual a la resultante (incluye lo recalculado). */
  patch: PatchOp[];
  changes: RecipeChange[];
  /** Cambios directos fuera de las áreas permitidas (vacío = cumple la regla de oro). */
  outside: RecipeChange[];
  errors: string[];
  /** Avisos no fatales (p. ej. operaciones ignoradas sobre rutas del servidor). */
  notes: string[];
}

/** Parche mínimo (RFC 6902) para pasar de `a` a `b`. */
export function minimalPatch(a: Recipe, b: Recipe): PatchOp[] {
  return jsonpatch.compare(a as object, b as object) as PatchOp[];
}

/** ¿Cambió algo que obliga a recalcular los subtítulos? (cortes o correcciones manuales de texto). */
export function needsRematerialize(a: Recipe, b: Recipe): boolean {
  if (!deepEqual(a.tracks.video, b.tracks.video)) return true;
  if (!deepEqual(a.tracks.captions.overrides, b.tracks.captions.overrides)) return true;
  if (a.tracks.captions.words.length === 0 && b.tracks.captions.enabled && !a.tracks.captions.enabled) return true;
  return false;
}

/** Valida una receta con el toolbox; devuelve la receta normalizada o los errores. */
export function validateWith(toolbox: EditorToolbox, data: unknown): { ok: true; recipe: Recipe } | { ok: false; errors: string[] } {
  try {
    return toolbox.validateRecipe(data);
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
}

/**
 * Aplica un parche a una COPIA de la receta y verifica la regla de oro.
 * `postProcess` permite completar datos derivados (p. ej. costos de pedidos de IA) antes de validar.
 */
export function verifyPatch(
  current: Recipe,
  ops: PatchOp[],
  areas: Area[],
  toolbox: EditorToolbox,
  opts: { postProcess?: (r: Recipe) => Recipe } = {},
): PatchVerification {
  const notes: string[] = [];
  const fail = (errors: string[]): PatchVerification => ({ ok: false, recipe: null, patch: [], changes: [], outside: [], errors, notes });

  const usable = ops.filter((op) => {
    if (SERVER_MANAGED.some((re) => re.test(op.path))) {
      notes.push(`Se ignoró la operación sobre ${op.path}: el servidor la recalcula sola.`);
      return false;
    }
    return true;
  });

  let patched: unknown;
  try {
    const doc = structuredClone(current);
    const err = jsonpatch.validate(usable as Operation[], doc);
    if (err) return fail([`Operación inválida (${err.name}) en ${String((err.operation as { path?: string } | undefined)?.path ?? "?")}: ${err.message.split("\n")[0]}`]);
    patched = jsonpatch.applyPatch(doc, usable as Operation[], true, false).newDocument;
  } catch (err) {
    return fail([`No se pudo aplicar el parche: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`]);
  }

  if (opts.postProcess) {
    try {
      patched = opts.postProcess(patched as Recipe);
    } catch (err) {
      return fail([`El parche dejó la receta incompleta: ${err instanceof Error ? err.message : String(err)}`]);
    }
  }

  const valid = validateWith(toolbox, patched);
  if (!valid.ok) return fail(valid.errors.map((e) => `La receta resultante no es válida: ${e}`));

  const baseValid = validateWith(toolbox, current);
  const base = baseValid.ok ? baseValid.recipe : current;
  let recipe = valid.recipe;
  if (needsRematerialize(base, recipe)) recipe = toolbox.materializeCaptions(recipe);

  const changes = diffRecipes(base, recipe);
  const outside = changesOutsideAreas(changes, areas);
  return {
    ok: outside.length === 0,
    recipe,
    patch: minimalPatch(current, recipe),
    changes,
    outside,
    errors: [],
    notes,
  };
}

/** Explica en español los cambios fuera de las áreas permitidas (para que Claude los corrija). */
export function describeOutside(outside: RecipeChange[], areas: Area[]): string {
  const lines = outside.slice(0, 12).map((c) => `- ${c.path} (área "${c.area}"): ${c.label}`);
  const more = outside.length > 12 ? `\n- …y ${outside.length - 12} cambios más` : "";
  return (
    `El parche cambia cosas fuera de lo pedido (áreas permitidas: ${areas.join(", ") || "ninguna"}). ` +
    `La regla de oro exige que todo lo demás quede idéntico. Cambios que sobran:\n${lines.join("\n")}${more}\n` +
    `Envía un parche nuevo (sobre la receta ORIGINAL) que solo toque lo pedido, o agrega el área si de verdad es parte de la corrección.`
  );
}

// ---------------------------------------------------------------------------
// Resúmenes para prompts
// ---------------------------------------------------------------------------

/** Receta compacta para prompts: sin las palabras materializadas de subtítulos (solo cuántas son). */
export function compactRecipe(recipe: Recipe): Record<string, unknown> {
  const clone = structuredClone(recipe) as unknown as { tracks: { captions: Record<string, unknown> } } & Record<string, unknown>;
  const words = recipe.tracks.captions.words.length;
  clone.tracks.captions.words = `(${words} palabras; las materializa el servidor, no las edites)`;
  return clone;
}

/** Métricas rápidas de una receta (para devolverle a Claude y para resúmenes). */
export function recipeMetrics(recipe: Recipe): {
  duration: number;
  clips: number;
  averageShot: number;
  brollSeconds: number;
  brollCoverage: number;
  texts: number;
  graphics: number;
  captionWords: number;
  aiRequests: number;
  aiCostUsd: number;
} {
  const clips = recipe.tracks.video.length;
  const brollSeconds = recipe.tracks.overlays.filter((o) => o.kind !== "logo").reduce((s, o) => s + Math.max(0, o.end - o.start), 0);
  return {
    duration: recipe.duration,
    clips,
    averageShot: clips ? round3(recipe.tracks.video.reduce((s, c) => s + clipDuration(c), 0) / clips) : 0,
    brollSeconds: round3(brollSeconds),
    brollCoverage: recipe.duration > 0 ? Math.round((brollSeconds / recipe.duration) * 100) / 100 : 0,
    texts: recipe.tracks.text.length,
    graphics: recipe.tracks.graphics.length,
    captionWords: recipe.tracks.captions.words.length,
    aiRequests: recipe.ai.length,
    aiCostUsd: round3(recipe.ai.reduce((s, a) => s + (a.costUsd ?? 0), 0)),
  };
}

// ---------------------------------------------------------------------------
// Storyboard
// ---------------------------------------------------------------------------

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/**
 * Escenas del storyboard a partir de la receta: una escena por bloque continuo de material
 * (se corta donde se quitó un silencio o cambia de archivo), uniendo bloques muy cortos.
 */
export function buildScenes(recipe: Recipe, assets: Asset[], opts: { titles?: (index: number, total: number, text: string) => string } = {}): PlanScene[] {
  const assetName = new Map(assets.map((a) => [a.id, a.originalName]));
  const clips = recipe.tracks.video;
  if (!clips.length) return [];
  // 1) Bloques continuos.
  const blocks: { start: number; end: number; clipIdx: number[] }[] = [];
  clips.forEach((c, i) => {
    const prev = clips[i - 1];
    const contiguous = prev && prev.assetId === c.assetId && Math.abs(prev.sourceOut - c.sourceIn) < 0.02 && c.stillDuration == null && prev.stillDuration == null;
    const end = c.start + clipDuration(c);
    const last = blocks[blocks.length - 1];
    if (contiguous && last) {
      last.end = end;
      last.clipIdx.push(i);
    } else {
      blocks.push({ start: c.start, end, clipIdx: [i] });
    }
  });
  // 2) Unir bloques de menos de 2 s con el anterior.
  const merged: typeof blocks = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && b.end - b.start < 2) {
      last.end = b.end;
      last.clipIdx.push(...b.clipIdx);
    } else merged.push({ ...b, clipIdx: [...b.clipIdx] });
  }
  const music = recipe.tracks.audio.music[0];
  const musicLabel = music ? `${assetName.get(music.assetId) ?? "Música"} a ${music.gainDb} dB${music.duck ? " (baja cuando se habla)" : ""}` : "";
  return merged.map((b, idx) => {
    const overlapping = <T extends { start: number; end: number }>(items: T[]) => items.filter((it) => it.start < b.end && it.end > b.start);
    const words = recipe.tracks.captions.words.filter((w) => w.start >= b.start - 0.01 && w.start < b.end);
    const captionText = words.map((w) => w.text).join(" ");
    const defaultTitle =
      idx === 0 ? "Gancho" : idx === merged.length - 1 && overlapping(recipe.tracks.text).some((t) => t.kind === "cta") ? "Cierre y llamado a la acción" : `Escena ${idx + 1}`;
    const title = opts.titles ? opts.titles(idx, merged.length, captionText) : defaultTitle;
    const sceneClips = b.clipIdx.map((i) => clips[i]!);
    return {
      id: `escena-${idx + 1}`,
      title,
      start: round3(b.start),
      end: round3(b.end),
      clips: sceneClips.map((c) => ({ assetId: c.assetId, sourceIn: c.sourceIn, sourceOut: c.sourceOut, label: c.label || assetName.get(c.assetId) || "" })),
      onScreenText: overlapping(recipe.tracks.text).map((t) => t.text),
      captions: captionText,
      music: musicLabel,
      graphics: [
        ...overlapping(recipe.tracks.graphics).map((g) => g.description || `Gráfico ${g.templateId}`),
        ...overlapping(recipe.tracks.overlays).map((o) => `${o.kind === "logo" ? "Logo" : "B-roll"}: ${assetName.get(o.assetId) ?? o.assetId} (${o.layout}, ${fmt(o.start)}–${fmt(o.end)})`),
      ],
      ai: recipe.ai
        .filter((a) => (a.placeAt ? a.placeAt.start < b.end && a.placeAt.end > b.start : idx === 0))
        .map((a) => ({ kind: a.kind, prompt: a.prompt, model: a.model, costUsd: a.costUsd })),
      notes: [...new Set(sceneClips.map((c) => c.reason).filter(Boolean))].join(" "),
    };
  });
}
