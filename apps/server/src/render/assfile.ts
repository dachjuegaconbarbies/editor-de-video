/**
 * Arma el archivo .ass de una receta (textos + subtítulos) y prepara sus fuentes.
 *
 * Las fuentes se resuelven ANTES (asíncrono: subidas, fábrica, caché o descarga de Google Fonts)
 * y se copian a una carpeta propia del render que se pasa como `fontsdir` a libass: así libass solo
 * ve esas caras y el nombre completo del estilo siempre coincide (media-pipeline.md §6.3).
 */
import path from "node:path";
import { CaptionStyle, StyleTokens, type FontRef, type Recipe } from "@autoeditor/shared";
import { AssDocument } from "./ass.js";
import { FontLibrary, stageFonts, type ResolvedFont } from "./fonts.js";
import type { OutputSpec } from "./layout.js";
import { addCaptionEvents, addTextEvents, captionsReserve, type FontPicker } from "./subtitles.js";
import type { Log, RenderContext } from "../services/types.js";

export interface PreparedFonts {
  caption: ResolvedFont;
  pick: FontPicker;
  all: ResolvedFont[];
}

const keyOf = (f: Partial<FontRef> | null | undefined) => JSON.stringify([f?.family ?? "", f?.weight ?? 0, f?.assetId ?? "", f?.googleFont ?? ""]);

export function fontLibraryFor(ctx: RenderContext, log: Log, googleCacheDir: string | null): FontLibrary {
  return new FontLibrary({
    log,
    dirs: ctx.fontsDir ? [ctx.fontsDir] : [],
    googleCacheDir,
    resolveAssetPath: async (id) => (await ctx.resolveAsset(id)).path,
  });
}

/** Resuelve todas las fuentes que usa la receta (subtítulos, título, cuerpo y textos). */
export async function prepareFonts(recipe: Recipe, lib: FontLibrary): Promise<PreparedFonts> {
  const style = recipe.style ?? StyleTokens.parse({});
  const capStyle = recipe.tracks.captions.style ?? CaptionStyle.parse({});
  const refs: (FontRef | null)[] = [capStyle.font, style.titleFont, style.bodyFont, ...recipe.tracks.text.map((t) => t.font)];
  const map = new Map<string, ResolvedFont>();
  for (const ref of refs) {
    if (!ref || map.has(keyOf(ref))) continue;
    map.set(keyOf(ref), await lib.resolve(ref, ref.weight));
  }
  const caption = map.get(keyOf(capStyle.font))!;
  const pick: FontPicker = (ref, fallback) => map.get(keyOf(ref ?? fallback)) ?? map.get(keyOf(fallback)) ?? caption;
  return { caption, pick, all: [...new Set(map.values())] };
}

export interface AssBuild {
  text: string;
  events: number;
  /** Alto reservado por los subtítulos abajo, en unidades del PlayRes. */
  captionsReserve: number;
}

/** Documento ASS completo (determinista: misma receta → mismo texto). */
export function buildAss(recipe: Recipe, spec: OutputSpec, fonts: PreparedFonts, burnCaptions: boolean): AssBuild {
  const doc = new AssDocument(spec.playResX, spec.playResY);
  const caps = recipe.tracks.captions;
  const burn = burnCaptions && caps.enabled && caps.burnIn;
  let events = 0;
  if (burn) events += addCaptionEvents(doc, recipe, spec, fonts.caption);
  const reserve = captionsReserve(recipe, burn);
  events += addTextEvents(doc, recipe, spec, fonts.pick, { captionsReserve: reserve });
  return { text: doc.toString(), events, captionsReserve: reserve };
}

/** Copia las fuentes a `<dir>/fonts` y devuelve el nombre relativo de la carpeta. */
export async function stageAssFonts(fonts: PreparedFonts, dir: string): Promise<string> {
  await stageFonts(fonts.all, path.join(dir, "fonts"));
  return "fonts";
}
