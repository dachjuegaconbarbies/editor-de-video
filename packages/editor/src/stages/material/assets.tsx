/**
 * Piezas para mostrar archivos en el lienzo: miniatura con duración, estado y etiqueta A-roll/B-roll.
 * (La lista completa de la vista enfocada vive en entrada/material/AssetCard.tsx.)
 */
import type { Asset } from "@autoeditor/shared";
import clsx from "clsx";
import { AudioLines, FileText, Film, Image as ImageIcon, LoaderCircle, Music, Star, TriangleAlert, Type } from "lucide-react";
import { useState } from "react";
import { formatDuration } from "../../lib/format.js";
import { useApi } from "../../store/context.js";
import type { UploadItem } from "../../store/editorStore.js";
import { ProgressBar } from "../../ui/index.js";

export const ROLE_LABELS: Record<Asset["analysis"]["role"], string> = {
  "a-roll": "A-roll",
  "b-roll": "B-roll",
  mixto: "Mixto",
  desconocido: "",
};

export const ROLE_HELP =
  "A-roll: alguien habla (toma principal). B-roll: toma de apoyo (paisaje, producto, detalle) que Claude usa de fondo o como corte sobre lo que se dice.";

export function kindIcon(asset: Pick<Asset, "kind" | "category">, size = 18) {
  if (asset.category === "musica" || asset.category === "sfx") return <Music size={size} aria-hidden />;
  if (asset.kind === "audio") return <AudioLines size={size} aria-hidden />;
  if (asset.kind === "imagen") return <ImageIcon size={size} aria-hidden />;
  if (asset.kind === "fuente") return <Type size={size} aria-hidden />;
  if (asset.kind === "documento") return <FileText size={size} aria-hidden />;
  return <Film size={size} aria-hidden />;
}

export function RoleTag({ asset, size = "sm" }: { asset: Asset; size?: "sm" | "md" }) {
  const role = asset.analysis.role;
  if (role === "desconocido" || asset.analysis.status !== "listo") return null;
  const segs = asset.analysis.brollSegments.length;
  return (
    <span className={clsx("ae-role", `ae-role--${role}`, `ae-role--${size}`)} title={ROLE_HELP}>
      {ROLE_LABELS[role]}
      {size === "md" && segs > 0 && role !== "a-roll" && <span className="ae-role__count">· {segs} tomas de apoyo</span>}
      {size === "md" && segs > 0 && role === "a-roll" && <span className="ae-role__count">· {segs} con B-roll</span>}
    </span>
  );
}

export function AssetThumb({ asset, size = "md", showMeta = true }: { asset: Asset; size?: "sm" | "md" | "lg"; showMeta?: boolean }) {
  const api = useApi();
  const [broken, setBroken] = useState(false);
  const src = broken ? null : api.assetThumbnailUrl(asset);
  const analyzing = asset.analysis.status === "pendiente" || asset.analysis.status === "analizando";
  const vertical = (asset.probe.height ?? 0) > (asset.probe.width ?? 0);
  return (
    <div className={clsx("ae-thumb", `ae-thumb--${size}`, vertical && "is-vertical", `ae-thumb--${asset.kind}`)} title={asset.originalName}>
      {src ? <img src={src} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} /> : <span className="ae-thumb__icon">{kindIcon(asset, size === "sm" ? 14 : 18)}</span>}
      {showMeta && (
        <>
          {asset.priority === "debe-aparecer" && asset.category === "crudo-video" && (
            <span className="ae-thumb__star" title="Debe aparecer">
              <Star size={10} fill="currentColor" aria-hidden />
            </span>
          )}
          {asset.probe.duration != null && <span className="ae-thumb__dur">{formatDuration(asset.probe.duration)}</span>}
          {analyzing && (
            <span className="ae-thumb__busy" title="Analizando…">
              <LoaderCircle size={12} className="ae-spin" aria-hidden />
            </span>
          )}
          {asset.analysis.status === "error" && (
            <span className="ae-thumb__err" title={asset.analysis.error ?? "No se pudo analizar"}>
              <TriangleAlert size={12} aria-hidden />
            </span>
          )}
          {size !== "sm" && (
            <span className="ae-thumb__role">
              <RoleTag asset={asset} />
            </span>
          )}
        </>
      )}
    </div>
  );
}

export function UploadThumb({ item, size = "md" }: { item: UploadItem; size?: "sm" | "md" }) {
  return (
    <div className={clsx("ae-thumb", `ae-thumb--${size}`, "is-uploading", item.status === "error" && "is-error")} title={item.error ?? item.name}>
      <span className="ae-thumb__icon">{item.status === "error" ? <TriangleAlert size={16} aria-hidden /> : <LoaderCircle size={16} className="ae-spin" aria-hidden />}</span>
      <span className="ae-thumb__progress">
        <ProgressBar value={item.status === "error" ? 1 : item.progress} size="sm" tone={item.status === "error" ? "coral" : "purple"} label={`Subiendo ${item.name}`} />
      </span>
    </div>
  );
}
