/**
 * Revisión de calidad DETERMINISTA (sin IA): duración objetivo, zonas seguras, tipografías existentes,
 * volumen, palabras cortadas y reglas aprendidas con comprobación (RuleCheck).
 *
 * La usan el editor demo (review) y el editor con Claude (se suma a la revisión visual), además de las
 * comprobaciones editoriales de una propuesta (palabras cortadas, "debe aparecer", marcas de la transcripción).
 */
import type { Asset, CaptionWord, MemoryRule, ProjectSettings, Recipe, RuleCheck, Transcript } from "@autoeditor/shared";
import { clipDuration, durationMeetsTarget, groupCaptionLines, normalizeRecipe, SAFE_ZONES } from "@autoeditor/shared";
import { isFontAvailable } from "./fonts.js";
import { isRemovableFiller, wordAt, wordsByAsset } from "./transcript.js";
import { normalize, normWord, round2, round3 } from "./text.js";

export { round3 };

export interface QaCheck {
  check: string;
  ok: boolean;
  detail: string;
}

const sameColor = (a: string, b: string) => a.slice(0, 7).toUpperCase() === b.slice(0, 7).toUpperCase();

/** Ancho estimado (px) de un texto con la fuente a `fontPx` (aprox. por carácter). */
function textWidth(chars: number, fontPx: number, uppercase: boolean): number {
  return chars * fontPx * (uppercase ? 0.62 : 0.54);
}

interface CaptionFit {
  ok: boolean;
  detail: string;
  /** Tamaño de letra que sí cabría (si no cabe). */
  suggestedFontSize: number | null;
}

/** ¿Los subtítulos caben dentro de la zona segura de la plataforma? */
export function captionsFit(recipe: Recipe): CaptionFit {
  const { width: W, height: H, platform } = recipe.format;
  const safe = SAFE_ZONES[platform];
  const style = recipe.tracks.captions.style;
  const scale = W / 1080;
  const fontPx = style.fontSize * scale;
  const availW = W * (1 - safe.left - safe.right);
  const lines = recipe.tracks.captions.words.length ? groupCaptionLines(recipe.tracks.captions.words, style) : [];
  const longest = lines.reduce((m, l) => Math.max(m, l.text.length), 0) || Math.min(style.maxCharsPerLine, 18);
  const lineW = textWidth(longest, fontPx, style.uppercase) + style.outlineWidth * 2 * scale;
  const neededLines = Math.max(1, Math.ceil(lineW / availW));
  const blockH = neededLines * fontPx * 1.25 + style.outlineWidth * 2 * scale;
  const margin = style.marginV * (H / 1920);
  let verticalOk: boolean;
  if (style.position === "abajo") verticalOk = H - (H * safe.bottom + margin) - blockH >= H * safe.top;
  else if (style.position === "arriba") verticalOk = H * safe.top + margin + blockH <= H * (1 - safe.bottom);
  else verticalOk = blockH <= H * (1 - safe.top - safe.bottom);
  const ok = neededLines <= style.maxLines && verticalOk;
  let suggestedFontSize: number | null = null;
  if (!ok) {
    const maxFont = (availW * style.maxLines) / Math.max(1, textWidth(longest, 1, style.uppercase) * scale + 1);
    suggestedFontSize = Math.max(16, Math.min(style.fontSize - 4, Math.floor(maxFont / scale)));
  }
  const detail = ok
    ? `Subtítulos de ${style.fontSize} px caben en la zona segura de ${platform} (línea más larga: ${longest} caracteres).`
    : `La línea más larga (${longest} caracteres a ${style.fontSize} px) necesita ${neededLines} línea(s) y se sale de la zona segura de ${platform}.`;
  return { ok, detail, suggestedFontSize };
}

/** ¿Un texto en pantalla cabe a lo ancho (máx. 2 líneas) dentro de la zona segura? */
function textItemFits(recipe: Recipe, text: string, fontSize: number, uppercase: boolean): { ok: boolean; suggested: number } {
  const { width: W, platform } = recipe.format;
  const safe = SAFE_ZONES[platform];
  const scale = W / 1080;
  const availW = W * (1 - safe.left - safe.right) * 2;
  const w = textWidth(text.length, fontSize * scale, uppercase);
  if (w <= availW) return { ok: true, suggested: fontSize };
  return { ok: false, suggested: Math.max(24, Math.floor(availW / (textWidth(text.length, 1, uppercase) * scale))) };
}

/** Evalúa una regla con comprobación automática contra la receta. */
export function evaluateRuleCheck(recipe: Recipe, check: RuleCheck): { ok: boolean; detail: string } {
  switch (check.type) {
    case "fuente-titulos": {
      const fams = [recipe.style.titleFont.family, ...recipe.tracks.text.filter((t) => t.kind === "titulo" && t.font).map((t) => t.font!.family)];
      const bad = fams.filter((f) => normalize(f) !== normalize(check.family));
      return { ok: bad.length === 0, detail: bad.length ? `Títulos en ${[...new Set(bad)].join(", ")}; la regla pide ${check.family}.` : `Títulos en ${check.family}.` };
    }
    case "fuente-subtitulos": {
      const fam = recipe.tracks.captions.style.font.family;
      const ok = normalize(fam) === normalize(check.family);
      return { ok, detail: ok ? `Subtítulos en ${check.family}.` : `Subtítulos en ${fam}; la regla pide ${check.family}.` };
    }
    case "subtitulos-mayusculas": {
      const ok = recipe.tracks.captions.style.uppercase === check.value;
      return { ok, detail: `Subtítulos ${recipe.tracks.captions.style.uppercase ? "en" : "sin"} mayúsculas; la regla pide ${check.value ? "mayúsculas" : "sin mayúsculas"}.` };
    }
    case "sin-transicion": {
      const t = check.transition;
      const clips = recipe.tracks.video.filter((c, i) => i > 0 && c.transitionIn.type === t).length;
      const overlays = recipe.tracks.overlays.filter((o) => o.transition.type === t).length;
      const ok = clips + overlays === 0;
      return { ok, detail: ok ? `No se usa la transición «${t}».` : `Se usa la transición «${t}» en ${clips + overlays} lugar(es).` };
    }
    case "duracion-plano-max": {
      const long = recipe.tracks.video.filter((c) => clipDuration(c) > check.seconds + 0.05);
      return { ok: long.length === 0, detail: long.length ? `${long.length} plano(s) duran más de ${check.seconds} s.` : `Ningún plano dura más de ${check.seconds} s.` };
    }
    case "color-resaltado": {
      const ok = sameColor(recipe.tracks.captions.style.highlightColor, check.color);
      return { ok, detail: ok ? `Resaltado en ${check.color}.` : `Resaltado en ${recipe.tracks.captions.style.highlightColor}; la regla pide ${check.color}.` };
    }
    case "musica-volumen-max": {
      const loud = recipe.tracks.audio.music.filter((m) => m.gainDb > check.gainDb);
      return { ok: loud.length === 0, detail: loud.length ? `Música a ${loud[0]!.gainDb} dB; máximo ${check.gainDb} dB.` : `Música a ${check.gainDb} dB o menos.` };
    }
    case "texto-palabra": {
      const wrong = normalize(check.wrong);
      const inWords = recipe.tracks.captions.words.some((w) => normWord(w.text) === wrong.replace(/\s+/g, ""));
      const inTexts = recipe.tracks.text.some((t) => ` ${normalize(`${t.text} ${t.subtitle}`)} `.includes(` ${wrong} `));
      const ok = !inWords && !inTexts;
      return { ok, detail: ok ? `«${check.right}» bien escrito.` : `Aparece «${check.wrong}»; debe escribirse «${check.right}».` };
    }
    case "duracion-objetivo": {
      const r = durationMeetsTarget({ duration: recipe.duration, target: { duration: check.seconds, mode: check.mode } });
      return { ok: r.ok, detail: r.detail };
    }
  }
}

/** Revisión determinista completa. */
export function deterministicChecks(recipe: Recipe, rules: MemoryRule[], _settings: ProjectSettings): QaCheck[] {
  const out: QaCheck[] = [];
  const target = durationMeetsTarget(recipe);
  out.push({ check: "Duración objetivo", ok: target.ok, detail: target.detail });

  if (recipe.tracks.captions.enabled) {
    const fit = captionsFit(recipe);
    out.push({ check: "Subtítulos dentro de la zona segura", ok: fit.ok, detail: fit.detail });
  }

  const longTexts = recipe.tracks.text.filter((t) => {
    const upper = t.uppercase ?? recipe.style.textCase === "mayusculas";
    return !textItemFits(recipe, t.text, t.fontSize, upper).ok;
  });
  if (recipe.tracks.text.length) {
    out.push({
      check: "Textos en pantalla sin cortarse",
      ok: longTexts.length === 0,
      detail: longTexts.length ? `Podrían salirse de la pantalla: ${longTexts.map((t) => `«${t.text}»`).join(", ")}.` : "Todos los textos caben dentro de la zona segura.",
    });
  }

  const fonts = [
    { where: "títulos", f: recipe.style.titleFont },
    { where: "texto", f: recipe.style.bodyFont },
    { where: "subtítulos", f: recipe.tracks.captions.style.font },
    ...recipe.tracks.text.filter((t) => t.font).map((t) => ({ where: `«${t.text}»`, f: t.font! })),
  ];
  const missing = fonts.filter((x) => !isFontAvailable(x.f));
  out.push({
    check: "Tipografías disponibles",
    ok: missing.length === 0,
    detail: missing.length ? `No encuentro la tipografía ${missing.map((m) => `${m.f.family} (${m.where})`).join(", ")}.` : "Todas las tipografías están disponibles.",
  });

  const loudMusic = recipe.tracks.audio.music.filter((m) => m.gainDb > 0);
  if (recipe.tracks.audio.music.length) {
    out.push({
      check: "Audio sin saturar",
      ok: loudMusic.length === 0,
      detail: loudMusic.length ? `La música está a +${loudMusic[0]!.gainDb} dB: puede saturar y tapar la voz.` : "La música queda por debajo de la voz.",
    });
  }

  const tiny = recipe.tracks.video.filter((c) => clipDuration(c) < 0.25);
  const cutWords = cutCaptionWords(recipe);
  out.push({
    check: "Sin palabras ni planos cortados",
    ok: tiny.length === 0 && cutWords.length === 0,
    detail:
      tiny.length || cutWords.length
        ? [tiny.length ? `${tiny.length} plano(s) de menos de 0.25 s` : "", cutWords.length ? `palabra(s) cortada(s): ${cutWords.slice(0, 5).map((w) => `«${w.text}»`).join(", ")}` : ""].filter(Boolean).join("; ") + "."
        : "Los cortes caen entre palabras.",
  });

  for (const rule of rules) {
    if (!rule.enabled || !rule.check) continue;
    const r = evaluateRuleCheck(recipe, rule.check);
    out.push({ check: `Regla: ${rule.text}`, ok: r.ok, detail: r.detail });
  }
  return out;
}

/** Palabras de subtítulos que quedaron recortadas por un corte (duran casi nada en el borde de un clip). */
export function cutCaptionWords(recipe: Recipe): CaptionWord[] {
  const bounds = recipe.tracks.video.flatMap((c) => [c.start, c.start + clipDuration(c)]);
  return recipe.tracks.captions.words.filter((w) => w.end - w.start < 0.06 && bounds.some((b) => Math.abs(b - w.start) < 0.02 || Math.abs(b - w.end) < 0.02));
}

/**
 * Arreglo determinista de lo que sí se puede corregir sin criterio editorial
 * (reglas con comprobación, tipografías inexistentes, subtítulos fuera de zona, volumen, duración cercana).
 * Devuelve null si no hay nada que arreglar.
 */
export function deterministicFix(recipe: Recipe, rules: MemoryRule[], checks: QaCheck[]): Recipe | null {
  const next: Recipe = structuredClone(recipe);
  let changed = false;
  const failed = (name: string) => checks.some((c) => c.check === name && !c.ok);

  if (failed("Subtítulos dentro de la zona segura")) {
    const fit = captionsFit(next);
    if (fit.suggestedFontSize && fit.suggestedFontSize < next.tracks.captions.style.fontSize) {
      next.tracks.captions.style.fontSize = fit.suggestedFontSize;
      changed = true;
    }
  }
  if (failed("Textos en pantalla sin cortarse")) {
    for (const t of next.tracks.text) {
      const upper = t.uppercase ?? next.style.textCase === "mayusculas";
      const fit = textItemFits(next, t.text, t.fontSize, upper);
      if (!fit.ok && fit.suggested < t.fontSize) {
        t.fontSize = fit.suggested;
        changed = true;
      }
    }
  }
  if (failed("Tipografías disponibles")) {
    const fallback = { family: "Inter", weight: 800, assetId: null, googleFont: "Inter" };
    if (!isFontAvailable(next.style.titleFont)) (next.style.titleFont = { ...fallback }), (changed = true);
    if (!isFontAvailable(next.style.bodyFont)) (next.style.bodyFont = { ...fallback, weight: 500 }), (changed = true);
    if (!isFontAvailable(next.tracks.captions.style.font)) (next.tracks.captions.style.font = { ...fallback }), (changed = true);
    for (const t of next.tracks.text) if (t.font && !isFontAvailable(t.font)) (t.font = null), (changed = true);
  }
  if (failed("Audio sin saturar")) {
    for (const m of next.tracks.audio.music) if (m.gainDb > 0) (m.gainDb = -12), (changed = true);
  }
  for (const rule of rules) {
    if (!rule.enabled || !rule.check) continue;
    if (evaluateRuleCheck(next, rule.check).ok) continue;
    changed = applyRuleCheck(next, rule.check) || changed;
  }
  if (failed("Duración objetivo")) changed = nudgeDuration(next) || changed;
  if (!changed) return null;
  return normalizeRecipe(next);
}

/** Aplica una regla con comprobación a la receta (muta). Devuelve true si cambió algo. */
export function applyRuleCheck(r: Recipe, check: RuleCheck): boolean {
  switch (check.type) {
    case "fuente-titulos":
      r.style.titleFont = { ...r.style.titleFont, family: check.family, googleFont: r.style.titleFont.assetId ? r.style.titleFont.googleFont : check.family };
      for (const t of r.tracks.text) if (t.kind === "titulo" && t.font) t.font = { ...t.font, family: check.family, googleFont: check.family };
      return true;
    case "fuente-subtitulos":
      r.tracks.captions.style.font = { ...r.tracks.captions.style.font, family: check.family, googleFont: r.tracks.captions.style.font.assetId ? r.tracks.captions.style.font.googleFont : check.family };
      return true;
    case "subtitulos-mayusculas":
      r.tracks.captions.style.uppercase = check.value;
      return true;
    case "sin-transicion": {
      let changed = false;
      r.tracks.video.forEach((c) => {
        if (c.transitionIn.type === check.transition) (c.transitionIn = { type: "corte", duration: 0 }), (changed = true);
      });
      r.tracks.overlays.forEach((o) => {
        if (o.transition.type === check.transition) (o.transition = check.transition === "fundido" ? { type: "corte", duration: 0 } : { type: "fundido", duration: 0.25 }), (changed = true);
      });
      if (r.style.defaultTransition.type === check.transition) (r.style.defaultTransition = { type: "corte", duration: 0 }), (changed = true);
      return changed;
    }
    case "color-resaltado":
      r.tracks.captions.style.highlightColor = check.color.length === 7 || check.color.length === 9 ? check.color.toUpperCase() : r.tracks.captions.style.highlightColor;
      return true;
    case "musica-volumen-max": {
      let changed = false;
      for (const m of r.tracks.audio.music) if (m.gainDb > check.gainDb) (m.gainDb = check.gainDb), (changed = true);
      return changed;
    }
    case "texto-palabra": {
      const wrong = normWord(check.wrong);
      let changed = false;
      r.tracks.captions.words = r.tracks.captions.words.map((w) => {
        if (normWord(w.text) !== wrong) return w;
        changed = true;
        const [, pre = "", , post = ""] = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su.exec(w.text) ?? [];
        return { ...w, text: `${pre}${check.right}${post}` };
      });
      const re = new RegExp(`\\b${check.wrong.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
      for (const t of r.tracks.text) {
        const nt = t.text.replace(re, check.right);
        if (nt !== t.text) (t.text = nt), (changed = true);
      }
      return changed;
    }
    case "duracion-plano-max":
    case "duracion-objetivo":
      return false;
  }
}

/** Si la duración no cumple por poco (≤ 1.5 s), ajusta la salida del último clip sin cortar palabras. */
function nudgeDuration(r: Recipe): boolean {
  const norm = normalizeRecipe(r);
  const { duration: target, mode } = norm.target;
  if (target == null || mode === "auto") return false;
  const diff = target - norm.duration;
  if (Math.abs(diff) > 1.5 || Math.abs(diff) < 0.05) return false;
  const last = r.tracks.video[r.tracks.video.length - 1];
  if (!last) return false;
  if (last.stillDuration != null) {
    last.stillDuration = Math.max(0.5, last.stillDuration + diff);
    return true;
  }
  let newOut = last.sourceOut + diff * last.speed;
  if (diff < 0) {
    // No cortar una palabra: si el nuevo final cae dentro de una palabra, termina antes de ella.
    const lastStart = norm.tracks.video[norm.tracks.video.length - 1]!.start;
    const endTl = lastStart + (newOut - last.sourceIn) / last.speed;
    const inside = norm.tracks.captions.words.find((w) => w.start < endTl && w.end > endTl);
    if (inside) newOut = last.sourceIn + (inside.start - 0.04 - lastStart) * last.speed;
  }
  if (newOut <= last.sourceIn + 0.4) return false;
  last.sourceOut = round3(newOut);
  return true;
}

/**
 * Comprobaciones editoriales de una propuesta (necesitan la transcripción):
 * cortes a mitad de palabra, material "debe aparecer", marcas quitar/debe-ir, muletillas y silencios que quedaron.
 */
export function editorialWarnings(recipe: Recipe, ctx: { transcripts: Transcript[]; assets: Asset[]; settings: ProjectSettings }): string[] {
  const warnings: string[] = [];
  const words = wordsByAsset(ctx.transcripts);
  const names = new Map(ctx.assets.map((a) => [a.id, a.originalName]));
  recipe.tracks.video.forEach((c, idx) => {
    if (c.stillDuration != null) return;
    const list = words.get(c.assetId);
    if (!list) return;
    const atIn = wordAt(list, c.sourceIn);
    const atOut = wordAt(list, c.sourceOut);
    if (atIn) warnings.push(`El clip #${idx} (${c.id}) empieza a mitad de la palabra «${atIn.text}» (${round2(atIn.start)}–${round2(atIn.end)} s del original).`);
    if (atOut) warnings.push(`El clip #${idx} (${c.id}) termina a mitad de la palabra «${atOut.text}» (${round2(atOut.start)}–${round2(atOut.end)} s del original).`);
  });
  const used = new Set([...recipe.tracks.video.map((c) => c.assetId), ...recipe.tracks.overlays.map((o) => o.assetId)]);
  for (const a of ctx.assets) {
    if (a.priority === "debe-aparecer" && (a.kind === "video" || a.kind === "imagen") && !used.has(a.id)) {
      warnings.push(`El archivo «${a.originalName}» está marcado como "debe aparecer" y no se usa.`);
    }
  }
  const inClip = (assetId: string, t: number) => recipe.tracks.video.some((c) => c.assetId === assetId && c.stillDuration == null && t >= c.sourceIn && t <= c.sourceOut);
  const settings = ctx.settings.tools;
  for (const [assetId, list] of words) {
    const usedAsset = recipe.tracks.video.some((c) => c.assetId === assetId);
    list.forEach((w, k) => {
      const mid = (w.start + w.end) / 2;
      if (w.mark === "debe-ir" && !inClip(assetId, mid)) warnings.push(`La palabra «${w.text}» (${round2(w.start)} s de ${names.get(assetId) ?? assetId}) está marcada "debe ir" y quedó fuera.`);
      if (w.mark === "quitar" && inClip(assetId, mid)) warnings.push(`La palabra «${w.text}» (${round2(w.start)} s) está marcada "quitar" y sigue en el video.`);
      if (usedAsset && settings.removeFillers.enabled && inClip(assetId, mid) && isRemovableFiller(w, list[k - 1], list[k + 1]) && w.mark !== "debe-ir") {
        warnings.push(`Quedó la muletilla «${w.text}» (${round2(w.start)} s de ${names.get(assetId) ?? assetId}).`);
      }
      const next = list[k + 1];
      if (usedAsset && settings.removeSilences.enabled && next && next.start - w.end > 1.2 && inClip(assetId, w.end + 0.05) && inClip(assetId, next.start - 0.05)) {
        const sameClip = recipe.tracks.video.some((c) => c.assetId === assetId && c.sourceIn <= w.end && c.sourceOut >= next.start);
        if (sameClip) warnings.push(`Quedó un silencio de ${round2(next.start - w.end)} s entre «${w.text}» y «${next.text}» (${round2(w.end)} s).`);
      }
    });
  }
  return [...new Set(warnings)];
}
