/**
 * Etapa MATERIAL (obligatoria).
 * - Material en crudo: videos (marcables "debe aparecer"/"opcional"), fotos y notas de voz.
 * - Elementos del video: música, efectos, imágenes/gráficos/logos y videos que deben aparecer.
 * El análisis (escenas, voz, A-roll/B-roll) arranca solo al subir.
 */
import type { Asset, AssetCategory } from "@autoeditor/shared";
import clsx from "clsx";
import { AudioLines, Film, Image as ImageIcon, Music, Shapes, Sparkles, Star, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { useActions, useController, useEditorShallow, useStageStates } from "../../store/context.js";
import { ELEMENT_CATEGORIES, RAW_CATEGORIES } from "../../store/derive.js";
import type { UploadItem } from "../../store/editorStore.js";
import { Dropzone, EmptyState, SectionLabel, StageCard, Tooltip, useFileDrop } from "../../ui/index.js";
import { AssetRow, AssetThumb, ROLE_HELP, UploadRow, UploadThumb } from "./assets.js";

export interface StageProps {
  variant: "compact" | "focus";
}

const ACCEPT_RAW = "video/*,image/*,audio/*,.mov,.mp4,.m4v,.mkv,.heic,.m4a,.wav,.mp3";
const ACCEPT_ELEMENTS = "audio/*,image/*,video/*,.svg,.png";

function useMaterialData() {
  return useEditorShallow((s) => ({ assets: s.assets, uploads: s.uploads }));
}

const isRaw = (c: AssetCategory) => (RAW_CATEGORIES as readonly string[]).includes(c);
const isElement = (c: AssetCategory) => (ELEMENT_CATEGORIES as readonly string[]).includes(c);

export function MaterialStage({ variant }: StageProps) {
  const states = useStageStates();
  const { openFocus } = useActions();
  const state = states.material;
  if (variant === "focus") return <MaterialFocus />;
  return (
    <StageCard title="Material" variant="compact" status={state.status} hint={state.hint} onOpen={() => openFocus("material")} width={312}>
      <MaterialCompact />
    </StageCard>
  );
}

// ---------------------------------------------------------------------------- Compacto (lienzo)

function MaterialCompact() {
  const { assets, uploads } = useMaterialData();
  const controller = useController();
  const raw = assets.filter((a) => isRaw(a.category));
  const elements = assets.filter((a) => isElement(a.category));
  const rawUploads = uploads.filter((u) => isRaw(u.category));
  const elementUploads = uploads.filter((u) => !isRaw(u.category));
  const brollCount = raw.filter((a) => a.analysis.status === "listo" && (a.analysis.role === "b-roll" || a.analysis.role === "mixto")).length;

  return (
    <div className="ae-material">
      <CompactSection
        title="Material en crudo"
        count={raw.length}
        onFiles={(f) => void controller.uploadFiles(f, "crudo")}
        extra={
          brollCount > 0 ? (
            <Tooltip text={ROLE_HELP}>
              <span className="ae-mini-note">{brollCount} con B-roll</span>
            </Tooltip>
          ) : null
        }
        empty={<Dropzone size="md" label="Arrastra tus videos" hint="También fotos y notas de voz" accept={ACCEPT_RAW} icon={<Film size={20} />} onFiles={(f) => void controller.uploadFiles(f, "crudo")} />}
      >
        {(raw.length > 0 || rawUploads.length > 0) && <ThumbGrid assets={raw} uploads={rawUploads} max={6} />}
      </CompactSection>

      <CompactSection
        title="Elementos del video"
        count={elements.length}
        optional
        onFiles={(f) => void controller.uploadFiles(f, "elementos")}
        empty={<Dropzone size="sm" label="Música, efectos, logos o gráficos" accept={ACCEPT_ELEMENTS} icon={<Music size={16} />} onFiles={(f) => void controller.uploadFiles(f, "elementos")} />}
      >
        {(elements.length > 0 || elementUploads.length > 0) && (
          <div className="ae-elements">
            <ElementCount icon={<Music size={14} />} label="Música" n={elements.filter((a) => a.category === "musica").length} />
            <ElementCount icon={<Sparkles size={14} />} label="Efectos" n={elements.filter((a) => a.category === "sfx").length} />
            <ElementCount icon={<Shapes size={14} />} label="Gráficos" n={elements.filter((a) => a.category === "grafico").length} />
            <ElementCount icon={<ImageIcon size={14} />} label="Logos" n={elements.filter((a) => a.category === "logo").length} />
            {elementUploads.length > 0 && <span className="ae-mini-note">Subiendo {elementUploads.length}…</span>}
          </div>
        )}
      </CompactSection>
    </div>
  );
}

function CompactSection({
  title,
  count,
  optional,
  onFiles,
  empty,
  extra,
  children,
}: {
  title: string;
  count: number;
  optional?: boolean;
  onFiles: (files: File[]) => void;
  empty: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
}) {
  const { over, handlers } = useFileDrop(onFiles);
  const hasContent = !!children;
  return (
    <div className={clsx("ae-msec", over && "is-over")} {...handlers}>
      <SectionLabel extra={extra ?? (optional && !hasContent ? <span className="ae-optional">opcional</span> : count > 0 ? <span className="ae-count">{count}</span> : null)}>{title}</SectionLabel>
      {hasContent ? children : empty}
      {over && (
        <div className="ae-msec__over" aria-hidden>
          <Upload size={18} /> Suelta para subir
        </div>
      )}
    </div>
  );
}

function ThumbGrid({ assets, uploads, max }: { assets: Asset[]; uploads: UploadItem[]; max: number }) {
  const items = [...uploads.map((u) => ({ kind: "u" as const, u })), ...assets.map((a) => ({ kind: "a" as const, a }))];
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return (
    <div className="ae-thumbgrid">
      {shown.map((it, i) =>
        it.kind === "u" ? <UploadThumb key={it.u.id} item={it.u} /> : <AssetThumb key={it.a.id} asset={it.a} />,
      )}
      {rest > 0 && <div className="ae-thumbgrid__more" aria-label={`${rest} archivos más`}>+{rest}</div>}
      {shown.length === 0 && null}
      {items.length > 0 && items.length < 3 && Array.from({ length: 3 - items.length }).map((_, i) => <div key={`ph${i}`} className="ae-thumb ae-thumb--md ae-thumb--placeholder" aria-hidden />)}
    </div>
  );
}

function ElementCount({ icon, label, n }: { icon: ReactNode; label: string; n: number }) {
  return (
    <span className={clsx("ae-elcount", n === 0 && "is-zero")}>
      {icon}
      <span>{label}</span>
      <b>{n}</b>
    </span>
  );
}

// ---------------------------------------------------------------------------- Vista enfocada

interface ZoneDef {
  key: string;
  title: string;
  hint: string;
  icon: ReactNode;
  accept: string;
  categories: AssetCategory[];
  forced?: AssetCategory;
  priority?: Asset["priority"];
  /** Solo es un atajo de subida (los archivos se listan en otra zona). */
  uploadOnly?: boolean;
}

const RAW_ZONES: ZoneDef[] = [
  { key: "videos", title: "Videos", hint: "Del celular o la cámara, verticales u horizontales.", icon: <Film size={18} />, accept: "video/*,.mov,.mp4,.m4v,.mkv", categories: ["crudo-video"], forced: "crudo-video" },
  { key: "fotos", title: "Fotos", hint: "JPG, PNG o HEIC.", icon: <ImageIcon size={18} />, accept: "image/*,.heic", categories: ["crudo-foto"], forced: "crudo-foto" },
  { key: "voz", title: "Notas de voz", hint: "Audios con tu voz.", icon: <AudioLines size={18} />, accept: "audio/*,.m4a", categories: ["crudo-voz"], forced: "crudo-voz" },
];

const ELEMENT_ZONES: ZoneDef[] = [
  { key: "musica", title: "Música", hint: "MP3, WAV o M4A.", icon: <Music size={18} />, accept: "audio/*", categories: ["musica"], forced: "musica" },
  { key: "sfx", title: "Efectos de sonido", hint: "Tus whoosh, golpes o pops.", icon: <Sparkles size={18} />, accept: "audio/*", categories: ["sfx"], forced: "sfx" },
  { key: "graficos", title: "Imágenes y gráficos", hint: "PNG con transparencia, ilustraciones.", icon: <Shapes size={18} />, accept: "image/*,.svg", categories: ["grafico"], forced: "grafico" },
  { key: "logos", title: "Logos", hint: "Variantes claras y oscuras.", icon: <ImageIcon size={18} />, accept: "image/*,.svg", categories: ["logo"], forced: "logo" },
  {
    key: "deben",
    title: "Videos que deben aparecer",
    hint: "Se suben a tus videos marcados como “debe aparecer”.",
    icon: <Star size={18} />,
    accept: "video/*,.mov,.mp4",
    categories: [],
    forced: "crudo-video",
    priority: "debe-aparecer",
    uploadOnly: true,
  },
];

function MaterialFocus() {
  const { assets, uploads } = useMaterialData();
  const actions = useActions();
  const states = useStageStates();
  const raw = assets.filter((a) => isRaw(a.category));
  const rawUploads = uploads.filter((u) => isRaw(u.category));
  const elements = assets.filter((a) => isElement(a.category));
  const elementUploads = uploads.filter((u) => !isRaw(u.category));
  const mustAppear = raw.filter((a) => a.category === "crudo-video" && a.priority === "debe-aparecer").length;
  return (
    <div className="ae-material-focus">
      <p className="ae-lead">{states.material.hint} El análisis (escenas, voz y A-roll/B-roll) arranca solo al subir; no tienes que esperar a GENERAR.</p>
      <div className="ae-material-focus__cols">
        <section className="ae-panel" aria-label="Material en crudo">
          <header className="ae-panel__head">
            <h3>Material en crudo</h3>
            <span className="ae-count">{raw.length}</span>
          </header>
          <div className="ae-zones ae-zones--3">
            {RAW_ZONES.map((z) => (
              <Zone key={z.key} zone={z} zoneGroup="crudo" />
            ))}
          </div>
          <FileList assets={raw} uploads={rawUploads} onDismiss={actions.removeUpload} empty="Todavía no hay material. Arrastra tus videos a la zona de arriba." />
        </section>
        <section className="ae-panel" aria-label="Elementos del video">
          <header className="ae-panel__head">
            <h3>Elementos del video</h3>
            <span className="ae-optional">opcional</span>
          </header>
          <div className="ae-zones ae-zones--2">
            {ELEMENT_ZONES.map((z) => (
              <Zone key={z.key} zone={z} zoneGroup="elementos" extra={z.key === "deben" && mustAppear > 0 ? `${mustAppear} marcados` : undefined} />
            ))}
          </div>
          <FileList assets={elements} uploads={elementUploads} onDismiss={actions.removeUpload} empty="Música, efectos, logos o gráficos que quieras usar. Si no subes nada, Claude usa la biblioteca." />
        </section>
      </div>
    </div>
  );
}

function Zone({ zone, zoneGroup, extra }: { zone: ZoneDef; zoneGroup: "crudo" | "elementos"; extra?: string }) {
  const controller = useController();
  const { assets } = useMaterialData();
  const n = zone.uploadOnly ? 0 : assets.filter((a) => zone.categories.includes(a.category)).length;
  return (
    <Dropzone accept={zone.accept} label={zone.title} hint={zone.hint} onFiles={(f) => void controller.uploadFiles(f, zoneGroup, zone.forced, zone.priority ? { priority: zone.priority } : undefined)}>
      <span className="ae-drop__icon" aria-hidden>
        {zone.icon}
      </span>
      <span className="ae-drop__label">
        {zone.title}
        {n > 0 && <span className="ae-count">{n}</span>}
        {extra && <span className="ae-mini-note">{extra}</span>}
      </span>
      <span className="ae-drop__hint">{zone.hint}</span>
    </Dropzone>
  );
}

function FileList({ assets, uploads, empty, onDismiss }: { assets: Asset[]; uploads: UploadItem[]; empty: string; onDismiss: (id: string) => void }) {
  if (!assets.length && !uploads.length) return <EmptyState compact icon={<Upload size={20} />} title="Sin archivos">{empty}</EmptyState>;
  return (
    <div className="ae-filelist">
      {uploads.map((u) => (
        <UploadRow key={u.id} item={u} onDismiss={() => onDismiss(u.id)} />
      ))}
      {assets.map((a) => (
        <AssetRow key={a.id} asset={a} />
      ))}
    </div>
  );
}
