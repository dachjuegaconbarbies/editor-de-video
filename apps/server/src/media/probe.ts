/**
 * Inventario de un archivo con ffprobe (JSON) → MediaProbe.
 *
 * - La resolución se devuelve YA corregida por rotación: los videos de iPhone guardan 1920x1080 con
 *   una "display matrix" de ±90° y ffmpeg los autorrota al decodificar (entrega 1080x1920). Todos
 *   los filtros ven el fotograma rotado, así que el tamaño visible es el que importa.
 * - VFR: `r_frame_rate` ≠ `avg_frame_rate` (con 1 % de tolerancia) es la pista barata y suficiente.
 * - Imágenes (jpg/png/webp…): `hasVideo = false`, sin duración ni fps.
 * - Portadas de audio (attached_pic) no cuentan como video.
 */
import type { MediaProbe } from "@autoeditor/shared";
import { UserFacingError } from "../services/types.js";
import { runProcess, stderrSummary } from "./process.js";

export interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  nb_frames?: string;
  disposition?: { attached_pic?: number };
  side_data_list?: { side_data_type?: string; rotation?: number | string }[];
  tags?: Record<string, string>;
}

export interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { format_name?: string; duration?: string; size?: string; tags?: Record<string, string> };
}

const ratio = (s: string | undefined): number => {
  if (!s) return 0;
  const [n, d] = s.split("/").map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || !d) return 0;
  return n! / d!;
};

const IMAGE_CODECS = new Set(["mjpeg", "png", "webp", "bmp", "tiff", "jpeg2000", "jpegls", "heif", "hevc_image", "avif", "pgm", "ppm", "qoi", "jpegxl"]);

/** ¿El contenedor es una imagen fija? */
export function isImageFormat(out: FfprobeOutput): boolean {
  const fmt = out.format?.format_name ?? "";
  if (/(^|,)(image2|.*_pipe)(,|$)/.test(fmt)) return true;
  const v = (out.streams ?? []).find((s) => s.codec_type === "video");
  if (!v) return false;
  // HEIC/AVIF fijos pueden venir como mov/mp4 con un solo fotograma.
  return IMAGE_CODECS.has(v.codec_name ?? "") && (Number(v.nb_frames ?? "0") <= 1 || !Number(out.format?.duration ?? "0"));
}

/** Rotación de la display matrix (o la etiqueta `rotate` de ffmpeg viejos), en grados. */
export function rotationOf(stream: FfprobeStream | undefined): number {
  if (!stream) return 0;
  const sd = stream.side_data_list?.find((d) => d.rotation !== undefined);
  const raw = Number(sd?.rotation ?? stream.tags?.rotate ?? 0);
  if (!Number.isFinite(raw)) return 0;
  // Se redondea al múltiplo de 90 más cercano y se lleva a (-180, 180].
  let r = Math.round(raw / 90) * 90;
  r = ((r % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Convierte la salida de ffprobe en MediaProbe. */
export function parseProbe(out: FfprobeOutput): MediaProbe {
  const streams = out.streams ?? [];
  const image = isImageFormat(out);
  const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === "audio");
  const rotation = rotationOf(v);
  const swap = Math.abs(rotation) % 180 === 90;
  const w = v?.width ?? null;
  const h = v?.height ?? null;
  const rFps = ratio(v?.r_frame_rate);
  const avgFps = ratio(v?.avg_frame_rate);
  const fps = image || !v ? null : avgFps || rFps || null;
  const vfr = !image && !!v && rFps > 0 && avgFps > 0 && Math.abs(rFps - avgFps) / rFps > 0.01;
  let duration: number | null = Number(out.format?.duration ?? v?.duration ?? a?.duration ?? NaN);
  if (!Number.isFinite(duration) || duration <= 0 || image) duration = null;
  return {
    duration: duration === null ? null : round3(duration),
    width: w === null ? null : swap ? h : w,
    height: h === null ? null : swap ? w : h,
    fps: fps === null ? null : round3(fps),
    rotation,
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
    hasAudio: !!a,
    hasVideo: !!v && !image,
    variableFrameRate: vfr,
  };
}

/** Ejecuta ffprobe y devuelve su JSON. */
export async function ffprobeJson(ffprobe: string, filePath: string, signal?: AbortSignal): Promise<FfprobeOutput> {
  const res = await runProcess(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath], {
    label: "ffprobe",
    signal,
    timeoutMs: 60_000,
  });
  if (res.code !== 0) {
    throw new UserFacingError(
      "archivo-ilegible",
      `No se pudo leer el archivo: no parece un video, audio o imagen válido${stderrSummary(res.stderr, 1) ? ` (${stderrSummary(res.stderr, 1)})` : ""}.`,
      422,
    );
  }
  try {
    return JSON.parse(res.stdout) as FfprobeOutput;
  } catch {
    throw new UserFacingError("archivo-ilegible", "ffprobe devolvió una respuesta que no se pudo interpretar.", 422);
  }
}
