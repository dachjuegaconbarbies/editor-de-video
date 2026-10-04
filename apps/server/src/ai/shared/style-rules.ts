/**
 * Ficha de reglas del estilo SIN IA: se arma a partir de la receta final, TODAS las correcciones y las
 * reglas aprendidas. La usan el editor demo y el editor con Claude (como base y como respaldo).
 *
 * Las reglas son cortas y verificables ("títulos siempre en Montserrat y en mayúsculas",
 * "un corte cada ~1.5 s") para que el siguiente video salga igual sin repetir errores.
 */
import type { Recipe } from "@autoeditor/shared";
import { clipDuration } from "@autoeditor/shared";
import type { StyleRulesInput } from "../../services/types.js";
import { findColorInText, findFontInText } from "./fonts.js";
import { normalize, round2 } from "./text.js";

const TRANSITION_LABEL: Record<string, string> = {
  corte: "cortes directos",
  fundido: "fundidos",
  "fundido-negro": "fundidos a negro",
  "deslizar-izq": "deslizamientos",
  "deslizar-der": "deslizamientos",
  zoom: "transiciones de zoom",
  barrido: "barridos",
  desenfoque: "desenfoques",
};

const LAYOUT_LABEL: Record<string, string> = {
  "pantalla-completa": "a pantalla completa (corte sobre lo que se dice)",
  "fondo-con-orador": "de fondo con la persona en un recuadro",
  "pip-arriba-der": "en recuadro",
  "pip-arriba-izq": "en recuadro",
  "pip-abajo-der": "en recuadro",
  "pip-abajo-izq": "en recuadro",
  "mitad-superior": "en la mitad superior",
  "mitad-inferior": "en la mitad inferior",
};

/** Lecciones de una corrección (texto corto) a partir de lo que pidió el usuario. */
function lessonFrom(correction: string, summary: string): string | null {
  const n = normalize(correction);
  const font = findFontInText(correction);
  if (font) return `Tipografía: usar ${font.family} (lo pediste en una corrección).`;
  if (/\b(tipografia|fuente|letra)\b/.test(n) && /\b(bonita|otra|fea|mejor)\b/.test(n)) return `Tipografía: la original no gustó; mantener la que quedó tras la corrección (${summary.replace(/\.$/, "")}).`;
  if (/\bmusica\b/.test(n) && /\b(quita|sin|elimina)\b/.test(n)) return "Música: este estilo va sin música de fondo.";
  if (/\bmusica\b/.test(n) && /\b(baja|muy fuerte|tapa)\b/.test(n)) return "Música: siempre bajita, por debajo de la voz.";
  if (/\bsubtitulos?\b/.test(n) && /\bmas grandes?\b/.test(n)) return "Subtítulos: grandes y legibles.";
  if (/\bsubtitulos?\b/.test(n) && /\b(mas pequen|mas chic)/.test(n)) return "Subtítulos: discretos, no muy grandes.";
  if (/\bmayusculas\b/.test(n)) return `Subtítulos: ${/\b(sin|minusculas)\b/.test(n) ? "sin" : "en"} mayúsculas.`;
  if (/\b(mas rapido|mas dinamico|mas ritmo|aburrido)\b/.test(n)) return "Ritmo: rápido, sin planos largos.";
  if (/\b(mas lento|mas pausado|menos cortes)\b/.test(n)) return "Ritmo: pausado, sin cortar de más.";
  if (/\bzoom\b/.test(n) && /\b(sin|quita|nunca)\b/.test(n)) return "Edición: sin zooms ni punch-ins.";
  if (/\b(b ?roll|tomas de apoyo)\b/.test(n)) return `B-roll: ${/\b(sin|quita)\b/.test(n) ? "no usar tomas de apoyo" : /\bmas\b/.test(n) ? "usar más tomas de apoyo" : summary}.`;
  const color = findColorInText(correction);
  if (color) return `Color: ${color.name} (${color.hex}) — ${summary.replace(/\.$/, "")}.`;
  if (/\b(dure|duracion|segundos)\b/.test(n)) return `Duración: ${summary.replace(/\.$/, "")}.`;
  return summary ? `Corrección aplicada: «${correction}» → ${summary.replace(/\.$/, "")}.` : null;
}

export interface StyleRulesOutput {
  rulesMarkdown: string;
  rules: string[];
}

/** Ficha determinista (markdown) + lista de reglas. */
export function buildStyleRules(input: StyleRulesInput): StyleRulesOutput {
  const r: Recipe = input.recipe;
  const rules: string[] = [];
  const st = r.style;
  const cap = r.tracks.captions;
  const clips = r.tracks.video;
  const avgShot = clips.length ? round2(clips.reduce((s, c) => s + clipDuration(c), 0) / clips.length) : st.targetShotLength;
  const transitions = [...new Set(clips.slice(1).map((c) => c.transitionIn.type))];
  const upperTitles = st.textCase === "mayusculas";

  rules.push(`Títulos en ${st.titleFont.family} (${st.titleFont.weight})${upperTitles ? " y en mayúsculas" : ""}.`);
  if (cap.enabled) {
    rules.push(
      `Subtítulos ${cap.style.mode === "palabra" ? "palabra por palabra" : cap.style.mode === "frase" ? "por frase" : "por bloque"} en ${cap.style.font.family}, ${cap.style.fontSize} px${cap.style.uppercase ? ", en mayúsculas" : ""}, ${cap.style.position}.`,
    );
    if (cap.style.highlightKeywords) rules.push(`Palabras clave resaltadas en ${cap.style.highlightColor} (${cap.style.highlightStyle}).`);
  } else rules.push("Sin subtítulos quemados.");
  rules.push(`Un corte cada ~${avgShot} s (ritmo objetivo ${st.targetShotLength} s por plano).`);
  rules.push(transitions.length === 0 || (transitions.length === 1 && transitions[0] === "corte") ? "Solo cortes directos entre planos." : `Transiciones: ${transitions.map((t) => TRANSITION_LABEL[t] ?? t).join(", ")}.`);
  const zooms = clips.filter((c) => c.zoom).length;
  rules.push(zooms ? `Punch-ins/zooms en ~${Math.round((zooms / Math.max(1, clips.length)) * 100)} % de los planos.` : "Sin zooms.");
  const broll = r.tracks.overlays.filter((o) => o.kind !== "logo");
  if (broll.length) {
    const layouts = [...new Set(broll.map((o) => LAYOUT_LABEL[o.layout] ?? o.layout))];
    rules.push(`B-roll ${layouts.join(" y ")}, cerca de ${round2(r.duration / broll.length)} s entre tomas de apoyo.`);
  }
  const music = r.tracks.audio.music[0];
  rules.push(music ? `Música de fondo a ${music.gainDb} dB${music.duck ? " que baja cuando se habla" : ""}.` : "Sin música de fondo.");
  if (r.tracks.audio.sfx.length) rules.push(`Efectos de sonido (${[...new Set(r.tracks.audio.sfx.map((s) => s.kind))].join(", ")}) en cortes y textos.`);
  if (r.tracks.text.some((t) => t.kind === "titulo")) rules.push("Abre con un título-gancho en los primeros 3 s.");
  if (r.tracks.text.some((t) => t.kind === "cta") || r.tracks.graphics.some((g) => /cta/i.test(g.templateId))) rules.push("Cierra con un llamado a la acción.");
  if (r.tracks.overlays.some((o) => o.kind === "logo")) rules.push("Logo al cierre.");
  if (r.tracks.graphics.length) rules.push(`Motion graphics: ${[...new Set(r.tracks.graphics.map((g) => g.templateId))].join(", ")}.`);
  if (r.target.duration != null && r.target.mode !== "auto") rules.push(`Duración ${r.target.mode} de ${r.target.duration} s.`);
  rules.push(`Formato ${r.format.aspect} para ${r.format.platform}.`);

  const lessons = input.corrections.map((c) => lessonFrom(c.correction, c.summary)).filter((x): x is string => !!x);
  const learned = input.rules.filter((x) => x.enabled).map((x) => x.text);
  for (const l of learned) if (!rules.some((x) => normalize(x) === normalize(l))) rules.push(l.endsWith(".") ? l : `${l}.`);

  const md = [
    `# Estilo: ${input.name}`,
    "",
    "Ficha de reglas para que cada video nuevo salga igual: mismas tipografías, colores, ritmo, transiciones, subtítulos y gráficos; solo cambia el contenido.",
    "",
    "## Reglas",
    ...rules.map((x) => `- ${x}`),
    "",
    "## Tipografía y colores",
    `- Títulos: ${st.titleFont.family} ${st.titleFont.weight}${st.titleFont.googleFont ? " (Google Fonts)" : st.titleFont.assetId ? " (archivo de la marca)" : ""}.`,
    `- Texto: ${st.bodyFont.family} ${st.bodyFont.weight}.`,
    `- Paleta: principal ${st.palette.primary}, secundario ${st.palette.secondary}, acento ${st.palette.accent}, texto ${st.palette.text}, fondo ${st.palette.background}.`,
    "",
    "## Ritmo y cortes",
    `- Duración promedio de plano: ${avgShot} s (${clips.length} planos en ${round2(r.duration)} s).`,
    `- Transición por defecto: ${TRANSITION_LABEL[st.defaultTransition.type] ?? st.defaultTransition.type}.`,
    `- Reencuadre: ${[...new Set(clips.map((c) => c.reframe.mode))].join(", ") || "—"}.`,
    "",
    "## Subtítulos",
    cap.enabled
      ? `- ${cap.style.mode}, ${cap.style.font.family} ${cap.style.fontSize} px, color ${cap.style.primaryColor}, resaltado ${cap.style.highlightColor}, contorno ${cap.style.outlineWidth} px, fondo ${cap.style.background}, animación ${cap.style.animation}, máx. ${cap.style.maxCharsPerLine} caracteres por línea.`
      : "- Apagados.",
    "",
    "## Audio",
    music ? `- Música a ${music.gainDb} dB, entrada ${music.fadeIn} s, salida ${music.fadeOut} s${music.duck ? ", con ducking" : ""}.` : "- Sin música.",
    `- Volumen final ${r.tracks.audio.mix.targetLufs} LUFS${r.tracks.audio.mix.voiceEnhance ? ", voz limpia" : ""}.`,
  ];
  if (lessons.length) {
    md.push("", "## Lo que corregiste (no repetir)", ...lessons.map((x) => `- ${x}`));
  }
  if (r.ai.length) {
    md.push("", "## Generación con IA (reutilizable)", ...r.ai.map((a) => `- ${a.kind} con ${a.model}${a.seed != null ? ` (semilla ${a.seed})` : ""}: ${a.prompt}`));
  }
  return { rulesMarkdown: md.join("\n") + "\n", rules };
}
