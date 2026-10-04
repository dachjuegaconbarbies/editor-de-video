/**
 * Comparador de recetas: produce la lista de cambios "qué cambió" entre dos versiones,
 * con etiquetas en español y área afectada. Las listas de objetos con `id` se comparan por id
 * (no por posición), así que mover o quitar un clip no marca como cambiados a todos los demás.
 *
 * También sirve para comprobar la REGLA DE ORO: una corrección solo cambia lo que se pidió.
 */
import type { RecipeChange } from "./entities.js";
import type { Recipe } from "./recipe.js";

type Json = unknown;
type Area = RecipeChange["area"];

const isObj = (v: Json): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);
const hasIds = (arr: Json[]) => arr.length > 0 && arr.every((x) => isObj(x) && typeof x.id === "string");

export function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

const escapePtr = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

const FIELD_LABELS: Record<string, string> = {
  family: "tipografía",
  weight: "grosor",
  fontSize: "tamaño de letra",
  uppercase: "mayúsculas",
  primaryColor: "color del texto",
  highlightColor: "color de resaltado",
  outlineColor: "color del contorno",
  outlineWidth: "grosor del contorno",
  background: "fondo",
  position: "posición",
  mode: "modo",
  animation: "animación",
  maxCharsPerLine: "caracteres por línea",
  text: "texto",
  subtitle: "subtítulo",
  start: "inicio",
  end: "fin",
  sourceIn: "entrada del fragmento",
  sourceOut: "salida del fragmento",
  speed: "velocidad",
  volume: "volumen",
  gainDb: "volumen (dB)",
  transitionIn: "transición",
  type: "tipo",
  duration: "duración",
  zoom: "zoom",
  color: "color",
  look: "look de color",
  reframe: "reencuadre",
  titleFont: "tipografía de títulos",
  bodyFont: "tipografía de texto",
  palette: "paleta",
  targetShotLength: "ritmo (duración de plano)",
  defaultTransition: "transición por defecto",
  enabled: "activado",
  burnIn: "quemados en el video",
  targetLufs: "volumen objetivo (LUFS)",
  duckingDb: "ducking",
  prompt: "prompt",
  model: "modelo",
  layout: "acomodo",
  props: "parámetros",
  templateId: "plantilla",
  highlightKeywords: "resaltar palabras clave",
  highlightStyle: "estilo de resaltado",
  aspect: "formato",
  textCase: "mayúsculas/minúsculas",
};

const AREA_NAMES: Record<string, string> = {
  video: "clip",
  overlays: "b-roll/imagen",
  text: "texto en pantalla",
  graphics: "motion graphic",
  music: "música",
  sfx: "efecto de sonido",
  voiceover: "voz en off",
  ai: "pedido de IA",
};

function areaFor(path: string[]): Area {
  const [a, b] = path;
  if (a === "tracks") {
    if (b === "video" || b === "overlays") return "cortes";
    if (b === "text") return "texto";
    if (b === "captions") return "subtitulos";
    if (b === "graphics") return "graficos";
    if (b === "audio") return "audio";
  }
  if (a === "style") return "estilo";
  if (a === "format") return "formato";
  if (a === "ai") return "ia";
  return "otro";
}

function short(v: Json): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v.length > 40 ? `"${v.slice(0, 37)}…"` : `"${v}"`;
  if (typeof v === "number") return String(Math.round(v * 100) / 100);
  if (typeof v === "boolean") return v ? "sí" : "no";
  if (Array.isArray(v)) return `${v.length} elementos`;
  if (isObj(v)) {
    if (typeof v.text === "string") return short(v.text);
    if (typeof v.family === "string") return v.family;
    if (typeof v.label === "string" && v.label) return short(v.label);
    if (typeof v.type === "string") return v.type;
    return "objeto";
  }
  return String(v);
}

function itemName(listKey: string, item: Json): string {
  const base = AREA_NAMES[listKey] ?? "elemento";
  if (isObj(item)) {
    const name = (item.text as string) || (item.label as string) || (item.description as string) || (item.prompt as string) || "";
    if (name) return `${base} ${short(name)}`;
  }
  return base;
}

function labelFor(path: string[], before: Json, after: Json, op: RecipeChange["op"], listItem?: Json): string {
  const last = path[path.length - 1] ?? "";
  const listKey = path.find((p) => AREA_NAMES[p]) ?? "";
  if (op === "add" && listItem !== undefined) return `Se agregó ${itemName(listKey, listItem)}`;
  if (op === "remove" && listItem !== undefined) return `Se quitó ${itemName(listKey, listItem)}`;
  const field = FIELD_LABELS[last] ?? last;
  const parentField = FIELD_LABELS[path[path.length - 2] ?? ""];
  const ctx = path[0] === "tracks" && path[1] === "captions" ? "Subtítulos: " : path[0] === "style" ? "Estilo: " : listKey ? `${(AREA_NAMES[listKey] ?? "").replace(/^./, (c) => c.toUpperCase())}: ` : "";
  const fieldText = parentField && !/^\d+$/.test(path[path.length - 2] ?? "") ? `${parentField} — ${field}` : field;
  return `${ctx}${fieldText} ${short(before)} → ${short(after)}`;
}

interface Ctx {
  out: RecipeChange[];
}

function walk(a: Json, b: Json, path: string[], ctx: Ctx) {
  if (deepEqual(a, b)) return;
  const ptr = "/" + path.map(escapePtr).join("/");
  // Palabras de subtítulos: se reportan como un solo cambio derivado.
  if (path.join("/") === "tracks/captions/words") {
    ctx.out.push({ path: ptr, op: "replace", label: "Subtítulos recalculados para los nuevos cortes", area: "subtitulos", derived: true, before: undefined, after: undefined });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b) && (hasIds(a) || hasIds(b)) && (a.length === 0 || hasIds(a)) && (b.length === 0 || hasIds(b))) {
    const listKey = path[path.length - 1] ?? "";
    const aMap = new Map(a.map((x) => [(x as Record<string, string>).id, x]));
    const bMap = new Map(b.map((x) => [(x as Record<string, string>).id, x]));
    a.forEach((x, i) => {
      const id = (x as Record<string, string>).id!;
      if (!bMap.has(id)) ctx.out.push({ path: `${ptr}/${i}`, op: "remove", before: x, label: labelFor([...path, String(i)], x, undefined, "remove", x), area: areaFor(path), derived: false });
    });
    b.forEach((x, i) => {
      const id = (x as Record<string, string>).id!;
      const prev = aMap.get(id);
      if (prev === undefined) {
        ctx.out.push({ path: `${ptr}/${i}`, op: "add", after: x, label: labelFor([...path, String(i)], undefined, x, "add", x), area: areaFor(path), derived: false });
      } else {
        walk(prev, x, [...path, String(i)], ctx);
      }
    });
    const commonA = a.map((x) => (x as Record<string, string>).id).filter((id) => bMap.has(id!));
    const commonB = b.map((x) => (x as Record<string, string>).id).filter((id) => aMap.has(id!));
    if (!deepEqual(commonA, commonB)) {
      ctx.out.push({ path: ptr, op: "move", label: `Cambió el orden de ${AREA_NAMES[listKey] ?? "elementos"}s`, area: areaFor(path), derived: false });
    }
    return;
  }
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) walk(a[k], b[k], [...path, k], ctx);
    return;
  }
  const op: RecipeChange["op"] = a === undefined ? "add" : b === undefined ? "remove" : "replace";
  // El inicio de los clips principales lo recalcula normalizeRecipe → derivado.
  const derived =
    (path[0] === "tracks" && path[1] === "video" && path[path.length - 1] === "start") || path[0] === "duration" || path[0] === "meta" || path[0] === "notes";
  ctx.out.push({ path: ptr, op, before: a, after: b, label: labelFor(path, a, b, op), area: areaFor(path), derived });
}

/** Lista de cambios entre dos recetas (de `before` a `after`). */
export function diffRecipes(before: Recipe, after: Recipe): RecipeChange[] {
  const ctx: Ctx = { out: [] };
  walk(before as unknown as Json, after as unknown as Json, [], ctx);
  return ctx.out.filter((c) => !(c.path.startsWith("/meta") || c.path === "/notes"));
}

/** Resumen corto en español para la tarjeta de versión. */
export function summarizeChanges(changes: RecipeChange[]): string {
  const direct = changes.filter((c) => !c.derived);
  if (direct.length === 0) return changes.length ? "Solo cambios derivados (recalculados automáticamente)." : "Sin cambios.";
  const head = direct.slice(0, 4).map((c) => c.label);
  const rest = direct.length - head.length;
  return head.join(" · ") + (rest > 0 ? ` · y ${rest} cambio${rest === 1 ? "" : "s"} más` : "");
}

/**
 * Verifica la regla de oro: todos los cambios directos caen en las áreas permitidas.
 * Devuelve los cambios que se salen de lo pedido (lista vacía = correcto).
 */
export function changesOutsideAreas(changes: RecipeChange[], allowed: Area[]): RecipeChange[] {
  return changes.filter((c) => !c.derived && !allowed.includes(c.area));
}
