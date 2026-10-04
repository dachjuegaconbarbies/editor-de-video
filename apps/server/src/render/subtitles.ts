/**
 * Receta → archivo .ass con los textos (tracks.text) y los subtítulos (tracks.captions).
 *
 * Subtítulos:
 *  - Se agrupan con `groupCaptionLines` (shared) y cada grupo ("tarjeta") se reparte en ≤ maxLines
 *    renglones de ≤ maxCharsPerLine caracteres; se mide con las métricas reales de la fuente y, si
 *    no cabe en el ancho seguro, se reduce la escala de esa tarjeta (nunca se sale del cuadro).
 *  - palabra: karaoke; la palabra que se está diciendo cambia a `highlightColor` y regresa al
 *    terminar (hasta que empieza la siguiente, sin parpadeo). Las palabras clave (highlight=true)
 *    quedan resaltadas todo el tiempo según `highlightStyle`: color, escala (más grandes) o caja
 *    (recuadro de color detrás, en una capa aparte que comparte el mismo acomodo).
 *  - frase / bloque: la tarjeta completa a la vez (bloque = hasta maxLines renglones fijos).
 *  - Animación de entrada por tarjeta: pop, fundido o rebote.
 *  - Posición dentro de las zonas seguras de la plataforma (SAFE_ZONES) + marginV.
 *
 * Textos: título, cintillo, CTA, palabra clave y etiqueta con caja redondeada (dibujo ASS), fuente
 * de título/cuerpo del estilo y animaciones (pop, fundido, subir, máquina de escribir, deslizar).
 */
import {
  groupCaptionLines,
  type CaptionStyle,
  type CaptionWord,
  type FontRef,
  type Recipe,
  type StyleTokens,
  type TextItem,
} from "@autoeditor/shared";
import { AssDocument, assEscape, parseHex, roundedRectPath, styleColor, tagAlpha, tagColor, titleCaseEs, upperEs, type Paint } from "./ass.js";
import { measureText, type ResolvedFont } from "./fonts.js";
import { centeredLineWidth, safeBox, type OutputSpec } from "./layout.js";

export type FontPicker = (ref: FontRef | null | undefined, fallback: FontRef) => ResolvedFont;

const PAINT: Paint = { mono: false };
const r1 = (n: number) => Math.round(n * 10) / 10;
const ms = (s: number) => Math.max(0, Math.round(s * 1000));

/** Palabras con las correcciones manuales aplicadas (idempotente si ya venían aplicadas). */
export function captionWordsWithOverrides(recipe: Recipe): CaptionWord[] {
  const { words, overrides } = recipe.tracks.captions;
  return words.map((w, i) => (overrides[String(i)] != null ? { ...w, text: overrides[String(i)]! } : w));
}

/** Reparte palabras en renglones de ≤ maxChars caracteres, intentando no pasar de maxLines. */
export function wrapWords<T extends { text: string }>(words: T[], maxChars: number, maxLines: number): T[][] {
  const total = words.reduce((n, w) => n + w.text.length, 0) + Math.max(0, words.length - 1);
  const targetRows = Math.max(1, Math.min(maxLines, Math.ceil(total / maxChars)));
  const limit = Math.max(maxChars, Math.ceil(total / targetRows));
  const rows: T[][] = [];
  let cur: T[] = [];
  let len = 0;
  for (const w of words) {
    const add = (cur.length ? 1 : 0) + w.text.length;
    if (cur.length && len + add > limit && rows.length < maxLines - 1) {
      rows.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(w);
    len += (cur.length > 1 ? 1 : 0) + w.text.length;
  }
  if (cur.length) rows.push(cur);
  return rows;
}

// ---------------------------------------------------------------------------
// Subtítulos
// ---------------------------------------------------------------------------

interface CaptionLayout {
  x: number;
  y: number;
  an: 2 | 5 | 8;
}

function captionAnchor(style: CaptionStyle, spec: OutputSpec): CaptionLayout {
  const box = safeBox(spec);
  const x = spec.playResX / 2;
  if (style.position === "arriba") return { x, y: box.top + style.marginV, an: 8 };
  if (style.position === "centro") return { x, y: spec.playResY / 2 + style.marginV, an: 5 };
  return { x, y: box.bottom - style.marginV, an: 2 };
}

/** Animación de entrada de una tarjeta, escalada por `f` (1 = 100 %). */
function cardScaleTags(style: CaptionStyle, f: number): string {
  const p = (n: number) => r1(n * f);
  switch (style.animation) {
    case "pop":
      return `\\fscx${p(82)}\\fscy${p(82)}\\t(0,90,\\fscx${p(106)}\\fscy${p(106)})\\t(90,160,\\fscx${p(100)}\\fscy${p(100)})`;
    case "rebote":
      return `\\fscx${p(100)}\\fscy${p(72)}\\t(0,90,\\fscy${p(112)})\\t(90,160,\\fscy${p(95)})\\t(160,220,\\fscy${p(100)})`;
    default:
      return `\\fscx${p(100)}\\fscy${p(100)}`;
  }
}

function cardPositionTags(style: CaptionStyle, l: CaptionLayout): string {
  if (style.animation === "rebote") return `\\an${l.an}\\move(${r1(l.x)},${r1(l.y + style.fontSize * 0.35)},${r1(l.x)},${r1(l.y)},0,140)`;
  const fad = style.animation === "fundido" ? "\\fad(120,80)" : style.animation === "pop" ? "\\fad(40,60)" : "";
  return `\\an${l.an}\\pos(${r1(l.x)},${r1(l.y)})${fad}`;
}

export function addCaptionEvents(doc: AssDocument, recipe: Recipe, spec: OutputSpec, font: ResolvedFont, layerBase = 10): number {
  const track = recipe.tracks.captions;
  const st = track.style;
  const words = captionWordsWithOverrides(recipe).filter((w) => w.text.trim() && w.end > w.start);
  if (!words.length) return 0;
  const cards = groupCaptionLines(words, st);
  const KEY_SCALE = 1.18;
  const keywordsOn = st.highlightKeywords;
  const display = (w: CaptionWord) => assEscape(st.uppercase ? upperEs(w.text) : w.text);
  const isKey = (w: CaptionWord) => keywordsOn && w.highlight;

  const box = st.background === "caja";
  const shadow = st.background === "sombra";
  const styleName = doc.addStyle({
    name: "Subtitulo",
    fontName: font.assName,
    fontSize: st.fontSize,
    primary: styleColor(st.primaryColor, PAINT),
    secondary: styleColor(st.primaryColor, PAINT),
    outline: box ? styleColor(st.boxColor, PAINT) : styleColor(st.outlineColor, PAINT),
    back: styleColor("#000000", PAINT, shadow ? 0.55 : 0),
    borderStyle: box ? 3 : 1,
    outlineWidth: box ? Math.max(8, st.fontSize * 0.16) : st.outlineWidth,
    shadow: shadow ? Math.max(3, st.fontSize * 0.06) : 0,
    alignment: 2,
  });
  // Capa de cajas para palabras clave (cuando el subtítulo no es de caja completa).
  const keyBoxStyle =
    st.highlightStyle === "caja" && !box
      ? doc.addStyle({
          name: "SubtituloCajaClave",
          fontName: font.assName,
          fontSize: st.fontSize,
          primary: styleColor(st.highlightColor, PAINT, 0),
          secondary: styleColor(st.highlightColor, PAINT, 0),
          outline: styleColor(st.highlightColor, PAINT),
          back: styleColor("#000000", PAINT, 0),
          borderStyle: 3,
          outlineWidth: Math.max(6, st.fontSize * 0.12),
          shadow: 0,
          alignment: 2,
        })
      : null;

  const anchor = captionAnchor(st, spec);
  const maxWidth = centeredLineWidth(spec);
  const hl = tagColor(st.highlightColor, PAINT);
  const base = tagColor(st.primaryColor, PAINT);
  // Texto sobre una caja de color claro: oscuro y sin contorno para que se lea.
  const keyTextOnBox = tagColor(parseHex(st.highlightColor).r + parseHex(st.highlightColor).g + parseHex(st.highlightColor).b > 382 ? "#111111" : "#FFFFFF", PAINT);
  let count = 0;

  for (const card of cards) {
    const rows = wrapWords(card.words, st.maxCharsPerLine, st.maxLines);
    // Medición con las métricas reales: el renglón más ancho define la escala de la tarjeta.
    const space = measureText(font.metrics, " ", st.fontSize);
    const widest = Math.max(
      ...rows.map((row) =>
        row.reduce((sum, w, i) => sum + (i ? space : 0) + measureText(font.metrics, st.uppercase ? upperEs(w.text) : w.text, st.fontSize) * (isKey(w) && st.highlightStyle === "escala" ? KEY_SCALE : 1), 0),
      ),
    );
    const fit = Math.min(1, maxWidth / Math.max(1, widest + (box ? st.fontSize * 0.32 : st.outlineWidth * 2)));
    const pos = cardPositionTags(st, anchor);
    const start = card.start;
    const end = Math.max(card.end, card.start + 0.2);
    const lastWordEnd = card.words[card.words.length - 1]!.end;

    const wordTags = (w: CaptionWord, j: number, all: CaptionWord[]): string => {
      const key = isKey(w);
      const scale = key && st.highlightStyle === "escala" ? fit * KEY_SCALE : fit;
      let color = base;
      let extra = "";
      if (key) {
        if (st.highlightStyle === "caja") {
          color = keyTextOnBox;
          extra = box ? `\\3c${hl}\\bord${r1(st.fontSize * 0.12)}` : "\\bord0\\shad0";
        } else {
          color = hl;
        }
      }
      let karaoke = "";
      if (st.mode === "palabra" && !key) {
        const a = ms(w.start - start);
        const next = all[j + 1];
        const b = ms((next ? next.start : Math.max(lastWordEnd, w.end)) - start);
        karaoke = `\\t(${a},${a + 1},\\1c${hl})\\t(${b},${b + 1},\\1c${base})`;
      }
      const reset = box && key && st.highlightStyle === "caja" ? `\\3c${tagColor(st.boxColor, PAINT)}\\bord${r1(Math.max(8, st.fontSize * 0.16))}` : "";
      return `{\\1c${color}${extra}${cardScaleTags(st, scale)}${karaoke}}${display(w)}{${reset}${key && !box && st.highlightStyle === "caja" ? `\\bord${r1(st.outlineWidth)}\\shad${shadow ? r1(Math.max(3, st.fontSize * 0.06)) : 0}` : ""}}`;
    };

    const text = rows
      .map((row) => {
        return row
          .map((w, i) => {
            const j = card.words.indexOf(w);
            return (i ? " " : "") + wordTags(w, j, card.words);
          })
          .join("");
      })
      .join("\\N");
    doc.add({ layer: layerBase + 1, start, end, style: styleName, text: `{${pos}}${text}`.replace(/\{\}/g, "") });

    if (keyBoxStyle && card.words.some(isKey)) {
      const boxText = rows
        .map((row) =>
          row
            .map((w, i) => {
              const key = isKey(w);
              const scale = fit;
              return `${i ? "{\\3a&HFF&} " : ""}{\\3a${key ? "&H00&" : "&HFF&"}${cardScaleTags(st, scale)}}${display(w)}`;
            })
            .join(""),
        )
        .join("\\N");
      doc.add({ layer: layerBase, start, end, style: keyBoxStyle, text: `{${pos}}${boxText}` });
    }
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Textos (tracks.text)
// ---------------------------------------------------------------------------

/** Tamaño por tipo cuando el editor deja el valor por defecto del esquema (96). */
const KIND_SIZE: Record<TextItem["kind"], number> = { titulo: 96, cintillo: 54, cta: 78, "palabra-clave": 112, etiqueta: 42 };

function displayText(text: string, item: TextItem, style: StyleTokens): string {
  const upper = item.uppercase ?? (style.textCase === "mayusculas" ? true : null);
  if (upper === true) return upperEs(text);
  if (upper === null && style.textCase === "titulo") return titleCaseEs(text);
  return text;
}

const isLight = (hex: string) => {
  const c = parseHex(hex);
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b > 150;
};

interface TextBlock {
  x: number;
  y: number;
  an: 4 | 5 | 7 | 8 | 9 | 1 | 2 | 3;
}

export function addTextEvents(doc: AssDocument, recipe: Recipe, spec: OutputSpec, pickFont: FontPicker, opts: { captionsReserve: number; layerBase?: number }): number {
  const style = recipe.style;
  const sb = safeBox(spec);
  const W = spec.playResX;
  const H = spec.playResY;
  let layer = opts.layerBase ?? 30;
  let count = 0;

  for (const item of recipe.tracks.text) {
    const isBodyKind = item.kind === "cintillo" || item.kind === "etiqueta";
    const font = pickFont(item.font, isBodyKind && item.kind === "etiqueta" ? style.bodyFont : style.titleFont);
    const subFont = pickFont(null, style.bodyFont);
    const size = item.fontSize === 96 ? KIND_SIZE[item.kind] : item.fontSize;
    const defaultBg: Record<TextItem["kind"], string | null> = {
      titulo: null,
      cintillo: style.palette.primary,
      cta: style.palette.accent,
      "palabra-clave": style.palette.secondary,
      etiqueta: "#000000A6",
    };
    const bg = item.background ?? defaultBg[item.kind];
    const fg = item.color ?? (bg && isLight(bg) ? style.palette.background : style.palette.text);
    const main = displayText(item.text, item, style);
    const sub = item.subtitle ? displayText(item.subtitle, { ...item, uppercase: item.kind === "cintillo" ? false : item.uppercase }, style) : "";
    const subSize = Math.round(size * (item.kind === "cintillo" ? 0.62 : 0.5));

    // Medidas del bloque.
    const maxW = item.kind === "cintillo" || item.position === "arriba-izq" || item.position === "arriba-der" ? sb.width : centeredLineWidth(spec);
    const padX = bg ? size * 0.42 : 0;
    const padY = bg ? size * 0.2 : 0;
    const bar = item.kind === "cintillo" ? Math.max(8, size * 0.16) : 0;
    const wMain = measureText(font.metrics, main, size);
    const wSub = sub ? measureText(subFont.metrics, sub, subSize) : 0;
    const contentW = Math.max(wMain, wSub);
    const fit = Math.min(1, (maxW - 2 * padX - bar) / Math.max(1, contentW));
    const blockW = (contentW * fit + 2 * padX + bar);
    const blockH = (size + (sub ? subSize * 1.05 : 0)) * fit + 2 * padY;

    // Posición del bloque (esquina superior izquierda).
    let left: number;
    let top: number;
    switch (item.position) {
      case "arriba":
        left = (W - blockW) / 2;
        top = sb.top;
        break;
      case "abajo":
        left = (W - blockW) / 2;
        top = sb.bottom - opts.captionsReserve - blockH;
        break;
      case "cintillo":
        left = sb.left;
        top = sb.bottom - opts.captionsReserve - blockH - H * 0.02;
        break;
      case "arriba-izq":
        left = sb.left;
        top = sb.top;
        break;
      case "arriba-der":
        left = sb.right - blockW;
        top = sb.top;
        break;
      default:
        left = (W - blockW) / 2;
        top = (H - blockH) / 2;
    }
    // Un cintillo siempre se alinea a la izquierda aunque venga con otra posición vertical.
    const leftAligned = item.kind === "cintillo" || item.position === "cintillo" || item.position === "arriba-izq";
    const rightAligned = item.position === "arriba-der";
    const cy = top + blockH / 2;
    const textAnchor: TextBlock = leftAligned
      ? { x: left + bar + padX, y: cy, an: 4 }
      : rightAligned
        ? { x: left + blockW - padX, y: cy, an: 6 as TextBlock["an"] }
        : { x: left + blockW / 2, y: cy, an: 5 };
    const boxAnchor: TextBlock = leftAligned ? { x: left, y: cy, an: 4 } : rightAligned ? { x: left + blockW, y: cy, an: 6 as TextBlock["an"] } : { x: left + blockW / 2, y: cy, an: 5 };

    const dur = item.end - item.start;
    const anim = item.animation;
    const fadeOut = anim === "ninguna" ? 0 : Math.min(200, ms(dur * 0.2));
    const motion = (a: TextBlock): string => {
      const at = `\\an${a.an}`;
      const p = `\\pos(${r1(a.x)},${r1(a.y)})`;
      switch (anim) {
        case "pop":
          return `${at}${p}\\fad(60,${fadeOut})\\fscx${r1(40 * fit)}\\fscy${r1(40 * fit)}\\t(0,180,\\fscx${r1(110 * fit)}\\fscy${r1(110 * fit)})\\t(180,280,\\fscx${r1(100 * fit)}\\fscy${r1(100 * fit)})`;
        case "subir":
          return `${at}\\move(${r1(a.x)},${r1(a.y + size * 0.7)},${r1(a.x)},${r1(a.y)},0,320)\\fad(220,${fadeOut})\\fscx${r1(100 * fit)}\\fscy${r1(100 * fit)}`;
        case "deslizar": {
          const dx = leftAligned ? -(blockW + sb.left + 40) : rightAligned ? blockW + (W - sb.right) + 40 : -W * 0.6;
          return `${at}\\move(${r1(a.x + dx)},${r1(a.y)},${r1(a.x)},${r1(a.y)},0,380)\\fad(120,${fadeOut})\\fscx${r1(100 * fit)}\\fscy${r1(100 * fit)}`;
        }
        case "fundido":
          return `${at}${p}\\fad(250,${fadeOut})\\fscx${r1(100 * fit)}\\fscy${r1(100 * fit)}`;
        case "maquina-escribir":
          return `${at}${p}\\fad(0,${fadeOut})\\fscx${r1(100 * fit)}\\fscy${r1(100 * fit)}`;
        default:
          return `${at}${p}\\fscx${r1(100 * fit)}\\fscy${r1(100 * fit)}`;
      }
    };

    const styleName = doc.addStyle({
      name: `Texto${count}`,
      fontName: font.assName,
      fontSize: size,
      primary: styleColor(fg, PAINT),
      secondary: styleColor(fg, PAINT),
      outline: styleColor("#000000", PAINT, bg ? 0 : 0.85),
      back: styleColor("#000000", PAINT, bg ? 0 : 0.45),
      borderStyle: 1,
      outlineWidth: bg ? 0 : Math.max(2, size * 0.04),
      shadow: bg ? 0 : Math.max(2, size * 0.05),
      alignment: 5,
    });

    if (bg) {
      const radius = item.kind === "palabra-clave" || item.kind === "cta" ? blockH * 0.28 : size * 0.16;
      doc.add({
        layer,
        start: item.start,
        end: item.end,
        style: styleName,
        text: `{${motion(boxAnchor)}\\bord0\\shad0\\1c${tagColor(bg, PAINT)}\\1a${tagAlpha(1, bg)}\\p1}${roundedRectPath(blockW / fit, blockH / fit, radius / fit)}{\\p0}`,
      });
      if (bar) {
        // Barra de acento del cintillo (encima de la caja, a la izquierda).
        const accent = style.palette.secondary;
        doc.add({
          layer: layer + 1,
          start: item.start,
          end: item.end,
          style: styleName,
          text: `{${motion(boxAnchor)}\\bord0\\shad0\\1c${tagColor(accent, PAINT)}\\p1}${roundedRectPath(bar / fit, blockH / fit, Math.min(bar, size * 0.16) / fit / 2)}{\\p0}`,
        });
      }
    }

    // Texto: principal + subtítulo en el mismo evento (comparten anclaje y animación).
    let mainText = assEscape(main);
    if (anim === "maquina-escribir") {
      const chars = [...main];
      const step = Math.min(0.06, (dur * 0.6) / Math.max(1, chars.length));
      mainText = chars.map((c, i) => `{\\alpha&HFF&\\t(${ms(i * step)},${ms(i * step) + 1},\\alpha&H00&)}${assEscape(c)}`).join("");
    }
    const subPart = sub
      ? `\\N{\\fn${subFont.assName}\\fs${subSize}\\1c${tagColor(fg, PAINT)}\\1a${tagAlpha(0.88)}}${assEscape(sub)}`
      : "";
    doc.add({ layer: layer + 2, start: item.start, end: item.end, style: styleName, text: `{${motion(textAnchor)}}${mainText}${subPart}` });
    layer += 3;
    count++;
  }
  return count;
}

/** Altura (en unidades del PlayRes) que ocupan los subtítulos abajo, para no encimar cintillos. */
export function captionsReserve(recipe: Recipe, burn: boolean): number {
  const c = recipe.tracks.captions;
  if (!burn || !c.enabled || !c.words.length || c.style.position !== "abajo") return 0;
  return c.style.maxLines * c.style.fontSize * 1.15 + c.style.marginV + 30;
}
