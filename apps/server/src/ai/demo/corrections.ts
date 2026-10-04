/**
 * EDITOR DEMO: intérprete determinista de correcciones comunes en español.
 *
 * Cada "intención" (tipografía, colores, ritmo, música, subtítulos, textos, cortes en un momento,
 * duración, zoom, transiciones, b-roll, logo, gráficos, formato…) modifica una COPIA de la receta y
 * declara las áreas que tocó. Al final se calcula el parche mínimo (fast-json-patch compare) y se
 * verifica la REGLA DE ORO con `verifyPatch` (diffRecipes + changesOutsideAreas).
 *
 * Si no entiende la corrección, devuelve una pregunta aclaratoria amable: el modo demo solo entiende
 * correcciones simples; con ANTHROPIC_API_KEY Claude entiende cualquier corrección.
 */
import type { Asset, FontRef, OverlayItem, ProvidersConfig, Recipe, RuleCheck, TextItem, VideoClip } from "@autoeditor/shared";
import { clipDuration, normalizeRecipe, RESOLUTIONS, timelineToSource } from "@autoeditor/shared";
import type { CorrectionInput, CorrectionResult, Log } from "../../services/types.js";
import { CURATED_FONTS, curatedFontRef, findColorInText, findFontInText, nextCuratedFont, nextPalette, type CuratedFont } from "../shared/fonts.js";
import { minimalPatch, verifyPatch, type Area } from "../shared/recipe-ops.js";
import { splitPhrases, wordsByAsset, type TWord } from "../shared/transcript.js";
import { clamp, normalize, parseDurationMention, parseTimeMention, round2, round3 } from "../shared/text.js";
import { buildDemoPlan } from "./planner.js";
import { findHookPhrase } from "./keywords.js";

export interface DemoCorrectionOptions {
  kie: ProvidersConfig["kie"];
  log?: Log;
}

type CorrectionCore = Omit<CorrectionResult, "usage">;

/** Estado de trabajo de una corrección. */
interface Ctx {
  input: CorrectionInput;
  /** Corrección normalizada (minúsculas, sin acentos ni puntuación), con espacios a los lados. */
  n: string;
  raw: string;
  /** Segundo del video final al que se ancla (del reproductor o escrito: "en 0:12"). */
  at: number | null;
  /** Receta de trabajo (copia de la actual). */
  r: Recipe;
  /** Receta actual normalizada (referencia de tiempos y duración). */
  base: Recipe;
  areas: Set<Area>;
  done: string[];
  /** Avisos (algo se entendió pero no había nada que cambiar). */
  notes: string[];
  rule: CorrectionResult["ruleSuggestion"];
  assets: Map<string, Asset>;
  words: Map<string, TWord[]>;
  opts: DemoCorrectionOptions;
}

const has = (ctx: Ctx, re: RegExp) => re.test(ctx.n);
const quoted = (raw: string): string[] => [...raw.matchAll(/["“«']([^"”»']{1,120})["”»']/g)].map((m) => m[1]!.trim()).filter(Boolean);

const REMOVE = String.raw`(?:quita|quitale|quitar|quites|elimina|eliminar|borra|borrar|saca|sacar|sin|no quiero|no pongas|no uses|fuera)`;
const ADD = String.raw`(?:pon|ponle|poner|agrega|agregale|agregar|anade|anadele|mete|metele|incluye|usa|con|quiero)`;
const BIGGER = /\b(mas grandes?|agranda|agrandalos?|aumenta|aumentale|mas grueso|mas visibles?|se ven? (muy )?(pequen|chic))/;
const SMALLER = /\b(mas pequen[oa]s?|mas chic[oa]s?|achica|achicalos?|reduce|reducele|mas discretos?|se ven? (muy )?grandes?|demasiado grandes?|muy grandes?)/;

const FONT_WORDS = /\b(tipografias?|fuentes?|font|letras?|tipo de letra)\b/;
const CAPTION_WORDS = /\b(subtitulos?|captions?|subs)\b/;
const TITLE_WORDS = /\b(titulos?|textos?|letreros?|encabezados?)\b/;
const MUSIC_WORDS = /\b(musica|cancion|pista|fondo musical|soundtrack)\b/;

function isContiguous(a: VideoClip, b: VideoClip): boolean {
  return a.assetId === b.assetId && a.stillDuration == null && b.stillDuration == null && a.speed === b.speed && Math.abs(a.sourceOut - b.sourceIn) < 0.02;
}

function uniqueId(r: Recipe, base: string): string {
  const ids = new Set<string>([
    ...r.tracks.video.map((c) => c.id),
    ...r.tracks.overlays.map((o) => o.id),
    ...r.tracks.text.map((t) => t.id),
    ...r.tracks.graphics.map((g) => g.id),
    ...r.tracks.audio.music.map((m) => m.id),
    ...r.tracks.audio.sfx.map((s) => s.id),
  ]);
  if (!ids.has(base)) return base;
  for (let k = 2; ; k++) if (!ids.has(`${base}-${k}`)) return `${base}-${k}`;
}

/** Mantiene la duración (si el objetivo es exacto) extendiendo o recortando la cola del último plano sin pisar palabras. */
function keepExactDuration(ctx: Ctx): void {
  if (ctx.r.target.mode !== "exacta" || ctx.r.target.duration == null) return;
  const target = ctx.r.target.duration;
  const n = normalizeRecipe(ctx.r);
  const diff = target - n.duration;
  if (Math.abs(diff) < 0.03) return;
  const last = ctx.r.tracks.video[ctx.r.tracks.video.length - 1];
  if (!last) return;
  if (last.stillDuration != null) {
    last.stillDuration = round3(Math.max(0.3, last.stillDuration + diff));
    return;
  }
  const words = ctx.words.get(last.assetId) ?? [];
  const next = words.find((w) => w.start >= last.sourceOut - 0.01);
  const assetDur = ctx.assets.get(last.assetId)?.probe.duration ?? last.sourceOut;
  const maxOut = Math.min(assetDur, next ? next.start - 0.02 : assetDur);
  const lastWord = [...words].reverse().find((w) => w.end <= last.sourceOut + 0.01 && w.start >= last.sourceIn);
  const minOut = Math.max(last.sourceIn + 0.3, lastWord ? lastWord.end + 0.04 : last.sourceIn + 0.3);
  last.sourceOut = round3(clamp(last.sourceOut + diff * last.speed, minOut, Math.max(minOut, maxOut)));
}

/**
 * Desplaza textos, gráficos, b-roll y SFX que empiezan después de `from` (línea de tiempo) en `delta` segundos,
 * para que sigan pegados a su contenido cuando un corte cambia la duración. Marca las áreas afectadas.
 */
function shiftAfter(ctx: Ctx, from: number, delta: number): void {
  if (Math.abs(delta) < 0.01) return;
  const move = <T extends { start: number; end: number }>(items: T[], area: Area) => {
    let moved = false;
    for (const it of items) {
      if (it.start >= from - 0.01) {
        it.start = round3(Math.max(0, it.start + delta));
        it.end = round3(Math.max(it.start + 0.1, it.end + delta));
        moved = true;
      }
    }
    if (moved) ctx.areas.add(area);
  };
  move(ctx.r.tracks.text, "texto");
  move(ctx.r.tracks.graphics, "graficos");
  move(ctx.r.tracks.overlays, "cortes");
  let sfxMoved = false;
  for (const s of ctx.r.tracks.audio.sfx) {
    if (s.at >= from - 0.01) {
      s.at = round3(Math.max(0, s.at + delta));
      sfxMoved = true;
    }
  }
  if (sfxMoved) ctx.areas.add("audio");
}

// ---------------------------------------------------------------------------
// Intenciones
// ---------------------------------------------------------------------------

interface Intent {
  name: string;
  match(ctx: Ctx): boolean;
  apply(ctx: Ctx): void;
}

const VIBES: { re: RegExp; family: string }[] = [
  { re: /\b(elegante|editorial|serif|clasica|sofisticada)\b/, family: "Playfair Display" },
  { re: /\b(impacto|llamativa|gruesa|potente|fuerte)\b/, family: "Anton" },
  { re: /\b(condensada|alta|estrecha)\b/, family: "Bebas Neue" },
  { re: /\b(redonda|amigable|divertida|juvenil)\b/, family: "Poppins" },
  { re: /\b(limpia|profesional|corporativa|sobria|seria)\b/, family: "DM Sans" },
  { re: /\b(moderna|geometrica)\b/, family: "Montserrat" },
];

/** Tipografía pedida antes (reglas con comprobación o una corrección anterior que nombró una fuente). */
function previouslyRequestedFont(ctx: Ctx): CuratedFont | null {
  for (const rule of ctx.input.rules) {
    if (!rule.enabled || !rule.check) continue;
    if (rule.check.type === "fuente-titulos" || rule.check.type === "fuente-subtitulos") {
      const fam = rule.check.family;
      return CURATED_FONTS.find((f) => normalize(f.family) === normalize(fam)) ?? { family: fam, weight: 800, vibe: "pedida" };
    }
  }
  for (const h of [...ctx.input.history].reverse()) {
    const f = findFontInText(h.correction);
    if (f) return f;
  }
  const fromInstruction = findFontInText(ctx.input.settings.instruction.text);
  return fromInstruction;
}

const fontIntent: Intent = {
  name: "tipografia",
  match: (ctx) => {
    if ((has(ctx, BIGGER) || has(ctx, SMALLER)) && !has(ctx, /\b(tipografias?|fuentes?|bonita|otra|diferente)\b/)) return false;
    return (
      (has(ctx, FONT_WORDS) && (has(ctx, /\b(bonita|linda|bonitas|mejor|otra|diferente|cambia|cambiala|cambiar|moderna|elegante|usaste|pedi|pon|usa|fea|feas|horrible)\b/) || VIBES.some((v) => has(ctx, v.re)))) ||
      !!findFontInText(ctx.raw)
    );
  },
  apply(ctx) {
    const named = findFontInText(ctx.raw);
    const complaint = has(ctx, /\b(no usaste|no pusiste|te pedi|que pedi|la que (te )?dije|equivocada|incorrecta)\b/);
    let chosen: CuratedFont | null = named;
    if (!chosen && complaint) chosen = previouslyRequestedFont(ctx);
    if (!chosen) {
      const vibe = VIBES.find((v) => has(ctx, v.re));
      if (vibe) chosen = CURATED_FONTS.find((f) => f.family === vibe.family) ?? null;
    }
    if (chosen && normalize(chosen.family) === normalize(ctx.r.style.titleFont.family) && !named && !complaint) chosen = null;
    if (!chosen) chosen = nextCuratedFont(ctx.r.style.titleFont.family, [ctx.r.tracks.captions.style.font.family]);
    const ref: FontRef = curatedFontRef(chosen);

    const onlyCaptions = has(ctx, CAPTION_WORDS) && !has(ctx, TITLE_WORDS);
    const onlyTitles = has(ctx, TITLE_WORDS) && !has(ctx, CAPTION_WORDS) && !has(ctx, /\b(todo|todos|todas|general)\b/);
    if (!onlyCaptions) {
      ctx.r.style.titleFont = { ...ref };
      ctx.areas.add("estilo");
      for (const t of ctx.r.tracks.text) {
        if (t.font && (t.kind === "titulo" || t.kind === "cta" || t.kind === "palabra-clave" || !onlyTitles)) {
          t.font = { ...ref, weight: t.font.weight };
          ctx.areas.add("texto");
        }
      }
      for (const g of ctx.r.tracks.graphics) {
        for (const key of ["fontFamily", "font", "fuente"]) {
          if (typeof g.props[key] === "string") {
            g.props[key] = chosen.family;
            ctx.areas.add("graficos");
          }
        }
      }
    }
    if (!onlyCaptions && !onlyTitles) {
      ctx.r.style.bodyFont = { ...ref, weight: Math.min(ref.weight, 600) };
    }
    if (!onlyTitles) {
      ctx.r.tracks.captions.style.font = { ...ref, weight: Math.max(ref.weight, chosen.weight) };
      ctx.areas.add("subtitulos");
    }
    const where = onlyCaptions ? "los subtítulos" : onlyTitles ? "los títulos" : "títulos y subtítulos";
    ctx.done.push(`Cambié la tipografía de ${where} a ${chosen.family}${chosen.vibe && chosen.vibe !== "pedida" ? ` (${chosen.vibe})` : ""}.`);
    if (named || complaint) {
      const check: RuleCheck = onlyCaptions ? { type: "fuente-subtitulos", family: chosen.family } : { type: "fuente-titulos", family: chosen.family };
      ctx.rule = { text: `${onlyCaptions ? "Subtítulos" : "Títulos"} siempre en ${chosen.family}`, check };
    }
  },
};

const sizeIntent: Intent = {
  name: "tamano",
  match: (ctx) => (has(ctx, BIGGER) || has(ctx, SMALLER)) && (has(ctx, CAPTION_WORDS) || has(ctx, TITLE_WORDS) || has(ctx, /\b(letras?|textos?)\b/)) && !has(ctx, /\b(logo|video|imagen)\b/),
  apply(ctx) {
    const bigger = has(ctx, BIGGER) && !has(ctx, SMALLER);
    const factor = bigger ? 1.2 : 1 / 1.2;
    const titles = has(ctx, TITLE_WORDS) && !has(ctx, CAPTION_WORDS);
    if (!titles) {
      const st = ctx.r.tracks.captions.style;
      const next = Math.round(clamp(st.fontSize * factor, 16, 200));
      if (next !== st.fontSize) {
        st.fontSize = next;
        ctx.areas.add("subtitulos");
        ctx.done.push(`Subtítulos ${bigger ? "más grandes" : "más pequeños"} (${next} px).`);
      }
    } else {
      let changed = 0;
      for (const t of ctx.r.tracks.text) {
        const next = Math.round(clamp(t.fontSize * factor, 12, 300));
        if (next !== t.fontSize) (t.fontSize = next), changed++;
      }
      if (changed) {
        ctx.areas.add("texto");
        ctx.done.push(`Textos en pantalla ${bigger ? "más grandes" : "más pequeños"}.`);
      } else ctx.notes.push("No hay textos en pantalla para cambiar de tamaño.");
    }
  },
};

const LOOKS: { re: RegExp; look: VideoClip["color"]["look"]; label: string; tweak?: Partial<VideoClip["color"]> }[] = [
  { re: /\bblanco y negro\b|\bbyn\b|\bgrises\b/, look: "blanco-negro", label: "blanco y negro" },
  { re: /\bcalid[oa]s?\b|\bmas calido\b/, look: "calido", label: "cálido" },
  { re: /\bfri[oa]s?\b/, look: "frio", label: "frío" },
  { re: /\bcine\b|\bcinematografic[oa]\b|\bpelicula\b/, look: "cine", label: "de cine" },
  { re: /\b(mas vivos?|colores vivos|mas saturad[oa]|saturalo|mas color)\b/, look: "vivo", label: "más vivo" },
  { re: /\b(color natural|colores naturales|sin filtro|quita el filtro)\b/, look: "natural", label: "natural" },
];

const lookIntent: Intent = {
  name: "look",
  match: (ctx) =>
    LOOKS.some((l) => has(ctx, l.re)) && !has(ctx, CAPTION_WORDS) && !has(ctx, TITLE_WORDS) ||
    has(ctx, /\b(mas brillo|mas brillante|mas luminoso|mas claro|mas oscuro|muy oscuro|muy claro|mas contraste|menos contraste)\b/),
  apply(ctx) {
    const look = LOOKS.find((l) => has(ctx, l.re));
    let dBright = 0;
    let dContrast = 0;
    if (has(ctx, /\b(mas brillo|mas brillante|mas luminoso|mas claro|muy oscuro)\b/)) dBright = 0.06;
    if (has(ctx, /\b(mas oscuro|muy claro)\b/)) dBright = -0.06;
    if (has(ctx, /\bmas contraste\b/)) dContrast = 0.12;
    if (has(ctx, /\bmenos contraste\b/)) dContrast = -0.12;
    for (const c of ctx.r.tracks.video) {
      c.color = {
        look: look ? look.look : c.color.look,
        brightness: round2(clamp(c.color.brightness + dBright, -1, 1)),
        contrast: round2(clamp(c.color.contrast + dContrast, 0, 3)),
        saturation: look?.look === "vivo" ? round2(clamp(Math.max(c.color.saturation, 1.15), 0, 3)) : c.color.saturation,
      };
    }
    ctx.areas.add("cortes");
    const parts = [look ? `look ${look.label}` : "", dBright ? (dBright > 0 ? "más brillo" : "menos brillo") : "", dContrast ? (dContrast > 0 ? "más contraste" : "menos contraste") : ""].filter(Boolean);
    ctx.done.push(`Color del video: ${parts.join(", ")}.`);
  },
};

const colorIntent: Intent = {
  name: "colores",
  match: (ctx) => {
    const c = findColorInText(ctx.raw.replace(/blanco y negro/gi, ""));
    if (lookIntent.match(ctx) && !c) return false;
    return (!!c && has(ctx, /\b(color|colores|ponl[oa]s?|cambia|en|de|resaltad|subtitul|titul|texto)\b/)) || has(ctx, /\b(otros colores|cambia (los )?colores|colores (mas )?(bonitos|diferentes|distintos)|otra paleta|cambia la paleta)\b/);
  },
  apply(ctx) {
    const color = findColorInText(ctx.raw.replace(/blanco y negro/gi, ""));
    const highlight = has(ctx, /\b(resaltad[oa]s?|resalta|resaltes|destacad[oa]s?|palabras? clave)\b/);
    const captions = has(ctx, CAPTION_WORDS);
    const titles = has(ctx, TITLE_WORDS) || has(ctx, /\b(cta|llamado)\b/);
    const background = has(ctx, /\bfondo\b/);
    if (!color) {
      const pal = nextPalette(ctx.r.style.palette);
      ctx.r.style.palette = { ...pal };
      ctx.areas.add("estilo");
      ctx.r.tracks.captions.style.highlightColor = pal.secondary;
      ctx.areas.add("subtitulos");
      ctx.done.push(`Cambié la paleta de colores (principal ${pal.primary}, resaltado ${pal.secondary}).`);
      return;
    }
    const hex = color.hex;
    if (highlight || (!captions && !titles && !background)) {
      ctx.r.tracks.captions.style.highlightColor = hex;
      ctx.areas.add("subtitulos");
      ctx.done.push(`Palabras clave resaltadas en ${color.name}.`);
      ctx.rule = { text: `Resaltado de palabras clave en ${color.name} (${hex})`, check: { type: "color-resaltado", color: hex } };
      if (!highlight && !captions && !titles) {
        ctx.r.style.palette.primary = hex;
        ctx.areas.add("estilo");
      }
      return;
    }
    if (captions && background) {
      ctx.r.tracks.captions.style.background = "caja";
      ctx.r.tracks.captions.style.boxColor = `${hex}CC`;
      ctx.areas.add("subtitulos");
      ctx.done.push(`Subtítulos sobre caja ${color.name}.`);
      return;
    }
    if (captions) {
      ctx.r.tracks.captions.style.primaryColor = hex;
      ctx.areas.add("subtitulos");
      ctx.done.push(`Texto de los subtítulos en ${color.name}.`);
      return;
    }
    // Títulos / textos en pantalla.
    let changed = 0;
    for (const t of ctx.r.tracks.text) {
      if (background) t.background = hex;
      else t.color = hex;
      changed++;
    }
    if (changed) {
      ctx.areas.add("texto");
      ctx.done.push(`${background ? "Fondo" : "Color"} de los textos en pantalla: ${color.name}.`);
    } else {
      ctx.r.style.palette.text = hex;
      ctx.areas.add("estilo");
      ctx.done.push(`Color de los textos del estilo: ${color.name}.`);
    }
  },
};

/** Parte planos largos entre palabras con punch-ins alternados (más ritmo). */
function splitClips(ctx: Ctx, target: number): number {
  const out: VideoClip[] = [];
  let splits = 0;
  const zoomOn = ctx.input.settings.tools.zooms.enabled;
  for (const c of ctx.r.tracks.video) {
    const d = clipDuration(c);
    const words = (ctx.words.get(c.assetId) ?? []).filter((w) => (w.start + w.end) / 2 > c.sourceIn && (w.start + w.end) / 2 < c.sourceOut);
    if (c.stillDuration != null || d <= target * 1.4 || words.length < 2) {
      out.push(c);
      continue;
    }
    const n = Math.max(2, Math.round(d / target));
    const points = words.slice(0, -1).map((w, k) => round3((w.end + words[k + 1]!.start) / 2));
    const cuts: number[] = [];
    let last = c.sourceIn;
    for (let j = 1; j < n; j++) {
      const ideal = c.sourceIn + ((c.sourceOut - c.sourceIn) * j) / n;
      let best: number | null = null;
      for (const p of points) {
        if (p - last < 0.7 || c.sourceOut - p < 0.7) continue;
        if (best == null || Math.abs(p - ideal) < Math.abs(best - ideal)) best = p;
      }
      if (best != null && !cuts.includes(best)) cuts.push(best), (last = best);
    }
    if (!cuts.length) {
      out.push(c);
      continue;
    }
    const bounds = [c.sourceIn, ...cuts.sort((a, b) => a - b), c.sourceOut];
    for (let k = 0; k < bounds.length - 1; k++) {
      const piece: VideoClip = structuredClone(c);
      piece.sourceIn = round3(bounds[k]!);
      piece.sourceOut = round3(bounds[k + 1]!);
      if (k > 0) {
        piece.id = uniqueId({ ...ctx.r, tracks: { ...ctx.r.tracks, video: [...ctx.r.tracks.video, ...out] } }, `${c.id}-${String.fromCharCode(97 + k)}`);
        piece.transitionIn = { type: "corte", duration: 0 };
        piece.zoom = zoomOn && k % 2 === 1 ? { from: 1.12, to: 1.12, start: 0, end: null, ease: "lineal" } : null;
        // El reencuadre "seguir" lleva keyframes relativos al clip: se recalculan para la pieza.
        piece.reframe = { ...piece.reframe, keyframes: piece.reframe.keyframes.filter((kf) => kf.t >= (bounds[k]! - c.sourceIn) / c.speed).map((kf) => ({ ...kf, t: round3(kf.t - (bounds[k]! - c.sourceIn) / c.speed) })) };
      } else {
        piece.reframe = { ...piece.reframe, keyframes: piece.reframe.keyframes.filter((kf) => kf.t <= (bounds[1]! - c.sourceIn) / c.speed) };
      }
      out.push(piece);
    }
    splits += bounds.length - 2;
  }
  ctx.r.tracks.video = out;
  return splits;
}

/** Une planos contiguos del mismo archivo mientras no pasen del largo objetivo (menos cortes). */
function mergeClips(ctx: Ctx, maxLen: number): number {
  const out: VideoClip[] = [];
  let merges = 0;
  for (const c of ctx.r.tracks.video) {
    const prev = out[out.length - 1];
    if (prev && isContiguous(prev, c) && c.transitionIn.type === "corte" && clipDuration(prev) + clipDuration(c) <= maxLen) {
      const prevDur = clipDuration(prev);
      prev.sourceOut = c.sourceOut;
      prev.reframe = { ...prev.reframe, keyframes: [...prev.reframe.keyframes, ...c.reframe.keyframes.map((kf) => ({ ...kf, t: round3(kf.t + prevDur) }))] };
      merges++;
    } else out.push(structuredClone(c));
  }
  ctx.r.tracks.video = out;
  return merges;
}

const pacingIntent: Intent = {
  name: "ritmo",
  match: (ctx) =>
    has(ctx, /\b(mas rapido|mas rapida|mas dinamico|mas dinamica|mas agil|mas ritmo|mas energia|ritmo mas rapido|cortes mas rapidos|mas cortes|muy lento|muy lenta|aburrido|mas lento|mas lenta|mas pausado|mas pausada|mas calmado|mas tranquilo|menos cortes|ritmo mas lento|muy rapido|demasiados cortes)\b/) &&
    !has(ctx, /\b(dure|duracion|segundos?|minutos?)\b/),
  apply(ctx) {
    const faster = has(ctx, /\b(mas rapido|mas rapida|mas dinamico|mas dinamica|mas agil|mas ritmo|mas energia|ritmo mas rapido|cortes mas rapidos|mas cortes|muy lento|muy lenta|aburrido)\b/);
    const cur = ctx.r.style.targetShotLength;
    if (faster) {
      const next = round2(Math.max(0.8, cur * 0.65));
      ctx.r.style.targetShotLength = next;
      ctx.areas.add("estilo");
      const splits = splitClips(ctx, next);
      if (splits) ctx.areas.add("cortes");
      ctx.done.push(splits ? `Más ritmo: ${splits} corte(s) nuevo(s) entre palabras, planos de ~${next} s.` : `Ritmo objetivo de ~${next} s por plano (los planos actuales ya son cortos).`);
      ctx.rule = { text: `Un corte cada ~${round2(next * 1.4)} s como máximo`, check: { type: "duracion-plano-max", seconds: round2(next * 1.4) } };
    } else {
      const next = round2(Math.min(8, cur * 1.6));
      ctx.r.style.targetShotLength = next;
      ctx.areas.add("estilo");
      const merges = mergeClips(ctx, next * 1.3);
      if (merges) ctx.areas.add("cortes");
      ctx.done.push(merges ? `Ritmo más pausado: uní ${merges} plano(s) seguidos (~${next} s por plano).` : `Ritmo objetivo de ~${next} s por plano.`);
    }
  },
};

const musicIntent: Intent = {
  name: "musica",
  match: (ctx) => has(ctx, MUSIC_WORDS) && !has(ctx, /\bmusica (con|de) ia\b/),
  apply(ctx) {
    const music = ctx.r.tracks.audio.music;
    const musicAssets = ctx.input.assets.filter((a) => a.kind === "audio" && a.category === "musica");
    const lower = has(ctx, /\b(baja|bajale|bajar|menos volumen|mas baja|mas bajo|muy fuerte|muy alta|tapa|no se escucha la voz|no se oye la voz|mas suave|mas despacio)\b/);
    const raise = has(ctx, /\b(sube|subele|subir|mas fuerte|mas alta|mas volumen|no se escucha la musica|no se oye la musica|casi no se oye|casi no se escucha)\b/) && !lower;
    const remove = has(ctx, new RegExp(String.raw`\b${REMOVE}\b[^.]*\b(musica|cancion|pista)\b`)) && !lower && !raise && !has(ctx, /\b(otra|cambia)\b/);
    const change = has(ctx, /\b(otra musica|otra cancion|cambia la musica|cambia la cancion|musica diferente)\b/);
    const add = has(ctx, new RegExp(String.raw`\b${ADD}\b[^.]*\b(musica|cancion)\b`)) && !remove && !lower && !raise;
    const duck = has(ctx, /\b(baje|bajar) (la musica )?cuando (hablo|habla|hablan)\b|\bducking\b/);
    if (remove) {
      if (!music.length) return void ctx.notes.push("Esta versión no tiene música, así que no había nada que quitar.");
      ctx.r.tracks.audio.music = [];
      ctx.areas.add("audio");
      ctx.done.push("Quité la música.");
      return;
    }
    if (duck) {
      if (!music.length) return void ctx.notes.push("Esta versión no tiene música.");
      music.forEach((m) => (m.duck = true));
      ctx.areas.add("audio");
      ctx.done.push("La música ahora baja cuando hablas.");
      return;
    }
    if (lower || raise) {
      if (!music.length) return void ctx.notes.push("Esta versión no tiene música para cambiarle el volumen.");
      const delta = lower ? -6 : 4;
      music.forEach((m) => (m.gainDb = round2(clamp(m.gainDb + delta, -40, -3))));
      ctx.areas.add("audio");
      const g = music[0]!.gainDb;
      ctx.done.push(`${lower ? "Bajé" : "Subí"} la música a ${g} dB.`);
      if (lower) ctx.rule = { text: `Música de fondo a ${g} dB o menos`, check: { type: "musica-volumen-max", gainDb: g } };
      return;
    }
    if (change || (add && music.length)) {
      const used = new Set(music.map((m) => m.assetId));
      const other = musicAssets.find((a) => !used.has(a.id));
      if (!other) return void ctx.notes.push(change ? "No hay otra pista de música en el material; sube otra para poder cambiarla." : "La música ya está puesta.");
      if (music.length) music.forEach((m) => (m.assetId = other.id));
      else ctx.r.tracks.audio.music = [{ id: uniqueId(ctx.r, "musica-1"), assetId: other.id, start: 0, end: null, sourceIn: 0, gainDb: ctx.input.settings.tools.music.gainDb, fadeIn: 0.5, fadeOut: 1.5, duck: true }];
      ctx.areas.add("audio");
      ctx.done.push(`Cambié la música por «${other.originalName}».`);
      return;
    }
    if (add) {
      const a = musicAssets[0];
      if (!a) return void ctx.notes.push("No subiste ninguna pista de música; súbela en MATERIAL → Música y vuelve a pedirlo.");
      ctx.r.tracks.audio.music = [{ id: uniqueId(ctx.r, "musica-1"), assetId: a.id, start: 0, end: null, sourceIn: 0, gainDb: ctx.input.settings.tools.music.gainDb, fadeIn: 0.5, fadeOut: 1.5, duck: true }];
      ctx.areas.add("audio");
      ctx.done.push(`Agregué la música «${a.originalName}».`);
      return;
    }
    ctx.notes.push("Entendí que hablas de la música, pero no qué cambiarle (puedo quitarla, bajarla, subirla o cambiarla).");
  },
};

const sfxIntent: Intent = {
  name: "sfx",
  match: (ctx) => has(ctx, /\b(efectos de sonido|efectos sonoros|sfx|whoosh|sonidos|swoosh|golpes)\b/),
  apply(ctx) {
    const remove = has(ctx, new RegExp(String.raw`\b${REMOVE}\b`)) || has(ctx, /\b(menos efectos|demasiados efectos)\b/);
    if (remove) {
      if (!ctx.r.tracks.audio.sfx.length) return void ctx.notes.push("Esta versión no tiene efectos de sonido.");
      ctx.r.tracks.audio.sfx = has(ctx, /\b(menos|demasiados)\b/) ? ctx.r.tracks.audio.sfx.filter((_, k) => k % 2 === 0) : [];
      ctx.areas.add("audio");
      ctx.done.push(ctx.r.tracks.audio.sfx.length ? "Dejé menos efectos de sonido." : "Quité los efectos de sonido.");
      return;
    }
    const sfxAssets = ctx.input.assets.filter((a) => a.kind === "audio" && a.category === "sfx");
    if (!sfxAssets.length) return void ctx.notes.push("No subiste efectos de sonido; súbelos en MATERIAL → Efectos de sonido.");
    const whoosh = sfxAssets.find((a) => /whoosh|swoosh|transici/i.test(a.originalName)) ?? sfxAssets[0]!;
    const hit = sfxAssets.find((a) => /golpe|hit|impact|pop/i.test(a.originalName)) ?? whoosh;
    const sfx = ctx.r.tracks.audio.sfx;
    const push = (at: number, assetId: string, kind: "whoosh" | "golpe", gainDb: number) => {
      if (at < 0 || at > ctx.base.duration || sfx.some((x) => Math.abs(x.at - at) < 0.4)) return;
      sfx.push({ id: uniqueId(ctx.r, `sfx-${sfx.length + 1}`), assetId, at: round3(at), gainDb, kind, origin: "usuario" });
    };
    const before = sfx.length;
    ctx.r.tracks.text.forEach((t) => push(t.start, hit.id, "golpe", -8));
    ctx.r.tracks.overlays.filter((o) => o.kind !== "logo").forEach((o) => push(Math.max(0, o.start - 0.15), whoosh.id, "whoosh", -10));
    ctx.base.tracks.video.forEach((c, k) => {
      const prev = ctx.base.tracks.video[k - 1];
      if (prev && !isContiguous(prev, c)) push(Math.max(0, c.start - 0.1), whoosh.id, "whoosh", -12);
    });
    sfx.sort((a, b) => a.at - b.at);
    if (sfx.length === before) return void ctx.notes.push("Ya hay efectos en los momentos clave.");
    ctx.areas.add("audio");
    ctx.done.push(`Agregué ${sfx.length - before} efecto(s) de sonido en cortes y textos.`);
  },
};

const captionsIntent: Intent = {
  name: "subtitulos",
  match: (ctx) => has(ctx, CAPTION_WORDS) || has(ctx, /\b(palabra por palabra|karaoke|en mayusculas|en minusculas|sin mayusculas|todo en mayusculas)\b/),
  apply(ctx) {
    const st = ctx.r.tracks.captions.style;
    const cap = ctx.r.tracks.captions;
    const before = JSON.stringify(cap);
    if (has(ctx, new RegExp(String.raw`\b${REMOVE}\b[^.]*\bsubtitulos?\b`)) && !has(ctx, /\b(mayusculas|resaltad|fondo|caja|emoji|animacion|color)\b/)) {
      if (!cap.enabled) return void ctx.notes.push("Los subtítulos ya estaban apagados.");
      cap.enabled = false;
      ctx.done.push("Quité los subtítulos.");
    } else if (!cap.enabled && has(ctx, new RegExp(String.raw`\b${ADD}\b[^.]*\bsubtitulos?\b`))) {
      cap.enabled = true;
      ctx.done.push("Prendí los subtítulos.");
    }
    if (has(ctx, /\b(sin mayusculas|en minusculas|minusculas|no (los pongas |esten )?en mayusculas)\b/)) {
      st.uppercase = false;
      ctx.done.push("Subtítulos sin mayúsculas.");
      ctx.rule = { text: "Subtítulos sin mayúsculas", check: { type: "subtitulos-mayusculas", value: false } };
    } else if (has(ctx, /\bmayusculas\b/)) {
      st.uppercase = true;
      ctx.done.push("Subtítulos en mayúsculas.");
      ctx.rule = { text: "Subtítulos siempre en mayúsculas", check: { type: "subtitulos-mayusculas", value: true } };
    }
    if (has(ctx, /\b(arriba|parte de arriba|superior)\b/)) (st.position = "arriba"), ctx.done.push("Subtítulos arriba.");
    else if (has(ctx, /\b(al centro|en el centro|en medio|centrados|a la mitad)\b/)) (st.position = "centro"), ctx.done.push("Subtítulos al centro.");
    else if (has(ctx, /\b(abajo|parte de abajo|inferior)\b/)) (st.position = "abajo"), ctx.done.push("Subtítulos abajo.");
    if (has(ctx, /\b(palabra por palabra|karaoke)\b/)) (st.mode = "palabra"), ctx.done.push("Subtítulos palabra por palabra.");
    else if (has(ctx, /\b(por frase|frases completas|frase completa)\b/)) (st.mode = "frase"), ctx.done.push("Subtítulos por frase.");
    else if (has(ctx, /\b(por bloque|bloques|dos lineas)\b/)) (st.mode = "bloque"), ctx.done.push("Subtítulos por bloque.");
    if (has(ctx, /\b(sin resaltar|no resaltes|quita el resaltado|sin resaltado|sin palabras clave)\b/)) (st.highlightKeywords = false), ctx.done.push("Sin resaltar palabras clave.");
    else if (has(ctx, /\b(resalta|resaltar|resaltadas?)\b/) && !findColorInText(ctx.raw) && !st.highlightKeywords) (st.highlightKeywords = true), ctx.done.push("Palabras clave resaltadas.");
    if (has(ctx, /\b(con caja|con fondo|fondo negro|caja negra)\b/) && !findColorInText(ctx.raw.replace(/fondo negro|caja negra/gi, ""))) (st.background = "caja"), ctx.done.push("Subtítulos sobre caja.");
    else if (has(ctx, /\b(sin caja|sin fondo)\b/)) (st.background = "sombra"), ctx.done.push("Subtítulos sin caja.");
    if (has(ctx, /\bsin animacion\b/)) (st.animation = "ninguna"), ctx.done.push("Subtítulos sin animación.");
    else if (has(ctx, /\b(con animacion|que reboten|rebote)\b/)) (st.animation = "rebote"), ctx.done.push("Subtítulos con rebote.");
    if (has(ctx, /\bsin emojis?\b/)) (st.emojis = false), ctx.done.push("Subtítulos sin emojis.");
    else if (has(ctx, /\b(con emojis?|agrega emojis?|pon emojis?)\b/)) (st.emojis = true), ctx.done.push("Subtítulos con emojis.");
    if (JSON.stringify(cap) !== before) ctx.areas.add("subtitulos");
  },
};

const textIntent: Intent = {
  name: "textos",
  match: (ctx) => has(ctx, /\b(titulos?|textos?|letreros?|cintillos?|cta|llamado a la accion|llamado|gancho)\b/) && !has(ctx, FONT_WORDS) && !(has(ctx, BIGGER) || has(ctx, SMALLER)),
  apply(ctx) {
    const texts = ctx.r.tracks.text;
    const q = quoted(ctx.raw);
    const isCta = has(ctx, /\b(cta|llamado a la accion|llamado)\b/);
    const isLower = has(ctx, /\bcintillos?\b/);
    const kind: TextItem["kind"] | "todos" = isCta ? "cta" : isLower ? "cintillo" : has(ctx, /\b(textos|letreros)\b/) && !has(ctx, /\btitulo/) ? "todos" : "titulo";
    const remove = has(ctx, new RegExp(String.raw`\b${REMOVE}\b`)) && !q.length;
    const ofKind = (t: TextItem) => kind === "todos" || t.kind === kind;
    if (remove) {
      const before = texts.length;
      ctx.r.tracks.text = texts.filter((t) => !ofKind(t));
      const removedTexts = before - ctx.r.tracks.text.length;
      let removedGraphics = 0;
      if (isCta || kind === "todos") {
        const g0 = ctx.r.tracks.graphics.length;
        ctx.r.tracks.graphics = ctx.r.tracks.graphics.filter((g) => !(kind === "todos" || /cta|llamado/i.test(`${g.templateId} ${g.description}`)));
        removedGraphics = g0 - ctx.r.tracks.graphics.length;
      }
      if (removedTexts) ctx.areas.add("texto");
      if (removedGraphics) ctx.areas.add("graficos");
      if (!removedTexts && !removedGraphics) return void ctx.notes.push(`No hay ${kind === "todos" ? "textos" : kind === "cta" ? "llamado a la acción" : kind} en esta versión.`);
      ctx.done.push(`Quité ${kind === "todos" ? "los textos en pantalla" : kind === "cta" ? "el llamado a la acción" : kind === "cintillo" ? "el cintillo" : "el título"}.`);
      return;
    }
    // Reemplazos: "cambia 'A' por 'B'".
    if (q.length >= 2) {
      const [from, to] = [q[0]!, q[1]!];
      const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      let changed = 0;
      for (const t of texts) {
        const nt = t.text.replace(re, to);
        if (nt !== t.text) (t.text = nt), changed++;
      }
      for (const g of ctx.r.tracks.graphics) {
        for (const [k, v] of Object.entries(g.props)) {
          if (typeof v === "string" && re.test(v)) (g.props[k] = v.replace(re, to)), ctx.areas.add("graficos"), changed++;
        }
      }
      if (!changed) return void ctx.notes.push(`No encontré «${from}» en los textos de esta versión.`);
      if (texts.length) ctx.areas.add("texto");
      ctx.done.push(`Cambié «${from}» por «${to}» en los textos.`);
      ctx.rule = { text: `Escribir «${to}» en lugar de «${from}»`, check: { type: "texto-palabra", wrong: from, right: to } };
      return;
    }
    if (q.length === 1) {
      const text = q[0]!;
      const target = texts.find((t) => (kind === "todos" ? true : t.kind === kind));
      if (target) {
        target.text = text;
        ctx.areas.add("texto");
        ctx.done.push(`Nuevo texto del ${kind === "cta" ? "llamado a la acción" : kind === "cintillo" ? "cintillo" : "título"}: «${text}».`);
        return;
      }
      if (isCta) {
        const g = ctx.r.tracks.graphics.find((x) => /cta|llamado/i.test(`${x.templateId} ${x.description}`));
        if (g) {
          for (const key of Object.keys(g.props)) if (typeof g.props[key] === "string" && /^(text|texto|title|titulo|label)$/i.test(key)) g.props[key] = text;
          if (!Object.keys(g.props).some((k) => /^(text|texto)$/i.test(k))) g.props.text = text;
          g.description = `Llamado a la acción: «${text}»`;
          ctx.areas.add("graficos");
          ctx.done.push(`Nuevo llamado a la acción: «${text}».`);
          return;
        }
      }
      // No existe: se agrega (en el momento anclado si lo hay).
      const D = ctx.base.duration;
      const start = isCta ? Math.max(0, D - 2.8) : ctx.at != null ? clamp(ctx.at, 0, Math.max(0, D - 1)) : 0.15;
      const end = isCta ? D : Math.min(D, start + 2.8);
      texts.push({
        id: uniqueId(ctx.r, isCta ? "cta-final" : isLower ? "cintillo-1" : "titulo-1"),
        kind: isCta ? "cta" : isLower ? "cintillo" : "titulo",
        text,
        subtitle: "",
        start: round3(start),
        end: round3(end),
        position: isCta ? "centro" : isLower ? "cintillo" : "arriba",
        font: null,
        fontSize: isCta ? 80 : isLower ? 56 : 84,
        color: null,
        background: isCta ? ctx.r.style.palette.accent : isLower ? ctx.r.style.palette.primary : null,
        uppercase: null,
        animation: isLower ? "deslizar" : "pop",
        engine: "builtin",
      });
      texts.sort((a, b) => a.start - b.start);
      ctx.areas.add("texto");
      ctx.done.push(`Agregué ${isCta ? "el llamado a la acción" : isLower ? "el cintillo" : "el título"} «${text}».`);
      return;
    }
    // "Pon un título" sin texto: el gancho de la transcripción (no invento datos).
    if (has(ctx, new RegExp(String.raw`\b${ADD}\b`)) && kind === "titulo" && !texts.some((t) => t.kind === "titulo")) {
      const phrases = [...ctx.words.values()].flatMap((w) => splitPhrases(w));
      const hook = findHookPhrase(phrases);
      if (!hook) return void ctx.notes.push("Dime entre comillas qué título quieres poner.");
      texts.push({ id: uniqueId(ctx.r, "titulo-gancho"), kind: "titulo", text: hook.text, subtitle: "", start: 0.15, end: round3(Math.min(ctx.base.duration, 3.2)), position: "arriba", font: null, fontSize: 84, color: null, background: null, uppercase: null, animation: "pop", engine: "builtin" });
      texts.sort((a, b) => a.start - b.start);
      ctx.areas.add("texto");
      ctx.done.push(`Agregué el título «${hook.text}» (sale de lo que dices al inicio).`);
      return;
    }
    if (has(ctx, /\b(mas tiempo|mas largo|dure mas|se va muy rapido)\b/)) {
      let changed = 0;
      for (const t of texts.filter(ofKind)) {
        const end = round3(Math.min(ctx.base.duration, t.end + 1.2));
        if (end !== t.end) (t.end = end), changed++;
      }
      if (changed) ctx.areas.add("texto"), ctx.done.push("Los textos duran un poco más en pantalla.");
      return;
    }
    ctx.notes.push("Para cambiar un texto escríbelo entre comillas, por ejemplo: cambia el título por \"3 trucos para editar\".");
  },
};

/** Clip de la receta base visible en el segundo t (índice). */
function clipIndexAt(r: Recipe, t: number): number {
  const loc = timelineToSource(r, t);
  if (!loc) return -1;
  return r.tracks.video.findIndex((c) => c.id === loc.clipId);
}

const cutAtIntent: Intent = {
  name: "corte-en-momento",
  match: (ctx) =>
    ctx.at != null &&
    has(ctx, /\b(corte|cortes|clip|parte|pedazo|esto|esta|este|aqui|frase|toma|zoom|salto|brinco|plano)\b/) &&
    has(ctx, new RegExp(String.raw`\b(${REMOVE}|no cortes|no cortar|junta|une|unir|no me gusta)\b`)),
  apply(ctx) {
    const t = ctx.at!;
    const clips = ctx.r.tracks.video;
    const baseClips = ctx.base.tracks.video;
    const idx = clipIndexAt(ctx.base, t);
    if (idx < 0) return void ctx.notes.push(`En ${round2(t)} s no hay ningún plano.`);
    if (has(ctx, /\bzoom\b/)) {
      const c = clips[idx]!;
      if (!c.zoom) return void ctx.notes.push(`El plano de ${round2(t)} s no tiene zoom.`);
      c.zoom = null;
      ctx.areas.add("cortes");
      ctx.done.push(`Quité el zoom del plano en ${round2(t)} s.`);
      return;
    }
    if (has(ctx, /\b(corte|cortes|salto|brinco|no cortes|no cortar|junta|une|unir)\b/)) {
      // Frontera más cercana a t.
      let best = -1;
      let bestDist = Infinity;
      for (let k = 1; k < baseClips.length; k++) {
        const d = Math.abs(baseClips[k]!.start - t);
        if (d < bestDist) (bestDist = d), (best = k);
      }
      if (best < 0 || bestDist > 1.5) return void ctx.notes.push(`No encontré un corte cerca de ${round2(t)} s.`);
      const a = clips[best - 1]!;
      const b = clips[best]!;
      if (a.assetId !== b.assetId || a.stillDuration != null || b.stillDuration != null || b.sourceIn < a.sourceOut - 0.02) {
        // Archivos distintos: no se pueden unir; se suaviza con un fundido.
        b.transitionIn = { type: "fundido", duration: 0.3 };
        ctx.areas.add("cortes");
        ctx.done.push(`En ${round2(baseClips[best]!.start)} s cambia de toma: no se puede unir, así que suavicé el corte con un fundido.`);
        keepExactDuration(ctx);
        return;
      }
      const gap = round3(b.sourceIn - a.sourceOut);
      // Los keyframes de b pasan a ser relativos al inicio de a.
      const offset = (b.sourceIn - a.sourceIn) / a.speed;
      a.sourceOut = b.sourceOut;
      a.reframe = { ...a.reframe, keyframes: [...a.reframe.keyframes, ...b.reframe.keyframes.map((kf) => ({ ...kf, t: round3(kf.t + offset) }))] };
      clips.splice(best, 1);
      ctx.areas.add("cortes");
      if (gap > 0.02) {
        shiftAfter(ctx, baseClips[best]!.start, gap / a.speed);
        ctx.done.push(`Quité el corte de ${round2(baseClips[best]!.start)} s: recuperé ${round2(gap)} s de material para que fluya.`);
      } else ctx.done.push(`Quité el corte de ${round2(baseClips[best]!.start)} s (un solo plano continuo de ${round2(clipDuration(a))} s).`);
      return;
    }
    // Quitar el plano/fragmento en t.
    if (clips.length <= 1) return void ctx.notes.push("No puedo quitar el único plano del video.");
    const removed = clips[idx]!;
    const removedStart = baseClips[idx]!.start;
    const dur = clipDuration(baseClips[idx]!);
    clips.splice(idx, 1);
    if (idx === 0 && clips[0]) clips[0].transitionIn = { type: "corte", duration: 0 };
    ctx.areas.add("cortes");
    shiftAfter(ctx, removedStart + dur - 0.01, -dur);
    ctx.done.push(`Quité el fragmento de ${round2(removedStart)}–${round2(removedStart + dur)} s («${removed.label || removed.id}»).`);
  },
};

const durationIntent: Intent = {
  name: "duracion",
  match: (ctx) =>
    (parseDurationMention(ctx.raw) != null &&
      has(ctx, /\b(dure|dura|duracion|que sea de|que quede (de|en)|de largo|en total|maximo|recortalo|recortala|acortalo|acortala|alargalo|alargala|hazlo de|hazla de|video de)\b/) &&
      !has(ctx, /\b(silencios?|pausas?|en (el )?segundo)\b/)) ||
    has(ctx, /\b(mas corto|mas corta|acortalo|acortala|mas breve|menos largo|recortalo|muy largo|muy larga|mas largo|mas larga|alargalo|alargala|muy corto|muy corta)\b/),
  apply(ctx) {
    const cur = ctx.base.duration;
    const mentioned = parseDurationMention(ctx.raw);
    let target = mentioned;
    if (target == null) target = has(ctx, /\b(mas largo|mas larga|alargalo|alargala|muy corto|muy corta)\b/) ? round2(cur * 1.25) : round2(cur * 0.75);
    target = Math.max(3, target);
    // Con un número explícito se clava (exacta); "más corto/largo" es aproximado salvo que ya fuera exacto.
    const exact = mentioned != null || has(ctx, /\b(exact[oa]s?|exactamente|justo|clavad[oa])\b/) || ctx.r.target.mode === "exacta";
    const mode: "exacta" | "aproximada" = exact ? "exacta" : "aproximada";
    const settings = structuredClone(ctx.input.settings);
    settings.instruction.targetDuration = target;
    settings.instruction.durationMode = mode;
    let plan;
    try {
      plan = buildDemoPlan({ ...ctx.input, settings, baseRecipe: ctx.base }, { kie: ctx.opts.kie });
    } catch {
      return void ctx.notes.push("No pude reajustar la duración con este material.");
    }
    const oldEnd = cur;
    ctx.r.tracks.video = plan.recipe.tracks.video;
    ctx.r.target = { duration: target, mode };
    ctx.areas.add("cortes");
    ctx.areas.add("otro");
    const newDur = normalizeRecipe(ctx.r).duration;
    // Lo que estaba anclado al final (CTA, logo, cierre) se mueve al nuevo final.
    const reanchor = <T extends { start: number; end: number }>(items: T[], area: Area) => {
      for (const it of items) {
        if (it.end >= oldEnd - 0.05 && Math.abs(newDur - oldEnd) > 0.01) {
          const len = it.end - it.start;
          it.end = round3(newDur);
          it.start = round3(Math.max(0, newDur - len));
          ctx.areas.add(area);
        }
      }
    };
    reanchor(ctx.r.tracks.text, "texto");
    reanchor(ctx.r.tracks.graphics, "graficos");
    reanchor(ctx.r.tracks.overlays, "cortes");
    // Lo que queda fuera del nuevo final lo quita normalizeRecipe (y marca su área).
    if (ctx.r.tracks.text.some((x) => x.start >= newDur)) ctx.areas.add("texto");
    if (ctx.r.tracks.graphics.some((x) => x.start >= newDur)) ctx.areas.add("graficos");
    if (ctx.r.tracks.audio.sfx.some((x) => x.at > newDur)) ctx.areas.add("audio");
    ctx.done.push(`Ajusté la duración a ${round2(newDur)} s (objetivo ${mode} de ${target} s) eligiendo las frases de más valor.`);
    ctx.rule = { text: `Videos de ${target} s (${mode})`, check: { type: "duracion-objetivo", seconds: target, mode } };
  },
};

const zoomIntent: Intent = {
  name: "zoom",
  match: (ctx) => ctx.at == null && has(ctx, /\b(zoom|zooms|acercamientos?|punch ?ins?)\b/) && !has(ctx, /\btransicion(es)? de zoom\b/),
  apply(ctx) {
    const remove = has(ctx, new RegExp(String.raw`\b(${REMOVE}|menos)\b`));
    if (remove) {
      const count = ctx.r.tracks.video.filter((c) => c.zoom).length;
      if (!count) return void ctx.notes.push("Esta versión no tiene zooms.");
      ctx.r.tracks.video.forEach((c) => (c.zoom = has(ctx, /\bmenos\b/) && c.zoom && c.zoom.from !== c.zoom.to ? c.zoom : null));
      ctx.areas.add("cortes");
      ctx.done.push(has(ctx, /\bmenos\b/) ? "Dejé solo los zooms de énfasis." : `Quité los zooms (${count}).`);
      ctx.rule = has(ctx, /\bmenos\b/) ? null : { text: "Sin zooms ni punch-ins", check: null };
      return;
    }
    let added = 0;
    ctx.r.tracks.video.forEach((c, k) => {
      if (!c.zoom && c.stillDuration == null && k % 2 === 1) (c.zoom = { from: 1, to: 1.12, start: 0, end: null, ease: "suave" }), added++;
    });
    if (!added) return void ctx.notes.push("Ya hay zooms en los planos.");
    ctx.areas.add("cortes");
    ctx.done.push(`Agregué ${added} zoom(s) suaves alternados.`);
  },
};

const transitionIntent: Intent = {
  name: "transiciones",
  match: (ctx) => has(ctx, /\b(transicion|transiciones|fundidos?|disolvencias?|cortes secos|solo cortes|corte directo|cortes directos)\b/),
  apply(ctx) {
    const clips = ctx.r.tracks.video;
    const toCuts = has(ctx, /\b(cortes secos|solo cortes|corte directo|cortes directos|sin transiciones|quita las transiciones|sin fundidos?|quita los fundidos?|nada de transiciones)\b/);
    const banZoom = has(ctx, /\btransicion(es)? de zoom\b/) && has(ctx, new RegExp(String.raw`\b(${REMOVE}|nunca|ninguna)\b`));
    if (banZoom) {
      let n = 0;
      clips.forEach((c) => c.transitionIn.type === "zoom" && ((c.transitionIn = { type: "corte", duration: 0 }), n++));
      if (ctx.r.style.defaultTransition.type === "zoom") (ctx.r.style.defaultTransition = { type: "corte", duration: 0 }), ctx.areas.add("estilo");
      if (n) ctx.areas.add("cortes");
      ctx.done.push(n ? `Quité ${n} transición(es) de zoom.` : "No había transiciones de zoom; queda anotado.");
      ctx.rule = { text: "Nunca transiciones de zoom", check: { type: "sin-transicion", transition: "zoom" } };
      keepExactDuration(ctx);
      return;
    }
    if (toCuts) {
      let n = 0;
      clips.forEach((c, k) => {
        if (k > 0 && c.transitionIn.type !== "corte") (c.transitionIn = { type: "corte", duration: 0 }), n++;
      });
      if (ctx.r.style.defaultTransition.type !== "corte") (ctx.r.style.defaultTransition = { type: "corte", duration: 0 }), ctx.areas.add("estilo");
      if (n) ctx.areas.add("cortes");
      ctx.done.push(n ? `Cambié ${n} transición(es) por cortes directos.` : "Ya eran cortes directos.");
      if (has(ctx, /\bfundidos?\b/)) ctx.rule = { text: "Sin fundidos entre planos", check: { type: "sin-transicion", transition: "fundido" } };
      keepExactDuration(ctx);
      return;
    }
    const type: VideoClip["transitionIn"]["type"] = has(ctx, /\bbarrido\b/) ? "barrido" : has(ctx, /\bdesliza|deslizar\b/) ? "deslizar-izq" : has(ctx, /\bnegro\b/) ? "fundido-negro" : "fundido";
    let n = 0;
    clips.forEach((c, k) => {
      const prev = clips[k - 1];
      if (prev && !isContiguous(prev, c) && c.transitionIn.type !== type) (c.transitionIn = { type, duration: 0.3 }), n++;
    });
    ctx.r.style.defaultTransition = { type, duration: 0.3 };
    ctx.areas.add("estilo");
    if (n) ctx.areas.add("cortes");
    ctx.done.push(n ? `Agregué transiciones de ${type} en ${n} cambio(s) de toma.` : `Transición por defecto: ${type}.`);
    keepExactDuration(ctx);
  },
};

/** Ventanas libres de la línea de tiempo para b-roll (alineadas a palabras, sin pisar otros b-roll). */
function brollWindows(r: Recipe, count: number, len: number): { start: number; end: number }[] {
  const D = r.duration;
  const taken: [number, number][] = r.tracks.overlays.filter((o) => o.kind !== "logo").map((o) => [o.start - 1.2, o.end + 1.2]);
  r.tracks.graphics.filter((g) => g.layout === "pantalla-completa").forEach((g) => taken.push([g.start, g.end]));
  const starts = r.tracks.captions.words.map((w) => w.start).filter((s) => s >= 2.5 && s + len <= D - 2.5);
  const out: { start: number; end: number }[] = [];
  const candidates = starts.length ? starts : Array.from({ length: Math.max(0, Math.floor((D - 5) / 1)) }, (_, k) => 2.5 + k);
  for (const s of candidates) {
    if (out.length >= count) break;
    const e = s + len;
    if (taken.some(([a, b]) => s < b && e > a)) continue;
    out.push({ start: round3(s), end: round3(e) });
    taken.push([s - 1.2, e + 1.2]);
  }
  return out;
}

const brollIntent: Intent = {
  name: "broll",
  match: (ctx) => has(ctx, /\b(b ?roll|brolls?|tomas? de apoyo|imagenes de apoyo|recursos|tomas extra)\b/),
  apply(ctx) {
    const isBroll = (o: OverlayItem) => o.kind !== "logo";
    const overlays = ctx.r.tracks.overlays;
    const layout: OverlayItem["layout"] | null = has(ctx, /\b(de fondo|fondo con|persona en (un )?recuadro|orador en (un )?recuadro)\b/)
      ? "fondo-con-orador"
      : has(ctx, /\b(en recuadro|pip|en una esquina|pequen[oa])\b/)
        ? "pip-arriba-der"
        : has(ctx, /\bpantalla completa\b/)
          ? "pantalla-completa"
          : null;
    if (has(ctx, new RegExp(String.raw`\b${REMOVE}\b`)) && !layout) {
      const n = overlays.filter(isBroll).length;
      if (!n) return void ctx.notes.push("Esta versión no tiene tomas de apoyo.");
      ctx.r.tracks.overlays = overlays.filter((o) => !isBroll(o));
      ctx.areas.add("cortes");
      ctx.done.push(`Quité las tomas de apoyo (${n}).`);
      return;
    }
    if (has(ctx, /\bmenos\b/)) {
      const list = overlays.filter(isBroll);
      if (list.length < 2) return void ctx.notes.push("Hay muy pocas tomas de apoyo para quitar más.");
      const drop = new Set(list.filter((_, k) => k % 2 === 1).map((o) => o.id));
      ctx.r.tracks.overlays = overlays.filter((o) => !drop.has(o.id));
      ctx.areas.add("cortes");
      ctx.done.push(`Dejé menos tomas de apoyo (quité ${drop.size}).`);
      return;
    }
    if (layout) {
      let n = 0;
      overlays.filter(isBroll).forEach((o) => o.layout !== layout && ((o.layout = layout), n++));
      if (!n) return void ctx.notes.push("Las tomas de apoyo ya tienen ese acomodo.");
      ctx.areas.add("cortes");
      ctx.done.push(`Tomas de apoyo en modo ${layout === "fondo-con-orador" ? "de fondo con la persona en un recuadro" : layout === "pantalla-completa" ? "pantalla completa" : "recuadro"}.`);
      return;
    }
    // Más b-roll.
    const used = new Set(ctx.r.tracks.video.map((c) => c.assetId));
    const pool = ctx.input.assets.filter(
      (a) => (a.kind === "video" && (a.analysis.role === "b-roll" || (ctx.words.get(a.id)?.length ?? 0) < 3) && !used.has(a.id) && (a.category === "crudo-video" || a.category === "ia-generado")) || (a.kind === "imagen" && a.category === "crudo-foto"),
    );
    if (!pool.length) return void ctx.notes.push("No hay tomas de apoyo en el material: sube videos sin voz (paisaje, producto, detalle) o prende IA videos.");
    const wanted = Math.max(1, Math.round(ctx.base.duration / 10));
    const windows = brollWindows(ctx.base, wanted, 2.5);
    if (!windows.length) return void ctx.notes.push("Ya no hay huecos libres para más tomas de apoyo sin tapar a la persona todo el tiempo.");
    const usage = new Map<string, number>();
    overlays.forEach((o) => usage.set(o.assetId, (usage.get(o.assetId) ?? 0) + 1));
    windows.forEach((w) => {
      const a = [...pool].sort((x, y) => (usage.get(x.id) ?? 0) - (usage.get(y.id) ?? 0) || x.order - y.order)[0]!;
      const n = usage.get(a.id) ?? 0;
      usage.set(a.id, n + 1);
      const seg = [...a.analysis.brollSegments].sort((x, y) => y.score - x.score)[0] ?? { start: 0, end: a.probe.duration ?? 30 };
      const len = w.end - w.start;
      const srcIn = a.kind === "imagen" ? 0 : seg.start + ((n * len) % Math.max(0.1, seg.end - seg.start - len));
      overlays.push({
        id: uniqueId(ctx.r, `broll-${overlays.length + 1}`),
        kind: a.kind === "imagen" ? "imagen" : "broll",
        assetId: a.id,
        start: w.start,
        end: w.end,
        sourceIn: round3(Math.max(0, srcIn)),
        layout: "pantalla-completa",
        opacity: 1,
        kenBurns: a.kind === "imagen",
        transition: { type: "fundido", duration: 0.25 },
        reason: "Toma de apoyo agregada por tu corrección.",
      });
    });
    overlays.sort((a, b) => a.start - b.start);
    ctx.areas.add("cortes");
    ctx.done.push(`Agregué ${windows.length} toma(s) de apoyo.`);
  },
};

const logoIntent: Intent = {
  name: "logo",
  match: (ctx) => has(ctx, /\blogo|logotipo\b/),
  apply(ctx) {
    const overlays = ctx.r.tracks.overlays;
    if (has(ctx, new RegExp(String.raw`\b${REMOVE}\b`))) {
      const n = overlays.filter((o) => o.kind === "logo").length;
      if (!n) return void ctx.notes.push("Esta versión no tiene logo.");
      ctx.r.tracks.overlays = overlays.filter((o) => o.kind !== "logo");
      ctx.areas.add("cortes");
      ctx.done.push("Quité el logo.");
      return;
    }
    const logo = ctx.input.assets.find((a) => a.category === "logo" && a.kind === "imagen");
    if (!logo) return void ctx.notes.push("No subiste un logo; súbelo en MATERIAL → Logos.");
    const D = ctx.base.duration;
    const all = has(ctx, /\b(todo el video|siempre|durante todo)\b/);
    const existing = overlays.find((o) => o.kind === "logo");
    if (existing) {
      if (all) (existing.start = 0), (existing.end = D);
      const pos: OverlayItem["layout"] | null = has(ctx, /\barriba a la izquierda\b/) ? "pip-arriba-izq" : has(ctx, /\babajo a la derecha\b/) ? "pip-abajo-der" : has(ctx, /\babajo a la izquierda\b/) ? "pip-abajo-izq" : has(ctx, /\barriba a la derecha\b/) ? "pip-arriba-der" : null;
      if (pos) existing.layout = pos;
      if (!all && !pos) return void ctx.notes.push("El logo ya está puesto.");
      ctx.areas.add("cortes");
      ctx.done.push("Ajusté el logo.");
      return;
    }
    overlays.push({ id: uniqueId(ctx.r, "logo-final"), kind: "logo", assetId: logo.id, start: all ? 0 : round3(Math.max(0, D - 3)), end: D, sourceIn: 0, layout: "pip-arriba-der", opacity: 1, kenBurns: false, transition: { type: "fundido", duration: 0.3 }, reason: "Logo agregado por tu corrección." });
    overlays.sort((a, b) => a.start - b.start);
    ctx.areas.add("cortes");
    ctx.done.push(all ? "Agregué el logo durante todo el video." : "Agregué el logo al cierre.");
  },
};

const graphicsIntent: Intent = {
  name: "graficos",
  match: (ctx) => has(ctx, /\b(motion graphics?|graficos?|animaciones|animacion)\b/) && !has(ctx, CAPTION_WORDS),
  apply(ctx) {
    if (has(ctx, new RegExp(String.raw`\b${REMOVE}\b`))) {
      const n = ctx.r.tracks.graphics.length;
      if (!n) return void ctx.notes.push("Esta versión no tiene gráficos animados.");
      ctx.r.tracks.graphics = [];
      ctx.areas.add("graficos");
      ctx.done.push(`Quité los gráficos animados (${n}).`);
      return;
    }
    ctx.notes.push("En modo demo solo puedo quitar los gráficos; para diseñar nuevos se necesita Claude.");
  },
};

const formatIntent: Intent = {
  name: "formato",
  match: (ctx) => has(ctx, /\b(horizontal|vertical|cuadrado|cuadrada|9 16|16 9|1 1|4 5)\b/) && has(ctx, /\b(hazlo|ponlo|formato|cambia|en|a)\b/) && !has(ctx, /\b(subtitulos?|textos?|titulos?)\b/),
  apply(ctx) {
    const aspect = has(ctx, /\b(horizontal|16 9)\b/) ? "16:9" : has(ctx, /\b(cuadrado|cuadrada|1 1)\b/) ? "1:1" : has(ctx, /\b4 5\b/) ? "4:5" : "9:16";
    if (ctx.r.format.aspect === aspect) return void ctx.notes.push(`El video ya está en ${aspect}.`);
    const { width, height } = RESOLUTIONS[aspect];
    ctx.r.format = { ...ctx.r.format, aspect, width, height };
    ctx.areas.add("formato");
    ctx.done.push(`Cambié el formato a ${aspect} (${width}×${height}).`);
  },
};

/** Orden de evaluación: lo más específico primero. */
const INTENTS: Intent[] = [
  cutAtIntent,
  durationIntent,
  fontIntent,
  sizeIntent,
  lookIntent,
  colorIntent,
  pacingIntent,
  musicIntent,
  sfxIntent,
  captionsIntent,
  textIntent,
  zoomIntent,
  transitionIntent,
  brollIntent,
  logoIntent,
  graphicsIntent,
  formatIntent,
];

export const DEMO_CLARIFY =
  "En modo demo entiendo correcciones simples como «cambia la tipografía por una más bonita», «quita la música», «subtítulos más grandes», " +
  "«más rápido», «que dure 30 segundos», «en 0:12 quita este corte» o «sin b-roll». ¿Puedes decirlo de una de esas formas? " +
  "Con ANTHROPIC_API_KEY configurada, Claude entiende cualquier corrección.";

/** Interpreta una corrección y devuelve el parche mínimo verificado (sin `usage`). */
export function interpretCorrection(input: CorrectionInput, opts: DemoCorrectionOptions): CorrectionCore {
  const raw = input.correction.trim();
  const base = normalizeRecipe(input.current);
  const ctx: Ctx = {
    input,
    n: ` ${normalize(raw)} `,
    raw,
    at: input.at ?? parseTimeMention(raw),
    r: structuredClone(base),
    base,
    areas: new Set(),
    done: [],
    notes: [],
    rule: null,
    assets: new Map(input.assets.map((a) => [a.id, a])),
    words: wordsByAsset(input.transcripts),
    opts,
  };
  const empty = (question: string, summary: string): CorrectionCore => ({ patch: [], areas: [], summary, clarifyingQuestion: question, ruleSuggestion: null, newTemplates: [] });
  if (!raw) return empty("¿Qué quieres cambiar del video?", "Corrección vacía.");

  const matched: string[] = [];
  for (const intent of INTENTS) {
    if (!intent.match(ctx)) continue;
    // El corte en un momento y la duración ya cubren lo demás de la frase.
    matched.push(intent.name);
    intent.apply(ctx);
    if (intent === cutAtIntent || intent === durationIntent) break;
  }
  if (!matched.length) return empty(DEMO_CLARIFY, "No entendí la corrección en modo demo.");

  const areas = [...ctx.areas];
  const ops = minimalPatch(input.current, ctx.r);
  if (!ops.length || !ctx.done.length) {
    const note = ctx.notes[0] ?? "La corrección no cambia nada en esta versión.";
    return empty(`${note} ¿Quieres pedir otro cambio?`, note);
  }
  const verified = verifyPatch(input.current, ops, areas, input.toolbox);
  if (!verified.recipe) {
    opts.log?.warn({ errors: verified.errors, correction: raw }, "El editor demo armó un parche inválido");
    return empty(`No pude aplicar ese cambio (${verified.errors[0] ?? "error interno"}). ¿Puedes pedirlo de otra forma?`, "No se pudo aplicar la corrección.");
  }
  let finalAreas = areas;
  if (verified.outside.length) {
    // No debería pasar: se registra y se declaran las áreas reales para no mentir sobre lo que cambió.
    opts.log?.warn({ outside: verified.outside.map((c) => c.path), correction: raw }, "La corrección demo tocó áreas no declaradas");
    finalAreas = [...new Set([...areas, ...verified.outside.map((c) => c.area)])];
  }
  const summary = [...ctx.done, ...ctx.notes.filter((n) => !ctx.done.includes(n))].join(" ");
  return { patch: verified.patch, areas: finalAreas, summary, clarifyingQuestion: null, ruleSuggestion: ctx.rule, newTemplates: [] };
}
