import { z } from "zod";

/** Relaciones de aspecto soportadas para el video final. */
export const AspectRatio = z.enum(["9:16", "1:1", "4:5", "16:9"]);
export type AspectRatio = z.infer<typeof AspectRatio>;

/** Plataformas destino: definen zonas seguras y duración sugerida. */
export const Platform = z.enum(["tiktok", "reels", "shorts", "youtube", "linkedin", "generico"]);
export type Platform = z.infer<typeof Platform>;

export const RESOLUTIONS: Record<AspectRatio, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "16:9": { width: 1920, height: 1080 },
};

/** Resoluciones de exportación disponibles (lado corto en píxeles). */
export const ExportQuality = z.enum(["720", "1080", "2160"]);
export type ExportQuality = z.infer<typeof ExportQuality>;

export function resolutionFor(aspect: AspectRatio, quality: ExportQuality = "1080"): { width: number; height: number } {
  const base = RESOLUTIONS[aspect];
  const shortSide = Math.min(base.width, base.height);
  const factor = Number(quality) / shortSide;
  // Siempre pares para códecs yuv420p.
  const even = (n: number) => Math.round(n / 2) * 2;
  return { width: even(base.width * factor), height: even(base.height * factor) };
}

/**
 * Zonas seguras por plataforma, en fracción de la altura/anchura del cuadro.
 * Indican cuánto margen dejar para que la interfaz de la app no tape textos y subtítulos.
 */
export const SAFE_ZONES: Record<Platform, { top: number; bottom: number; left: number; right: number }> = {
  tiktok: { top: 0.1, bottom: 0.22, left: 0.06, right: 0.16 },
  reels: { top: 0.12, bottom: 0.24, left: 0.06, right: 0.12 },
  shorts: { top: 0.1, bottom: 0.2, left: 0.06, right: 0.14 },
  youtube: { top: 0.06, bottom: 0.1, left: 0.05, right: 0.05 },
  linkedin: { top: 0.06, bottom: 0.12, left: 0.05, right: 0.05 },
  generico: { top: 0.06, bottom: 0.1, left: 0.05, right: 0.05 },
};

export const PLATFORM_LABELS: Record<Platform, string> = {
  tiktok: "TikTok",
  reels: "Instagram Reels",
  shorts: "YouTube Shorts",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  generico: "Genérico",
};

export const DEFAULT_ASPECT_FOR_PLATFORM: Record<Platform, AspectRatio> = {
  tiktok: "9:16",
  reels: "9:16",
  shorts: "9:16",
  youtube: "16:9",
  linkedin: "1:1",
  generico: "9:16",
};
