/**
 * Lógica PURA de la vista previa de subtítulos: dónde caen las zonas seguras de la plataforma,
 * tamaño de letra a escala, si el texto cabe (misma fórmula que la revisión de calidad del servidor)
 * y qué líneas mostrar a partir de la transcripción real.
 */
import {
  RESOLUTIONS,
  SAFE_ZONES,
  groupCaptionLines,
  makeKeywordMatcher,
  type AspectRatio,
  type CaptionLine,
  type CaptionStyle,
  type CaptionWord,
  type Platform,
  type TranscriptWord,
} from "@autoeditor/shared";

export interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CaptionPreviewLayout {
  /** Tamaño del cuadro de vista previa (px). */
  width: number;
  height: number;
  /** Márgenes de la zona segura (px dentro de la vista previa). */
  safe: Box;
  /** Tamaño de letra y contorno ya escalados a la vista previa (px). */
  fontPx: number;
  outlinePx: number;
  /** Ancho máximo del bloque de texto (px). */
  maxTextWidth: number;
  /** Posición vertical del bloque: distancia desde arriba o desde abajo (px). */
  anchor: { edge: "top" | "bottom" | "center"; offset: number };
  /** ¿Cabe en la zona segura? (misma heurística que la revisión de calidad). */
  fits: boolean;
  neededLines: number;
  /** Explicación corta en español. */
  detail: string;
  /** Tamaño sugerido si no cabe. */
  suggestedFontSize: number | null;
}

/** Ancho estimado de un texto (px) — igual que en la revisión de calidad del servidor. */
export function estimateTextWidth(chars: number, fontPx: number, uppercase: boolean): number {
  return chars * fontPx * (uppercase ? 0.62 : 0.54);
}

export function previewSize(aspect: AspectRatio, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const { width: W, height: H } = RESOLUTIONS[aspect];
  const k = Math.min(maxWidth / W, maxHeight / H);
  return { width: Math.round(W * k), height: Math.round(H * k) };
}

/**
 * Calcula la vista previa a escala. `longestChars` = la línea más larga que se mostrará
 * (por defecto, el máximo de caracteres por línea).
 */
export function captionPreviewLayout(
  style: Pick<CaptionStyle, "fontSize" | "outlineWidth" | "uppercase" | "position" | "marginV" | "maxLines" | "maxCharsPerLine" | "mode">,
  platform: Platform,
  aspect: AspectRatio,
  previewWidth: number,
  longestChars?: number,
): CaptionPreviewLayout {
  const { width: W, height: H } = RESOLUTIONS[aspect];
  const k = previewWidth / W;
  const height = Math.round(H * k);
  const safeFr = SAFE_ZONES[platform];
  const scale = W / 1080;
  const fontOut = style.fontSize * scale;
  const outlineOut = style.outlineWidth * scale;
  const availW = W * (1 - safeFr.left - safeFr.right);
  const perLine = style.mode === "palabra" ? Math.min(style.maxCharsPerLine, 18) : style.maxCharsPerLine;
  const longest = Math.max(1, longestChars ?? perLine);
  const lineW = estimateTextWidth(longest, fontOut, style.uppercase) + outlineOut * 2;
  const neededLines = Math.max(1, Math.ceil(lineW / availW));
  const blockH = neededLines * fontOut * 1.25 + outlineOut * 2;
  const margin = style.marginV * (H / 1920);
  let verticalOk: boolean;
  if (style.position === "abajo") verticalOk = H - (H * safeFr.bottom + margin) - blockH >= H * safeFr.top;
  else if (style.position === "arriba") verticalOk = H * safeFr.top + margin + blockH <= H * (1 - safeFr.bottom);
  else verticalOk = blockH <= H * (1 - safeFr.top - safeFr.bottom);
  const fits = neededLines <= style.maxLines && verticalOk;
  let suggestedFontSize: number | null = null;
  if (!fits) {
    const maxFont = (availW * style.maxLines) / Math.max(1, estimateTextWidth(longest, 1, style.uppercase) * scale + 1);
    suggestedFontSize = Math.max(16, Math.min(style.fontSize - 4, Math.floor(maxFont / scale)));
  }
  const safe: Box = { top: H * safeFr.top * k, bottom: H * safeFr.bottom * k, left: W * safeFr.left * k, right: W * safeFr.right * k };
  const anchor: CaptionPreviewLayout["anchor"] =
    style.position === "abajo"
      ? { edge: "bottom", offset: safe.bottom + margin * k }
      : style.position === "arriba"
        ? { edge: "top", offset: safe.top + margin * k }
        : { edge: "center", offset: 0 };
  const detail = fits
    ? `Cabe dentro de la zona segura (${neededLines} ${neededLines === 1 ? "línea" : "líneas"}).`
    : neededLines > style.maxLines
      ? `Con ${style.fontSize} px la línea más larga necesita ${neededLines} líneas y el máximo es ${style.maxLines}.`
      : "El bloque se sale de la zona segura: súbelo o baja el tamaño.";
  return {
    width: Math.round(previewWidth),
    height,
    safe,
    fontPx: fontOut * k,
    outlinePx: outlineOut * k,
    maxTextWidth: availW * k,
    anchor,
    fits,
    neededLines,
    detail,
    suggestedFontSize,
  };
}

/** Palabras de la transcripción como palabras de subtítulo (sin las marcadas "quitar"). */
export function captionWordsFromTranscript(words: TranscriptWord[], keywords: string[], highlightKeywords: boolean): CaptionWord[] {
  const isKw = makeKeywordMatcher(keywords.map((k) => k.replace(/[¿?¡!…]+/g, " ").trim()).filter(Boolean));
  const texts = words.map((w) => w.text);
  const out: CaptionWord[] = [];
  words.forEach((w, p) => {
    if (w.mark === "quitar") return;
    out.push({ text: w.text, start: w.start, end: w.end, highlight: w.mark === "resaltar" || (highlightKeywords && isKw(texts, p)), emoji: null, speaker: w.speaker ?? null });
  });
  return out;
}

/** Líneas/tarjetas de subtítulos (agrupadas como en el render). */
export function previewLines(words: CaptionWord[], style: Pick<CaptionStyle, "mode" | "maxCharsPerLine" | "maxLines">): CaptionLine[] {
  return groupCaptionLines(words, style);
}

/** Línea que se ve en el segundo `t` (o la más cercana anterior). */
export function lineAt(lines: CaptionLine[], t: number): number {
  if (!lines.length) return -1;
  let idx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.start <= t) idx = i;
    else break;
  }
  return idx;
}

/** Palabra activa dentro de una línea (modo palabra por palabra / karaoke). */
export function wordInLine(line: CaptionLine, t: number): number {
  let idx = 0;
  for (let i = 0; i < line.words.length; i++) if (line.words[i]!.start <= t) idx = i;
  return idx;
}

/** Texto tal como se mostraría (mayúsculas opcionales). */
export function displayText(text: string, uppercase: boolean): string {
  return uppercase ? text.toLocaleUpperCase("es") : text;
}

const EMOJI_RULES: [RegExp, string][] = [
  [/caf[eé]|taza|olla/i, "☕"],
  [/dinero|precio|pesos|d[oó]lares|gratis|ahorr/i, "💰"],
  [/minuto|segundo|hora|r[aá]pido|tiempo/i, "⏱️"],
  [/amor|encanta|abuela|coraz/i, "❤️"],
  [/fuego|incre[ií]ble|wow|mejor/i, "🔥"],
  [/visita|ven|fin de semana|tienda|local/i, "📍"],
  [/idea|tip|truco|sab[ií]as/i, "💡"],
];

/** Emoji opcional para una línea (según sus palabras); null si ninguna regla aplica. */
export function emojiFor(text: string): string | null {
  for (const [re, e] of EMOJI_RULES) if (re.test(text)) return e;
  return null;
}

/** Línea de ejemplo cuando todavía no hay transcripción. */
export const SAMPLE_WORDS: CaptionWord[] = "Así se ven tus subtítulos con tu estilo y tus palabras clave"
  .split(" ")
  .map((text, i) => ({ text, start: i * 0.38, end: i * 0.38 + 0.34, highlight: text === "subtítulos" || text === "palabras" || text === "clave", emoji: null, speaker: null }));
