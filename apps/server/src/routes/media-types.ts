/** Detección de tipo de archivo por mime y extensión (lo que sale de un celular o una cámara). */
import path from "node:path";
import type { AssetCategory, MediaKind } from "@autoeditor/shared";

const EXT: Record<string, { kind: MediaKind; mime: string }> = {
  // Video
  ".mp4": { kind: "video", mime: "video/mp4" },
  ".m4v": { kind: "video", mime: "video/x-m4v" },
  ".mov": { kind: "video", mime: "video/quicktime" },
  ".qt": { kind: "video", mime: "video/quicktime" },
  ".mkv": { kind: "video", mime: "video/x-matroska" },
  ".webm": { kind: "video", mime: "video/webm" },
  ".avi": { kind: "video", mime: "video/x-msvideo" },
  ".3gp": { kind: "video", mime: "video/3gpp" },
  ".3g2": { kind: "video", mime: "video/3gpp2" },
  ".mts": { kind: "video", mime: "video/mp2t" },
  ".m2ts": { kind: "video", mime: "video/mp2t" },
  ".ts": { kind: "video", mime: "video/mp2t" },
  ".mpg": { kind: "video", mime: "video/mpeg" },
  ".mpeg": { kind: "video", mime: "video/mpeg" },
  ".wmv": { kind: "video", mime: "video/x-ms-wmv" },
  ".flv": { kind: "video", mime: "video/x-flv" },
  ".hevc": { kind: "video", mime: "video/hevc" },
  // Imagen
  ".jpg": { kind: "imagen", mime: "image/jpeg" },
  ".jpeg": { kind: "imagen", mime: "image/jpeg" },
  ".png": { kind: "imagen", mime: "image/png" },
  ".webp": { kind: "imagen", mime: "image/webp" },
  ".gif": { kind: "imagen", mime: "image/gif" },
  ".heic": { kind: "imagen", mime: "image/heic" },
  ".heif": { kind: "imagen", mime: "image/heif" },
  ".avif": { kind: "imagen", mime: "image/avif" },
  ".bmp": { kind: "imagen", mime: "image/bmp" },
  ".tif": { kind: "imagen", mime: "image/tiff" },
  ".tiff": { kind: "imagen", mime: "image/tiff" },
  ".svg": { kind: "imagen", mime: "image/svg+xml" },
  // Audio
  ".mp3": { kind: "audio", mime: "audio/mpeg" },
  ".wav": { kind: "audio", mime: "audio/wav" },
  ".m4a": { kind: "audio", mime: "audio/mp4" },
  ".aac": { kind: "audio", mime: "audio/aac" },
  ".ogg": { kind: "audio", mime: "audio/ogg" },
  ".oga": { kind: "audio", mime: "audio/ogg" },
  ".opus": { kind: "audio", mime: "audio/opus" },
  ".flac": { kind: "audio", mime: "audio/flac" },
  ".aif": { kind: "audio", mime: "audio/aiff" },
  ".aiff": { kind: "audio", mime: "audio/aiff" },
  ".amr": { kind: "audio", mime: "audio/amr" },
  ".wma": { kind: "audio", mime: "audio/x-ms-wma" },
  // Fuentes
  ".ttf": { kind: "fuente", mime: "font/ttf" },
  ".otf": { kind: "fuente", mime: "font/otf" },
  ".woff": { kind: "fuente", mime: "font/woff" },
  ".woff2": { kind: "fuente", mime: "font/woff2" },
  // Documentos (guiones)
  ".pdf": { kind: "documento", mime: "application/pdf" },
  ".docx": { kind: "documento", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  ".doc": { kind: "documento", mime: "application/msword" },
  ".txt": { kind: "documento", mime: "text/plain; charset=utf-8" },
  ".md": { kind: "documento", mime: "text/markdown; charset=utf-8" },
  ".rtf": { kind: "documento", mime: "application/rtf" },
  ".srt": { kind: "documento", mime: "application/x-subrip" },
  ".vtt": { kind: "documento", mime: "text/vtt" },
  ".zip": { kind: "otro", mime: "application/zip" },
  ".json": { kind: "otro", mime: "application/json" },
};

/** Tipo de medio y mime confiable a partir del nombre y del mime que mandó el navegador. */
export function detectMedia(filename: string, browserMime: string | undefined): { kind: MediaKind; mimeType: string } {
  const ext = path.extname(filename).toLowerCase();
  const byExt = EXT[ext];
  const mime = (browserMime ?? "").toLowerCase().split(";")[0]!.trim();
  const generic = mime === "" || mime === "application/octet-stream" || mime === "binary/octet-stream";
  if (!generic) {
    let kind: MediaKind | null = null;
    if (mime.startsWith("video/")) kind = "video";
    else if (mime.startsWith("image/")) kind = "imagen";
    else if (mime.startsWith("audio/")) kind = "audio";
    else if (mime.startsWith("font/") || mime.includes("font")) kind = "fuente";
    else if (mime === "application/pdf" || mime.startsWith("text/") || mime.includes("word")) kind = "documento";
    // Algunos navegadores mandan audio/mp4 para .m4a o video/mp2t para .ts: la extensión manda si es más específica.
    if (byExt && (kind === null || (byExt.kind !== kind && byExt.kind !== "otro"))) return { kind: byExt.kind, mimeType: byExt.mime };
    if (kind) return { kind, mimeType: mime };
  }
  if (byExt) return { kind: byExt.kind, mimeType: byExt.mime };
  return { kind: "otro", mimeType: generic ? "application/octet-stream" : mime };
}

/** Categoría por defecto si el cliente no la mandó. */
export function defaultCategory(kind: MediaKind): AssetCategory {
  switch (kind) {
    case "video":
      return "crudo-video";
    case "imagen":
      return "crudo-foto";
    case "audio":
      return "musica";
    case "fuente":
      return "fuente";
    case "documento":
      return "guion";
    default:
      return "otro";
  }
}

/** Content-Type para servir un archivo por su extensión. */
export function mimeForKey(key: string, fallback = "application/octet-stream"): string {
  return EXT[path.extname(key).toLowerCase()]?.mime ?? fallback;
}
