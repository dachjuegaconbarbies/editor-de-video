/**
 * Utilidades para escribir subtítulos ASS (libass).
 *
 * Formato y trampas (media-pipeline.md §6.2):
 *  - Colores de estilo `&HAABBGGRR` (alfa primero, 00 = opaco, orden BGR); en etiquetas `\1c&HBBGGRR&`
 *    y el alfa aparte (`\1a&HAA&`).
 *  - Tiempos `H:MM:SS.cc` (centésimas); `\t`, `\fad` y `\move` en milisegundos.
 *  - ASS no transforma a mayúsculas ni tiene escape fiable para `{ } \` (se reemplazan).
 *  - Con BorderStyle=3 (caja) el color de la caja es OutlineColour.
 *
 * Modo "mono": la misma escena con TODOS los colores en blanco (conservando alfas). Sirve para
 * obtener el canal alfa de un gráfico renderizado con libass (el filtro `ass` no escribe alfa):
 * se renderiza a color sobre negro y en mono sobre negro, y el mono es la máscara (motor builtin).
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** Opacidad 0..255 (255 = opaco). */
  a: number;
}

/** "#RRGGBB" o "#RRGGBBAA" (AA = opacidad, como en CSS). */
export function parseHex(hex: string | null | undefined, fallback = "#FFFFFF"): Rgba {
  const h = (hex && /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex) ? hex : fallback).slice(1);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255,
  };
}

const hx = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).toUpperCase().padStart(2, "0");

export interface Paint {
  /** true = pasada de alfa (todo blanco). */
  mono: boolean;
}

/** Color para etiquetas de override: `&HBBGGRR&`. */
export function tagColor(hex: string, paint: Paint): string {
  if (paint.mono) return "&HFFFFFF&";
  const c = parseHex(hex);
  return `&H${hx(c.b)}${hx(c.g)}${hx(c.r)}&`;
}

/** Alfa ASS (00 = opaco) a partir de una opacidad 0..1 y el alfa del color. */
export function tagAlpha(opacity: number, hex?: string): string {
  const a = hex ? parseHex(hex).a / 255 : 1;
  return `&H${hx(255 - 255 * Math.max(0, Math.min(1, opacity * a)))}&`;
}

/** Color de estilo: `&HAABBGGRR`. `opacity` multiplica el alfa propio del color. */
export function styleColor(hex: string, paint: Paint, opacity = 1): string {
  const c = parseHex(hex);
  const alpha = 255 - (c.a / 255) * Math.max(0, Math.min(1, opacity)) * 255;
  if (paint.mono) return `&H${hx(alpha)}FFFFFF`;
  return `&H${hx(alpha)}${hx(c.b)}${hx(c.g)}${hx(c.r)}`;
}

/** Segundos → `H:MM:SS.cc`. */
export function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** Texto seguro para ASS (sin llaves ni barras invertidas; saltos → \N). */
export function assEscape(s: string): string {
  return s.replace(/\\/g, "/").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\r?\n/g, "\\N");
}

export interface AssStyle {
  name: string;
  fontName: string;
  fontSize: number;
  primary: string;
  secondary: string;
  outline: string;
  back: string;
  bold?: boolean;
  italic?: boolean;
  scaleX?: number;
  scaleY?: number;
  spacing?: number;
  /** 1 = contorno + sombra; 3 = caja opaca. */
  borderStyle: 1 | 3;
  outlineWidth: number;
  shadow: number;
  alignment: number;
  marginL?: number;
  marginR?: number;
  marginV?: number;
}

export interface AssEvent {
  layer: number;
  start: number;
  end: number;
  style: string;
  text: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export class AssDocument {
  readonly styles: AssStyle[] = [];
  readonly events: AssEvent[] = [];
  constructor(
    readonly playResX: number,
    readonly playResY: number,
    readonly wrapStyle: 0 | 1 | 2 | 3 = 2,
  ) {}

  addStyle(s: AssStyle): string {
    if (!this.styles.some((x) => x.name === s.name)) this.styles.push(s);
    return s.name;
  }

  add(ev: AssEvent): void {
    if (ev.end - ev.start <= 0.004) return;
    this.events.push(ev);
  }

  toString(): string {
    const head = [
      "[Script Info]",
      "; Generado por el autoeditor (determinista: misma receta → mismo archivo)",
      "ScriptType: v4.00+",
      `PlayResX: ${this.playResX}`,
      `PlayResY: ${this.playResY}`,
      `WrapStyle: ${this.wrapStyle}`,
      "ScaledBorderAndShadow: yes",
      "YCbCr Matrix: TV.709",
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      ...this.styles.map(
        (s) =>
          `Style: ${s.name},${s.fontName.replace(/,/g, " ")},${r2(s.fontSize)},${s.primary},${s.secondary},${s.outline},${s.back},${s.bold ? -1 : 0},${s.italic ? -1 : 0},0,0,${r2(s.scaleX ?? 100)},${r2(s.scaleY ?? 100)},${r2(s.spacing ?? 0)},0,${s.borderStyle},${r2(s.outlineWidth)},${r2(s.shadow)},${s.alignment},${Math.round(s.marginL ?? 0)},${Math.round(s.marginR ?? 0)},${Math.round(s.marginV ?? 0)},1`,
      ),
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ];
    // Orden estable: por inicio, capa y orden de inserción.
    const evs = this.events.map((e, i) => ({ e, i })).sort((a, b) => a.e.start - b.e.start || a.e.layer - b.e.layer || a.i - b.i);
    const lines = evs.map(({ e }) => `Dialogue: ${e.layer},${assTime(e.start)},${assTime(e.end)},${e.style},,0,0,0,,${e.text}`);
    return [...head, ...lines, ""].join("\n");
  }
}

/** Rectángulo redondeado como dibujo ASS (\p1), con origen en (0,0). */
export function roundedRectPath(w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  const k = rr * 0.5523; // aproximación de cuarto de círculo con Bézier
  const f = (n: number) => String(Math.round(n * 10) / 10);
  if (rr <= 0.5) return `m 0 0 l ${f(w)} 0 ${f(w)} ${f(h)} 0 ${f(h)}`;
  return [
    `m ${f(rr)} 0`,
    `l ${f(w - rr)} 0`,
    `b ${f(w - rr + k)} 0 ${f(w)} ${f(rr - k)} ${f(w)} ${f(rr)}`,
    `l ${f(w)} ${f(h - rr)}`,
    `b ${f(w)} ${f(h - rr + k)} ${f(w - rr + k)} ${f(h)} ${f(w - rr)} ${f(h)}`,
    `l ${f(rr)} ${f(h)}`,
    `b ${f(rr - k)} ${f(h)} 0 ${f(h - rr + k)} 0 ${f(h - rr)}`,
    `l 0 ${f(rr)}`,
    `b 0 ${f(rr - k)} ${f(rr - k)} 0 ${f(rr)} 0`,
  ].join(" ");
}

/** Círculo como dibujo ASS centrado en (r, r). */
export function circlePath(r: number): string {
  return roundedRectPath(2 * r, 2 * r, r);
}

/** Mayúsculas correctas en español (ñ, acentos). */
export const upperEs = (s: string) => s.toLocaleUpperCase("es");

/** "hola mundo" → "Hola Mundo" (respeta palabras cortas en minúscula salvo la primera). */
export function titleCaseEs(s: string): string {
  const small = new Set(["de", "del", "la", "las", "el", "los", "y", "o", "a", "en", "con", "por", "para", "un", "una"]);
  return s
    .toLocaleLowerCase("es")
    .split(/(\s+)/)
    .map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toLocaleUpperCase("es") + w.slice(1)))
    .join("");
}
