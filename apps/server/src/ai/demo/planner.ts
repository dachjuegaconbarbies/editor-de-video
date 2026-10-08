/**
 * EDITOR DEMO: planeación determinista (sin IA) que da videos razonables.
 *
 * Pasos:
 *  1. Clasifica el material (a-roll con voz, b-roll, fotos, música, SFX, logos).
 *  2. Parte la transcripción en frases y arma segmentos quitando silencios y muletillas SIN cortar palabras
 *     (los cortes caen en los huecos entre palabras) y respetando las marcas "quitar"/"debe-ir".
 *  3. Ajusta a la duración objetivo: auto = todo; aproximada/exacta = elige las frases de más valor
 *     (palabras clave, gancho, CTA, "debe-ir", "debe aparecer") con una mochila; en exacta clava la
 *     duración (±0.5 s) ajustando el último plano, los respiros entre frases o un cierre.
 *  4. Ritmo: parte planos largos en tomas ≤ targetShotLength con punch-ins alternados; reencuadre a vertical.
 *  5. B-roll, títulos, CTA, cintillo, subtítulos, música con ducking, SFX, motion graphics, pedidos de IA
 *     y marca según las herramientas prendidas. Al final aplica las reglas aprendidas con comprobación.
 */
import type {
  AiRequest,
  Asset,
  Brand,
  CaptionStyle,
  FontRef,
  GraphicItem,
  Keyword,
  MotionTemplate,
  OverlayItem,
  PlanScene,
  ProvidersConfig,
  Recipe,
  SfxItem,
  StyleTokens,
  TextItem,
  Transition,
  VideoClip,
} from "@autoeditor/shared";
import { clipDuration, normalizeRecipe, RESOLUTIONS, sourceToTimeline, StyleTokens as StyleTokensSchema } from "@autoeditor/shared";
import type { EditInput } from "../../services/types.js";
import { UserFacingError } from "../../services/types.js";
import { applyRuleCheck } from "../shared/checks.js";
import { familyFromFontFile } from "../shared/fonts.js";
import { buildScenes, validateWith } from "../shared/recipe-ops.js";
import { isRemovableFiller, splitPhrases, wordsByAsset, type Phrase, type TWord } from "../shared/transcript.js";
import { capitalizeFirst, clamp, digitsForNumberWords, hashString, limitWords, looksLikeCta, normalize, round2, round3, stripPunctuation } from "../shared/text.js";
import { buildKieRequestCost } from "../shared/ai-requests.js";
import { discardedPhraseIds, materialMapFor, type MaterialMap } from "../shared/material-map.js";
import { detectKeywordsHeuristic, findCtaPhrase, findHookPhrase } from "./keywords.js";

export interface DemoPlanOptions {
  kie: ProvidersConfig["kie"];
}

export interface DemoPlanOutput {
  recipe: Recipe;
  scenes: PlanScene[];
  summary: string;
}

const PACING_SHOT = { lento: 4, medio: 2.5, rapido: 1.5 } as const;
const SILENCE = { suave: { gap: 0.9, pad: 0.2 }, media: { gap: 0.5, pad: 0.12 }, agresiva: { gap: 0.3, pad: 0.07 } } as const;
const ZOOM_SCALE = { sutil: 1.08, media: 1.12, fuerte: 1.18 } as const;
const BROLL_FREQ = { baja: { every: 12, dur: 3 }, media: { every: 7, dur: 2.5 }, alta: { every: 4, dur: 2 } } as const;

/** Segmento de material continuo (tiempos del archivo fuente). */
interface Seg {
  assetId: string;
  phraseKey: string;
  in: number;
  out: number;
  words: TWord[];
}

/** Frase candidata (una o varias tomas) con su valor editorial. */
interface Cand {
  key: string;
  assetId: string;
  order: number;
  phrase: Phrase | null;
  segs: Seg[];
  dur: number;
  value: number;
  mustKeep: boolean;
  label: string;
}

/** Plano principal en construcción con sus márgenes para extender/recortar sin pisar palabras. */
interface ClipMeta {
  assetId: string;
  phraseKey: string;
  in: number;
  out: number;
  words: TWord[];
  speech: boolean;
  still: number | null;
  minIn: number;
  maxOut: number;
  zoom: VideoClip["zoom"];
  transition: Transition;
  reason: string;
  volume: number;
  kind: "voz" | "intro" | "outro" | "cierre" | "montaje";
  speed: number;
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const quote = (s: string, max = 7) => `«${limitWords(s.replace(/\s+([,.!?;:])/g, "$1"), max)}${s.split(/\s+/).length > max ? "…" : ""}»`;

/** Orden del material: "abre con este" primero, "cierra con este" al final, luego el orden manual. */
function sortAssets(list: Asset[]): Asset[] {
  const weight = (a: Asset) => {
    const n = normalize(a.note);
    if (/\b(abre|abrir|empieza|inicio|primero|arranca)\b/.test(n)) return -1;
    if (/\b(cierra|cerrar|final|termina|ultimo)\b/.test(n)) return 1;
    return 0;
  };
  return [...list].sort((a, b) => weight(a) - weight(b) || a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

interface Material {
  /** Columna del video: clips base (o clips con voz detectados) en el orden sugerido. */
  aroll: Asset[];
  broll: Asset[];
  photos: Asset[];
  music: Asset[];
  sfx: Asset[];
  logos: Asset[];
  words: Map<string, TWord[]>;
  map: MaterialMap;
}

export { materialMapFor };

/**
 * Clasifica el material. La columna sale del mapa del material: los clips base en su orden sugerido
 * (si no hay, los clips con voz detectados); todo lo demás es apoyo (b-roll, fotos, música…).
 */
function classify(input: EditInput): Material {
  const words = wordsByAsset(input.transcripts);
  const map = materialMapFor(input);
  const byId = new Map(input.assets.map((a) => [a.id, a]));
  const columnIds = new Set(map.clips.map((c) => c.assetId));
  const aroll: Asset[] = [];
  const columnBroll: Asset[] = [];
  for (const c of map.clips) {
    const a = byId.get(c.assetId);
    if (!a) continue;
    if (c.speechSeconds > 0 || c.hasTranscript) aroll.push(a);
    else columnBroll.push(a);
  }
  const others = input.assets.filter((a) => a.kind === "video" && !columnIds.has(a.id) && (a.category === "crudo-video" || a.category === "ia-generado" || a.category === "clip-base"));
  return {
    aroll,
    broll: [...columnBroll, ...sortAssets(others)],
    photos: sortAssets(input.assets.filter((a) => a.kind === "imagen" && (a.category === "crudo-foto" || a.category === "grafico"))),
    music: sortAssets(input.assets.filter((a) => a.kind === "audio" && a.category === "musica")),
    sfx: sortAssets(input.assets.filter((a) => a.kind === "audio" && a.category === "sfx")),
    logos: sortAssets(input.assets.filter((a) => a.kind === "imagen" && a.category === "logo")),
    words,
    map,
  };
}

interface BrandKit {
  colors: string[];
  googleFonts: string[];
  fontAssets: Asset[];
  logoAssetIds: string[];
  introAssetId: string | null;
  outroAssetId: string | null;
}

function brandKit(input: EditInput): BrandKit | null {
  const b = input.settings.context.brand;
  if (!b.enabled) return null;
  const lib: Brand | null = input.brand;
  const inline = b.inline;
  const pick = <T>(a: T[] | undefined, c: T[] | undefined) => (a && a.length ? a : (c ?? []));
  const fontIds = pick(inline.fontAssetIds, lib?.fontAssetIds);
  return {
    colors: pick(inline.colors, lib?.colors).filter((c) => /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(c)),
    googleFonts: pick(inline.googleFonts, lib?.googleFonts),
    fontAssets: fontIds.map((id) => input.assets.find((a) => a.id === id)).filter((a): a is Asset => !!a),
    logoAssetIds: pick(inline.logoAssetIds, lib?.logoAssetIds),
    introAssetId: inline.introAssetId ?? lib?.introAssetId ?? null,
    outroAssetId: inline.outroAssetId ?? lib?.outroAssetId ?? null,
  };
}

/** Tokens de estilo: receta base / estilo guardado → herramientas → marca. */
function buildStyle(input: EditInput, brand: BrandKit | null): { style: StyleTokens; captionStyle: CaptionStyle } {
  const t = input.settings.tools;
  const preset = input.style?.version.preset;
  const style: StyleTokens = structuredClone(input.baseRecipe?.style ?? preset?.styleTokens ?? StyleTokensSchema.parse({}));
  const captionStyle: CaptionStyle = structuredClone(input.settings.captions.style);
  if (!input.baseRecipe && !preset) {
    style.targetShotLength = t.pacing.enabled ? PACING_SHOT[t.pacing.value] : 4;
  }
  if (t.transitions.enabled) {
    const map: Record<string, Transition> = {
      auto: { type: "corte", duration: 0 },
      corte: { type: "corte", duration: 0 },
      fundido: { type: "fundido", duration: 0.3 },
      barrido: { type: "barrido", duration: 0.3 },
      zoom: { type: "zoom", duration: 0.3 },
      deslizar: { type: "deslizar-izq", duration: 0.3 },
    };
    if (!input.baseRecipe && !preset) style.defaultTransition = map[t.transitions.style] ?? { type: "corte", duration: 0 };
  } else style.defaultTransition = { type: "corte", duration: 0 };

  if (brand) {
    const [c0, c1, c2] = brand.colors;
    if (c0) style.palette.primary = c0.toUpperCase();
    if (c1) style.palette.secondary = c1.toUpperCase();
    if (c2) style.palette.accent = c2.toUpperCase();
    if (c0) captionStyle.highlightColor = (c1 ?? c0).toUpperCase();
    const fontRefs: FontRef[] = [
      ...brand.fontAssets.map((a) => ({ family: familyFromFontFile(a.originalName), weight: 800, assetId: a.id, googleFont: null })),
      ...brand.googleFonts.map((g) => ({ family: g, weight: 800, assetId: null, googleFont: g })),
    ];
    const title = fontRefs[0];
    const body = fontRefs[1] ?? fontRefs[0];
    if (title) style.titleFont = { ...title };
    if (body) {
      style.bodyFont = { ...body, weight: 500 };
      captionStyle.font = { ...body, weight: 800 };
    }
  }
  return { style, captionStyle };
}

/** Palabras clave para decidir: las del proyecto (activas) o, si no hay, la heurística. */
function planKeywords(input: EditInput): Keyword[] {
  const active = input.keywords.filter((k) => k.enabled);
  if (active.length) return active;
  return detectKeywordsHeuristic({ transcripts: input.transcripts, settings: input.settings, existing: [], glossary: input.glossary }).keywords;
}

/** Arma los segmentos de una frase quitando muletillas, palabras "quitar" y silencios largos. */
function phraseSegments(p: Phrase, all: TWord[], assetDur: number, opts: { removeSilences: boolean; gap: number; pad: number; removeFillers: boolean; extraFillers: string[] }, removed: TWord[]): Seg[] {
  const segs: Seg[] = [];
  let run: TWord[] = [];
  const flush = () => {
    if (!run.length) return;
    const first = run[0]!;
    const last = run[run.length - 1]!;
    const prev = all[first.pos - 1];
    const next = all[last.pos + 1];
    let segIn: number;
    let segOut: number;
    if (opts.removeSilences) {
      segIn = Math.max(first.start - opts.pad, prev ? prev.end + 0.02 : 0, 0);
      segOut = Math.min(last.end + opts.pad, next ? next.start - 0.02 : assetDur, assetDur);
    } else {
      // Sin quitar silencios: los segmentos se tocan en el punto medio de las pausas.
      segIn = prev ? (prev.end + first.start) / 2 : Math.max(0, first.start - 0.4);
      segOut = next ? (last.end + next.start) / 2 : Math.min(assetDur, last.end + 0.5);
      if (prev && removed.includes(prev)) segIn = Math.max(segIn, prev.end + 0.02);
      if (next && (next.mark === "quitar" || (opts.removeFillers && isRemovableFiller(next, all[next.pos - 1], all[next.pos + 1], opts.extraFillers)))) segOut = Math.min(segOut, next.start - 0.02);
    }
    if (segOut - segIn > 0.15) segs.push({ assetId: first.assetId, phraseKey: p.id, in: round3(segIn), out: round3(segOut), words: run });
    run = [];
  };
  for (const w of p.words) {
    const prevAll = all[w.pos - 1];
    const nextAll = all[w.pos + 1];
    const drop = w.mark === "quitar" || (opts.removeFillers && isRemovableFiller(w, prevAll, nextAll, opts.extraFillers));
    if (drop) {
      removed.push(w);
      flush();
      continue;
    }
    const last = run[run.length - 1];
    if (last && opts.removeSilences && w.start - last.end > opts.gap) flush();
    run.push(w);
  }
  flush();
  return segs;
}

/** Valor editorial de una frase (palabras clave, marcas, gancho, CTA). */
function phraseValue(p: Phrase, keywords: Keyword[], isFirstAsset: boolean): { value: number; mustKeep: boolean; tags: string[] } {
  let value = 0.5;
  const tags: string[] = [];
  const idxSet = new Set(p.words.map((w) => w.i));
  for (const k of keywords) {
    const hits = k.occurrences.filter((o) => o.assetId === p.assetId && idxSet.has(o.wordIndex)).length;
    if (hits) {
      value += hits * (1 + 2 * (k.score || 0.5)) * (k.category === "gancho" ? 1.5 : 1);
      tags.push(k.text);
    }
  }
  if (isFirstAsset && p.index === 0) value += 3;
  if (isFirstAsset && p.index === 1) value += 1.5;
  if (looksLikeCta(p.text)) value += 2;
  value += p.words.filter((w) => w.mark === "resaltar").length * 1.5;
  const mustKeep = p.words.some((w) => w.mark === "debe-ir");
  if (p.words.length <= 2 && !mustKeep) value -= 0.4;
  return { value, mustKeep, tags };
}

/** Mochila 0/1 (resolución 0.05 s): máximo valor con duración ≤ capacidad (premia llenar el tiempo). */
function knapsack(items: Cand[], capacity: number): Set<string> {
  const unit = 0.05;
  const cap = Math.max(0, Math.floor(capacity / unit));
  const w = items.map((it) => Math.max(1, Math.round(it.dur / unit)));
  const v = items.map((it) => it.value + 0.35 * it.dur);
  const n = items.length;
  const best = new Float64Array(cap + 1);
  const take: Uint8Array[] = items.map(() => new Uint8Array(cap + 1));
  for (let i = 0; i < n; i++) {
    const wi = w[i]!;
    const vi = v[i]!;
    for (let c = cap; c >= wi; c--) {
      const cand = best[c - wi]! + vi;
      if (cand > best[c]! + 1e-9) {
        best[c] = cand;
        take[i]![c] = 1;
      }
    }
  }
  const chosen = new Set<string>();
  let c = cap;
  for (let i = n - 1; i >= 0; i--) {
    if (take[i]![c]) {
      chosen.add(items[i]!.key);
      c -= w[i]!;
    }
  }
  return chosen;
}

/** Elige frases según el objetivo de duración. */
function selectCandidates(cands: Cand[], target: number | null, mode: "auto" | "aproximada" | "exacta"): Cand[] {
  if (target == null || mode === "auto") return cands;
  const total = cands.reduce((s, c) => s + c.dur, 0);
  const capacity = mode === "exacta" ? target + 0.3 : target * 1.08;
  if (total <= capacity) return cands;
  const must = cands.filter((c) => c.mustKeep);
  const mustDur = must.reduce((s, c) => s + c.dur, 0);
  const rest = cands.filter((c) => !c.mustKeep);
  const chosen = knapsack(rest, Math.max(0, capacity - mustDur));
  return cands.filter((c) => c.mustKeep || chosen.has(c.key));
}

/** Parte un segmento largo en tomas ≤ objetivo, siempre entre palabras. */
function splitForPacing(seg: Seg, target: number): { in: number; out: number; words: TWord[] }[] {
  const d = seg.out - seg.in;
  if (d <= target * 1.4 || seg.words.length < 2) return [{ in: seg.in, out: seg.out, words: seg.words }];
  const n = Math.max(2, Math.round(d / target));
  const points = seg.words.slice(0, -1).map((w, k) => round3((w.end + seg.words[k + 1]!.start) / 2));
  const cuts: number[] = [];
  let last = seg.in;
  for (let j = 1; j < n; j++) {
    const ideal = seg.in + (d * j) / n;
    let best: number | null = null;
    for (const p of points) {
      if (p - last < 0.8 || seg.out - p < 0.8) continue;
      if (best == null || Math.abs(p - ideal) < Math.abs(best - ideal)) best = p;
    }
    if (best != null && !cuts.includes(best)) {
      cuts.push(best);
      last = best;
    }
  }
  const bounds = [seg.in, ...cuts.sort((a, b) => a - b), seg.out];
  const pieces: { in: number; out: number; words: TWord[] }[] = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const a = bounds[k]!;
    const b = bounds[k + 1]!;
    pieces.push({ in: a, out: b, words: seg.words.filter((w) => (w.start + w.end) / 2 >= a && (w.start + w.end) / 2 <= b) });
  }
  return pieces;
}

/** Reencuadre según formato, herramienta y rostros detectados. */
function reframeFor(asset: Asset, outW: number, outH: number, tool: EditInput["settings"]["tools"]["reframe"], range: { in: number; out: number; speed: number }): VideoClip["reframe"] {
  const rot = Math.abs(asset.probe.rotation) % 180 === 90;
  const sw = (rot ? asset.probe.height : asset.probe.width) ?? outW;
  const sh = (rot ? asset.probe.width : asset.probe.height) ?? outH;
  const srcAR = sw / sh;
  const outAR = outW / outH;
  const center = { mode: "llenar" as const, focusX: 0.5, focusY: 0.5, keyframes: [] };
  if (Math.abs(srcAR - outAR) / outAR < 0.15) return center;
  const faces = asset.analysis.faces.filter((f) => f.t >= range.in - 0.5 && f.t <= range.out + 0.5);
  const follow = (): VideoClip["reframe"] => {
    const xs = faces.map((f) => f.x).sort((a, b) => a - b);
    const ys = faces.map((f) => f.y).sort((a, b) => a - b);
    const step = Math.max(1, Math.ceil(faces.length / 8));
    return {
      mode: "seguir",
      focusX: round3(xs[Math.floor(xs.length / 2)] ?? 0.5),
      focusY: round3(ys[Math.floor(ys.length / 2)] ?? 0.5),
      keyframes: faces
        .filter((_, k) => k % step === 0)
        .map((f) => ({ t: round3(Math.max(0, (f.t - range.in) / range.speed)), x: round3(clamp(f.x, 0, 1)), y: round3(clamp(f.y, 0, 1)) })),
    };
  };
  if (!tool.enabled) return { mode: "fondo-desenfocado", focusX: 0.5, focusY: 0.5, keyframes: [] };
  switch (tool.mode) {
    case "centro":
      return center;
    case "fondo-desenfocado":
      return { mode: "fondo-desenfocado", focusX: 0.5, focusY: 0.5, keyframes: [] };
    case "seguir":
      return faces.length ? follow() : center;
    default:
      return faces.length ? follow() : { mode: "fondo-desenfocado", focusX: 0.5, focusY: 0.5, keyframes: [] };
  }
}

interface Stats {
  fillers: TWord[];
  silences: number;
  silenceSeconds: number;
  droppedPhrases: number;
  shots: number;
  brollInserts: number;
  endCard: boolean;
  warnings: string[];
  /** Frases descartadas por ser tomas repetidas o arranques en falso. */
  repeatedTakes: number;
}

export function buildDemoPlan(input: EditInput, opts: DemoPlanOptions): DemoPlanOutput {
  const s = input.settings;
  const t = s.tools;
  const aspect = s.instruction.format;
  const { width, height } = RESOLUTIONS[aspect];
  const mat = classify(input);
  if (!mat.aroll.length && !mat.broll.length && !mat.photos.length) {
    throw new UserFacingError("sin-material", "Sube al menos un video o una foto para generar el video.", 409);
  }
  const brand = brandKit(input);
  const { style, captionStyle } = buildStyle(input, brand);
  const rules = input.rules.filter((r) => r.enabled);
  const appliedRuleIds = new Set<string>();
  // Reglas que influyen en decisiones (no solo en valores finales).
  for (const r of rules) {
    if (r.check?.type === "duracion-plano-max") {
      style.targetShotLength = Math.min(style.targetShotLength, Math.max(0.6, r.check.seconds * 0.85));
      appliedRuleIds.add(r.id);
    }
  }
  const bannedTransitions = new Set(rules.flatMap((r) => (r.check?.type === "sin-transicion" ? [r.check.transition] : [])));
  const allowTransition = (tr: Transition): Transition => (bannedTransitions.has(tr.type) ? { type: "corte", duration: 0 } : tr);
  const keywords = planKeywords(input);
  const target = s.instruction.targetDuration;
  const mode = target == null ? "auto" : s.instruction.durationMode;
  const silence = SILENCE[t.removeSilences.aggressiveness];
  const stats: Stats = { fillers: [], silences: 0, silenceSeconds: 0, droppedPhrases: 0, shots: 0, brollInserts: 0, endCard: false, warnings: [], repeatedTakes: 0 };
  const assetById = new Map(input.assets.map((a) => [a.id, a]));
  const nameOf = (id: string) => assetById.get(id)?.originalName ?? id;

  // ---------------------------------------------------------------------------
  // 1-2) Candidatos por frase.
  // ---------------------------------------------------------------------------
  const cands: Cand[] = [];
  const phraseByKey = new Map<string, Phrase>();
  const discarded = discardedPhraseIds(mat.map);
  mat.aroll.forEach((asset, assetIdx) => {
    const dur = asset.probe.duration ?? 0;
    const all = mat.words.get(asset.id);
    if (!all || all.length < 3) {
      // A-roll sin transcripción: tramos con voz del mapa (sin silencios largos ni b-roll del propio clip),
      // o tramos con sonido según el análisis, o el clip completo.
      const ranges: [number, number][] = [];
      const spoken = mat.map.fragments.filter((f) => f.assetId === asset.id && f.kind === "habla");
      const hasBrollInside = mat.map.fragments.some((f) => f.assetId === asset.id && f.kind === "b-roll");
      if (spoken.length && (t.removeSilences.enabled || hasBrollInside)) {
        for (const f of spoken) ranges.push([f.start, f.end]);
      } else if (t.removeSilences.enabled && asset.analysis.silences.length) {
        let cur = 0;
        for (const [a, b] of [...asset.analysis.silences].sort((x, y) => x[0] - y[0])) {
          if (b - a < silence.gap) continue;
          if (a - cur > 0.4) ranges.push([cur, Math.min(dur, a + silence.pad)]);
          cur = Math.max(cur, b - silence.pad);
        }
        if (dur - cur > 0.4) ranges.push([cur, dur]);
      }
      if (!ranges.length && dur > 0) ranges.push([0, dur]);
      ranges.forEach(([a, b], k) => {
        const key = `${asset.id}:r${k}`;
        cands.push({
          key,
          assetId: asset.id,
          order: cands.length,
          phrase: null,
          segs: [{ assetId: asset.id, phraseKey: key, in: round3(a), out: round3(b), words: [] }],
          dur: b - a,
          value: (asset.priority === "debe-aparecer" ? 2 : 1) + (k === 0 ? 1 : 0),
          mustKeep: false,
          label: `${asset.originalName} ${fmt(a)}–${fmt(b)}`,
        });
      });
      return;
    }
    const phrases = splitPhrases(all);
    for (const p of phrases) {
      // Tomas repetidas y arranques en falso: solo queda la mejor toma de cada frase.
      if (discarded.has(p.id)) {
        stats.repeatedTakes++;
        continue;
      }
      phraseByKey.set(p.id, p);
      const segs = phraseSegments(p, all, dur || all[all.length - 1]!.end + 0.5, {
        removeSilences: t.removeSilences.enabled,
        gap: silence.gap,
        pad: silence.pad,
        removeFillers: t.removeFillers.enabled,
        extraFillers: [],
      }, stats.fillers);
      if (!segs.length) continue;
      const pv = phraseValue(p, keywords, assetIdx === 0);
      const isHook = assetIdx === 0 && p.index === 0;
      cands.push({
        key: p.id,
        assetId: asset.id,
        order: cands.length,
        phrase: p,
        segs,
        dur: segs.reduce((acc, sg) => acc + (sg.out - sg.in), 0),
        value: pv.value,
        mustKeep: pv.mustKeep,
        label: `${isHook ? "Gancho" : looksLikeCta(p.text) ? "Llamado a la acción" : `Frase ${p.index + 1}`}: ${quote(p.text)}${pv.tags.length ? ` (palabras clave: ${[...new Set(pv.tags)].slice(0, 3).join(", ")})` : ""}`,
      });
    }
    // "Debe aparecer": su mejor frase se queda sí o sí.
    if (asset.priority === "debe-aparecer") {
      const mine = cands.filter((c) => c.assetId === asset.id);
      const best = [...mine].sort((a, b) => b.value - a.value)[0];
      if (best && !mine.some((c) => c.mustKeep)) best.mustKeep = true;
    }
  });

  // ---------------------------------------------------------------------------
  // 3) Selección por duración objetivo.
  // ---------------------------------------------------------------------------
  const introAsset = brand?.introAssetId ? assetById.get(brand.introAssetId) : undefined;
  const outroAsset = brand?.outroAssetId ? assetById.get(brand.outroAssetId) : undefined;
  const fixedDur = (introAsset?.kind === "video" ? (introAsset.probe.duration ?? 0) : 0) + (outroAsset?.kind === "video" ? (outroAsset.probe.duration ?? 0) : 0);
  const speechTarget = target != null ? Math.max(1, target - fixedDur) : null;
  const selected = cands.length ? selectCandidates(cands, speechTarget, mode) : [];
  stats.droppedPhrases = cands.length - selected.length;
  if (target != null && mode !== "auto") {
    const material = cands.reduce((acc, c) => acc + c.dur, 0) + fixedDur;
    if (material < target * (mode === "exacta" ? 0.97 : 0.85)) {
      stats.warnings.push(`Pediste ${target} s pero solo hay unos ${round2(material)} s de material útil.`);
    }
  }

  // ---------------------------------------------------------------------------
  // 4) Planos: ritmo, punch-ins, reencuadre y transiciones.
  // ---------------------------------------------------------------------------
  const zoomScale = ZOOM_SCALE[t.zooms.intensity];
  const metas: ClipMeta[] = [];
  const topKeywordWords = new Set<string>();
  const topKw = [...keywords].sort((a, b) => b.score - a.score)[0];
  topKw?.occurrences.forEach((o) => topKeywordWords.add(`${o.assetId}:${o.wordIndex}`));
  let shot = 0;
  const speechTransition = (): Transition => {
    if (!t.transitions.enabled || t.transitions.style === "auto" || t.transitions.style === "corte") return { type: "corte", duration: 0 };
    return allowTransition({ ...style.defaultTransition, duration: round3(Math.min(0.2, style.defaultTransition.duration, silence.pad * 1.6)) });
  };
  let prevPhrase: string | null = null;
  for (const c of selected.sort((a, b) => a.order - b.order)) {
    for (const seg of c.segs) {
      const pieces = t.pacing.enabled && t.zooms.enabled ? splitForPacing(seg, style.targetShotLength) : [{ in: seg.in, out: seg.out, words: seg.words }];
      pieces.forEach((piece, k) => {
        let zoom: VideoClip["zoom"] = null;
        if (t.zooms.enabled) {
          const hasTop = piece.words.some((w) => topKeywordWords.has(`${w.assetId}:${w.i}`));
          if (hasTop) zoom = { from: 1, to: zoomScale, start: 0, end: null, ease: "suave" };
          else if (shot % 2 === 1) zoom = { from: zoomScale, to: zoomScale, start: 0, end: null, ease: "lineal" };
        }
        const newPhrase = prevPhrase !== null && prevPhrase !== c.key && k === 0;
        metas.push({
          assetId: c.assetId,
          phraseKey: c.key,
          in: piece.in,
          out: piece.out,
          words: piece.words,
          speech: piece.words.length > 0,
          still: null,
          minIn: 0,
          maxOut: assetById.get(c.assetId)?.probe.duration ?? piece.out,
          zoom,
          transition: newPhrase ? speechTransition() : { type: "corte", duration: 0 },
          reason: c.label,
          volume: 1,
          kind: "voz",
          speed: 1,
        });
        shot++;
      });
      prevPhrase = c.key;
    }
  }

  // Sin a-roll: montaje con b-roll y fotos al ritmo elegido.
  if (!metas.length) {
    const shotLen = style.targetShotLength;
    const totalWanted = target ?? Math.min(30, Math.max(8, (mat.broll.reduce((a, b) => a + (b.probe.duration ?? 0), 0) + mat.photos.length * shotLen) * 0.8));
    let acc = 0;
    const pool: { asset: Asset; in: number; out: number }[] = [];
    for (const v of mat.broll) {
      const segs = v.analysis.brollSegments.length ? v.analysis.brollSegments : [{ start: 0, end: v.probe.duration ?? shotLen, score: 0.5, description: "", tags: [] }];
      for (const sg of segs) for (let a = sg.start; a + 0.8 <= sg.end; a += shotLen) pool.push({ asset: v, in: a, out: Math.min(sg.end, a + shotLen) });
    }
    for (const p of mat.photos) pool.push({ asset: p, in: 0, out: shotLen });
    if (!pool.length) throw new UserFacingError("sin-material", "No encontré tomas utilizables en el material.", 409);
    let k = 0;
    while (acc < totalWanted - 0.2 && k < 400) {
      const item = pool[k % pool.length]!;
      const d = Math.min(item.out - item.in, totalWanted - acc);
      if (d < 0.4) break;
      const isPhoto = item.asset.kind === "imagen";
      metas.push({
        assetId: item.asset.id,
        phraseKey: `montaje-${k}`,
        in: item.in,
        out: item.in + d,
        words: [],
        speech: false,
        still: isPhoto ? d : null,
        minIn: item.in,
        maxOut: isPhoto ? item.in + d : (item.asset.probe.duration ?? item.out),
        zoom: t.zooms.enabled ? { from: 1, to: zoomScale, start: 0, end: null, ease: "suave" } : null,
        transition: k === 0 ? { type: "corte", duration: 0 } : allowTransition(t.transitions.enabled && t.transitions.style !== "corte" ? (style.defaultTransition.type === "corte" ? { type: "fundido", duration: 0.3 } : style.defaultTransition) : { type: "corte", duration: 0 }),
        reason: "Montaje con tomas de apoyo (no hay material con voz).",
        volume: 0.4,
        kind: "montaje",
        speed: 1,
      });
      acc += d - (k === 0 ? 0 : metas[metas.length - 1]!.transition.duration);
      k++;
    }
  }
  stats.shots = metas.length;

  // Márgenes de cada plano (para extender o recortar sin pisar palabras ni repetir material).
  const computeRooms = () => {
    for (const m of metas) {
      if (m.kind !== "voz" && m.kind !== "montaje") continue;
      const all = mat.words.get(m.assetId) ?? [];
      const dur = assetById.get(m.assetId)?.probe.duration ?? m.out;
      let minIn = 0;
      let maxOut = dur;
      for (const w of all) {
        if (w.end <= m.in + 0.001) minIn = Math.max(minIn, w.end + 0.02);
        if (w.start >= m.out - 0.001) {
          maxOut = Math.min(maxOut, w.start - 0.02);
          break;
        }
      }
      for (const o of metas) {
        if (o === m || o.assetId !== m.assetId || o.still != null) continue;
        if (o.out <= m.in + 0.001) minIn = Math.max(minIn, o.out);
        if (o.in >= m.out - 0.001) maxOut = Math.min(maxOut, o.in);
      }
      m.minIn = Math.min(minIn, m.in);
      m.maxOut = Math.max(maxOut, m.out);
    }
  };
  computeRooms();

  // Intro / outro de la marca.
  if (introAsset?.kind === "video" && introAsset.probe.duration) {
    metas.unshift({ assetId: introAsset.id, phraseKey: "intro", in: 0, out: introAsset.probe.duration, words: [], speech: false, still: null, minIn: 0, maxOut: introAsset.probe.duration, zoom: null, transition: { type: "corte", duration: 0 }, reason: "Intro de la marca.", volume: 1, kind: "intro", speed: 1 });
    const second = metas[1];
    if (second) second.transition = allowTransition({ type: "fundido", duration: 0.3 });
  }
  if (outroAsset?.kind === "video" && outroAsset.probe.duration) {
    metas.push({ assetId: outroAsset.id, phraseKey: "outro", in: 0, out: outroAsset.probe.duration, words: [], speech: false, still: null, minIn: 0, maxOut: outroAsset.probe.duration, zoom: null, transition: allowTransition({ type: "fundido", duration: 0.3 }), reason: "Outro de la marca.", volume: 1, kind: "outro", speed: 1 });
  }

  const format = { aspect, width, height, fps: 30, platform: s.instruction.platform };
  const colorLook = t.colorCorrection.enabled ? t.colorCorrection.look : "natural";
  const toClips = (): VideoClip[] =>
    metas.map((m, k) => {
      const asset = assetById.get(m.assetId);
      const reframe = asset ? reframeFor(asset, width, height, m.kind === "voz" ? t.reframe : { ...t.reframe, mode: "centro" }, { in: m.in, out: m.out, speed: m.speed }) : { mode: "llenar" as const, focusX: 0.5, focusY: 0.5, keyframes: [] };
      return {
        id: `clip-${k + 1}`,
        assetId: m.assetId,
        sourceIn: round3(m.still != null ? 0 : m.in),
        sourceOut: round3(m.still != null ? Math.max(0.1, m.still) : m.out),
        start: 0,
        speed: m.speed,
        reframe: asset?.kind === "imagen" ? { mode: "fondo-desenfocado", focusX: 0.5, focusY: 0.5, keyframes: [] } : reframe,
        zoom: m.zoom,
        color: { look: colorLook, brightness: 0, contrast: 1, saturation: 1 },
        volume: m.volume,
        transitionIn: k === 0 ? { type: "corte", duration: 0 } : m.transition,
        stillDuration: m.still != null ? round3(m.still) : null,
        label: `${nameOf(m.assetId)} ${m.still != null ? "(foto)" : `${fmt(m.in)}–${fmt(m.out)}`}`,
        reason: m.reason,
      };
    });

  const baseRecipe = (clips: VideoClip[]): Recipe =>
    normalizeRecipe({
      schemaVersion: 1,
      format,
      duration: 0,
      style,
      tracks: {
        video: clips,
        overlays: [],
        text: [],
        graphics: [],
        captions: { enabled: s.captions.enabled, style: captionStyle, words: [], overrides: {}, language: input.transcripts[0]?.language ?? "es", burnIn: true },
        audio: {
          music: [],
          sfx: [],
          voiceover: [],
          mix: { targetLufs: t.loudness.enabled ? t.loudness.targetLufs : -14, duckingDb: -12, voiceEnhance: t.voiceEnhance.enabled, normalize: t.loudness.enabled },
        },
      },
      ai: [],
      target: { duration: target, mode: target == null ? "auto" : s.instruction.durationMode },
      notes: "",
      meta: { generator: "demo", model: "demo", styleId: s.style.styleId, styleVersion: s.style.styleVersion, appliedRuleIds: [] },
    });

  // ---------------------------------------------------------------------------
  // 5) Duración exacta: ajustar el último plano, respiros entre frases o un cierre.
  // ---------------------------------------------------------------------------
  let recipe = baseRecipe(toClips());
  if (target != null && mode === "exacta") {
    const isBoundary = (k: number, side: "in" | "out") => {
      const m = metas[k]!;
      const other = side === "out" ? metas[k + 1] : metas[k - 1];
      if (!other) return true;
      return !(other.assetId === m.assetId && Math.abs((side === "out" ? other.in : other.out) - (side === "out" ? m.out : m.in)) < 0.005);
    };
    const firstWordStart = (m: ClipMeta) => (m.words.length ? m.words[0]!.start : m.in);
    const lastWordEnd = (m: ClipMeta) => (m.words.length ? m.words[m.words.length - 1]!.end : m.out);
    for (let iter = 0; iter < 6; iter++) {
      recipe = baseRecipe(toClips());
      let diff = target - recipe.duration;
      if (Math.abs(diff) <= 0.03) break;
      const endCard = metas.find((m) => m.kind === "cierre");
      if (endCard) {
        const cur = endCard.still ?? endCard.out - endCard.in;
        const next = cur + diff;
        if (next >= 0.5 && (endCard.still != null || endCard.in + next <= endCard.maxOut)) {
          if (endCard.still != null) endCard.still = next;
          else endCard.out = endCard.in + next;
          continue;
        }
      }
      const speechIdx = metas.map((m, k) => (m.kind === "voz" || m.kind === "montaje" ? k : -1)).filter((k) => k >= 0);
      if (diff > 0) {
        // a) Cola del último plano (máx. 1.5 s de respiro).
        const lastK = speechIdx[speechIdx.length - 1];
        if (lastK != null) {
          const m = metas[lastK]!;
          const add = Math.min(diff, m.maxOut - m.out, Math.max(0, lastWordEnd(m) + 1.5 - m.out));
          if (add > 0.001) (m.out += add), (diff -= add);
        }
        // b) Respiros en los bordes entre frases (hasta 0.35 s más allá de la palabra).
        for (const k of [...speechIdx].reverse()) {
          if (diff <= 0.001) break;
          const m = metas[k]!;
          if (isBoundary(k, "out")) {
            const add = Math.min(diff, m.maxOut - m.out, Math.max(0, lastWordEnd(m) + 0.35 - m.out));
            if (add > 0.001) (m.out += add), (diff -= add);
          }
          if (diff > 0.001 && isBoundary(k, "in")) {
            const add = Math.min(diff, m.in - m.minIn, Math.max(0, m.in - (firstWordStart(m) - 0.35)));
            if (add > 0.001) (m.in -= add), (diff -= add);
          }
        }
        // c) Cierre con b-roll, foto o logo.
        if (diff > 0.35 && !metas.some((m) => m.kind === "cierre")) {
          const usedBroll = new Set(metas.map((m) => m.assetId));
          const brollVid = mat.broll.find((b) => !usedBroll.has(b.id)) ?? mat.broll[0];
          const photo = mat.photos[0];
          const logo = (brand?.logoAssetIds[0] && assetById.get(brand.logoAssetIds[0])) || mat.logos[0];
          const tr = allowTransition({ type: "fundido", duration: 0.3 });
          const extra = diff + (tr.type === "corte" ? 0 : tr.duration);
          if (brollVid && (brollVid.probe.duration ?? 0) >= 1) {
            const seg = [...brollVid.analysis.brollSegments].sort((a, b) => b.score - a.score)[0] ?? { start: 0, end: brollVid.probe.duration ?? 0 };
            const len = Math.min(extra, seg.end - seg.start, brollVid.probe.duration ?? 0);
            metas.push({ assetId: brollVid.id, phraseKey: "cierre", in: seg.start, out: seg.start + len, words: [], speech: false, still: null, minIn: seg.start, maxOut: brollVid.probe.duration ?? seg.end, zoom: t.zooms.enabled ? { from: 1, to: 1.08, start: 0, end: null, ease: "suave" } : null, transition: tr, reason: "Cierre con toma de apoyo para clavar la duración pedida.", volume: 0, kind: "cierre", speed: 1 });
            stats.endCard = true;
          } else if (photo || logo) {
            const a = (photo ?? logo)!;
            metas.push({ assetId: a.id, phraseKey: "cierre", in: 0, out: extra, words: [], speech: false, still: extra, minIn: 0, maxOut: extra, zoom: photo ? { from: 1, to: 1.08, start: 0, end: null, ease: "suave" } : null, transition: tr, reason: "Cierre para clavar la duración pedida.", volume: 0, kind: "cierre", speed: 1 });
            stats.endCard = true;
          }
          continue;
        }
        // d) Último recurso: un poco más lento (máx. 12 %).
        if (diff > 0.03) {
          const speechTotal = speechIdx.reduce((acc, k) => acc + (metas[k]!.out - metas[k]!.in) / metas[k]!.speed, 0);
          const factor = Math.max(0.88, speechTotal / (speechTotal + diff));
          speechIdx.forEach((k) => (metas[k]!.speed = round3(metas[k]!.speed * factor)));
          if (factor <= 0.8801) stats.warnings.push("No alcanzó el material para la duración exacta pedida.");
        }
      } else {
        let over = -diff;
        const lastK = speechIdx[speechIdx.length - 1];
        if (lastK != null) {
          const m = metas[lastK]!;
          const cut = Math.min(over, Math.max(0, m.out - (lastWordEnd(m) + 0.06)));
          if (cut > 0.001) (m.out -= cut), (over -= cut);
        }
        for (const k of [...speechIdx].reverse()) {
          if (over <= 0.001) break;
          const m = metas[k]!;
          if (isBoundary(k, "out")) {
            const cut = Math.min(over, Math.max(0, m.out - (lastWordEnd(m) + 0.04)));
            if (cut > 0.001) (m.out -= cut), (over -= cut);
          }
          if (over > 0.001 && isBoundary(k, "in")) {
            const cut = Math.min(over, Math.max(0, firstWordStart(m) - 0.04 - m.in));
            if (cut > 0.001) (m.in += cut), (over -= cut);
          }
        }
        if (over > 0.03) {
          const speechTotal = speechIdx.reduce((acc, k) => acc + (metas[k]!.out - metas[k]!.in) / metas[k]!.speed, 0);
          const factor = Math.min(1.12, speechTotal / Math.max(0.1, speechTotal - over));
          speechIdx.forEach((k) => (metas[k]!.speed = round3(metas[k]!.speed * factor)));
        }
      }
    }
    recipe = baseRecipe(toClips());
  }

  // ---------------------------------------------------------------------------
  // 6) Subtítulos (los materializa el servidor con la transcripción y palabras clave).
  // ---------------------------------------------------------------------------
  recipe = input.toolbox.materializeCaptions(recipe);
  const duration = recipe.duration;
  const clipsTl = recipe.tracks.video;
  const phraseRanges: { key: string; start: number; end: number; mustShowFace: boolean; text: string; tags: string[] }[] = [];
  clipsTl.forEach((c, k) => {
    const m = metas[k]!;
    if (m.kind !== "voz") return;
    const end = c.start + clipDuration(c);
    const last = phraseRanges[phraseRanges.length - 1];
    if (last && last.key === m.phraseKey) last.end = end;
    else {
      const p = phraseByKey.get(m.phraseKey);
      phraseRanges.push({ key: m.phraseKey, start: c.start, end, mustShowFace: !!p?.words.some((w) => w.mark === "debe-ir"), text: p?.text ?? "", tags: [] });
    }
  });
  const wordStarts = recipe.tracks.captions.words.map((w) => w.start);

  // ---------------------------------------------------------------------------
  // 7) B-roll automático.
  // ---------------------------------------------------------------------------
  const overlays: OverlayItem[] = [];
  const aiRequests: AiRequest[] = [];
  const overlayTransition: Transition = allowTransition(
    !t.transitions.enabled || t.transitions.style === "corte"
      ? { type: "corte", duration: 0 }
      : t.transitions.style === "auto" || t.transitions.style === "fundido"
        ? { type: "fundido", duration: 0.25 }
        : { ...style.defaultTransition, duration: 0.3 },
  );
  interface BrollCand {
    asset: Asset;
    start: number;
    end: number;
    score: number;
    words: string;
    used: number;
    offset: number;
    must: boolean;
  }
  const brollCands: BrollCand[] = [];
  const hasAroll = metas.some((m) => m.kind === "voz");
  for (const v of [...mat.broll, ...mat.aroll]) {
    if (!hasAroll) break;
    const isAroll = mat.aroll.includes(v);
    // En los clips de la columna, los fragmentos de b-roll del mapa (ya recortados para no pisar la voz).
    const inside = isAroll
      ? mat.map.fragments.filter((f) => f.assetId === v.id && f.kind === "b-roll").map((f) => ({ start: f.start, end: f.end, score: f.score, description: f.reason, tags: [] as string[] }))
      : [];
    const segs = isAroll
      ? inside
      : v.analysis.brollSegments.length
        ? v.analysis.brollSegments
        : Array.from({ length: Math.max(1, Math.floor((v.probe.duration ?? 4) / 4)) }, (_, k) => ({ start: k * 4, end: Math.min(v.probe.duration ?? 4, (k + 1) * 4), score: 0.5, description: v.analysis.description, tags: [] as string[] }));
    for (const sg of segs) {
      if (sg.end - sg.start < 1) continue;
      brollCands.push({ asset: v, start: sg.start, end: sg.end, score: sg.score * (isAroll ? 0.85 : 1), words: normalize(`${sg.description} ${sg.tags.join(" ")} ${v.originalName} ${v.note}`), used: 0, offset: 0, must: v.priority === "debe-aparecer" && !isAroll });
    }
  }
  if (hasAroll) {
    for (const p of mat.photos) brollCands.push({ asset: p, start: 0, end: 30, score: 0.45, words: normalize(`${p.analysis.description} ${p.originalName} ${p.note}`), used: 0, offset: 0, must: p.priority === "debe-aparecer" });
  }
  const brollOn = t.broll.enabled && hasAroll;
  const useMaterial = brollOn && t.broll.source !== "ia";
  const useAiBroll = brollOn && t.broll.source !== "material";
  const freq = BROLL_FREQ[t.broll.frequency];
  const layoutFor = (k: number): OverlayItem["layout"] => {
    switch (t.broll.layout) {
      case "pantalla-completa":
        return "pantalla-completa";
      case "fondo":
        return "fondo-con-orador";
      case "pip":
        return "pip-arriba-der";
      default: {
        const cycle: OverlayItem["layout"][] =
          t.broll.frequency === "alta" ? ["pantalla-completa", "fondo-con-orador"] : t.broll.frequency === "media" ? ["pantalla-completa", "pantalla-completa", "fondo-con-orador"] : ["pantalla-completa"];
        return cycle[k % cycle.length]!;
      }
    }
  };
  const lastPhrase = phraseRanges[phraseRanges.length - 1];
  const slots = phraseRanges.filter((p) => !p.mustShowFace && p.end > 2.5 && !(p === lastPhrase && looksLikeCta(p.text) && phraseRanges.length > 1));
  const alignToWord = (tt: number, limit: number) => wordStarts.find((w) => w >= tt - 0.001 && w < limit - 1) ?? tt;
  const freeSlots: { start: number; end: number; text: string }[] = [];
  let nextAllowed = 2.5;
  const mustQueue = brollCands.filter((c) => c.must);
  for (const slot of slots) {
    if (slot.end - Math.max(slot.start, nextAllowed) < 1.2) continue;
    const startRaw = Math.max(slot.start, nextAllowed);
    const start = round3(alignToWord(startRaw, slot.end));
    const maxEnd = Math.min(slot.end, start + freq.dur);
    if (maxEnd - start < 1.2) continue;
    const placeMaterial = useMaterial || mustQueue.some((c) => c.used === 0);
    let placed = false;
    if (placeMaterial && brollCands.length) {
      const slotText = normalize(slot.text);
      const pick = [...brollCands]
        .filter((c) => useMaterial || (c.must && c.used === 0))
        .map((c) => ({ c, s: c.score + (c.must && c.used === 0 ? 2 : 0) - c.used * 0.4 + (slotText.split(" ").some((w) => w.length >= 5 && c.words.includes(w)) ? 0.3 : 0) }))
        .sort((a, b) => b.s - a.s)[0]?.c;
      if (pick) {
        const isPhoto = pick.asset.kind === "imagen";
        let srcIn = pick.start + pick.offset;
        if (!isPhoto && pick.end - srcIn < 1.2) (pick.offset = 0), (srcIn = pick.start);
        const len = isPhoto ? maxEnd - start : Math.min(maxEnd - start, pick.end - srcIn);
        if (len >= 1.2) {
          overlays.push({
            id: `broll-${overlays.length + 1}`,
            kind: isPhoto ? "imagen" : "broll",
            assetId: pick.asset.id,
            start,
            end: round3(start + len),
            sourceIn: round3(isPhoto ? 0 : srcIn),
            layout: layoutFor(overlays.length),
            opacity: 1,
            kenBurns: isPhoto,
            transition: overlayTransition,
            reason: `Toma de apoyo sobre ${quote(slot.text, 6)}.`,
          });
          pick.used++;
          pick.offset = isPhoto ? 0 : pick.offset + len;
          placed = true;
          stats.brollInserts++;
        }
      }
    }
    if (!placed) freeSlots.push({ start, end: maxEnd, text: slot.text });
    if (placed || useAiBroll) nextAllowed = start + freq.every;
  }

  // ---------------------------------------------------------------------------
  // 8) Textos en pantalla, motion graphics y logo.
  // ---------------------------------------------------------------------------
  const texts: TextItem[] = [];
  const graphics: GraphicItem[] = [];
  const allPhrases = [...phraseByKey.values()];
  const hook = findHookPhrase(allPhrases);
  const ctaPhrase = findCtaPhrase(allPhrases);
  const firstPhraseEnd = phraseRanges[0]?.end ?? Math.min(3, duration);
  let templates: MotionTemplate[] = [];
  try {
    templates = input.toolbox.motionTemplates();
  } catch {
    templates = [];
  }
  const findTemplate = (...names: string[]) =>
    templates.find((tp) => names.includes(tp.id)) ?? templates.find((tp) => names.some((n) => normalize(`${tp.id} ${tp.name}`).includes(normalize(n))));
  const templateProps = (tp: MotionTemplate | undefined, text: string): Record<string, unknown> => {
    const props: Record<string, unknown> = {};
    const keys = tp ? Object.keys(tp.propsSchema) : [];
    const setFirst = (cands: string[], value: unknown) => {
      const key = keys.find((k) => cands.includes(k));
      if (key) props[key] = value;
    };
    if (!keys.length) return { text, color: style.palette.primary, accent: style.palette.secondary };
    setFirst(["text", "texto", "word", "palabra", "title", "titulo", "label"], text);
    setFirst(["color", "primary", "primario", "accentColor"], style.palette.primary);
    setFirst(["accent", "highlight", "secondary", "acento", "resaltado"], style.palette.secondary);
    setFirst(["background", "fondo", "bg"], style.palette.background);
    setFirst(["fontFamily", "font", "fuente"], style.titleFont.family);
    return props;
  };
  const mgOn = t.motionGraphics.enabled;
  const mgAuto = mgOn && t.motionGraphics.mode === "automatico";

  if (t.titles.enabled && duration > 1.5) {
    const hookText = hook ? hook.text : (topKw?.text ?? "");
    const titleText = limitWords(digitsForNumberWords(hookText), 7);
    if (titleText) {
      texts.push({
        id: "titulo-gancho",
        kind: "titulo",
        text: capitalizeFirst(titleText),
        subtitle: "",
        start: 0.15,
        end: round3(Math.min(duration, Math.max(2.2, Math.min(3.5, firstPhraseEnd + 0.4)))),
        position: "arriba",
        font: null,
        fontSize: 84,
        color: null,
        background: null,
        uppercase: null,
        animation: "pop",
        engine: "builtin",
      });
    }
  }
  if (t.lowerThirds.enabled) {
    if (t.lowerThirds.name.trim()) {
      texts.push({
        id: "cintillo-1",
        kind: "cintillo",
        text: t.lowerThirds.name.trim(),
        subtitle: t.lowerThirds.role.trim(),
        start: round3(Math.min(0.6, duration / 4)),
        end: round3(Math.min(duration, 4.5)),
        position: "cintillo",
        font: null,
        fontSize: 56,
        color: null,
        background: style.palette.primary,
        uppercase: false,
        animation: "deslizar",
        engine: "builtin",
      });
    } else stats.warnings.push("Cintillo omitido: falta el nombre (no invento datos en pantalla).");
  }
  const ctaText = t.cta.text.trim() || (ctaPhrase ? capitalizeFirst(ctaPhrase.text) : "");
  if (t.cta.enabled && duration > 3) {
    const text = ctaText || "¡Síguenos para más!";
    const start = round3(Math.max(0, duration - 2.8));
    const tp = mgAuto ? findTemplate("cta-final", "cta") : undefined;
    if (tp) {
      graphics.push({ id: "mg-cta", templateId: tp.id, engine: tp.engine, props: templateProps(tp, text), start, end: duration, layout: "superpuesto", renderedAssetId: null, description: `Llamado a la acción: «${text}»` });
    } else {
      texts.push({ id: "cta-final", kind: "cta", text, subtitle: "", start, end: duration, position: "centro", font: null, fontSize: 80, color: null, background: style.palette.accent, uppercase: null, animation: "pop", engine: "builtin" });
    }
  }
  if (mgOn) {
    if (mgAuto) {
      // Palabra clave con más puntaje que siga en la edición, fuera del título.
      const occ = [...keywords]
        .filter((k) => k.category !== "gancho" && k.category !== "cta")
        .sort((a, b) => b.score - a.score)
        .flatMap((k) => k.occurrences.map((o) => ({ k, tl: sourceToTimeline(recipe, o.assetId, o.t) })))
        .find((x) => x.tl != null && x.tl > 3.6 && x.tl < duration - 3.2 && !overlays.some((o) => o.layout === "pantalla-completa" && o.start <= x.tl! + 1.6 && o.end >= x.tl!));
      const tp = findTemplate("palabra-clave-pop", "palabra-clave", "keyword");
      if (occ && occ.tl != null) {
        const start = round3(Math.max(0, occ.tl - 0.1));
        const end = round3(Math.min(duration, start + 1.6));
        if (tp) graphics.push({ id: "mg-palabra-clave", templateId: tp.id, engine: tp.engine, props: templateProps(tp, occ.k.text), start, end, layout: "superpuesto", renderedAssetId: null, description: `Palabra clave animada: «${occ.k.text}»` });
        else texts.push({ id: "palabra-clave-1", kind: "palabra-clave", text: occ.k.text, subtitle: "", start, end, position: "centro", font: null, fontSize: 110, color: style.palette.secondary, background: null, uppercase: null, animation: "pop", engine: "builtin" });
      }
    } else {
      t.motionGraphics.items.forEach((item, k) => {
        const isCta = /\b(cta|llamado|siguenos|suscribete)\b/.test(normalize(item.description));
        const tp = isCta ? findTemplate("cta-final", "cta") : findTemplate("palabra-clave-pop", "titulo", "palabra-clave");
        const start = round3(clamp(item.at ?? (k + 1) * (duration / (t.motionGraphics.items.length + 1)), 0, Math.max(0, duration - 0.5)));
        const end = round3(Math.min(duration, start + item.duration));
        const text = limitWords(item.description, 6) || "…";
        if (tp) graphics.push({ id: `mg-manual-${k + 1}`, templateId: tp.id, engine: tp.engine, props: templateProps(tp, text), start, end, layout: "superpuesto", renderedAssetId: null, description: item.description });
        else texts.push({ id: `mg-texto-${k + 1}`, kind: "etiqueta", text, subtitle: "", start, end, position: "centro", font: null, fontSize: 90, color: null, background: null, uppercase: null, animation: "pop", engine: "builtin" });
      });
    }
  }
  // Logo al final (marca o logo marcado "debe aparecer").
  const logoId = brand?.logoAssetIds.find((id) => assetById.has(id)) ?? mat.logos.find((l) => l.priority === "debe-aparecer" || !!brand)?.id;
  if (logoId && duration > 3) {
    overlays.push({ id: "logo-final", kind: "logo", assetId: logoId, start: round3(Math.max(0, duration - 3)), end: duration, sourceIn: 0, layout: "pip-arriba-der", opacity: 1, kenBurns: false, transition: allowTransition({ type: "fundido", duration: 0.3 }), reason: "Logo de la marca al cierre." });
  }

  // ---------------------------------------------------------------------------
  // 9) Audio: música con ducking y SFX.
  // ---------------------------------------------------------------------------
  const music = t.music.enabled && t.music.source !== "ia" ? mat.music[0] : undefined;
  const sfx: SfxItem[] = [];
  const recipeMusic = music
    ? [{ id: "musica-1", assetId: music.id, start: 0, end: null, sourceIn: 0, gainDb: t.music.gainDb, fadeIn: 0.5, fadeOut: 1.5, duck: t.ducking.enabled }]
    : [];
  if (t.music.enabled && t.music.source !== "ia" && !music) stats.warnings.push("Música prendida pero no subiste ninguna pista: el video va sin música.");
  if (t.sfx.enabled && t.sfx.source === "biblioteca" && mat.sfx.length) {
    const byName = (re: RegExp) => mat.sfx.find((a) => re.test(normalize(a.originalName)));
    const whoosh = byName(/whoosh|swoosh|transici|swish/) ?? mat.sfx[0]!;
    const hit = byName(/golpe|hit|impact|pop|boom|punch/) ?? mat.sfx[1] ?? whoosh;
    const push = (at: number, asset: Asset, kind: SfxItem["kind"], gainDb: number) => {
      if (at < 0 || at > duration || sfx.some((x) => Math.abs(x.at - at) < 0.4)) return;
      sfx.push({ id: `sfx-${sfx.length + 1}`, assetId: asset.id, at: round3(at), gainDb, kind, origin: "usuario" });
    };
    for (const tx of texts) if (tx.kind === "titulo" || tx.kind === "cta" || tx.kind === "palabra-clave") push(Math.max(0, tx.start), hit, "golpe", -8);
    for (const g of graphics) push(g.start, hit, "golpe", -8);
    if (t.sfx.density !== "baja") for (const o of overlays) if (o.kind !== "logo") push(Math.max(0, o.start - 0.15), whoosh, "whoosh", -10);
    if (t.sfx.density === "alta") {
      clipsTl.forEach((c, k) => {
        if (k > 0 && metas[k]!.phraseKey !== metas[k - 1]!.phraseKey) push(Math.max(0, c.start - 0.1), whoosh, "whoosh", -12);
      });
    }
    sfx.sort((a, b) => a.at - b.at);
  }

  // ---------------------------------------------------------------------------
  // 10) Pedidos de IA (Kie AI) respetando los máximos.
  // ---------------------------------------------------------------------------
  const kwForPrompts = [...keywords].filter((k) => k.category === "tema" || k.category === "beneficio" || k.category === "cifra").sort((a, b) => b.score - a.score);
  const aiSlots = [...freeSlots];
  const nextSlot = () => aiSlots.shift() ?? null;
  const visualPrompt = (text: string) =>
    `Escena visual que ilustre: «${limitWords(text.replace(/\s+([,.!?;:])/g, "$1"), 14)}». Estilo ${t.aiImages.style || "fotográfico, natural"}. Composición ${height > width ? "vertical" : width > height ? "horizontal" : "cuadrada"} ${aspect}, sin texto, sin logotipos, sin marcas de agua.`;
  const negative = "texto, letras, subtítulos, marcas de agua, logotipos, baja calidad, deformado";
  const addAi = (kind: AiRequest["kind"], usage: AiRequest["usage"], prompt: string, model: string | null, params: Record<string, unknown>, placeAt: AiRequest["placeAt"]) => {
    const req = buildKieRequestCost(opts.kie, kind, model, { prompt, params });
    if (!req) {
      stats.warnings.push(`No hay un modelo de Kie AI configurado para ${kind}.`);
      return;
    }
    aiRequests.push({
      id: `ia-${aiRequests.length + 1}`,
      kind,
      provider: "kie",
      model: req.model,
      prompt,
      negativePrompt: kind === "imagen" || kind === "video" ? negative : "",
      params,
      seed: hashString(`${kind}:${prompt}`) % 2_147_483_647,
      status: "pendiente",
      resultAssetId: null,
      error: null,
      costUsd: req.costUsd,
      usage,
      placeAt,
    });
  };
  const promptSource = (k: number, slotText: string | null) => slotText || kwForPrompts[k % Math.max(1, kwForPrompts.length)]?.text || s.instruction.text || "tema del video";
  let imagesLeft = t.aiImages.enabled ? t.aiImages.max : useAiBroll ? 3 : 0;
  if (t.aiImages.enabled && t.aiImages.usage.includes("portada") && imagesLeft > 0) {
    addAi("imagen", "portada", `Portada para redes: ${hook ? `«${hook.text}»` : s.instruction.text || "tema del video"}. Estilo ${t.aiImages.style}. Formato ${aspect}, composición limpia con espacio para el título, sin texto.`, t.aiImages.model || null, { aspectRatio: aspect }, null);
    imagesLeft--;
  }
  const wantImagesInTimeline = (t.aiImages.enabled && (t.aiImages.usage.includes("broll") || t.aiImages.usage.includes("fondo"))) || useAiBroll;
  let videosLeft = t.aiVideos.enabled ? t.aiVideos.max : 0;
  let k = 0;
  while ((videosLeft > 0 || (wantImagesInTimeline && imagesLeft > 0)) && k < 40) {
    const slot = nextSlot();
    if (!slot && hasAroll) break;
    const placeAt = slot ? { start: slot.start, end: round3(Math.min(slot.end, slot.start + freq.dur)) } : null;
    const text = promptSource(k, slot?.text ?? null);
    if (videosLeft > 0) {
      addAi("video", "broll", visualPrompt(text), t.aiVideos.model || null, { aspectRatio: aspect, duration: t.aiVideos.duration }, placeAt);
      videosLeft--;
    } else {
      const usage: AiRequest["usage"] = t.aiImages.enabled && t.aiImages.usage.includes("fondo") && !t.aiImages.usage.includes("broll") ? "fondo" : "broll";
      addAi("imagen", usage, visualPrompt(text), t.aiImages.model || null, { aspectRatio: aspect }, placeAt);
      imagesLeft--;
    }
    k++;
  }
  if (t.music.enabled && t.music.source === "ia") {
    addAi("musica", "musica", `Música instrumental ${s.instruction.tone || "dinámica"} para un video de ${s.instruction.platform}, sin voz, con buena energía para fondo de narración.`, null, { duration: Math.ceil(duration) }, { start: 0, end: duration });
  }
  if (t.sfx.enabled && t.sfx.source === "ia") {
    const firstOverlay = overlays.find((o) => o.kind !== "logo");
    const at = firstOverlay ? Math.max(0, firstOverlay.start - 0.15) : 0;
    addAi("sfx", "sfx", "Whoosh corto y limpio para transición de video, 0.5 segundos.", null, {}, { start: round3(at), end: round3(Math.min(duration, at + 0.6)) });
  }
  if (t.voiceover.enabled) {
    if (t.voiceover.script.trim()) addAi("voz", "voz", t.voiceover.script.trim(), null, t.voiceover.voice ? { voice: t.voiceover.voice } : {}, { start: 0, end: duration });
    else stats.warnings.push("Voz en off prendida pero sin guion: no se generó narración.");
  }

  // ---------------------------------------------------------------------------
  // 11) Ensamblar, aplicar reglas aprendidas y validar.
  // ---------------------------------------------------------------------------
  recipe = {
    ...recipe,
    tracks: { ...recipe.tracks, overlays, text: texts, graphics, audio: { ...recipe.tracks.audio, music: recipeMusic, sfx } },
    ai: aiRequests,
  };
  for (const r of rules) {
    if (!r.check || r.check.type === "duracion-plano-max" || r.check.type === "duracion-objetivo") continue;
    if (applyRuleCheck(recipe, r.check)) appliedRuleIds.add(r.id);
  }
  for (const r of rules) if (r.check?.type === "sin-transicion") appliedRuleIds.add(r.id);
  recipe.meta = { ...recipe.meta, appliedRuleIds: [...appliedRuleIds] };

  const summary = summarize(recipe, stats, mode, target, selected.length, cands.length, mat.map);
  recipe.notes = summary;
  const valid = validateWith(input.toolbox, recipe);
  if (!valid.ok) throw new UserFacingError("receta-invalida", `El editor demo armó una receta inválida: ${valid.errors.slice(0, 3).join("; ")}`, 500);
  recipe = valid.recipe;

  const scenes = buildScenes(recipe, input.assets, {
    titles: (idx, total, text) => {
      if (idx === 0) return text ? `Gancho: ${quote(text, 6)}` : "Inicio";
      if (idx === total - 1 && looksLikeCta(text)) return `Cierre: ${quote(text, 6)}`;
      return text ? `Idea ${idx}: ${quote(text, 5)}` : `Escena ${idx + 1}`;
    },
  });
  return { recipe, scenes, summary };
}

function summarize(recipe: Recipe, st: Stats, mode: string, target: number | null, kept: number, total: number, map: MaterialMap): string {
  const parts: string[] = ["Edición automática (modo demo, sin IA)."];
  if (map.clips.length > 1) parts.push(`Usé ${map.clips.length} clips ${map.base === "clip-base" ? "base" : "con voz"} ${map.order.reason}.`);
  if (st.repeatedTakes) parts.push(`Quité ${st.repeatedTakes} toma(s) repetida(s) o arranque(s) en falso y me quedé con la mejor de cada frase.`);
  const fillers = [...new Set(st.fillers.map((w) => `«${stripPunctuation(w.text)}»`))];
  if (fillers.length) parts.push(`Quité ${st.fillers.length} muletilla(s) (${fillers.slice(0, 4).join(", ")}) y las palabras marcadas para quitar.`);
  if (recipe.tracks.video.length) parts.push(`Armé ${recipe.tracks.video.length} plano(s) cortando las pausas largas sin partir palabras.`);
  if (st.droppedPhrases > 0) parts.push(`Para la duración pedida dejé ${kept} de ${total} frases (las de más valor: gancho, palabras clave y llamado a la acción).`);
  if (st.brollInserts) parts.push(`Agregué ${st.brollInserts} toma(s) de apoyo (b-roll).`);
  if (st.endCard) parts.push("Cerré con una toma extra para clavar la duración.");
  if (recipe.tracks.text.length || recipe.tracks.graphics.length) parts.push(`Textos/gráficos: ${[...recipe.tracks.text.map((t) => `«${t.text}»`), ...recipe.tracks.graphics.map((g) => g.description)].slice(0, 4).join(", ")}.`);
  if (recipe.tracks.audio.music.length) parts.push(`Música a ${recipe.tracks.audio.music[0]!.gainDb} dB${recipe.tracks.audio.music[0]!.duck ? " que baja cuando hablas" : ""}.`);
  if (recipe.ai.length) parts.push(`${recipe.ai.length} pedido(s) a Kie AI (≈ US$${recipe.ai.reduce((s, a) => s + (a.costUsd ?? 0), 0).toFixed(2)}).`);
  parts.push(`Duración: ${recipe.duration.toFixed(1)} s${target != null && mode !== "auto" ? ` (objetivo ${mode} de ${target} s)` : ""}.`);
  if (st.warnings.length) parts.push(`Avisos: ${st.warnings.join(" ")}`);
  return parts.join(" ");
}
