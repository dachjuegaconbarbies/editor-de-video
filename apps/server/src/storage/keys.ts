/**
 * Convenciones de claves del almacenamiento (siempre relativas, nunca rutas absolutas).
 * Todo lo de un dueño vive bajo `<ownerId>/…`, y lo de un proyecto bajo `<ownerId>/<projectId>/…`,
 * así borrar un proyecto o un asset es borrar un prefijo.
 *
 *   <owner>/<project>/assets/<assetId>/<nombre-saneado>     archivo original
 *   <owner>/<project>/assets/<assetId>/thumb.jpg            miniatura
 *   <owner>/<project>/assets/<assetId>/frames/<ms>-<w>.jpg  fotogramas en caché
 *   <owner>/<project>/assets/<assetId>/keyframes/<ms>.jpg   fotogramas clave del análisis
 *   <owner>/<project>/versions/<versionId>/video.mp4        render de la versión
 *   <owner>/<project>/versions/<versionId>/export-<q>.mp4   exportación en otra calidad
 *   <owner>/<project>/versions/<versionId>/poster.jpg       portada
 *   <owner>/<project>/versions/<versionId>/captions.srt|vtt subtítulos sueltos
 *   <owner>/biblioteca/assets/<assetId>/…                   assets sin proyecto (marcas, estilos)
 *   <owner>/styles/<styleId>/…                              assets y plantillas de un estilo
 */
import path from "node:path";

/** Segmento seguro para una clave: letras, números, punto, guion y guion bajo. */
export function safeSegment(raw: string, fallback = "archivo"): string {
  const clean = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[-.]+$/, "");
  return clean.length > 0 && clean !== "." && clean !== ".." ? clean : fallback;
}

/** Nombre de archivo saneado conservando la extensión (en minúsculas), máximo ~120 caracteres. */
export function safeFileName(originalName: string): string {
  const base = path.basename(originalName.replace(/\\/g, "/"));
  const ext = path.extname(base).toLowerCase().replace(/[^a-z0-9.]/g, "").slice(0, 12);
  const stem = safeSegment(base.slice(0, base.length - path.extname(base).length), "archivo").slice(0, 100);
  return `${stem}${ext}`;
}

const projectRoot = (ownerId: string, projectId: string | null) => `${safeSegment(ownerId)}/${projectId ? safeSegment(projectId) : "biblioteca"}`;

export const keys = {
  ownerRoot: (ownerId: string) => safeSegment(ownerId),
  projectRoot,
  assetDir: (ownerId: string, projectId: string | null, assetId: string) => `${projectRoot(ownerId, projectId)}/assets/${safeSegment(assetId)}`,
  assetFile: (ownerId: string, projectId: string | null, assetId: string, originalName: string) =>
    `${projectRoot(ownerId, projectId)}/assets/${safeSegment(assetId)}/${safeFileName(originalName)}`,
  assetThumb: (ownerId: string, projectId: string | null, assetId: string) => `${projectRoot(ownerId, projectId)}/assets/${safeSegment(assetId)}/thumb.jpg`,
  assetFrame: (ownerId: string, projectId: string | null, assetId: string, t: number, width: number) =>
    `${projectRoot(ownerId, projectId)}/assets/${safeSegment(assetId)}/frames/${Math.round(t * 1000)}-${Math.round(width)}.jpg`,
  assetKeyframe: (ownerId: string, projectId: string | null, assetId: string, t: number) =>
    `${projectRoot(ownerId, projectId)}/assets/${safeSegment(assetId)}/keyframes/${Math.round(t * 1000)}.jpg`,
  versionDir: (ownerId: string, projectId: string, versionId: string) => `${projectRoot(ownerId, projectId)}/versions/${safeSegment(versionId)}`,
  versionVideo: (ownerId: string, projectId: string, versionId: string) => `${projectRoot(ownerId, projectId)}/versions/${safeSegment(versionId)}/video.mp4`,
  versionExport: (ownerId: string, projectId: string, versionId: string, quality: string) =>
    `${projectRoot(ownerId, projectId)}/versions/${safeSegment(versionId)}/export-${safeSegment(quality)}.mp4`,
  versionPoster: (ownerId: string, projectId: string, versionId: string) => `${projectRoot(ownerId, projectId)}/versions/${safeSegment(versionId)}/poster.jpg`,
  versionCaptions: (ownerId: string, projectId: string, versionId: string, ext: "srt" | "vtt" | "txt") =>
    `${projectRoot(ownerId, projectId)}/versions/${safeSegment(versionId)}/captions.${ext}`,
  styleDir: (ownerId: string, styleId: string) => `${safeSegment(ownerId)}/styles/${safeSegment(styleId)}`,
};
