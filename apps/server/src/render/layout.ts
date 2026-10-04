/**
 * Geometría del cuadro de salida: resolución por calidad, espacio de diseño ASS y zonas seguras.
 *
 * Convención de tamaños: `CaptionStyle.fontSize` y `TextItem.fontSize` están "en px relativos a un
 * cuadro de 1080 px". Se interpreta como 1080 px en el LADO CORTO (que es el ancho en 9:16, 1:1 y
 * 4:5, y el alto en 16:9). Así un subtítulo de 72 mide lo mismo, en proporción, en todos los
 * formatos verticales y no se vuelve gigantesco en horizontal. El ASS usa un PlayRes con el lado
 * corto = 1080 y libass lo escala a la resolución real (720/1080/2160).
 */
import { RESOLUTIONS, SAFE_ZONES, resolutionFor, type ExportQuality, type Recipe } from "@autoeditor/shared";

export interface OutputSpec {
  width: number;
  height: number;
  fps: number;
  /** fps como argumento de ffmpeg (racional si hace falta: 30000/1001). */
  fpsArg: string;
  /** Espacio de diseño ASS (lado corto = 1080). */
  playResX: number;
  playResY: number;
  safe: { top: number; bottom: number; left: number; right: number };
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** fps → argumento de ffmpeg (29.97 → 30000/1001). */
export function fpsArgument(fps: number): string {
  for (const base of [24, 30, 60, 120]) {
    if (Math.abs(fps - (base * 1000) / 1001) < 0.005) return `${base * 1000}/1001`;
  }
  return Number.isInteger(fps) ? String(fps) : String(Math.round(fps * 1000) / 1000);
}

export function outputSpec(recipe: Recipe, quality: ExportQuality): OutputSpec {
  const { aspect, width, height, fps, platform } = recipe.format;
  const std = RESOLUTIONS[aspect];
  let size: { width: number; height: number };
  if (std && width * std.height === height * std.width) {
    size = resolutionFor(aspect, quality);
  } else {
    // Formato a medida: misma proporción, lado corto = calidad.
    const f = Number(quality) / Math.min(width, height);
    size = { width: even(width * f), height: even(height * f) };
  }
  const short = Math.min(size.width, size.height);
  return {
    ...size,
    fps,
    fpsArg: fpsArgument(fps),
    playResX: Math.round((size.width * 1080) / short),
    playResY: Math.round((size.height * 1080) / short),
    safe: SAFE_ZONES[platform] ?? SAFE_ZONES.generico,
  };
}

/** Caja disponible para texto (en unidades del PlayRes), respetando zonas seguras. */
export function safeBox(spec: OutputSpec): { left: number; right: number; top: number; bottom: number; width: number; height: number } {
  const { playResX: W, playResY: H, safe } = spec;
  const left = W * safe.left;
  const right = W * (1 - safe.right);
  const top = H * safe.top;
  const bottom = H * (1 - safe.bottom);
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

/** Ancho máximo de una línea centrada que no invade ninguna zona lateral. */
export function centeredLineWidth(spec: OutputSpec): number {
  const m = Math.max(spec.safe.left, spec.safe.right);
  return spec.playResX * (1 - 2 * m);
}
