/**
 * MAPA DEL MATERIAL (función pura, sin IA): qué hay dentro de cada clip, por fragmentos.
 *
 * El usuario solo sube; nunca etiqueta. Dentro de los mismos clips base puede haber partes donde la
 * persona habla (A-roll), tomas de apoyo sin voz (B-roll), tomas repetidas y tiempos muertos. Este
 * módulo arma, a partir de los assets + su análisis (rol, silencios, brollSegments) + transcripciones:
 *
 *   - la COLUMNA del video: los clips base (o, si no hay, los clips con voz detectados) en el orden
 *     sugerido (ver clip-order.ts) con su motivo;
 *   - los FRAGMENTOS de cada clip de la columna: "habla" (frases), "b-roll", "toma-repetida" (la misma
 *     frase dicha otra vez; ver takes.ts) y "tiempo-muerto";
 *   - el material de APOYO (otros clips/B-roll, fotos, música, logos, efectos);
 *   - un resumen para la interfaz: «3 clips · 2 tomas repetidas · 4 tomas de apoyo detectadas».
 *
 * Lo usan el editor demo (para construir la columna), Claude (como contexto y herramienta) y el
 * pipeline (lo guarda para que la interfaz lo muestre).
 */
import type { Asset, AssetAnalysis, ProjectSettings, Transcript } from "@autoeditor/shared";
import { suggestClipOrder, type ClipOrderSuggestion, type OrderClip } from "./clip-order.js";
import { detectRepeatedTakes, type TakeGroup } from "./takes.js";
import { round2, round3 } from "./text.js";
import { splitPhrases, wordsByAsset, type TWord } from "./transcript.js";

export const MATERIAL_MAP_VERSION = 1;

export type FragmentKind = "habla" | "b-roll" | "toma-repetida" | "tiempo-muerto";

export interface MaterialFragment {
  /** Para "habla"/"toma-repetida" es el id de la frase (`<assetId>:<índice de su primera palabra>`). */
  id: string;
  assetId: string;
  kind: FragmentKind;
  start: number;
  end: number;
  /** Lo que se dice (habla / toma repetida). */
  text: string;
  /** Calidad 0..1 (b-roll: puntaje del análisis; habla: 1). */
  score: number;
  /** Explicación corta en español. */
  reason: string;
  /** Grupo de tomas repetidas al que pertenece (si aplica). */
  takeGroupId: string | null;
}

export interface MaterialClipInfo {
  assetId: string;
  name: string;
  category: Asset["category"];
  duration: number;
  role: AssetAnalysis["role"];
  /** Posición sugerida en la columna (0 = primero). */
  suggestedOrder: number;
  orderReason: string;
  recordedAt: string | null;
  hasTranscript: boolean;
  speechSeconds: number;
  brollSeconds: number;
  deadSeconds: number;
  repeatedSeconds: number;
}

export interface SupportItem {
  assetId: string;
  name: string;
  kind: "b-roll" | "foto" | "musica" | "sfx" | "logo" | "grafico" | "voz" | "otro";
  /** Segundos aprovechables como b-roll (videos). */
  brollSeconds: number;
}

export interface MaterialMap {
  version: typeof MATERIAL_MAP_VERSION;
  /** De dónde sale la columna: clips base, clips con voz detectados o ninguno (montaje). */
  base: "clip-base" | "a-roll-detectado" | "ninguno";
  clips: MaterialClipInfo[];
  order: ClipOrderSuggestion;
  fragments: MaterialFragment[];
  takes: TakeGroup[];
  support: SupportItem[];
  summary: {
    clips: number;
    repeatedTakes: number;
    falseStarts: number;
    brollFragments: number;
    supportBroll: number;
    speechSeconds: number;
    deadSeconds: number;
    text: string;
  };
}

export interface MaterialMapInput {
  assets: Asset[];
  transcripts: Transcript[];
  /** Texto del guion (si hay) para ordenar los clips. */
  script?: string | null;
  /** Hora de grabación por asset (metadatos), si se conoce. */
  recordedAt?: Record<string, string | null>;
  /** Hueco mínimo (s) para marcar un tiempo muerto. */
  deadGap?: number;
}

const COLUMN_VIDEO_CATEGORIES = new Set<Asset["category"]>(["crudo-video", "ia-generado"]);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const dur = (a: Asset) => Math.max(0, a.probe.duration ?? 0);

/** Resta intervalos: [a,b] menos la lista `cuts` (ordenada o no). */
export function subtractRanges(range: [number, number], cuts: [number, number][]): [number, number][] {
  let pieces: [number, number][] = [range];
  for (const [cs, ce] of [...cuts].sort((x, y) => x[0] - y[0])) {
    const next: [number, number][] = [];
    for (const [s, e] of pieces) {
      if (ce <= s || cs >= e) next.push([s, e]);
      else {
        if (cs > s) next.push([s, cs]);
        if (ce < e) next.push([ce, e]);
      }
    }
    pieces = next;
  }
  return pieces;
}

/** ¿Este clip tiene voz para la columna? */
function speaks(a: Asset, words: TWord[] | undefined): boolean {
  if ((words?.length ?? 0) >= 3) return true;
  if (a.analysis.role === "a-roll" || a.analysis.role === "mixto") return true;
  return a.analysis.hasSpeech === true && a.analysis.role !== "b-roll";
}

/** Elige los clips de la columna: los clips base; si no hay, los clips con voz detectados. */
export function columnAssets(assets: Asset[], byAsset: Map<string, TWord[]>): { base: MaterialMap["base"]; clips: Asset[] } {
  const baseClips = assets.filter((a) => a.category === "clip-base" && a.kind === "video");
  if (baseClips.length) return { base: "clip-base", clips: baseClips };
  const detected = assets.filter((a) => a.kind === "video" && COLUMN_VIDEO_CATEGORIES.has(a.category) && speaks(a, byAsset.get(a.id)));
  if (detected.length) return { base: "a-roll-detectado", clips: detected };
  return { base: "ninguno", clips: [] };
}

function supportKind(a: Asset): SupportItem["kind"] | null {
  if (a.category === "render" || a.category === "motion-render" || a.category === "fuente" || a.category === "guion" || a.category === "referencia") return null;
  if (a.kind === "video") return "b-roll";
  if (a.kind === "imagen") return a.category === "logo" ? "logo" : a.category === "grafico" ? "grafico" : "foto";
  if (a.kind === "audio") return a.category === "musica" ? "musica" : a.category === "sfx" ? "sfx" : a.category === "crudo-voz" ? "voz" : "otro";
  return null;
}

/** Fragmentos de UN clip de la columna (sin decidir todavía las tomas repetidas). */
function clipFragments(a: Asset, words: TWord[] | undefined, deadGap: number): MaterialFragment[] {
  const d = dur(a) || (words?.length ? words[words.length - 1]!.end + 0.3 : 0);
  const out: MaterialFragment[] = [];
  const broll = a.analysis.brollSegments.filter((b) => b.end - b.start >= 0.5);
  if (words && words.length >= 3) {
    const phrases = splitPhrases(words);
    const speech: [number, number][] = phrases.map((p) => [p.start, p.end]);
    for (const p of phrases) {
      out.push({ id: p.id, assetId: a.id, kind: "habla", start: round3(p.start), end: round3(p.end), text: p.text, score: 1, reason: "Frase hablada", takeGroupId: null });
    }
    // B-roll del propio clip, sin pisar lo que se dice (con un pequeño margen).
    const padded = speech.map(([s, e]) => [s - 0.15, e + 0.15] as [number, number]);
    const brollRanges: [number, number][] = [];
    for (const b of broll) {
      for (const [s, e] of subtractRanges([b.start, b.end], padded)) {
        if (e - s < 1) continue;
        brollRanges.push([s, e]);
        out.push({ id: `${a.id}:b${round2(s)}`, assetId: a.id, kind: "b-roll", start: round3(s), end: round3(e), text: "", score: b.score, reason: b.description || "Toma de apoyo sin voz dentro del clip", takeGroupId: null });
      }
    }
    // Tiempos muertos: huecos sin voz ni b-roll.
    for (const [s, e] of subtractRanges([0, d], [...speech, ...brollRanges])) {
      if (e - s >= deadGap) out.push({ id: `${a.id}:m${round2(s)}`, assetId: a.id, kind: "tiempo-muerto", start: round3(s), end: round3(e), text: "", score: 0, reason: `Pausa de ${round2(e - s)} s sin voz`, takeGroupId: null });
    }
  } else if (a.analysis.hasSpeech === false || a.analysis.role === "b-roll") {
    // Toma de apoyo completa (o sus mejores fragmentos).
    const ranges = broll.length ? broll.map((b) => ({ s: b.start, e: b.end, score: b.score, why: b.description })) : d > 0 ? [{ s: 0, e: d, score: 0.5, why: "" }] : [];
    for (const r of ranges) out.push({ id: `${a.id}:b${round2(r.s)}`, assetId: a.id, kind: "b-roll", start: round3(r.s), end: round3(r.e), text: "", score: r.score, reason: r.why || "Toma de apoyo sin voz", takeGroupId: null });
  } else if (d > 0) {
    // Con voz pero sin transcripción: tramos con sonido (sin silencios largos ni b-roll).
    const silences = a.analysis.silences.filter(([s, e]) => e - s >= 1).map(([s, e]) => [s, e] as [number, number]);
    const brollRanges = broll.map((b) => [b.start, b.end] as [number, number]);
    for (const [s, e] of subtractRanges([0, d], [...silences, ...brollRanges])) {
      if (e - s >= 0.4) out.push({ id: `${a.id}:r${round2(s)}`, assetId: a.id, kind: "habla", start: round3(s), end: round3(e), text: "", score: 0.8, reason: "Tramo con voz (sin transcripción)", takeGroupId: null });
    }
    for (const b of broll) out.push({ id: `${a.id}:b${round2(b.start)}`, assetId: a.id, kind: "b-roll", start: round3(b.start), end: round3(b.end), text: "", score: b.score, reason: b.description || "Toma de apoyo sin voz dentro del clip", takeGroupId: null });
    for (const [s, e] of silences) {
      const free = subtractRanges([s, e], brollRanges);
      for (const [fs, fe] of free) if (fe - fs >= deadGap) out.push({ id: `${a.id}:m${round2(fs)}`, assetId: a.id, kind: "tiempo-muerto", start: round3(fs), end: round3(fe), text: "", score: 0, reason: `Silencio de ${round2(fe - fs)} s`, takeGroupId: null });
    }
  }
  return out.sort((x, y) => x.start - y.start || x.kind.localeCompare(y.kind));
}

/** Texto de resumen para la interfaz. */
export function materialSummaryText(s: Omit<MaterialMap["summary"], "text">): string {
  const parts = [plural(s.clips, "clip", "clips")];
  parts.push(plural(s.repeatedTakes, "toma repetida", "tomas repetidas"));
  const broll = s.brollFragments + s.supportBroll;
  parts.push(`${plural(broll, "toma de apoyo detectada", "tomas de apoyo detectadas")}`);
  if (s.deadSeconds >= 3) parts.push(`${Math.round(s.deadSeconds)} s de tiempos muertos`);
  return parts.join(" · ");
}

/** Arma el mapa del material. Puro y determinista. */
export function buildMaterialMap(input: MaterialMapInput): MaterialMap {
  const deadGap = input.deadGap ?? 1.5;
  const byAsset = wordsByAsset(input.transcripts);
  const { base, clips: column } = columnAssets(input.assets, byAsset);

  // Orden sugerido de la columna.
  const orderClips: OrderClip[] = column.map((a) => ({
    assetId: a.id,
    name: a.originalName,
    createdAt: a.createdAt,
    order: a.order,
    recordedAt: input.recordedAt?.[a.id] ?? null,
    text: (byAsset.get(a.id) ?? []).map((w) => w.text).join(" "),
    note: a.note,
  }));
  const order = suggestClipOrder(orderClips, { script: input.script ?? null });
  const rank = new Map(order.assetIds.map((id, i) => [id, i]));
  const sortedColumn = [...column].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));

  // Fragmentos por clip y tomas repetidas sobre las frases en el orden de la columna.
  let fragments = sortedColumn.flatMap((a) => clipFragments(a, byAsset.get(a.id), deadGap));
  const spoken = fragments.filter((f) => f.kind === "habla" && f.text);
  const wordsOf = (f: MaterialFragment) => (byAsset.get(f.assetId) ?? []).filter((w) => w.start >= f.start - 0.001 && w.end <= f.end + 0.001);
  const takes = detectRepeatedTakes(spoken.map((f) => ({ id: f.id, assetId: f.assetId, start: f.start, end: f.end, text: f.text, words: wordsOf(f) })));
  const groupReason = new Map(takes.groups.map((g) => [g.id, g]));
  fragments = fragments.map((f) => {
    const gid = takes.discarded.get(f.id);
    if (gid) {
      const g = groupReason.get(gid)!;
      const fs = g.falseStartIds.includes(f.id);
      return { ...f, kind: "toma-repetida", takeGroupId: gid, score: 0, reason: fs ? "Arranque en falso (se retoma después)" : g.reason };
    }
    const keepOf = takes.groups.find((g) => g.keepId === f.id);
    return keepOf ? { ...f, takeGroupId: keepOf.id, reason: `Mejor toma: ${keepOf.reason}` } : f;
  });

  const sumKind = (assetId: string, kind: FragmentKind) => round2(fragments.filter((f) => f.assetId === assetId && f.kind === kind).reduce((s, f) => s + (f.end - f.start), 0));
  const clips: MaterialClipInfo[] = sortedColumn.map((a, i) => ({
    assetId: a.id,
    name: a.originalName,
    category: a.category,
    duration: round2(dur(a)),
    role: a.analysis.role,
    suggestedOrder: i,
    orderReason: order.perClip[a.id] ?? order.reason,
    recordedAt: input.recordedAt?.[a.id] ?? null,
    hasTranscript: (byAsset.get(a.id)?.length ?? 0) >= 3,
    speechSeconds: sumKind(a.id, "habla"),
    brollSeconds: sumKind(a.id, "b-roll"),
    deadSeconds: sumKind(a.id, "tiempo-muerto"),
    repeatedSeconds: sumKind(a.id, "toma-repetida"),
  }));

  const inColumn = new Set(column.map((a) => a.id));
  const support: SupportItem[] = [];
  for (const a of input.assets) {
    if (inColumn.has(a.id)) continue;
    const kind = supportKind(a);
    if (!kind) continue;
    const segs = a.analysis.brollSegments.reduce((s, b) => s + Math.max(0, b.end - b.start), 0);
    support.push({ assetId: a.id, name: a.originalName, kind, brollSeconds: kind === "b-roll" ? round2(segs > 0 ? segs : dur(a)) : 0 });
  }
  const supportBroll = input.assets
    .filter((a) => !inColumn.has(a.id) && supportKind(a) === "b-roll")
    .reduce((n, a) => n + Math.max(1, a.analysis.brollSegments.length), 0);

  const summaryBase = {
    clips: clips.length,
    repeatedTakes: fragments.filter((f) => f.kind === "toma-repetida").length,
    falseStarts: takes.groups.reduce((n, g) => n + g.falseStartIds.length, 0),
    brollFragments: fragments.filter((f) => f.kind === "b-roll").length,
    supportBroll,
    speechSeconds: round2(clips.reduce((s, c) => s + c.speechSeconds, 0)),
    deadSeconds: round2(clips.reduce((s, c) => s + c.deadSeconds, 0)),
  };
  return {
    version: MATERIAL_MAP_VERSION,
    base,
    clips,
    order,
    fragments,
    takes: takes.groups,
    support,
    summary: { ...summaryBase, text: materialSummaryText(summaryBase) },
  };
}

/** Mapa del material de una entrada del editor: el que mandó el servidor o uno calculado aquí. */
export function materialMapFor(input: { materialMap?: MaterialMap | null; assets: Asset[]; transcripts: Transcript[]; settings: ProjectSettings }): MaterialMap {
  if (input.materialMap) return input.materialMap;
  const script = input.settings.context.script.enabled ? input.settings.context.script.text : "";
  return buildMaterialMap({ assets: input.assets, transcripts: input.transcripts, script });
}

/** Ids de frases descartadas por tomas repetidas (para que el editor no las use). */
export function discardedPhraseIds(map: MaterialMap): Set<string> {
  return new Set(map.fragments.filter((f) => f.kind === "toma-repetida").map((f) => f.id));
}

/** Descripción compacta del mapa para el prompt de Claude (acotada para material largo). */
export function describeMaterialMap(map: MaterialMap, opts: { maxTakes?: number; maxBroll?: number } = {}): string {
  const maxTakes = opts.maxTakes ?? 40;
  const maxBroll = opts.maxBroll ?? 30;
  const lines: string[] = [];
  lines.push(`Resumen: ${map.summary.text}.`);
  if (map.base === "ninguno") lines.push("No hay clip base ni clips con voz: arma un montaje con las tomas de apoyo y fotos.");
  else {
    lines.push(
      `Columna del video (${map.base === "clip-base" ? "clips base que subió el usuario" : "clips con voz detectados"}), orden sugerido ${map.order.reason}${map.order.manual ? " — RESPÉTALO" : " — puedes cambiarlo si la narrativa lo pide"}:`,
    );
    for (const c of map.clips) {
      lines.push(
        `  ${c.suggestedOrder + 1}. ${c.assetId} «${c.name}» ${c.duration} s · habla ${c.speechSeconds} s · b-roll ${c.brollSeconds} s · tiempos muertos ${c.deadSeconds} s · tomas repetidas ${c.repeatedSeconds} s (${c.orderReason})`,
      );
    }
  }
  if (map.takes.length) {
    lines.push(`Tomas repetidas (usa SOLO la toma elegida; nunca las descartadas):`);
    const byId = new Map(map.fragments.map((f) => [f.id, f]));
    for (const g of map.takes.slice(0, maxTakes)) {
      const keep = byId.get(g.keepId);
      const drop = g.discardIds.map((id) => byId.get(id)).filter((f): f is MaterialFragment => !!f);
      lines.push(
        `  - queda ${keep?.assetId} ${keep?.start}–${keep?.end} «${(keep?.text ?? "").slice(0, 70)}»; descartar ${drop.map((f) => `${f.assetId} ${f.start}–${f.end}`).join(", ")}`,
      );
    }
    if (map.takes.length > maxTakes) lines.push(`  …y ${map.takes.length - maxTakes} grupos más (pide el detalle con ver_mapa_material).`);
  }
  const broll = map.fragments.filter((f) => f.kind === "b-roll");
  if (broll.length) {
    lines.push("Tomas de apoyo DENTRO de los clips de la columna (úsalas como fondo o corte sobre lo que se dice; nunca como columna):");
    for (const f of broll.slice(0, maxBroll)) lines.push(`  - ${f.assetId} ${f.start}–${f.end} (puntaje ${round2(f.score)})${f.reason ? ` ${f.reason}` : ""}`);
    if (broll.length > maxBroll) lines.push(`  …y ${broll.length - maxBroll} más.`);
  }
  const dead = map.fragments.filter((f) => f.kind === "tiempo-muerto");
  if (dead.length) lines.push(`Tiempos muertos (no los uses): ${dead.length} tramos, ${map.summary.deadSeconds} s en total.`);
  if (map.support.length) lines.push(`Material de apoyo (abajo): ${map.support.map((s) => `${s.assetId} ${s.kind}${s.brollSeconds ? ` ${s.brollSeconds} s` : ""}`).join(", ")}.`);
  return lines.join("\n");
}
