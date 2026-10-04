/**
 * Lista de archivos de MATERIAL (vista enfocada): cada archivo con miniatura (clic = vista previa),
 * duración, peso, resolución, estado del análisis (con reintentar), etiqueta A-ROLL / B-ROLL / MIXTO
 * corregible, tira de B-roll, nota, prioridad, orden (arrastrar o ↑/↓) y borrar con deshacer.
 * Las subidas en curso muestran su progreso real con cancelar y, si fallan, reintentar.
 */
import type { Asset } from "@autoeditor/shared";
import clsx from "clsx";
import { CircleAlert, CircleCheck, GripVertical, LoaderCircle, Play, RefreshCw, Replace, Star, Trash2, TriangleAlert, X } from "lucide-react";
import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { formatBytes, formatDuration } from "../../lib/format.js";
import { useApi } from "../../store/context.js";
import type { UploadItem } from "../../store/editorStore.js";
import { kindIcon } from "../../stages/material/assets.js";
import { Button, IconButton, ProgressBar, Segmented } from "../../ui/index.js";
import { useAssetOps } from "../assetOps.js";
import { BrollStrip, hasTimeline } from "../media/BrollStrip.js";
import { useUploader } from "../uploads.js";
import { RolePicker } from "./RolePicker.js";

const DND_TYPE = "application/x-ae-asset";

export function AssetList({ assets, uploads, onPreview, empty }: { assets: Asset[]; uploads: UploadItem[]; onPreview: (id: string) => void; empty?: ReactNode }) {
  const ops = useAssetOps();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  if (!assets.length && !uploads.length) return <>{empty ?? null}</>;

  const onDrop = (e: DragEvent, to: number) => {
    const id = e.dataTransfer.getData(DND_TYPE) || dragId;
    setOverIdx(null);
    setDragId(null);
    if (!id) return;
    e.preventDefault();
    const from = assets.findIndex((a) => a.id === id);
    if (from === -1) return;
    // Solo dentro de la misma categoría (el orden es por zona).
    const target = assets[Math.min(to, assets.length - 1)];
    if (!target || target.category !== assets[from]!.category) return;
    const same = assets.filter((a) => a.category === target.category);
    void ops.reorder(same, same.findIndex((a) => a.id === id), same.findIndex((a) => a.id === target.id));
  };

  return (
    <div className="ae-in-files" role="list">
      {uploads.map((u) => (
        <UploadCard key={u.id} item={u} />
      ))}
      {assets.map((a, i) => {
        const same = assets.filter((x) => x.category === a.category);
        const pos = same.findIndex((x) => x.id === a.id);
        return (
          <AssetCard
            key={a.id}
            asset={a}
            onPreview={() => onPreview(a.id)}
            canMoveUp={pos > 0}
            canMoveDown={pos < same.length - 1}
            onMove={(dir) => void ops.reorder(same, pos, pos + dir)}
            dragging={dragId === a.id}
            dropTarget={overIdx === i && dragId !== a.id && assets.find((x) => x.id === dragId)?.category === a.category}
            dnd={{
              onDragStart: (e) => {
                e.dataTransfer.setData(DND_TYPE, a.id);
                e.dataTransfer.effectAllowed = "move";
                setDragId(a.id);
              },
              onDragEnd: () => {
                setDragId(null);
                setOverIdx(null);
              },
              onDragOver: (e) => {
                if (!e.dataTransfer.types.includes(DND_TYPE)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (overIdx !== i) setOverIdx(i);
              },
              onDrop: (e) => onDrop(e, i),
            }}
          />
        );
      })}
    </div>
  );
}

interface DndHandlers {
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}

function AnalysisStatus({ asset }: { asset: Asset }) {
  const ops = useAssetOps();
  const uploader = useUploader();
  const input = useRef<HTMLInputElement>(null);
  const st = asset.analysis.status;
  if (st === "listo") {
    return (
      <span className="ae-in-status is-ok">
        <CircleCheck size={13} aria-hidden /> Analizado
      </span>
    );
  }
  if (st === "pendiente" || st === "analizando") {
    return (
      <span className="ae-in-status is-busy" role="status">
        <LoaderCircle size={13} className="ae-spin" aria-hidden /> {st === "pendiente" ? "En cola para analizar" : "Analizando…"}
      </span>
    );
  }
  const replace = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const [fresh] = await uploader.upload([file], { category: asset.category, priority: asset.priority, note: asset.note });
    if (fresh) ops.remove(asset);
  };
  return (
    <span className="ae-in-status is-error">
      <CircleAlert size={13} aria-hidden />
      <span className="ae-in-status__text" title={asset.analysis.error ?? undefined}>
        {asset.analysis.error ?? "No se pudo analizar."}
      </span>
      <Button
        size="sm"
        tone="ghost"
        icon={<RefreshCw size={13} />}
        onClick={async () => {
          const ok = await ops.retryAnalysis(asset);
          if (!ok) input.current?.click();
        }}
      >
        Reintentar
      </Button>
      <Button size="sm" tone="plain" icon={<Replace size={13} />} onClick={() => input.current?.click()}>
        Reemplazar
      </Button>
      <input ref={input} type="file" hidden onChange={(e) => void replace(e.target.files).finally(() => (e.target.value = ""))} />
    </span>
  );
}

export function AssetCard({
  asset,
  onPreview,
  canMoveUp,
  canMoveDown,
  onMove,
  dragging,
  dropTarget,
  dnd,
}: {
  asset: Asset;
  onPreview: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (dir: -1 | 1) => void;
  dragging?: boolean;
  dropTarget?: boolean;
  dnd?: DndHandlers;
}) {
  const api = useApi();
  const ops = useAssetOps();
  const [note, setNote] = useState(asset.note);
  const [broken, setBroken] = useState(false);
  const [draggable, setDraggable] = useState(false);
  const thumb = broken ? null : api.assetThumbnailUrl(asset);
  const p = asset.probe;
  const res = p.width && p.height ? `${p.width}×${p.height}` : null;
  const vertical = (p.height ?? 0) > (p.width ?? 0);
  const isRawVideo = asset.category === "crudo-video";
  const canPlay = asset.kind === "video" || asset.kind === "audio" || asset.kind === "imagen";

  const onHandleKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowUp" && canMoveUp) {
      e.preventDefault();
      onMove(-1);
    } else if (e.key === "ArrowDown" && canMoveDown) {
      e.preventDefault();
      onMove(1);
    }
  };

  return (
    <div
      role="listitem"
      className={clsx("ae-in-file", dragging && "is-dragging", dropTarget && "is-droptarget", asset.analysis.status === "error" && "is-error")}
      draggable={draggable}
      onDragStart={dnd?.onDragStart}
      onDragEnd={() => {
        setDraggable(false);
        dnd?.onDragEnd();
      }}
      onDragOver={dnd?.onDragOver}
      onDrop={dnd?.onDrop}
    >
      <button
        type="button"
        className="ae-in-file__grip"
        aria-label={`Mover ${asset.originalName} (flechas arriba/abajo)`}
        title="Arrastra para reordenar (o usa ↑ ↓)"
        onMouseDown={() => setDraggable(true)}
        onMouseUp={() => setDraggable(false)}
        onKeyDown={onHandleKey}
        disabled={!canMoveUp && !canMoveDown}
      >
        <GripVertical size={14} aria-hidden />
      </button>
      <button type="button" className={clsx("ae-in-file__thumb", vertical && "is-vertical")} onClick={onPreview} aria-label={`Ver ${asset.originalName}`} disabled={!canPlay}>
        {thumb ? <img src={thumb} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} /> : <span className="ae-in-file__icon">{kindIcon(asset, 20)}</span>}
        {canPlay && asset.kind !== "imagen" && (
          <span className="ae-in-file__play" aria-hidden>
            <Play size={14} fill="currentColor" />
          </span>
        )}
        {p.duration != null && <span className="ae-in-file__dur">{formatDuration(p.duration)}</span>}
        {isRawVideo && asset.priority === "debe-aparecer" && (
          <span className="ae-in-file__star" title="Debe aparecer">
            <Star size={10} fill="currentColor" aria-hidden />
          </span>
        )}
      </button>
      <div className="ae-in-file__main">
        <div className="ae-in-file__top">
          <span className="ae-in-file__name" title={asset.originalName}>
            {asset.originalName}
          </span>
          <span className="ae-in-file__meta">
            {p.duration != null && <span>{formatDuration(p.duration)}</span>}
            <span>{formatBytes(asset.sizeBytes)}</span>
            {res && <span>{res}</span>}
            {p.fps ? <span>{Math.round(p.fps)} fps</span> : null}
          </span>
        </div>
        <div className="ae-in-file__tags">
          <AnalysisStatus asset={asset} />
          {asset.kind === "video" && asset.analysis.status === "listo" && <RolePicker asset={asset} size="sm" onChange={(role) => void ops.setRole(asset, role)} />}
          {asset.analysis.description && asset.analysis.status === "listo" && <span className="ae-in-file__desc">{asset.analysis.description}</span>}
        </div>
        {hasTimeline(asset) && (asset.analysis.brollSegments.length > 0 || asset.analysis.role === "b-roll") && <BrollStrip asset={asset} onSeek={() => onPreview()} />}
        <input
          className="ae-input ae-input--sm ae-in-file__note"
          placeholder="Nota para Claude (p. ej. “abre con este”)"
          value={note}
          aria-label={`Nota para ${asset.originalName}`}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => void ops.setNote(asset, note)}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </div>
      <div className="ae-in-file__side">
        {isRawVideo && (
          <Segmented
            size="sm"
            label={`Prioridad de ${asset.originalName}`}
            value={asset.priority}
            onChange={(priority) => void ops.setPriority(asset, priority)}
            options={[
              { value: "debe-aparecer", label: "Debe aparecer", title: "Claude lo incluye sí o sí." },
              { value: "opcional", label: "Opcional", title: "Claude decide si lo usa." },
            ]}
          />
        )}
        <IconButton className="ae-in-file__del" label={`Quitar ${asset.originalName}`} icon={<Trash2 size={15} />} onClick={() => ops.remove(asset)} />
      </div>
    </div>
  );
}

export function UploadCard({ item }: { item: UploadItem }) {
  const uploader = useUploader();
  const failed = item.status === "error";
  const pct = Math.round(item.progress * 100);
  return (
    <div role="listitem" className={clsx("ae-in-file", "is-uploading", failed && "is-error")}>
      <span className="ae-in-file__grip" aria-hidden />
      <span className={clsx("ae-in-file__thumb", "is-uploading")}>
        <span className="ae-in-file__icon">{failed ? <TriangleAlert size={18} aria-hidden /> : <LoaderCircle size={18} className="ae-spin" aria-hidden />}</span>
      </span>
      <div className="ae-in-file__main">
        <div className="ae-in-file__top">
          <span className="ae-in-file__name">{item.name}</span>
          <span className="ae-in-file__meta">
            <span>{formatBytes(item.size)}</span>
          </span>
        </div>
        <div className="ae-in-file__tags">
          <span className={clsx("ae-in-status", failed ? "is-error" : "is-busy")} role="status">
            {failed ? <CircleAlert size={13} aria-hidden /> : null}
            {failed ? (item.error ?? "No se pudo subir.") : `Subiendo… ${pct} % · ${formatBytes(item.size * item.progress)} de ${formatBytes(item.size)}`}
          </span>
        </div>
        <ProgressBar value={failed ? 1 : item.progress} tone={failed ? "coral" : "purple"} label={`Progreso de ${item.name}`} />
      </div>
      <div className="ae-in-file__side ae-in-file__side--row">
        {failed ? (
          <>
            {uploader.canRetry(item.id) && (
              <Button size="sm" tone="ghost" icon={<RefreshCw size={13} />} onClick={() => void uploader.retry(item.id)}>
                Reintentar
              </Button>
            )}
            <IconButton label="Descartar" icon={<X size={15} />} onClick={() => uploader.dismiss(item.id)} />
          </>
        ) : (
          <Button size="sm" tone="plain" icon={<X size={13} />} onClick={() => uploader.cancel(item.id)} aria-label={`Cancelar la subida de ${item.name}`}>
            Cancelar
          </Button>
        )}
      </div>
    </div>
  );
}
