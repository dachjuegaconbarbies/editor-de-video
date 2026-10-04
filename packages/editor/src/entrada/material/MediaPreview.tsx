/**
 * Vista previa de un archivo (clic en su miniatura): reproductor de video/audio (GET /assets/:id/file)
 * o imagen, con la tira de fragmentos de B-roll sobre la línea de tiempo y sus datos.
 * ← / → en los botones de arriba pasan al archivo anterior/siguiente de la misma lista.
 */
import type { Asset } from "@autoeditor/shared";
import { ChevronLeft, ChevronRight, Star } from "lucide-react";
import { useRef, useState } from "react";
import { formatBytes, formatDuration } from "../../lib/format.js";
import { useApi } from "../../store/context.js";
import { IconButton, Modal, Segmented } from "../../ui/index.js";
import { useAssetOps } from "../assetOps.js";
import { BrollStrip, hasTimeline } from "../media/BrollStrip.js";
import { ClipPlayer, type ClipPlayerHandle } from "../media/ClipPlayer.js";
import { RolePicker } from "./RolePicker.js";

export function MediaPreview({ assets, assetId, onClose, onNavigate }: { assets: Asset[]; assetId: string | null; onClose: () => void; onNavigate: (id: string) => void }) {
  const asset = assetId ? assets.find((a) => a.id === assetId) : undefined;
  return (
    <Modal open={!!asset} onClose={onClose} title={asset ? asset.originalName : "Vista previa"} width={920}>
      {asset && <PreviewBody asset={asset} assets={assets} onNavigate={onNavigate} />}
    </Modal>
  );
}

function PreviewBody({ asset, assets, onNavigate }: { asset: Asset; assets: Asset[]; onNavigate: (id: string) => void }) {
  const api = useApi();
  const ops = useAssetOps();
  const player = useRef<ClipPlayerHandle>(null);
  const [note, setNote] = useState(asset.note);
  const [noteFor, setNoteFor] = useState(asset.id);
  if (noteFor !== asset.id) {
    setNoteFor(asset.id);
    setNote(asset.note);
  }
  const idx = assets.findIndex((a) => a.id === asset.id);
  const prev = idx > 0 ? assets[idx - 1] : undefined;
  const next = idx >= 0 && idx < assets.length - 1 ? assets[idx + 1] : undefined;
  const p = asset.probe;
  const isImage = asset.kind === "imagen";
  const src = isImage ? (api.assetThumbnailUrl(asset) ?? api.assetFileUrl(asset)) : null;
  const meta = [
    p.duration != null ? formatDuration(p.duration) : null,
    formatBytes(asset.sizeBytes),
    p.width && p.height ? `${p.width}×${p.height}` : null,
    p.fps ? `${Math.round(p.fps)} fps` : null,
    p.videoCodec ? p.videoCodec.toUpperCase() : null,
    p.hasAudio && asset.kind === "video" ? "con audio" : null,
  ].filter(Boolean);
  return (
    <div className="ae-in-preview">
      <div className="ae-in-preview__nav">
        <IconButton label={prev ? `Anterior: ${prev.originalName}` : "Anterior"} icon={<ChevronLeft size={16} />} disabled={!prev} onClick={() => prev && onNavigate(prev.id)} />
        <span className="ae-in-preview__pos">
          {idx + 1} de {assets.length}
        </span>
        <IconButton label={next ? `Siguiente: ${next.originalName}` : "Siguiente"} icon={<ChevronRight size={16} />} disabled={!next} onClick={() => next && onNavigate(next.id)} />
      </div>
      <div className="ae-in-preview__media">
        {isImage ? (
          src ? <img className="ae-in-preview__img" src={src} alt={asset.originalName} /> : null
        ) : (
          <ClipPlayer
            ref={player}
            asset={asset}
            size="lg"
            autoFocus
            below={({ time, duration, seek }) => (hasTimeline(asset) ? <BrollStrip asset={asset} duration={duration} time={time} onSeek={(t) => seek(t, true)} size="md" detailed /> : null)}
          />
        )}
      </div>
      <div className="ae-in-preview__info">
        <div className="ae-in-preview__meta">{meta.join(" · ")}</div>
        {p.variableFrameRate && <div className="ae-help">Framerate variable: se normaliza al renderizar.</div>}
        {asset.analysis.description && <p className="ae-in-preview__desc">{asset.analysis.description}</p>}
        <div className="ae-row ae-row--wrap">
          {asset.kind === "video" && asset.analysis.status === "listo" && <RolePicker asset={asset} onChange={(role) => void ops.setRole(asset, role)} />}
          {asset.category === "crudo-video" && (
            <Segmented
              size="sm"
              label="Prioridad"
              value={asset.priority}
              onChange={(priority) => void ops.setPriority(asset, priority)}
              options={[
                { value: "debe-aparecer", label: <><Star size={12} aria-hidden /> Debe aparecer</> },
                { value: "opcional", label: "Opcional" },
              ]}
            />
          )}
        </div>
        <input
          className="ae-input ae-input--sm"
          placeholder="Nota para Claude (p. ej. “abre con este”)"
          aria-label="Nota para Claude"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => void ops.setNote(asset, note)}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </div>
    </div>
  );
}
