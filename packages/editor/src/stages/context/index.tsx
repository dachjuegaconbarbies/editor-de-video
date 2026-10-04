/**
 * Etapa CONTEXTO (opcional). Tres interruptores "TENGO …":
 * - TENGO GUION → pegar texto o subir PDF/DOCX/TXT; seguirlo estricto o flexible.
 * - TENGO IDENTIDAD DE MARCA → logos, tipografías, paleta, notas.
 * - TENGO REFERENCIAS VISUALES → imágenes/videos y links (red social o página web) con "qué me gusta".
 * Apagado = chip pequeño sobre la línea ("Guion: no"). Prendido = el nodo se despliega.
 */
import type { ProjectSettings, ReferenceLink } from "@autoeditor/shared";
import clsx from "clsx";
import { FileText, FileUp, Globe, ImagePlus, Link2, Palette, Plus, Sparkles, Trash2, Type } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { nanoid } from "nanoid";
import { useState, type ReactNode } from "react";
import { CONTEXT_KEYS, CONTEXT_LABELS, type ContextKey } from "../../lib/stages.js";
import { useActions, useApi, useController, useEditor, useEditorShallow } from "../../store/context.js";
import { contextIssues } from "../../store/derive.js";
import { Button, Chip, Dropzone, Field, IconButton, Segmented, StageCard, TogglePill, Tooltip } from "../../ui/index.js";
import type { StageProps } from "../material/index.js";

const ICONS: Record<ContextKey, ReactNode> = {
  script: <FileText size={14} aria-hidden />,
  brand: <Palette size={14} aria-hidden />,
  references: <Sparkles size={14} aria-hidden />,
};

const WHY: Record<ContextKey, string> = {
  script: "Claude seguirá tu guion como estructura: orden, textos en pantalla y subtítulos.",
  brand: "Claude usará tu logo, tipografías y colores. Apagado: estilo neutro y limpio.",
  references: "Claude saca ritmo, estilo de textos, colores y transiciones de tus referencias.",
};

/** Prende/apaga un interruptor de contexto (queda en el historial de deshacer). */
export function useToggleContext() {
  const { updateSettings } = useActions();
  return (key: ContextKey, enabled: boolean) =>
    updateSettings((d) => {
      d.context[key].enabled = enabled;
    });
}

// ---------------------------------------------------------------------------- Nodo del lienzo

export function ContextNodeBody({ contextKey, enabled }: { contextKey: ContextKey; enabled: boolean }) {
  const toggle = useToggleContext();
  const reduce = useReducedMotion();
  return (
    <AnimatePresence mode="wait" initial={false}>
      {enabled ? (
        <motion.div
          key="card"
          initial={{ opacity: 0, scale: reduce ? 1 : 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: reduce ? 1 : 0.96 }}
          transition={{ duration: reduce ? 0 : 0.22, ease: [0.2, 0.8, 0.2, 1] }}
          style={{ transformOrigin: "left center" }}
        >
          <ContextCard contextKey={contextKey} variant="compact" onOff={() => toggle(contextKey, false)} />
        </motion.div>
      ) : (
        <motion.div key="chip" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? 0 : 0.15 }}>
          <ContextChip contextKey={contextKey} onOn={() => toggle(contextKey, true)} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ContextChip({ contextKey, onOn }: { contextKey: ContextKey; onOn: () => void }) {
  const l = CONTEXT_LABELS[contextKey];
  return (
    <Tooltip text={`Prender ${l.pill}. ${WHY[contextKey]}`} side="bottom">
      <button type="button" role="switch" aria-checked={false} aria-label={`${l.pill}: apagado. Prender`} className="ae-ctxchip nodrag" onClick={onOn}>
        <span className="ae-ctxchip__icon">{ICONS[contextKey]}</span>
        <span className="ae-ctxchip__text">
          {l.chip}: <b>no</b>
        </span>
        <span className="ae-ctxchip__add" aria-hidden>
          <Plus size={12} strokeWidth={2.5} />
        </span>
      </button>
    </Tooltip>
  );
}

function ContextCard({ contextKey, variant, onOff }: { contextKey: ContextKey; variant: "compact" | "focus"; onOff: () => void }) {
  const settings = useEditor((s) => s.settings);
  const { openFocus } = useActions();
  const issue = contextIssues(settings).find((i) => i.key === contextKey);
  const l = CONTEXT_LABELS[contextKey];
  return (
    <StageCard
      title={l.title}
      variant="compact"
      status={issue ? "vacio" : "listo"}
      hint={issue?.hint}
      width={296}
      onOpen={variant === "compact" ? () => openFocus("contexto", `ctx-${contextKey}`) : undefined}
      className="ae-ctxcard"
    >
      <div className="ae-ctxcard__pill">
        <TogglePill label={l.pill} checked onChange={() => onOff()} size="sm" />
      </div>
      {contextKey === "script" && <ScriptFields variant={variant} />}
      {contextKey === "brand" && <BrandFields variant={variant} />}
      {contextKey === "references" && <ReferenceFields variant={variant} />}
    </StageCard>
  );
}

// ---------------------------------------------------------------------------- Campos

function useCtx() {
  return useEditorShallow((s) => ({ ctx: s.settings.context, assets: s.assets }));
}

function ScriptFields({ variant }: { variant: "compact" | "focus" }) {
  const { ctx, assets } = useCtx();
  const { updateSettings } = useActions();
  const controller = useController();
  const file = ctx.script.fileAssetId ? assets.find((a) => a.id === ctx.script.fileAssetId) : null;
  const set = (fn: (d: ProjectSettings["context"]["script"]) => void) => updateSettings((d) => fn(d.context.script));
  return (
    <div className="ae-fields">
      <textarea
        className="ae-input ae-textarea nodrag nowheel"
        rows={variant === "focus" ? 14 : 5}
        placeholder="Pega aquí tu guion…"
        aria-label="Texto del guion"
        value={ctx.script.text}
        onChange={(e) => set((s) => void (s.text = e.target.value))}
      />
      <div className="ae-row ae-row--between">
        {file ? (
          <Chip tone="yellow" icon={<FileText size={12} />} onRemove={() => set((s) => void (s.fileAssetId = null))} removeLabel="Quitar archivo del guion">
            {file.originalName}
          </Chip>
        ) : (
          <UploadButton
            label="Subir PDF, DOCX o TXT"
            accept=".pdf,.docx,.txt,.md,application/pdf,text/plain"
            onFiles={async (files) => {
              const [asset] = await controller.uploadFiles(files.slice(0, 1), "elementos", "guion");
              if (asset) set((s) => void (s.fileAssetId = asset.id));
            }}
          />
        )}
      </div>
      <Field label="¿Qué tan al pie de la letra?">
        <Segmented
          size="sm"
          label="Seguir el guion"
          value={ctx.script.follow}
          onChange={(follow) => set((s) => void (s.follow = follow))}
          options={[
            { value: "flexible", label: "Flexible", title: "Claude puede reordenar o recortar para que fluya." },
            { value: "estricto", label: "Estricto", title: "Respeta el orden y los textos tal cual." },
          ]}
        />
      </Field>
    </div>
  );
}

function BrandFields({ variant }: { variant: "compact" | "focus" }) {
  const { ctx, assets } = useCtx();
  const { updateSettings } = useActions();
  const controller = useController();
  const api = useApi();
  const inline = ctx.brand.inline;
  const [font, setFont] = useState("");
  const set = (fn: (d: ProjectSettings["context"]["brand"]["inline"]) => void) => updateSettings((d) => fn(d.context.brand.inline));
  const logos = inline.logoAssetIds.map((id) => assets.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a);
  const addFont = () => {
    const f = font.trim();
    if (!f) return;
    set((b) => void (b.googleFonts = [...new Set([...b.googleFonts, f])]));
    setFont("");
  };
  return (
    <div className="ae-fields">
      <input className="ae-input nodrag" placeholder="Nombre de la marca" aria-label="Nombre de la marca" value={inline.name} onChange={(e) => set((b) => void (b.name = e.target.value))} />
      <Field label="Paleta">
        <div className="ae-swatches">
          {inline.colors.map((c, i) => (
            <span key={`${c}-${i}`} className="ae-swatch-wrap">
              <label className="ae-swatch" style={{ background: c }} title={c}>
                <input
                  type="color"
                  className="nodrag"
                  value={c.slice(0, 7)}
                  aria-label={`Color ${i + 1}`}
                  onChange={(e) => set((b) => void (b.colors[i] = e.target.value.toUpperCase()))}
                />
              </label>
              <button type="button" className="ae-swatch__remove" aria-label={`Quitar color ${c}`} onClick={() => set((b) => void b.colors.splice(i, 1))}>
                ×
              </button>
            </span>
          ))}
          {inline.colors.length < 8 && (
            <button type="button" className="ae-swatch ae-swatch--add nodrag" aria-label="Agregar color" onClick={() => set((b) => void b.colors.push(DEFAULT_SWATCHES[b.colors.length % DEFAULT_SWATCHES.length]!))}>
              <Plus size={14} aria-hidden />
            </button>
          )}
        </div>
      </Field>
      <Field label="Tipografías (Google Fonts o archivos)">
        <div className="ae-row ae-row--wrap">
          {inline.googleFonts.map((f) => (
            <Chip key={f} tone="outline" icon={<Type size={12} />} onRemove={() => set((b) => void (b.googleFonts = b.googleFonts.filter((x) => x !== f)))} removeLabel={`Quitar ${f}`}>
              <span style={{ fontFamily: `"${f}", var(--ae-font)` }}>{f}</span>
            </Chip>
          ))}
          <input
            className="ae-input ae-input--sm nodrag ae-grow"
            placeholder={inline.googleFonts.length ? "Otra…" : "p. ej. Poppins"}
            aria-label="Agregar tipografía"
            value={font}
            onChange={(e) => setFont(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addFont()}
            onBlur={addFont}
          />
        </div>
      </Field>
      <Field label="Logos">
        <div className="ae-row ae-row--wrap">
          {logos.map((l) => {
            const src = api.assetThumbnailUrl(l);
            return (
              <span key={l.id} className="ae-logo-thumb" title={l.originalName}>
                {src ? <img src={src} alt={l.originalName} /> : <span>{l.originalName}</span>}
                <button type="button" aria-label={`Quitar ${l.originalName}`} onClick={() => set((b) => void (b.logoAssetIds = b.logoAssetIds.filter((x) => x !== l.id)))}>
                  ×
                </button>
              </span>
            );
          })}
          <UploadButton
            label={logos.length ? "Otro logo" : "Subir logo"}
            accept="image/*,.svg"
            onFiles={async (files) => {
              const up = await controller.uploadFiles(files, "elementos", "logo");
              if (up.length) set((b) => void (b.logoAssetIds = [...b.logoAssetIds, ...up.map((a) => a.id)]));
            }}
          />
        </div>
      </Field>
      {variant === "focus" && (
        <Field label="Notas de la marca" hint="Tono, palabras prohibidas, cómo se escribe el nombre…">
          <textarea className="ae-input ae-textarea" rows={4} value={inline.notes} onChange={(e) => set((b) => void (b.notes = e.target.value))} />
        </Field>
      )}
    </div>
  );
}

const DEFAULT_SWATCHES = ["#1F1F1F", "#8B7CF0", "#FBE88A", "#EE6B6B", "#BFEFD3", "#F6D5B3"];

function ReferenceFields({ variant }: { variant: "compact" | "focus" }) {
  const { ctx, assets } = useCtx();
  const { updateSettings } = useActions();
  const controller = useController();
  const api = useApi();
  const refs = ctx.references;
  const set = (fn: (d: ProjectSettings["context"]["references"]) => void) => updateSettings((d) => fn(d.context.references));
  const images = refs.imageAssetIds.map((id) => assets.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a);
  const addLink = (kind: ReferenceLink["kind"]) =>
    set((r) => void r.links.push({ id: nanoid(8), kind, url: "", likes: "", status: "pendiente", analysis: "" }));
  const shownLinks = variant === "compact" ? refs.links.slice(0, 2) : refs.links;
  return (
    <div className="ae-fields">
      <Dropzone
        size={variant === "focus" ? "lg" : "sm"}
        label={images.length ? `${images.length} referencias · agregar más` : "Imágenes o videos de referencia"}
        hint={variant === "focus" ? "Capturas, fotogramas o clips que te gusten." : undefined}
        accept="image/*,video/*"
        icon={<ImagePlus size={16} />}
        onFiles={async (files) => {
          const up = await controller.uploadFiles(files, "elementos", "referencia");
          if (up.length) set((r) => void (r.imageAssetIds = [...r.imageAssetIds, ...up.map((a) => a.id)]));
        }}
      />
      {images.length > 0 && (
        <div className="ae-refgrid">
          {images.slice(0, variant === "focus" ? 24 : 4).map((a) => {
            const src = api.assetThumbnailUrl(a);
            return (
              <span key={a.id} className="ae-refgrid__item" title={a.originalName}>
                {src ? <img src={src} alt={a.originalName} /> : <ImagePlus size={14} aria-hidden />}
              </span>
            );
          })}
        </div>
      )}
      <div className="ae-row ae-row--wrap">
        <Button size="sm" tone="ink" icon={<Link2 size={14} />} onClick={() => addLink("red-social")} className="nodrag">
          + Link de red social
        </Button>
        <Button size="sm" tone="ink" icon={<Globe size={14} />} onClick={() => addLink("pagina-web")} className="nodrag">
          + Página web
        </Button>
      </div>
      <AnimatePresence initial={false}>
        {shownLinks.map((link) => (
          <motion.div key={link.id} className="ae-linkrow" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18 }}>
            <div className="ae-row">
              {link.kind === "red-social" ? <Link2 size={14} aria-hidden /> : <Globe size={14} aria-hidden />}
              <input
                className="ae-input ae-input--sm nodrag ae-grow"
                placeholder={link.kind === "red-social" ? "https://www.tiktok.com/@…" : "https://…"}
                aria-label="URL de la referencia"
                value={link.url}
                onChange={(e) => set((r) => void (r.links.find((l) => l.id === link.id)!.url = e.target.value))}
              />
              <IconButton label="Quitar link" icon={<Trash2 size={14} />} onClick={() => set((r) => void (r.links = r.links.filter((l) => l.id !== link.id)))} />
            </div>
            <input
              className="ae-input ae-input--sm nodrag"
              placeholder="¿Qué te gusta de esto? (ritmo, textos, colores…)"
              aria-label="Qué te gusta de esta referencia"
              value={link.likes}
              onChange={(e) => set((r) => void (r.links.find((l) => l.id === link.id)!.likes = e.target.value))}
            />
          </motion.div>
        ))}
      </AnimatePresence>
      {variant === "compact" && refs.links.length > 2 && <div className="ae-mini-note">+{refs.links.length - 2} links más</div>}
      {variant === "focus" && <p className="ae-help">Si un link no se puede analizar, te pediremos una captura o el archivo. No descargamos contenido de redes contra sus términos.</p>}
    </div>
  );
}

function UploadButton({ label, accept, onFiles }: { label: string; accept: string; onFiles: (files: File[]) => void }) {
  return (
    <label className={clsx("ae-btn ae-btn--ghost ae-btn--sm nodrag", "ae-upload-btn")}>
      <FileUp size={14} aria-hidden />
      <span className="ae-btn__label">{label}</span>
      <input
        type="file"
        hidden
        accept={accept}
        multiple
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------- Vista enfocada

export function ContextStage({ variant, target }: StageProps & { target?: string }) {
  const ctx = useEditor((s) => s.settings.context);
  const toggle = useToggleContext();
  if (variant === "compact") return null;
  const first = target?.replace("ctx-", "") as ContextKey | undefined;
  const order = first && CONTEXT_KEYS.includes(first) ? [first, ...CONTEXT_KEYS.filter((k) => k !== first)] : CONTEXT_KEYS;
  return (
    <div className="ae-context-focus">
      <p className="ae-lead">Todo es opcional. Prende solo lo que tengas: si no, Claude arma la estructura y usa un estilo neutro y limpio.</p>
      <div className="ae-context-focus__toggles" role="group" aria-label="Interruptores de contexto">
        {CONTEXT_KEYS.map((k) => (
          <TogglePill key={k} label={CONTEXT_LABELS[k].pill} checked={ctx[k].enabled} onChange={(v) => toggle(k, v)} />
        ))}
      </div>
      <div className="ae-context-focus__cols">
        {order.map((k) =>
          ctx[k].enabled ? (
            <section key={k} className="ae-panel" aria-label={CONTEXT_LABELS[k].title}>
              <header className="ae-panel__head">
                <h3>{CONTEXT_LABELS[k].title}</h3>
                <TogglePill label="Prendido" checked onChange={() => toggle(k, false)} size="sm" />
              </header>
              <p className="ae-help">{WHY[k]}</p>
              {k === "script" && <ScriptFields variant="focus" />}
              {k === "brand" && <BrandFields variant="focus" />}
              {k === "references" && <ReferenceFields variant="focus" />}
            </section>
          ) : (
            <section key={k} className="ae-panel ae-panel--off" aria-label={CONTEXT_LABELS[k].title}>
              <header className="ae-panel__head">
                <h3>{CONTEXT_LABELS[k].title}</h3>
              </header>
              <p className="ae-help">{WHY[k]}</p>
              <Button tone="ink" size="sm" icon={<Plus size={14} />} onClick={() => toggle(k, true)}>
                {CONTEXT_LABELS[k].pill}
              </Button>
            </section>
          ),
        )}
      </div>
    </div>
  );
}
