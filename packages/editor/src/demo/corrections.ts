/**
 * "Editor" de correcciones de la DEMO: interpreta la corrección escrita con reglas simples y aplica un
 * cambio MÍNIMO sobre la receta (regla de oro), para que la demo muestre un "qué cambió" plausible:
 *  - tipografía/fuente/letra → cambia la tipografía de títulos y subtítulos
 *  - más rápido/ritmo → planos más cortos (y subtítulos recalculados como cambio derivado)
 *  - mayúsculas, colores, música más baja/alta, subtítulos más grandes, quitar un corte, zoom…
 *  - si es ambigua ("cámbialo", "no me gusta") devuelve una pregunta aclaratoria y no renderiza.
 */
import { clipDuration, normalizeRecipe, timelineToSource, type Recipe, type RecipeChange, type TranscriptWord } from "@autoeditor/shared";
import { materializeCaptions } from "./recipes.js";

export interface DemoCorrectionResult {
  recipe: Recipe;
  summary: string;
  areas: RecipeChange["area"][];
  clarifyingQuestion: string | null;
  ruleSuggestion: string | null;
}

export const DEMO_FONTS = ["Playfair Display", "Montserrat", "Poppins", "Bebas Neue", "Anton", "Inter"];

const COLORS: Record<string, [string, string]> = {
  amarill: ["#FBE88A", "amarillo"],
  roj: ["#EE6B6B", "rojo"],
  azul: ["#5AA9F2", "azul"],
  verde: ["#4FD18B", "verde"],
  morad: ["#8B7CF0", "morado"],
  ros: ["#F59AC8", "rosa"],
  naranja: ["#F6A350", "naranja"],
  blanc: ["#FFFFFF", "blanco"],
};

const strip = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** ¿La corrección es demasiado vaga para aplicarla sin preguntar? */
export function isAmbiguous(text: string): boolean {
  const t = strip(text).trim();
  if (t.length < 4) return true;
  if (/^(cambia(lo)?|mejora(lo)?|no me gusta|hazlo mejor|otra vez|arreglalo|cambia esto|asi no|mas bonito|no)\.?!?$/.test(t)) return true;
  return false;
}

export function applyDemoCorrection(input: Recipe, text: string, at: number | null, transcripts: Map<string, TranscriptWord[]>): DemoCorrectionResult {
  const t = strip(text);
  if (isAmbiguous(text)) {
    return {
      recipe: input,
      summary: "",
      areas: [],
      clarifyingQuestion: "¿Qué te gustaría cambiar exactamente: el ritmo de los cortes, la tipografía, los colores, la música o algún momento en particular?",
      ruleSuggestion: null,
    };
  }
  let r: Recipe = structuredClone(input);
  const notes: string[] = [];
  const areas = new Set<RecipeChange["area"]>();
  let rule: string | null = null;
  let recaption = false;

  // Tipografía
  if (/tipograf|fuente|letra|font/.test(t)) {
    const named = DEMO_FONTS.find((f) => t.includes(strip(f)));
    const current = r.style.titleFont.family;
    const next = named ?? DEMO_FONTS[(DEMO_FONTS.indexOf(current) + 1) % DEMO_FONTS.length] ?? "Playfair Display";
    const onlyCaptions = /subtitul/.test(t) && !/titul/.test(t.replace(/subtitul\w*/g, ""));
    if (!onlyCaptions) r.style.titleFont = { ...r.style.titleFont, family: next };
    r.tracks.captions.style.font = { ...r.tracks.captions.style.font, family: next };
    notes.push(`Cambié la tipografía${onlyCaptions ? " de los subtítulos" : " de títulos y subtítulos"} a ${next}`);
    areas.add("estilo").add("subtitulos");
    rule = `${onlyCaptions ? "Subtítulos" : "Títulos y subtítulos"} en ${next}.`;
  }

  // Ritmo
  if (/rapid|ritmo|dinamic|agil|mas cortes|acelera/.test(t) && !/lent/.test(t)) {
    r.style.targetShotLength = Math.max(0.8, Math.round(r.style.targetShotLength * 0.65 * 10) / 10);
    r.tracks.video = r.tracks.video.map((c) => {
      if (c.stillDuration != null) return { ...c, stillDuration: Math.max(1, Math.round(c.stillDuration * 0.75 * 100) / 100) };
      const d = clipDuration(c);
      const cut = Math.min(d * 0.22, 1.4);
      return d > 1.6 ? { ...c, sourceOut: Math.round((c.sourceOut - cut) * 100) / 100 } : c;
    });
    notes.push(`Acorté los planos (un corte cada ~${r.style.targetShotLength} s)`);
    areas.add("cortes");
    recaption = true;
    rule = `Ritmo rápido: un corte cada ~${r.style.targetShotLength} s.`;
  } else if (/lent|calma|pausad|tranquil/.test(t)) {
    r.style.targetShotLength = Math.min(6, Math.round(r.style.targetShotLength * 1.4 * 10) / 10);
    r.tracks.video = r.tracks.video.map((c) => (c.stillDuration != null ? { ...c, stillDuration: c.stillDuration * 1.3 } : { ...c, sourceOut: Math.round((c.sourceOut + 0.6) * 100) / 100 }));
    notes.push("Alargué los planos para un ritmo más pausado");
    areas.add("cortes");
    recaption = true;
  }

  // Mayúsculas / minúsculas
  if (/mayuscul/.test(t)) {
    r.tracks.captions.style.uppercase = true;
    r.style.textCase = "mayusculas";
    notes.push("Puse los subtítulos y títulos en mayúsculas");
    areas.add("subtitulos").add("estilo");
    rule = "Subtítulos siempre en mayúsculas.";
  } else if (/minuscul/.test(t)) {
    r.tracks.captions.style.uppercase = false;
    r.style.textCase = "original";
    notes.push("Quité las mayúsculas de los subtítulos");
    areas.add("subtitulos").add("estilo");
    rule = "Subtítulos sin mayúsculas.";
  }

  // Colores
  const colorKey = Object.keys(COLORS).find((k) => t.includes(k));
  if (colorKey && /color|resalt|amarill|roj|azul|verde|morad|ros|naranja|blanc/.test(t) && !/tipograf|fuente/.test(t)) {
    const [hex, name] = COLORS[colorKey]!;
    if (/subtitul|resalt|palabra/.test(t) || !/titul/.test(t)) {
      r.tracks.captions.style.highlightColor = hex;
      notes.push(`Resalté las palabras clave en ${name}`);
      areas.add("subtitulos");
      rule = `Resaltar palabras clave en ${name}.`;
    }
    if (/titul|texto/.test(t)) {
      r.tracks.text = r.tracks.text.map((x) => ({ ...x, color: hex }));
      notes.push(`Pinté los textos en pantalla de ${name}`);
      areas.add("texto");
    }
  }

  // Tamaño de subtítulos
  if (/subtitul/.test(t) && /grande|mas grande|tamano|aumenta/.test(t)) {
    r.tracks.captions.style.fontSize = Math.min(140, r.tracks.captions.style.fontSize + 14);
    notes.push(`Agrandé los subtítulos a ${r.tracks.captions.style.fontSize} px`);
    areas.add("subtitulos");
    rule = "Subtítulos grandes.";
  } else if (/subtitul/.test(t) && /pequen|chic|reduce|mas chico/.test(t)) {
    r.tracks.captions.style.fontSize = Math.max(36, r.tracks.captions.style.fontSize - 12);
    notes.push(`Reduje los subtítulos a ${r.tracks.captions.style.fontSize} px`);
    areas.add("subtitulos");
  }

  // Música
  if (/music/.test(t)) {
    const before = notes.length;
    if (/quita|sin music|elimina/.test(t)) {
      r.tracks.audio.music = [];
      notes.push("Quité la música");
      rule = "Sin música de fondo.";
    } else if (/baj|menos|suave|bajito/.test(t)) {
      r.tracks.audio.music = r.tracks.audio.music.map((m) => ({ ...m, gainDb: Math.max(-40, m.gainDb - 6) }));
      notes.push("Bajé la música 6 dB");
      rule = "Música más baja bajo la voz.";
    } else if (/sub|mas alta|fuerte|mas volumen/.test(t)) {
      r.tracks.audio.music = r.tracks.audio.music.map((m) => ({ ...m, gainDb: Math.min(0, m.gainDb + 4) }));
      notes.push("Subí la música 4 dB");
    }
    if (notes.length > before) areas.add("audio");
  }

  // Zooms
  if (/zoom/.test(t)) {
    if (/sin|quita|nunca|no uses|elimina/.test(t)) {
      r.tracks.video = r.tracks.video.map((c) => ({ ...c, zoom: null }));
      notes.push("Quité los zooms");
      rule = "Nunca usar zooms.";
    } else {
      r.tracks.video = r.tracks.video.map((c, i) => (i % 2 === 0 ? { ...c, zoom: { from: 1, to: 1.15, start: 0, end: null, ease: "golpe" as const } } : c));
      notes.push("Agregué punch-ins en los planos principales");
    }
    areas.add("cortes");
  }

  // Transiciones
  if (/transici|fundido/.test(t)) {
    const type = /sin|quita|corte seco|nunca/.test(t) ? ("corte" as const) : ("fundido" as const);
    r.style.defaultTransition = { type, duration: type === "corte" ? 0 : 0.3 };
    r.tracks.video = r.tracks.video.map((c, i) => (i === 0 ? c : { ...c, transitionIn: { type, duration: type === "corte" ? 0 : 0.3 } }));
    notes.push(type === "corte" ? "Dejé solo cortes secos" : "Agregué fundidos suaves entre planos");
    areas.add("cortes");
    recaption = true;
    rule = type === "corte" ? "Solo cortes secos, sin transiciones." : "Fundidos suaves entre planos.";
  }

  // Quitar un fragmento (anclado a un momento o "el último")
  if (/quita|elimina|borra|saca|corta/.test(t) && /corte|clip|parte|esto|aqui|toma|plano|fragmento|escena/.test(t) && !/music|zoom|transici/.test(t)) {
    const when = at ?? null;
    const hit = when != null ? timelineToSource(r, when) : null;
    const idx = hit ? r.tracks.video.findIndex((c) => c.id === hit.clipId) : r.tracks.video.length > 2 ? r.tracks.video.length - 2 : -1;
    if (idx >= 0 && r.tracks.video.length > 1) {
      const removed = r.tracks.video[idx]!;
      r.tracks.video = r.tracks.video.filter((_, i) => i !== idx);
      notes.push(when != null ? `Quité el fragmento en ${fmt(when)} (${removed.label || "clip"})` : `Quité el fragmento “${removed.label || "clip"}”`);
      areas.add("cortes");
      recaption = true;
    }
  }

  // Cambiar el texto de un título: “nuevo texto” entre comillas
  const quoted = /[“"«]([^”"»]{2,60})[”"»]/.exec(text)?.[1];
  if (quoted && /titul|texto|dice|pon|escribe|cambia/.test(t) && r.tracks.text.length) {
    const i = Math.max(0, r.tracks.text.findIndex((x) => x.kind === "titulo"));
    r.tracks.text = r.tracks.text.map((x, j) => (j === i ? { ...x, text: quoted } : x));
    notes.push(`Cambié el título a “${quoted}”`);
    areas.add("texto");
  }

  // Sin coincidencias: ajuste pequeño y razonable en los textos (para que la demo siempre responda).
  if (!notes.length) {
    if (r.tracks.text.length) {
      r.tracks.text = r.tracks.text.map((x, i) => (i === 0 ? { ...x, animation: x.animation === "subir" ? "pop" : "subir", fontSize: Math.min(140, x.fontSize + 8) } : x));
      notes.push("Ajusté el título de apertura para que destaque más");
      areas.add("texto");
    } else {
      r.tracks.captions.style.animation = r.tracks.captions.style.animation === "rebote" ? "pop" : "rebote";
      notes.push("Ajusté la animación de los subtítulos");
      areas.add("subtitulos");
    }
  }

  r = normalizeRecipe(r);
  if (recaption) r = normalizeRecipe(materializeCaptions(r, transcripts, keywordsFrom(input)));
  const summary = `${notes.join(". ")}. Todo lo demás quedó idéntico.`;
  return { recipe: r, summary, areas: [...areas], clarifyingQuestion: null, ruleSuggestion: rule };
}

/** Palabras resaltadas actuales (para conservarlas al recalcular subtítulos). */
function keywordsFrom(recipe: Recipe): string[] {
  return [...new Set(recipe.tracks.captions.words.filter((w) => w.highlight).map((w) => w.text))];
}
