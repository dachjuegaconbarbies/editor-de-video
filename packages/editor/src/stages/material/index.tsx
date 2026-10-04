/**
 * Etapa MATERIAL (obligatoria).
 * - Material en crudo: videos (marcables "debe aparecer"/"opcional"), fotos y notas de voz.
 * - Elementos del video: música, efectos, imágenes/gráficos/logos y videos que deben aparecer.
 * Zonas de arrastre por categoría, botón "Elegir archivos" y pegar (Ctrl+V). Subida con progreso
 * real, cancelar y reintentar. El análisis (escenas, voz, A-roll/B-roll) arranca solo al subir.
 */
import type { Asset, AssetCategory } from "@autoeditor/shared";
import clsx from "clsx";
import { AudioLines, ClipboardPaste, Film, FolderOpen, Image as ImageIcon, LoaderCircle, Music, Shapes, Sparkles, Star, Upload } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { formatSecondsShort, plural } from "../../lib/format.js";
import { useActions, useEditor, useEditorShallow, useStageStates } from "../../store/context.js";
import { ELEMENT_CATEGORIES, RAW_CATEGORIES } from "../../store/derive.js";
import type { UploadItem } from "../../store/editorStore.js";
import { Button, Dropzone, EmptyState, Kbd, SectionLabel, StageCard, Tooltip, useFileDrop } from "../../ui/index.js";
import { AssetList } from "../../entrada/material/AssetCard.js";
import { MediaPreview } from "../../entrada/material/MediaPreview.js";
import { groupByCategory } from "../../entrada/order.js";
import { CATEGORY_LABELS, usePasteFiles, useUploader, type UploadRequest } from "../../entrada/uploads.js";
import { AssetThumb, ROLE_HELP, UploadThumb } from "./assets.js";

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
    <StageCard title="Material" variant="compact" status={state.status} hint={state.status === "vacio" ? undefined : state.hint} onOpen={() => openFocus("material")} width={312}>
      <MaterialCompact />
    </StageCard>
  );
}

/** Sube a la zona indicada (o reparte por tipo) y avisa cuántos se agregaron. */
function useUpload() {
  const uploader = useUploader();
  return (files: File[], req: UploadRequest) => void uploader.upload(files, req);
}

// ---------------------------------------------------------------------------- Compacto (lienzo)

function MaterialCompact() {
  const { assets, uploads } = useMaterialData();
  const focus = useEditor((s) => s.focus);
  const upload = useUpload();
  const raw = assets.filter((a) => isRaw(a.category));
  const elements = assets.filter((a) => isElement(a.category));
  const rawUploads = uploads.filter((u) => isRaw(u.category));
  const elementUploads = uploads.filter((u) => !isRaw(u.category) && isElement(u.category));
  const brollCount = raw.filter((a) => a.analysis.status === "listo" && (a.analysis.role === "b-roll" || a.analysis.role === "mixto" || a.analysis.brollSegments.length > 0)).length;
  const analyzing = raw.filter((a) => a.analysis.status === "pendiente" || a.analysis.status === "analizando").length;

  // Pegar (Ctrl+V) en el diagrama sube al material en crudo; dentro de MATERIAL lo maneja su vista.
  usePasteFiles(!focus, (files) => upload(files, { zone: "crudo" }));

  return (
    <div className="ae-material">
      <CompactSection
        title="Material en crudo"
        count={raw.length}
        onFiles={(f) => upload(f, { zone: "crudo" })}
        extra={
          analyzing > 0 ? (
            <span className="ae-mini-note ae-in-mini-busy">
              <LoaderCircle size={11} className="ae-spin" aria-hidden /> Analizando {analyzing}
            </span>
          ) : brollCount > 0 ? (
            <Tooltip text={ROLE_HELP}>
              <span className="ae-mini-note">{brollCount} con B-roll</span>
            </Tooltip>
          ) : null
        }
        empty={<Dropzone size="md" label="Sube tus videos" hint="Arrástralos, toca para elegir o pega con Ctrl+V · también fotos y voz" accept={ACCEPT_RAW} icon={<Film size={20} />} onFiles={(f) => upload(f, { zone: "crudo" })} />}
      >
        {(raw.length > 0 || rawUploads.length > 0) && <ThumbGrid assets={raw} uploads={rawUploads} max={6} />}
      </CompactSection>

      <CompactSection
        title="Elementos del video"
        count={elements.length}
        optional
        onFiles={(f) => upload(f, { zone: "elementos" })}
        empty={<Dropzone size="sm" label="Música, efectos, logos o gráficos" accept={ACCEPT_ELEMENTS} icon={<Music size={16} />} onFiles={(f) => upload(f, { zone: "elementos" })} />}
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
      {shown.map((it) => (it.kind === "u" ? <UploadThumb key={it.u.id} item={it.u} /> : <AssetThumb key={it.a.id} asset={it.a} />))}
      {rest > 0 && (
        <div className="ae-thumbgrid__more" aria-label={`${rest} archivos más`}>
          +{rest}
        </div>
      )}
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
    hint: "Se agregan a tus videos marcados como “debe aparecer”.",
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
  const states = useStageStates();
  const upload = useUpload();
  const pick = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const raw = assets.filter((a) => isRaw(a.category));
  const rawUploads = uploads.filter((u) => isRaw(u.category));
  const elements = assets.filter((a) => isElement(a.category));
  const elementUploads = uploads.filter((u) => !isRaw(u.category) && isElement(u.category));
  const mustAppear = raw.filter((a) => a.category === "crudo-video" && a.priority === "debe-aparecer").length;
  const rawGroups = useMemo(() => groupByCategory(raw, RAW_CATEGORIES), [raw]);
  const elementGroups = useMemo(() => groupByCategory(elements, ELEMENT_CATEGORIES), [elements]);
  const ordered = useMemo(() => [...rawGroups, ...elementGroups].flatMap((g) => g.items), [rawGroups, elementGroups]);

  usePasteFiles(true, (files) => upload(files, { zone: "crudo" }));

  const videoSeconds = raw.filter((a) => a.category === "crudo-video").reduce((s, a) => s + (a.probe.duration ?? 0), 0);
  const brollAssets = raw.filter((a) => a.analysis.status === "listo" && (a.analysis.role === "b-roll" || a.analysis.brollSegments.length > 0)).length;
  const analyzing = assets.filter((a) => a.analysis.status === "pendiente" || a.analysis.status === "analizando").length;

  return (
    <div className="ae-material-focus">
      <div className="ae-in-mtop">
        <p className="ae-lead">
          {states.material.hint} El análisis (escenas, voz y A-roll/B-roll) arranca solo al subir; no tienes que esperar a GENERAR.
        </p>
        <div className="ae-in-mtop__actions">
          <Button tone="ink" icon={<FolderOpen size={15} />} onClick={() => pick.current?.click()}>
            Elegir archivos
          </Button>
          <span className="ae-in-mtop__paste">
            <ClipboardPaste size={14} aria-hidden /> o pega con <Kbd>Ctrl</Kbd>
            <Kbd>V</Kbd>
          </span>
          <input
            ref={pick}
            type="file"
            hidden
            multiple
            accept={`${ACCEPT_RAW},${ACCEPT_ELEMENTS}`}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length) upload(files, { zone: "crudo" });
            }}
          />
        </div>
      </div>
      {raw.length > 0 && (
        <div className="ae-in-msummary" aria-label="Resumen del material">
          <span>
            <b>{plural(raw.filter((a) => a.category === "crudo-video").length, "video", "videos")}</b>
          </span>
          {videoSeconds > 0 && <span>{formatSecondsShort(videoSeconds)} de material</span>}
          {mustAppear > 0 && (
            <span>
              <Star size={12} aria-hidden /> {mustAppear} “debe aparecer”
            </span>
          )}
          {brollAssets > 0 && <span className="is-broll">{brollAssets} con B-roll</span>}
          {analyzing > 0 && (
            <span className="is-busy">
              <LoaderCircle size={12} className="ae-spin" aria-hidden /> {analyzing} analizando
            </span>
          )}
        </div>
      )}
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
          {rawUploads.length > 0 && <AssetList assets={[]} uploads={rawUploads} onPreview={setPreview} />}
          {rawGroups.map((g) => (
            <CategoryBlock key={g.category} category={g.category as AssetCategory} count={g.items.length}>
              <AssetList assets={g.items} uploads={[]} onPreview={setPreview} />
            </CategoryBlock>
          ))}
          {!raw.length && !rawUploads.length && (
            <EmptyState compact icon={<Upload size={20} />} title="Todavía no hay material">
              Arrastra tus videos a la zona de arriba, toca “Elegir archivos” o pega con Ctrl+V.
            </EmptyState>
          )}
        </section>
        <section className="ae-panel" aria-label="Elementos del video">
          <header className="ae-panel__head">
            <h3>Elementos del video</h3>
            <span className="ae-optional">opcional</span>
          </header>
          <div className="ae-zones ae-zones--2">
            {ELEMENT_ZONES.map((z) => (
              <Zone key={z.key} zone={z} zoneGroup="elementos" extra={z.key === "deben" && mustAppear > 0 ? `${mustAppear} ${mustAppear === 1 ? "marcado" : "marcados"}` : undefined} />
            ))}
          </div>
          {elementUploads.length > 0 && <AssetList assets={[]} uploads={elementUploads} onPreview={setPreview} />}
          {elementGroups.map((g) => (
            <CategoryBlock key={g.category} category={g.category as AssetCategory} count={g.items.length}>
              <AssetList assets={g.items} uploads={[]} onPreview={setPreview} />
            </CategoryBlock>
          ))}
          {!elements.length && !elementUploads.length && (
            <EmptyState compact icon={<Music size={20} />} title="Sin elementos">
              Música, efectos, logos o gráficos que quieras usar. Si no subes nada, Claude usa la biblioteca.
            </EmptyState>
          )}
        </section>
      </div>
      <MediaPreview assets={ordered} assetId={preview} onClose={() => setPreview(null)} onNavigate={setPreview} />
    </div>
  );
}

function CategoryBlock({ category, count, children }: { category: AssetCategory; count: number; children: ReactNode }) {
  return (
    <div className="ae-in-catblock">
      <SectionLabel extra={<span className="ae-count">{count}</span>}>{CATEGORY_LABELS[category] ?? category}</SectionLabel>
      {children}
    </div>
  );
}

function Zone({ zone, zoneGroup, extra }: { zone: ZoneDef; zoneGroup: "crudo" | "elementos"; extra?: string }) {
  const upload = useUpload();
  const { assets } = useMaterialData();
  const n = zone.uploadOnly ? 0 : assets.filter((a) => zone.categories.includes(a.category)).length;
  return (
    <Dropzone accept={zone.accept} label={zone.title} hint={zone.hint} onFiles={(f) => upload(f, { zone: zoneGroup, category: zone.forced, priority: zone.priority })}>
      <span className="ae-drop__icon" aria-hidden>
        {zone.icon}
      </span>
      <span className="ae-drop__label">
        {zone.title}
        {n > 0 && <span className="ae-count">{n}</span>}
      </span>
      <span className="ae-drop__hint">{zone.hint}</span>
      {extra && <span className="ae-chip ae-chip--sm ae-chip--purple">{extra}</span>}
    </Dropzone>
  );
}
