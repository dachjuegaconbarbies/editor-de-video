/**
 * ABAJO, todo lo demás junto: otros clips y tomas de apoyo, fotos, música, logos, imágenes,
 * efectos, guion y referencias visuales (imágenes o links con "qué me gusta de esto").
 * La categoría sale sola del tipo de archivo; solo se muestran chips pequeños por tipo.
 */
import { ReferenceLink, type Asset } from "@autoeditor/shared";
import clsx from "clsx";
import { AudioLines, FileText, Film, ImageIcon, Link2, Music, Plus, Trash2, Type, X } from "lucide-react";
import { nanoid } from "nanoid";
import { useMemo, useState } from "react";
import { useAssetOps } from "../entrada/assetOps.js";
import { useActions, useApi, useEditorShallow } from "../store/context.js";
import { Button, useFileDrop } from "../ui/index.js";
import { AssetPreview } from "./AssetPreview.js";
import { UploadRow } from "./BaseClips.js";
import { useFilePicker, useStudioUpload } from "./hooks.js";
import { BASE_CATEGORY, extraChip, splitMaterial } from "./logic.js";

const ANY_ACCEPT = "video/*,image/*,audio/*,.mov,.mp4,.m4v,.mkv,.webm,.mp3,.wav,.m4a,.aac,.ogg,.flac,.png,.jpg,.jpeg,.webp,.heic,.gif,.svg,.ttf,.otf,.woff,.woff2,.pdf,.txt,.md,.doc,.docx";

export function Extras() {
  const { assets, uploads, links } = useEditorShallow((s) => ({ assets: s.assets, uploads: s.uploads, links: s.settings.context.references.links }));
  const { extras } = useMemo(() => splitMaterial(assets), [assets]);
  const pending = uploads.filter((u) => u.category !== BASE_CATEGORY);
  const upload = useStudioUpload();
  const ops = useAssetOps();
  const { updateSettings } = useActions();
  const [preview, setPreview] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const picker = useFilePicker({ accept: ANY_ACCEPT, label: "Elegir otros archivos", onFiles: (f) => void upload(f, "extras") });
  const refPicker = useFilePicker({ accept: "image/*", label: "Elegir imagen de referencia", onFiles: (f) => void upload(f, "extras", "referencia") });
  const drop = useFileDrop((f) => void upload(f, "extras"));
  const realLinks = links.filter((l) => l.url);
  const empty = extras.length === 0 && pending.length === 0 && realLinks.length === 0;

  const clearAll = () => {
    if (extras.length) ops.removeMany(extras, extras.length === 1 ? `Quitaste “${extras[0]!.originalName}”.` : `Vaciaste ${extras.length} archivos.`);
    if (realLinks.length)
      updateSettings((d) => {
        d.context.references.links = [];
        if (!d.context.references.imageAssetIds.length) d.context.references.enabled = false;
      });
  };

  const removeLink = (id: string) =>
    updateSettings((d) => {
      d.context.references.links = d.context.references.links.filter((l) => l.id !== id);
      if (!d.context.references.links.length && !d.context.references.imageAssetIds.length) d.context.references.enabled = false;
    });

  return (
    <section className={clsx("ae-zone ae-zone--extras", drop.over && "is-over")} aria-labelledby="ae-extras-title" {...drop.handlers}>
      <header className="ae-zone__head">
        <div>
          <h2 id="ae-extras-title" className="ae-zone__title">
            Todo lo demás <span className="ae-optional">opcional</span>
          </h2>
          <p className="ae-zone__sub">Otros clips y tomas de apoyo, fotos, música, logos, efectos y referencias. Claude reconoce qué es cada cosa.</p>
        </div>
        {!empty && (
          <button type="button" className="ae-textbtn" onClick={clearAll}>
            <Trash2 size={14} aria-hidden /> Vaciar
          </button>
        )}
      </header>
      {picker.input}
      {refPicker.input}

      {empty ? (
        <div
          className="ae-sdrop ae-sdrop--compact"
          role="button"
          tabIndex={0}
          aria-label="Suelta aquí lo demás o toca para elegir archivos"
          onClick={picker.open}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              picker.open();
            }
          }}
        >
          <span className="ae-sdrop__types" aria-hidden>
            <Film size={16} />
            <ImageIcon size={16} />
            <Music size={16} />
            <AudioLines size={16} />
            <Type size={16} />
          </span>
          <span className="ae-sdrop__title ae-sdrop__title--sm">Suelta aquí lo demás</span>
          <span className="ae-sdrop__text">o toca para elegir archivos</span>
        </div>
      ) : (
        <ul className="ae-tiles">
          {extras.map((a) => (
            <ExtraTile key={a.id} asset={a} onPreview={() => setPreview(a.id)} onRemove={() => ops.remove(a)} />
          ))}
          <li>
            <button type="button" className="ae-tile ae-tile--add" onClick={picker.open} aria-label="Agregar más archivos">
              <Plus size={20} aria-hidden />
              <span>Agregar</span>
            </button>
          </li>
        </ul>
      )}

      {pending.length > 0 && (
        <ol className="ae-clips ae-clips--uploads">
          {pending.map((u) => (
            <UploadRow key={u.id} item={u} compact />
          ))}
        </ol>
      )}

      {realLinks.length > 0 && (
        <ul className="ae-links" aria-label="Referencias">
          {realLinks.map((l) => (
            <li key={l.id} className="ae-link">
              <Link2 size={14} aria-hidden />
              <a href={l.url} target="_blank" rel="noreferrer noopener" className="ae-link__url">
                {l.url.replace(/^https?:\/\/(www\.)?/, "")}
              </a>
              {l.likes && <span className="ae-link__likes">“{l.likes}”</span>}
              <button type="button" className="ae-iconbtn" aria-label="Quitar referencia" onClick={() => removeLink(l.id)}>
                <X size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="ae-zone__foot">
        <button type="button" className="ae-textbtn" aria-expanded={linkOpen} onClick={() => setLinkOpen((v) => !v)}>
          <Link2 size={14} aria-hidden /> Link de referencia
        </button>
        <button type="button" className="ae-textbtn" onClick={refPicker.open}>
          <ImageIcon size={14} aria-hidden /> Imagen de referencia
        </button>
      </div>
      {linkOpen && <LinkForm onDone={() => setLinkOpen(false)} />}

      {drop.over && (
        <div className="ae-zone__overlay" aria-hidden>
          Suelta para agregar
        </div>
      )}
      <AssetPreview assets={extras} assetId={preview} onClose={() => setPreview(null)} onNavigate={setPreview} />
    </section>
  );
}

function ExtraTile({ asset, onPreview, onRemove }: { asset: Asset; onPreview: () => void; onRemove: () => void }) {
  const api = useApi();
  const chip = extraChip(asset);
  const thumb = asset.kind === "imagen" ? (api.assetThumbnailUrl(asset) ?? api.assetFileUrl(asset)) : api.assetThumbnailUrl(asset);
  const [broken, setBroken] = useState(false);
  const Icon = asset.kind === "audio" ? Music : asset.kind === "video" ? Film : asset.kind === "documento" ? FileText : asset.kind === "fuente" ? Type : ImageIcon;
  const busy = asset.analysis.status === "pendiente" || asset.analysis.status === "analizando";
  return (
    <li className="ae-tile-wrap">
      <button type="button" className={clsx("ae-tile", `ae-tile--${asset.kind}`)} onClick={onPreview} title={asset.originalName} aria-label={`Ver ${asset.originalName} (${chip.label})`}>
        <span className="ae-tile__media">
          {thumb && !broken ? <img src={thumb} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} /> : <Icon size={22} aria-hidden />}
          {busy && <span className="ae-tile__busy" aria-hidden />}
        </span>
        <span className={clsx("ae-tchip", `ae-tchip--${chip.tone}`)}>{chip.label}</span>
        <span className="ae-tile__name">{asset.originalName}</span>
      </button>
      <button type="button" className="ae-tile__remove" aria-label={`Quitar ${asset.originalName}`} title="Quitar" onClick={onRemove}>
        <X size={13} aria-hidden />
      </button>
    </li>
  );
}

function LinkForm({ onDone }: { onDone: () => void }) {
  const { updateSettings, toast } = useActions();
  const [url, setUrl] = useState("");
  const [likes, setLikes] = useState("");
  const valid = /^https?:\/\/\S+\.\S+/.test(url.trim());
  const add = () => {
    if (!valid) {
      toast({ kind: "error", text: "Pega un link completo (que empiece con https://)." });
      return;
    }
    const kind = /(instagram|tiktok|youtube|youtu\.be|facebook|x\.com|twitter|threads)/i.test(url) ? "red-social" : "pagina-web";
    updateSettings((d) => {
      d.context.references.enabled = true;
      d.context.references.links = [...d.context.references.links.filter((l) => l.url), ReferenceLink.parse({ id: nanoid(6), kind, url: url.trim(), likes: likes.trim() })];
    });
    onDone();
  };
  return (
    <div className="ae-linkform">
      <input className="ae-input" type="url" inputMode="url" placeholder="https://… (un reel, un video o una página)" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Link de referencia" autoFocus />
      <input
        className="ae-input"
        placeholder="¿Qué te gusta de esto? p. ej. “los textos grandes y el ritmo”"
        value={likes}
        onChange={(e) => setLikes(e.target.value)}
        aria-label="Qué te gusta de esta referencia"
        onKeyDown={(e) => e.key === "Enter" && add()}
      />
      <div className="ae-row">
        <Button size="sm" tone="ghost" onClick={onDone}>
          Cancelar
        </Button>
        <Button size="sm" tone="ink" onClick={add} disabled={!url.trim()}>
          Agregar
        </Button>
      </div>
    </div>
  );
}
