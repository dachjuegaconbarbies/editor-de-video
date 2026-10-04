/**
 * Catálogos curados: tipografías "bonitas" para rotar, fuentes conocidas, nombres de colores en español y paletas.
 * Los usa el editor demo (correcciones tipo "una tipografía más bonita") y la revisión de calidad.
 */
import type { FontRef } from "@autoeditor/shared";
import { normalize } from "./text.js";

export interface CuratedFont {
  family: string;
  weight: number;
  /** Descripción corta para resúmenes. */
  vibe: string;
}

/** Tipografías de Google Fonts con buen rendimiento en video vertical (orden de rotación). */
export const CURATED_FONTS: CuratedFont[] = [
  { family: "Montserrat", weight: 800, vibe: "geométrica y moderna" },
  { family: "Poppins", weight: 700, vibe: "redonda y amigable" },
  { family: "Bebas Neue", weight: 400, vibe: "condensada de impacto" },
  { family: "Anton", weight: 400, vibe: "gruesa y llamativa" },
  { family: "Oswald", weight: 700, vibe: "condensada elegante" },
  { family: "DM Sans", weight: 700, vibe: "limpia y profesional" },
  { family: "Playfair Display", weight: 700, vibe: "serif editorial" },
  { family: "Archivo Black", weight: 400, vibe: "negrita contundente" },
  { family: "Inter", weight: 800, vibe: "neutra y legible" },
];

/** Fuentes del sistema que el render puede usar sin descargar nada. */
export const SYSTEM_FONTS = ["DejaVu Sans", "DejaVu Serif", "Liberation Sans", "Liberation Serif", "FreeSans", "FreeSerif", "Arial", "Helvetica", "Noto Sans", "Roboto"];

/** Familias que se consideran disponibles (curadas + sistema). */
export const KNOWN_FONT_FAMILIES = new Set([...CURATED_FONTS.map((f) => normalize(f.family)), ...SYSTEM_FONTS.map((f) => normalize(f))]);

/** ¿La fuente existe? (archivo subido, Google Font declarada o fuente conocida). */
export function isFontAvailable(font: FontRef): boolean {
  if (font.assetId) return true;
  if (font.googleFont && font.googleFont.trim()) return true;
  return KNOWN_FONT_FAMILIES.has(normalize(font.family));
}

/** FontRef de Google Fonts a partir de una familia curada. */
export function curatedFontRef(f: CuratedFont): FontRef {
  return { family: f.family, weight: f.weight, assetId: null, googleFont: f.family };
}

/** Busca una tipografía nombrada en un texto ("ponla en Poppins" → Poppins). */
export function findFontInText(text: string): CuratedFont | null {
  const n = ` ${normalize(text)} `;
  for (const f of CURATED_FONTS) {
    if (n.includes(` ${normalize(f.family)} `)) return f;
  }
  return null;
}

/** Siguiente tipografía curada distinta de la actual (rotación determinista). */
export function nextCuratedFont(currentFamily: string, skip: string[] = []): CuratedFont {
  const cur = normalize(currentFamily);
  const skipSet = new Set([cur, ...skip.map(normalize)]);
  const idx = CURATED_FONTS.findIndex((f) => normalize(f.family) === cur);
  for (let k = 1; k <= CURATED_FONTS.length; k++) {
    const cand = CURATED_FONTS[(Math.max(idx, -1) + k + CURATED_FONTS.length) % CURATED_FONTS.length]!;
    if (!skipSet.has(normalize(cand.family))) return cand;
  }
  return CURATED_FONTS[0]!;
}

/** Nombres de colores en español → hex. */
export const COLOR_NAMES: Record<string, string> = {
  rojo: "#E53935", roja: "#E53935", azul: "#1E88E5", "azul marino": "#1A237E", "azul claro": "#64B5F6", celeste: "#4FC3F7",
  verde: "#43A047", "verde menta": "#BFEFD3", menta: "#BFEFD3", "verde limon": "#C6FF00", amarillo: "#FDD835", amarilla: "#FDD835",
  naranja: "#FB8C00", anaranjado: "#FB8C00", morado: "#8E24AA", morada: "#8E24AA", violeta: "#7E57C2", lila: "#B39DDB", purpura: "#8E24AA",
  rosa: "#EC407A", rosado: "#F48FB1", fucsia: "#E91E63", magenta: "#D81B60", blanco: "#FFFFFF", blanca: "#FFFFFF", negro: "#000000", negra: "#000000",
  gris: "#9E9E9E", dorado: "#D4AF37", dorada: "#D4AF37", oro: "#D4AF37", plateado: "#C0C0C0", plata: "#C0C0C0", turquesa: "#26C6DA",
  cian: "#00BCD4", coral: "#EE6B6B", durazno: "#F6D5B3", vino: "#8E2443", cafe: "#6D4C41", marron: "#6D4C41", beige: "#F5F5DC", crema: "#FFF8E1",
};

/** Encuentra un color en el texto: hex explícito o nombre en español. */
export function findColorInText(text: string): { hex: string; name: string } | null {
  const hex = /#([0-9a-fA-F]{6})\b/.exec(text);
  if (hex) return { hex: `#${hex[1]!.toUpperCase()}`, name: `#${hex[1]!.toUpperCase()}` };
  const n = ` ${normalize(text)} `;
  // Primero los nombres compuestos ("azul marino" antes que "azul").
  const names = Object.keys(COLOR_NAMES).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (n.includes(` ${name} `)) return { hex: COLOR_NAMES[name]!, name };
  }
  return null;
}

export interface Palette {
  primary: string;
  secondary: string;
  accent: string;
  text: string;
  background: string;
}

/** Paletas curadas para "otros colores" sin color nombrado. */
export const CURATED_PALETTES: Palette[] = [
  { primary: "#8B7CF0", secondary: "#FBE88A", accent: "#EE6B6B", text: "#FFFFFF", background: "#111111" },
  { primary: "#00B4D8", secondary: "#FFD166", accent: "#EF476F", text: "#FFFFFF", background: "#0B132B" },
  { primary: "#2EC4B6", secondary: "#FF9F1C", accent: "#E71D36", text: "#FFFFFF", background: "#011627" },
  { primary: "#F72585", secondary: "#4CC9F0", accent: "#FFBE0B", text: "#FFFFFF", background: "#10002B" },
  { primary: "#FFB703", secondary: "#8ECAE6", accent: "#FB8500", text: "#FFFFFF", background: "#023047" },
];

export function nextPalette(current: Palette): Palette {
  const idx = CURATED_PALETTES.findIndex((p) => p.primary.toUpperCase() === current.primary.toUpperCase());
  return CURATED_PALETTES[(idx + 1 + CURATED_PALETTES.length) % CURATED_PALETTES.length]!;
}

/** Familia a partir del nombre de archivo de una fuente ("Montserrat-ExtraBold.ttf" → "Montserrat"). */
export function familyFromFontFile(name: string): string {
  const base = name.replace(/\.(ttf|otf|woff2?|ttc)$/i, "");
  const family = base
    .replace(/[-_ ](thin|extralight|light|regular|book|medium|semibold|bold|extrabold|black|heavy|italic|variable|vf)+.*$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return family || base;
}
