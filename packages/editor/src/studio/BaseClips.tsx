/**
 * ARRIBA, separado: SOLO EL CLIP BASE (el video principal). Zona grande para arrastrar o elegir,
 * miniatura, duración y estado de cada clip; si hay varios, en el orden que sugiere la app
 * (reacomodables arrastrando o con el teclado). El usuario nunca etiqueta nada: abajo se muestra
 * un resumen de lo que Claude detectó dentro de los clips.
 */
import type { Asset } from "@autoeditor/shared";
import clsx from "clsx";
import { ArrowDown, ArrowUp, ChevronDown, CircleAlert, Film, GripVertical, LoaderCircle, Play, RotateCcw, Sparkles, Trash2, Upload, X } from "lucide-react";
import { useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import { useAssetOps } from "../entrada/assetOps.js";
import { useUploader } from "../entrada/uploads.js";
import { useFileDrop } from "../ui/index.js";
import { formatDuration, formatSecondsShort } from "../lib/format.js";
import { useApi, useEditorShallow } from "../store/context.js";
import type { UploadItem } from "../store/editorStore.js";
import { useFilePicker, useStudioUpload } from "./hooks.js";
import { BASE_CATEGORY, clipRoleText, insightsLine, isLongClip, materialInsights, splitMaterial, type MaterialInsights } from "./logic.js";
import { AssetPreview } from "./AssetPreview.js";

const VIDEO_ACCEPT = "video/*,.mov,.mp4,.m4v,.mkv,.webm,.avi,.mts,.3gp";

export function BaseClips() {
  const { assets, uploads, transcripts, projectId } = useEditorShallow((s) => ({ assets: s.assets, uploads: s.uploads, transcripts: s.transcripts, projectId: s.project?.id ?? "" }));
  const { base, extras } = useMemo(() => splitMaterial(assets), [assets]);
  const pending = uploads.filter((u) => u.category === BASE_CATEGORY);
  const upload = useStudioUpload();
  const ops = useAssetOps();
  const [preview, setPreview] = useState<string | null>(null);
  const [userOrdered, setUserOrdered] = useState<string | null>(null);
  const picker = useFilePicker({ accept: VIDEO_ACCEPT, label: "Elegir clip base", onFiles: (f) => void upload(f, "base") });
  const drop = useFileDrop((f) => void upload(f, "base"));
  const insights = useMemo(() => materialInsights(base, extras, transcripts), [base, extras, transcripts]);
  const empty = base.length === 0 && pending.length === 0;

  const reorder = (from: number, to: number) => {
    void ops.reorder(base, from, to);
    setUserOrdered(projectId);
  };

  return (
    <section className={clsx("ae-zone ae-zone--base", drop.over && "is-over", empty && "is-empty")} aria-labelledby="ae-base-title" {...drop.handlers}>
      <header className="ae-zone__head">
        <div>
          <h2 id="ae-base-title" className="ae-zone__title">
            Clip base
          </h2>
          <p className="ae-zone__sub">El video principal. Puede traer de todo: lo que dices, tomas de apoyo y tomas repetidas.</p>
        </div>
        {base.length > 0 && (
          <button type="button" className="ae-textbtn" onClick={() => ops.removeMany(base, base.length === 1 ? `Quitaste “${base[0]!.originalName}”.` : `Vaciaste ${base.length} clips.`)}>
            <Trash2 size={14} aria-hidden /> Vaciar
          </button>
        )}
      </header>
      {picker.input}

      {empty ? (
        <div
          className="ae-drop ae-drop--hero"
          role="button"
          tabIndex={0}
          aria-label="Arrastra aquí tu clip base o toca para elegirlo"
          onClick={picker.open}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              picker.open();
            }
          }}
        >
          <span className="ae-drop__icon" aria-hidden>
            <Film size={26} />
          </span>
          <span className="ae-drop__title">Arrastra aquí tu clip base</span>
          <span className="ae-drop__text">el video principal · o toca para elegirlo</span>
          <span className="ae-drop__hint">Uno o varios clips. Claude los ordena y quita lo que sobra.</span>
        </div>
      ) : (
        <>
          {base.length > 1 && (
            <p className="ae-order-note" role="note">
              <Sparkles size={13} aria-hidden />
              {insights.analyzing > 0 ? "Claude los está revisando para ordenarlos…" : userOrdered === projectId ? "Tu orden: Claude lo respeta." : "Ordenados según lo que dices."}
              <span className="ae-order-note__hint">Arrastra para cambiar el orden.</span>
            </p>
          )}
          <ol className={clsx("ae-clips", base.length === 1 && pending.length === 0 && "ae-clips--single")}>
            {base.map((a, i) => (
              <ClipRow key={a.id} asset={a} index={i} total={base.length} onPreview={() => setPreview(a.id)} onRemove={() => ops.remove(a)} onMove={reorder} />
            ))}
            {pending.map((u) => (
              <UploadRow key={u.id} item={u} />
            ))}
          </ol>
          <button type="button" className="ae-addmore" onClick={picker.open}>
            <Upload size={15} aria-hidden /> Agregar otro clip
            <span className="ae-addmore__hint">o arrástralo aquí</span>
          </button>
          {base.some(isLongClip) && (
            <p className="ae-longnote" role="note">
              <b>Clip largo:</b> Claude quitará tomas repetidas, silencios y tiempos muertos.
            </p>
          )}
          {base.length > 0 && <Insights insights={insights} />}
        </>
      )}
      {drop.over && (
        <div className="ae-zone__overlay" aria-hidden>
          Suelta para agregar al clip base
        </div>
      )}
      <AssetPreview assets={base} assetId={preview} onClose={() => setPreview(null)} onNavigate={setPreview} />
    </section>
  );
}

function StatusPill({ asset }: { asset: Asset }) {
  const st = asset.analysis.status;
  if (st === "listo") return <span className="ae-pill ae-pill--ok">Listo</span>;
  if (st === "error")
    return (
      <span className="ae-pill ae-pill--err" title={asset.analysis.error ?? undefined}>
        <CircleAlert size={12} aria-hidden /> Error
      </span>
    );
  return (
    <span className="ae-pill ae-pill--busy">
      <LoaderCircle size={12} className="ae-spin" aria-hidden /> Analizando
    </span>
  );
}

function Thumb({ asset, onClick, large }: { asset: Asset; onClick: () => void; large?: boolean }) {
  const api = useApi();
  const src = api.assetThumbnailUrl(asset);
  const [broken, setBroken] = useState(false);
  const w = asset.probe.width ?? 16;
  const h = asset.probe.height ?? 9;
  const portrait = h > w;
  return (
    <button type="button" className={clsx("ae-thumb", portrait && "is-portrait", large && "is-large")} onClick={onClick} aria-label={`Ver ${asset.originalName}`}>
      {src && !broken ? <img src={src} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} /> : <Film size={22} aria-hidden />}
      <span className="ae-thumb__play" aria-hidden>
        <Play size={14} fill="currentColor" />
      </span>
      {asset.probe.duration != null && <span className="ae-thumb__dur">{formatDuration(asset.probe.duration)}</span>}
    </button>
  );
}

function ClipRow({ asset, index, total, onPreview, onRemove, onMove }: { asset: Asset; index: number; total: number; onPreview: () => void; onRemove: () => void; onMove: (from: number, to: number) => void }) {
  const [dragOver, setDragOver] = useState(false);
  const single = total === 1;
  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData("application/x-ae-clip", String(index));
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes("application/x-ae-clip")) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };
  const onDrop = (e: DragEvent) => {
    const raw = e.dataTransfer.getData("application/x-ae-clip");
    setDragOver(false);
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    onMove(Number(raw), index);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!e.altKey) return;
    if (e.key === "ArrowUp" && index > 0) {
      e.preventDefault();
      onMove(index, index - 1);
    } else if (e.key === "ArrowDown" && index < total - 1) {
      e.preventDefault();
      onMove(index, index + 1);
    }
  };
  const long = isLongClip(asset);
  return (
    <li
      className={clsx("ae-clip", dragOver && "is-dragover", single && "is-single")}
      draggable={!single}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      onKeyDown={onKey}
    >
      {!single && (
        <span className="ae-clip__grip" aria-hidden title="Arrastra para reordenar">
          <GripVertical size={16} />
          <span className="ae-clip__num">{index + 1}</span>
        </span>
      )}
      <Thumb asset={asset} onClick={onPreview} large={single} />
      <div className="ae-clip__body">
        <div className="ae-clip__name" title={asset.originalName}>
          {asset.originalName}
        </div>
        <div className="ae-clip__meta">
          <span>{formatDuration(asset.probe.duration)}</span>
          <StatusPill asset={asset} />
          {long && <span className="ae-pill ae-pill--warn">Clip largo</span>}
        </div>
        {asset.analysis.status === "listo" && asset.analysis.description && <div className="ae-clip__desc">{asset.analysis.description}</div>}
        {asset.analysis.status === "error" && <div className="ae-clip__err">{asset.analysis.error ?? "No se pudo analizar este clip. Quítalo y vuelve a subirlo."}</div>}
      </div>
      <div className="ae-clip__actions">
        {!single && (
          <>
            <button type="button" className="ae-iconbtn" aria-label={`Subir ${asset.originalName}`} title="Subir (Alt+↑)" disabled={index === 0} onClick={() => onMove(index, index - 1)}>
              <ArrowUp size={15} aria-hidden />
            </button>
            <button type="button" className="ae-iconbtn" aria-label={`Bajar ${asset.originalName}`} title="Bajar (Alt+↓)" disabled={index === total - 1} onClick={() => onMove(index, index + 1)}>
              <ArrowDown size={15} aria-hidden />
            </button>
          </>
        )}
        <button type="button" className="ae-iconbtn ae-iconbtn--danger" aria-label={`Quitar ${asset.originalName}`} title="Quitar" onClick={onRemove}>
          <X size={16} aria-hidden />
        </button>
      </div>
    </li>
  );
}

export function UploadRow({ item, compact }: { item: UploadItem; compact?: boolean }) {
  const uploader = useUploader();
  const pct = Math.round(item.progress * 100);
  const failed = item.status === "error";
  return (
    <li className={clsx("ae-clip ae-clip--upload", failed && "is-error", compact && "is-compact")}>
      <span className="ae-thumb ae-thumb--ghost" aria-hidden>
        {failed ? <CircleAlert size={18} /> : <LoaderCircle size={18} className="ae-spin" />}
      </span>
      <div className="ae-clip__body">
        <div className="ae-clip__name" title={item.name}>
          {item.name}
        </div>
        {failed ? (
          <div className="ae-clip__err">{item.error ?? "No se pudo subir."}</div>
        ) : (
          <div className="ae-upbar" role="progressbar" aria-label={`Subiendo ${item.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span className="ae-upbar__fill" style={{ width: `${pct}%` }} />
            <span className="ae-upbar__text">Subiendo {pct}%</span>
          </div>
        )}
      </div>
      <div className="ae-clip__actions">
        {failed && uploader.canRetry(item.id) && (
          <button type="button" className="ae-iconbtn" aria-label={`Reintentar ${item.name}`} title="Reintentar" onClick={() => void uploader.retry(item.id)}>
            <RotateCcw size={15} aria-hidden />
          </button>
        )}
        <button type="button" className="ae-iconbtn" aria-label={failed ? `Descartar ${item.name}` : `Cancelar ${item.name}`} title={failed ? "Descartar" : "Cancelar"} onClick={() => (failed ? uploader.dismiss(item.id) : uploader.cancel(item.id))}>
          <X size={15} aria-hidden />
        </button>
      </div>
    </li>
  );
}

function Insights({ insights }: { insights: MaterialInsights }) {
  const [open, setOpen] = useState(false);
  if (!insights.ready) {
    return (
      <div className="ae-insights is-busy" role="status" aria-live="polite">
        <LoaderCircle size={14} className="ae-spin" aria-hidden />
        <span>Claude está revisando tu material: qué partes hablas, tomas de apoyo y tomas repetidas…</span>
      </div>
    );
  }
  return (
    <div className="ae-insights" aria-live="polite">
      <div className="ae-insights__row">
        <span className="ae-insights__label">
          <Sparkles size={14} aria-hidden /> Claude detectó
        </span>
        <span className="ae-insights__line">{insightsLine(insights)}</span>
        <button type="button" className="ae-textbtn ae-textbtn--sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Ocultar" : "Ver detalle"} <ChevronDown size={13} className={clsx("ae-chev", open && "is-open")} aria-hidden />
        </button>
      </div>
      {insights.analyzing > 0 && <div className="ae-insights__more">Sigue revisando {insights.analyzing === 1 ? "1 clip" : `${insights.analyzing} clips`}…</div>}
      {open && (
        <ul className="ae-insights__list">
          {insights.items.map((i) => (
            <li key={i.assetId}>
              <div className="ae-insights__name">{i.name}</div>
              {i.status !== "listo" ? (
                <div className="ae-insights__detail">{i.status === "error" ? "No se pudo analizar." : "Analizando…"}</div>
              ) : (
                <ul className="ae-insights__facts">
                  <li>{clipRoleText(i)}</li>
                  {i.support.map((s, k) => (
                    <li key={k}>
                      Toma de apoyo {formatDuration(s.start)}–{formatDuration(s.end)}
                      {s.description ? `: ${s.description}` : ""}
                    </li>
                  ))}
                  {i.repeated.map((r, k) => (
                    <li key={`r${k}`}>
                      Repites “{r.phrase.length > 60 ? `${r.phrase.slice(0, 59)}…` : r.phrase}” {r.count} veces: se queda la última.
                    </li>
                  ))}
                  {i.pauseSeconds >= 2 && <li>{formatSecondsShort(Math.round(i.pauseSeconds))} de pausas y silencios que se pueden quitar</li>}
                </ul>
              )}
            </li>
          ))}
          {insights.extraSupport > 0 && (
            <li>
              <div className="ae-insights__name">Lo demás</div>
              <div className="ae-insights__detail">{insights.extraSupport === 1 ? "1 toma de apoyo" : `${insights.extraSupport} tomas de apoyo`} en tus otros clips.</div>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
