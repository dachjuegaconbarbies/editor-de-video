/**
 * ORDEN AUTOMÁTICO DE VARIOS CLIPS BASE (función pura, sin IA).
 *
 * Si suben varios clips base desordenados, se sugiere un orden antes de editar. Señales, de más a
 * menos fuerte:
 *   1. Orden manual (la persona los reacomodó) o notas «abre con este» / «cierra con este».
 *   2. Guion: dónde cae lo que se dice en cada clip dentro del guion (trigramas de palabras).
 *   3. Sentido de lo que se dice: saludo/gancho al inicio, «primero / segundo / por último…», despedida
 *      o llamado a la acción al final.
 *   4. Hora de grabación de los metadatos (creation_time / com.apple.quicktime.creationdate).
 *   5. Números en el nombre del archivo («toma 2», «IMG_0042»).
 *   6. Orden de subida.
 * Las señales 4-6 también desempatan a los clips sin pistas en 2-3.
 */
import { normalize } from "./text.js";

export interface OrderClip {
  assetId: string;
  name: string;
  createdAt: string;
  /** Orden en su zona (al subir se asigna en secuencia; si la persona lo cambia, es manual). */
  order: number;
  /** Hora de grabación ISO de los metadatos, si se conoce. */
  recordedAt: string | null;
  /** Texto de la transcripción (vacío si no hay). */
  text: string;
  note?: string;
}

export type OrderSource = "manual" | "guion" | "contenido" | "hora-grabacion" | "nombre" | "subida";

export interface ClipOrderSuggestion {
  assetIds: string[];
  source: OrderSource;
  /** Motivo general en español («según el guion», «por hora de grabación»…). */
  reason: string;
  /** true si se respetó un orden que eligió la persona. */
  manual: boolean;
  /** Motivo por clip (para mostrar junto a cada uno). */
  perClip: Record<string, string>;
}

export const ORDER_REASONS: Record<OrderSource, string> = {
  manual: "en el orden que elegiste",
  guion: "según el guion",
  contenido: "por el sentido de lo que se dice (saludo al inicio, «primero, segundo…», despedida al final)",
  "hora-grabacion": "por hora de grabación",
  nombre: "por el número en el nombre del archivo",
  subida: "en el orden en que los subiste",
};

const fmtClock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
};

/** Peso de la nota: «abre con este» primero, «cierra con este» al final. */
export function noteWeight(note: string | undefined): number {
  const n = normalize(note ?? "");
  if (/\b(abre|abrir|empieza|inicio|primero|arranca)\b/.test(n)) return -1;
  if (/\b(cierra|cerrar|final|termina|ultimo)\b/.test(n)) return 1;
  return 0;
}

/** Último número del nombre del archivo (sin extensión), o null. */
export function fileNumber(name: string): number | null {
  const stem = name.replace(/\.[^.]+$/, "");
  const all = stem.match(/\d+/g);
  if (!all) return null;
  const n = Number(all[all.length - 1]);
  return Number.isFinite(n) ? n : null;
}

/** Posición narrativa (0..1) según pistas del contenido; null si no hay pistas. */
export function contentPosition(text: string): { pos: number; why: string } | null {
  const n = ` ${normalize(text)} `;
  if (n.trim().length === 0) return null;
  const head = ` ${n.trim().split(" ").slice(0, 14).join(" ")} `;
  const cues: { pos: number; why: string }[] = [];
  if (/ (hola|bienvenid\w*|buenos dias|buenas tardes|buenas noches|que tal) /.test(head) || / (soy \w+|en este video|hoy te voy|hoy les voy|hoy vamos) /.test(head)) cues.push({ pos: 0, why: "saludo o presentación" });
  const ordinals: [RegExp, number, string][] = [
    [/ (primero|primer paso|lo primero|paso uno|numero uno) /, 0.25, "«primero»"],
    [/ (segundo|segundo paso|paso dos|numero dos) /, 0.42, "«segundo»"],
    [/ (tercero|tercer paso|paso tres|numero tres) /, 0.58, "«tercero»"],
    [/ (cuarto|cuarto paso|paso cuatro) /, 0.7, "«cuarto»"],
    [/ (quinto|paso cinco) /, 0.78, "«quinto»"],
    [/ (por ultimo|finalmente|para terminar|para cerrar|en resumen) /, 0.85, "«por último»"],
  ];
  for (const [re, pos, why] of ordinals) if (re.test(n)) cues.push({ pos, why });
  if (/ (siguenos|suscribete|suscribanse|dale like|comenta|comentame|link en|gracias por ver|nos vemos|hasta la proxima|chao|adios) /.test(n)) cues.push({ pos: 1, why: "despedida o llamado a la acción" });
  if (!cues.length) return null;
  // Promedio: un clip con «primero» y «segundo» queda entre ambos.
  const pos = cues.reduce((s, c) => s + c.pos, 0) / cues.length;
  return { pos, why: cues.map((c) => c.why).join(", ") };
}

/** Índice de trigramas del guion → posiciones (0..1). */
function scriptIndex(script: string): { index: Map<string, number[]>; total: number } {
  const words = normalize(script).split(" ").filter(Boolean);
  const index = new Map<string, number[]>();
  for (let i = 0; i + 2 < words.length; i++) {
    const key = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key)!.push(i / Math.max(1, words.length - 1));
  }
  return { index, total: words.length };
}

/** Dónde cae el clip dentro del guion (mediana de sus trigramas encontrados) y qué tanto coincide. */
export function scriptPosition(text: string, idx: { index: Map<string, number[]> }): { pos: number; coverage: number } | null {
  const words = normalize(text).split(" ").filter(Boolean);
  if (words.length < 3) return null;
  const hits: number[] = [];
  let total = 0;
  for (let i = 0; i + 2 < words.length; i++) {
    total++;
    const found = idx.index.get(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    if (found?.length) hits.push(found[0]!);
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a - b);
  return { pos: hits[Math.floor(hits.length / 2)]!, coverage: hits.length / Math.max(1, total) };
}

/** Ordena por una clave numérica; los clips sin clave quedan pegados detrás del anterior en `fallback`. */
function orderWithGaps(fallback: OrderClip[], key: Map<string, number>): OrderClip[] {
  let last = -Infinity;
  const decorated = fallback.map((c, i) => {
    const k = key.get(c.assetId);
    if (k != null) last = k;
    return { c, k: k ?? (last === -Infinity ? -1 : last), i, has: k != null };
  });
  return decorated.sort((a, b) => a.k - b.k || Number(b.has) - Number(a.has) || a.i - b.i).map((d) => d.c);
}

/** Sugiere el orden de los clips base con su motivo. */
export function suggestClipOrder(clips: OrderClip[], opts: { script?: string | null } = {}): ClipOrderSuggestion {
  const perClip: Record<string, string> = {};
  const upload = [...clips].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.assetId.localeCompare(b.assetId));
  const result = (list: OrderClip[], source: OrderSource, manual = false): ClipOrderSuggestion => {
    // Las notas «abre con este» / «cierra con este» mandan siempre.
    const withNotes = list.map((c, i) => ({ c, i })).sort((a, b) => noteWeight(a.c.note) - noteWeight(b.c.note) || a.i - b.i).map((x) => x.c);
    for (const c of withNotes) {
      const w = noteWeight(c.note);
      if (w !== 0) perClip[c.assetId] = w < 0 ? "Tu nota dice que abre el video" : "Tu nota dice que cierra el video";
    }
    return { assetIds: withNotes.map((c) => c.assetId), source, reason: ORDER_REASONS[source], manual, perClip };
  };
  if (clips.length <= 1) return result(upload, "subida");

  // 1) Orden manual: el orden de la zona ya no coincide con el de subida.
  const byOrder = [...clips].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.assetId.localeCompare(b.assetId));
  if (byOrder.some((c, i) => c.assetId !== upload[i]!.assetId)) {
    byOrder.forEach((c, i) => (perClip[c.assetId] = `Posición ${i + 1} que elegiste`));
    return result(byOrder, "manual", true);
  }

  // Orden de respaldo (para desempatar): hora de grabación > número en el nombre > subida.
  const times = clips.map((c) => (c.recordedAt ? Date.parse(c.recordedAt) : NaN));
  const allTimes = times.every((t) => Number.isFinite(t)) && new Set(times).size === clips.length;
  const nums = clips.map((c) => fileNumber(c.name));
  const allNums = nums.every((n) => n != null) && new Set(nums).size === clips.length;
  let fallback = upload;
  let fallbackSource: OrderSource = "subida";
  if (allTimes) {
    fallback = [...clips].sort((a, b) => Date.parse(a.recordedAt!) - Date.parse(b.recordedAt!));
    fallbackSource = "hora-grabacion";
  } else if (allNums) {
    fallback = [...clips].sort((a, b) => fileNumber(a.name)! - fileNumber(b.name)!);
    fallbackSource = "nombre";
  }
  const fallbackWhy = (c: OrderClip) =>
    fallbackSource === "hora-grabacion" ? `Grabado a las ${fmtClock(c.recordedAt!)}` : fallbackSource === "nombre" ? `Número ${fileNumber(c.name)} en el nombre` : "Orden de subida";

  // 2) Guion.
  const script = opts.script?.trim() ?? "";
  if (script) {
    const idx = scriptIndex(script);
    const key = new Map<string, number>();
    for (const c of clips) {
      const sp = scriptPosition(c.text, idx);
      if (sp && sp.coverage >= 0.15) {
        key.set(c.assetId, sp.pos);
        perClip[c.assetId] = `Coincide con el guion (${Math.round(sp.pos * 100)} % del texto)`;
      }
    }
    if (key.size >= Math.max(2, Math.ceil(clips.length * 0.6))) {
      for (const c of clips) if (!key.has(c.assetId)) perClip[c.assetId] = `${fallbackWhy(c)} (no aparece en el guion)`;
      return result(orderWithGaps(fallback, key), "guion");
    }
    for (const k of Object.keys(perClip)) delete perClip[k];
  }

  // 3) Sentido de lo que se dice.
  const cueKey = new Map<string, number>();
  for (const c of clips) {
    const cp = contentPosition(c.text);
    if (cp) {
      cueKey.set(c.assetId, cp.pos);
      perClip[c.assetId] = `Por lo que se dice: ${cp.why}`;
    }
  }
  const distinct = new Set(cueKey.values()).size;
  if (cueKey.size >= 2 && distinct >= 2) {
    for (const c of clips) if (!cueKey.has(c.assetId)) perClip[c.assetId] = fallbackWhy(c);
    return result(orderWithGaps(fallback, cueKey), "contenido");
  }
  for (const k of Object.keys(perClip)) delete perClip[k];

  // 4-6) Metadatos, nombre o subida.
  for (const c of fallback) perClip[c.assetId] = fallbackWhy(c);
  return result(fallback, fallbackSource);
}
