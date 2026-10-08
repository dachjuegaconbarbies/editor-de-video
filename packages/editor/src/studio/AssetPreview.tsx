/**
 * Vista previa simple de un archivo (video, foto o audio) en un modal, con anterior/siguiente.
 * Sin etiquetas ni formularios: el usuario solo mira.
 */
import type { Asset } from "@autoeditor/shared";
import { ChevronLeft, ChevronRight, FileText } from "lucide-react";
import { formatBytes, formatDuration } from "../lib/format.js";
import { useApi } from "../store/context.js";
import { Modal } from "../ui/index.js";

export function AssetPreview({ assets, assetId, onClose, onNavigate }: { assets: Asset[]; assetId: string | null; onClose: () => void; onNavigate: (id: string) => void }) {
  const asset = assetId ? assets.find((a) => a.id === assetId) : undefined;
  return (
    <Modal open={!!asset} onClose={onClose} title={asset?.originalName ?? "Vista previa"} width={820}>
      {asset && <Body asset={asset} assets={assets} onNavigate={onNavigate} />}
    </Modal>
  );
}

function Body({ asset, assets, onNavigate }: { asset: Asset; assets: Asset[]; onNavigate: (id: string) => void }) {
  const api = useApi();
  const src = api.assetFileUrl(asset);
  const idx = assets.findIndex((a) => a.id === asset.id);
  const prev = idx > 0 ? assets[idx - 1] : undefined;
  const next = idx >= 0 && idx < assets.length - 1 ? assets[idx + 1] : undefined;
  const p = asset.probe;
  return (
    <div className="ae-apreview">
      <div className="ae-apreview__stage">
        {asset.kind === "video" && src ? (
          <video key={asset.id} src={src} controls playsInline preload="metadata" poster={api.assetThumbnailUrl(asset) ?? undefined} />
        ) : asset.kind === "imagen" && src ? (
          <img src={src} alt={asset.originalName} />
        ) : asset.kind === "audio" && src ? (
          <audio key={asset.id} src={src} controls preload="metadata" />
        ) : (
          <div className="ae-apreview__none">
            <FileText size={28} aria-hidden />
            <span>Vista previa no disponible</span>
          </div>
        )}
      </div>
      <div className="ae-apreview__bar">
        <span className="ae-apreview__meta">
          {[p.duration != null ? formatDuration(p.duration) : null, p.width && p.height ? `${p.width}×${p.height}` : null, formatBytes(asset.sizeBytes)].filter(Boolean).join(" · ")}
        </span>
        {asset.analysis.description && <span className="ae-apreview__desc">{asset.analysis.description}</span>}
        {assets.length > 1 && (
          <span className="ae-apreview__nav">
            <button type="button" className="ae-iconbtn" aria-label="Anterior" disabled={!prev} onClick={() => prev && onNavigate(prev.id)}>
              <ChevronLeft size={16} aria-hidden />
            </button>
            <span>
              {idx + 1} / {assets.length}
            </span>
            <button type="button" className="ae-iconbtn" aria-label="Siguiente" disabled={!next} onClick={() => next && onNavigate(next.id)}>
              <ChevronRight size={16} aria-hidden />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
