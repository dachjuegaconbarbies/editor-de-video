/**
 * Sondeo mínimo de un archivo para construir el grafo: dimensiones (ya rotadas), audio, códec y alfa.
 * Se prefiere lo que ya trae `asset.probe`; si falta algo, se consulta ffprobe (en caché por ruta).
 */
import { stat } from "node:fs/promises";
import type { Asset } from "@autoeditor/shared";
import { runProcess } from "./ffmpeg.js";

export interface SourceInfo {
  path: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  pixFmt: string | null;
  /** Imagen fija (jpg/png/webp…). */
  isImage: boolean;
  /** HDR (PQ o HLG): requiere mapeo de tonos a SDR. */
  hdr: boolean;
  /** Tiene canal alfa (o podría tenerlo: VP9 con alpha_mode). */
  alpha: boolean;
  /** VP9 con alfa: hay que decodificar con libvpx-vp9 para conservarlo. */
  vp9Alpha: boolean;
  sizeBytes: number;
  mtimeMs: number;
}

const IMAGE_CODECS = new Set(["mjpeg", "png", "webp", "bmp", "tiff", "gif", "jpegls", "jpeg2000"]);

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  color_transfer?: string;
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
  disposition?: { attached_pic?: number };
}

const cache = new Map<string, Promise<SourceInfo>>();

/** ffprobe JSON → SourceInfo. */
export async function probeSource(ffprobe: string, filePath: string): Promise<SourceInfo> {
  const st = await stat(filePath);
  const key = `${filePath}|${st.size}|${st.mtimeMs}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const res = await runProcess(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath], {
        timeoutMs: 60_000,
        keepStdout: true,
      });
      if (res.code !== 0) throw new Error(`ffprobe no pudo leer ${filePath}: ${res.stderr.slice(-300)}`);
      const data = JSON.parse(res.stdout) as { format?: { duration?: string; format_name?: string }; streams?: FfprobeStream[] };
      const streams = data.streams ?? [];
      const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
      const a = streams.find((s) => s.codec_type === "audio");
      const rotation = Math.abs(Number(v?.side_data_list?.find((d) => d.rotation != null)?.rotation ?? v?.tags?.rotate ?? 0)) % 180;
      const swap = rotation === 90;
      const codec = v?.codec_name ?? null;
      const formatName = data.format?.format_name ?? "";
      const isImage = !!codec && IMAGE_CODECS.has(codec) && (/image2|_pipe|png|webp/.test(formatName) || !data.format?.duration);
      const pix = v?.pix_fmt ?? null;
      const vp9Alpha = codec === "vp9" && (v?.tags?.alpha_mode === "1" || v?.tags?.ALPHA_MODE === "1");
      const duration = Number(data.format?.duration);
      return {
        path: filePath,
        duration: Number.isFinite(duration) && !isImage ? duration : null,
        width: v?.width ? (swap ? v.height! : v.width) : null,
        height: v?.height ? ((swap ? v.width : v.height) ?? null) : null,
        hasVideo: !!v,
        hasAudio: !!a,
        videoCodec: codec,
        pixFmt: pix,
        isImage,
        hdr: v?.color_transfer === "smpte2084" || v?.color_transfer === "arib-std-b67",
        alpha: vp9Alpha || (!!pix && /^(yuva|rgba|argb|bgra|abgr|gbrap|ya\d|pal8)/.test(pix)),
        vp9Alpha,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
      } satisfies SourceInfo;
    })();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

/** Usa la información del asset si es suficiente; si no, ffprobe. */
export async function sourceInfoFor(ffprobe: string, asset: Asset | null, filePath: string): Promise<SourceInfo> {
  // ffprobe es la verdad (dimensiones rotadas, alfa, HDR); asset.probe puede venir incompleto.
  const info = await probeSource(ffprobe, filePath);
  if (asset?.kind === "imagen" && !info.isImage) return { ...info, isImage: true, duration: null };
  return info;
}
