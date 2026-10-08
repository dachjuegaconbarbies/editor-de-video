/**
 * Palabras clave como chips editables por categoría (gancho, tema, nombre, cifra, beneficio, CTA).
 * - Clic en el chip: activar/desactivar · doble clic: editar el texto · ×: quitar · "+": agregar.
 * - Al pasar el mouse (o con foco) muestra dónde aparece en la transcripción; clic → salta ahí.
 * - "Detectar de nuevo" (POST /keywords/detect) conserva las que agregaste tú.
 * Más el texto para publicar sugerido (título, descripción, hashtags) con botón copiar.
 */
import type { Keyword, PublishCopy, Transcript } from "@autoeditor/shared";
import clsx from "clsx";
import { Check, Copy, LoaderCircle, Plus, ScanSearch, X } from "lucide-react";
import { nanoid } from "nanoid";
import { useMemo, useRef, useState } from "react";
import { messageOf } from "../../api/errors.js";
import { useActions, useApi, useEditorShallow } from "../../store/context.js";
import { Button, EmptyState, IconButton } from "../../ui/index.js";
import { copyText, useEscape } from "../dom.js";
import { formatTime } from "../media/ClipPlayer.js";
import { keywordOccurrences, rangeText, wordKey, type Occurrence } from "./model.js";
import type { TranscriptJump } from "./TranscriptEditor.js";

export const KW_CATEGORIES: { key: Keyword["category"]; label: string; help: string; tone: string }[] = [
  { key: "gancho", label: "Gancho", help: "La frase que engancha en los primeros segundos.", tone: "coral" },
  { key: "tema", label: "Tema", help: "De qué trata el video.", tone: "purple" },
  { key: "nombre", label: "Nombres", help: "Personas, marcas, lugares.", tone: "peach" },
  { key: "cifra", label: "Cifras", help: "Números que conviene mostrar en grande.", tone: "yellow" },
  { key: "beneficio", label: "Beneficios", help: "Lo que gana quien ve.", tone: "mint" },
  { key: "cta", label: "Llamado a la acción", help: "Lo que quieres que haga al final.", tone: "ink" },
  { key: "otro", label: "Otras", help: "Lo que agregaste sin categoría.", tone: "neutral" },
];

export const KW_TONE = Object.fromEntries(KW_CATEGORIES.map((c) => [c.key, c.tone])) as Record<Keyword["category"], string>;

/** Guarda la lista (optimista) y avisa si el servidor no la aceptó. */
function useKeywordsSave() {
  const api = useApi();
  const { setKeywords, toast } = useActions();
  const { projectId, keywords, publishCopy } = useEditorShallow((s) => ({ projectId: s.project?.id ?? null, keywords: s.keywords, publishCopy: s.publishCopy }));
  return (next: Keyword[]) => {
    const before = keywords;
    setKeywords(next, publishCopy);
    if (!projectId) return;
    api.putKeywords(projectId, next).catch((err) => {
      setKeywords(before, publishCopy);
      toast({ kind: "error", text: `No se guardaron las palabras clave: ${messageOf(err)}` });
    });
  };
}

export function KeywordsPanel({ onJump }: { onJump?: (j: TranscriptJump) => void }) {
  const api = useApi();
  const { setKeywords, toast } = useActions();
  const { keywords, transcripts, projectId } = useEditorShallow((s) => ({ keywords: s.keywords, transcripts: s.transcripts, projectId: s.project?.id ?? null }));
  const saveAll = useKeywordsSave();
  const [detecting, setDetecting] = useState(false);
  const ready = useMemo(() => transcripts.filter((t) => t.status === "listo" && t.words.length), [transcripts]);
  const enabled = keywords.filter((k) => k.enabled).length;

  const detect = async () => {
    if (!projectId) return;
    setDetecting(true);
    try {
      const res = await api.detectKeywords(projectId);
      setKeywords(res.keywords, res.publishCopy);
      toast({ kind: "exito", text: `Listo: ${res.keywords.length} palabras clave. Las que agregaste tú se conservan.` });
    } catch (err) {
      toast({ kind: "error", text: `No se pudieron detectar: ${messageOf(err)}` });
    } finally {
      setDetecting(false);
    }
  };

  const update = (id: string, patch: Partial<Keyword>) => saveAll(keywords.map((k) => (k.id === id ? { ...k, ...patch } : k)));
  const remove = (id: string) => saveAll(keywords.filter((k) => k.id !== id));
  const add = (text: string, category: Keyword["category"]) => {
    const t = text.trim();
    if (!t) return;
    if (keywords.some((k) => wordKey(k.text) === wordKey(t))) {
      toast({ kind: "info", text: `“${t}” ya está en tus palabras clave.` });
      return;
    }
    saveAll([...keywords, { id: `ku-${nanoid(6)}`, text: t, category, source: "usuario", enabled: true, occurrences: [], score: 1 }]);
  };

  return (
    <div className="ae-in-kw">
      <div className="ae-in-kw__head">
        <p className="ae-help">
          Se resaltan en los subtítulos y guían dónde van gráficos, zooms, efectos y B-roll. <b>{enabled}</b> activas de {keywords.length}.
        </p>
        <Button size="sm" tone="ghost" icon={detecting ? <LoaderCircle size={14} className="ae-spin" /> : <ScanSearch size={14} />} onClick={() => void detect()} disabled={detecting || !projectId || !ready.length} title={ready.length ? undefined : "Primero necesitamos una transcripción"}>
          {detecting ? "Detectando…" : "Detectar de nuevo"}
        </Button>
      </div>
      {!keywords.length && !ready.length ? (
        <EmptyState compact icon={<ScanSearch size={20} />} title="Aún no hay palabras clave">
          Claude las detecta al transcribir. También puedes escribirlas tú abajo.
        </EmptyState>
      ) : null}
      <div className="ae-in-kw__cats">
        {KW_CATEGORIES.map((c) => {
          const list = keywords.filter((k) => k.category === c.key);
          if (c.key === "otro" && !list.length) return null;
          return (
            <div key={c.key} className="ae-in-kw__cat">
              <div className="ae-in-kw__catlabel" title={c.help}>
                <i className={`is-${c.tone}`} aria-hidden />
                {c.label}
              </div>
              <div className="ae-in-kw__chips">
                {list.map((k) => (
                  <KeywordChip key={k.id} kw={k} tone={c.tone} transcripts={ready} onToggle={() => update(k.id, { enabled: !k.enabled })} onRemove={() => remove(k.id)} onRename={(text) => update(k.id, { text, source: "usuario" })} onJump={onJump} />
                ))}
                <AddKeyword category={c.key} label={c.label} onAdd={add} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function KeywordChip({
  kw,
  tone,
  transcripts,
  onToggle,
  onRemove,
  onRename,
  onJump,
}: {
  kw: Keyword;
  tone: string;
  transcripts: Transcript[];
  onToggle: () => void;
  onRemove: () => void;
  onRename: (text: string) => void;
  onJump?: (j: TranscriptJump) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(kw.text);
  const input = useRef<HTMLInputElement>(null);
  const occ = useMemo(() => keywordOccurrences(transcripts, kw.text), [transcripts, kw.text]);
  useEscape(input, () => {
    setEditing(false);
    setValue(kw.text);
  }, editing);
  if (editing) {
    const commit = () => {
      setEditing(false);
      const t = value.trim();
      if (t && t !== kw.text) onRename(t);
      else setValue(kw.text);
    };
    return (
      <span className={clsx("ae-in-kwchip is-editing", `is-${tone}`)}>
        <input
          ref={input}
          autoFocus
          className="ae-in-kwchip__input"
          value={value}
          aria-label={`Editar “${kw.text}”`}
          style={{ width: `${Math.max(4, value.length + 1)}ch` }}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
      </span>
    );
  }
  return (
    <span className={clsx("ae-in-kwchip", `is-${tone}`, !kw.enabled && "is-off")}>
      <button
        type="button"
        className="ae-in-kwchip__main"
        aria-pressed={kw.enabled}
        onClick={onToggle}
        onDoubleClick={() => {
          setValue(kw.text);
          setEditing(true);
        }}
        title={`${kw.enabled ? "Activa" : "Desactivada"} · clic para ${kw.enabled ? "desactivar" : "activar"} · doble clic para editar`}
      >
        {kw.enabled ? <Check size={11} strokeWidth={3} aria-hidden /> : null}
        <span>{kw.text}</span>
        {occ.length > 0 && <span className="ae-in-kwchip__n">{occ.length}</span>}
      </button>
      <button type="button" className="ae-in-kwchip__x" onClick={onRemove} aria-label={`Quitar “${kw.text}”`} title="Quitar">
        <X size={11} aria-hidden />
      </button>
      <OccurrencesCard text={kw.text} occ={occ} transcripts={transcripts} onJump={onJump} />
    </span>
  );
}

function OccurrencesCard({ text, occ, transcripts, onJump }: { text: string; occ: Occurrence[]; transcripts: Transcript[]; onJump?: (j: TranscriptJump) => void }) {
  return (
    <span className="ae-in-kwocc" role="tooltip">
      {occ.length === 0 ? (
        <span className="ae-in-kwocc__none">No aparece tal cual en lo que se dice{transcripts.length ? "" : " (aún no hay transcripción)"}. Igual guía el estilo del video.</span>
      ) : (
        <>
          <span className="ae-in-kwocc__title">
            “{text}” aparece {occ.length === 1 ? "1 vez" : `${occ.length} veces`}
          </span>
          {occ.slice(0, 4).map((o, i) => {
            const t = transcripts.find((x) => x.id === o.transcriptId);
            if (!t) return null;
            const before = rangeText(t.words, [Math.max(0, o.from - 4), Math.max(0, o.from - 1)]);
            const hit = rangeText(t.words, [o.from, o.to]);
            const after = rangeText(t.words, [Math.min(t.words.length - 1, o.to + 1), Math.min(t.words.length - 1, o.to + 4)]);
            return (
              <button key={i} type="button" className="ae-in-kwocc__item" onClick={() => onJump?.({ assetId: o.assetId, from: o.from, to: o.to, n: Date.now() })} disabled={!onJump}>
                <span className="ae-in-kwocc__t">{formatTime(o.t)}</span>
                <span className="ae-in-kwocc__ctx">
                  {o.from > 0 ? `…${before} ` : ""}
                  <mark>{hit}</mark>
                  {o.to < t.words.length - 1 ? ` ${after}…` : ""}
                </span>
              </button>
            );
          })}
          {occ.length > 4 && <span className="ae-in-kwocc__more">y {occ.length - 4} más</span>}
        </>
      )}
    </span>
  );
}

function AddKeyword({ category, label, onAdd }: { category: Keyword["category"]; label: string; onAdd: (text: string, category: Keyword["category"]) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEscape(input, () => {
    setOpen(false);
    setValue("");
  }, open);
  if (!open) {
    return (
      <button type="button" className="ae-in-kwadd" onClick={() => setOpen(true)} aria-label={`Agregar en ${label}`} title={`Agregar en ${label}`}>
        <Plus size={12} aria-hidden />
      </button>
    );
  }
  const commit = () => {
    if (value.trim()) onAdd(value, category);
    setValue("");
    setOpen(false);
  };
  return (
    <input
      ref={input}
      autoFocus
      className="ae-input ae-input--sm ae-in-kwadd__input"
      placeholder="Escribe y Enter"
      aria-label={`Nueva palabra clave en ${label}`}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      onBlur={commit}
    />
  );
}

// ---------------------------------------------------------------------------- Texto para publicar

export function PublishCopyCard() {
  const api = useApi();
  const { setKeywords, toast } = useActions();
  const { copy, keywords, projectId, hasTranscript } = useEditorShallow((s) => ({
    copy: s.publishCopy,
    keywords: s.keywords,
    projectId: s.project?.id ?? null,
    hasTranscript: s.transcripts.some((t) => t.status === "listo" && t.words.length > 0),
  }));
  const [busy, setBusy] = useState(false);
  const suggest = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      const res = await api.detectKeywords(projectId);
      setKeywords(res.keywords.length ? res.keywords : keywords, res.publishCopy);
    } catch (err) {
      toast({ kind: "error", text: `No se pudo sugerir el texto: ${messageOf(err)}` });
    } finally {
      setBusy(false);
    }
  };
  if (!copy || (!copy.title && !copy.description && !copy.hashtags.length)) {
    return (
      <div className="ae-in-pub is-empty">
        <p className="ae-help">Título, descripción y hashtags sugeridos para publicar, a partir de lo que se dice en el video.</p>
        <Button size="sm" tone="ghost" icon={busy ? <LoaderCircle size={14} className="ae-spin" /> : <ScanSearch size={14} />} onClick={() => void suggest()} disabled={busy || !hasTranscript}>
          Sugerir texto
        </Button>
      </div>
    );
  }
  return <PublishCopyView copy={copy} />;
}

function PublishCopyView({ copy }: { copy: PublishCopy }) {
  const all = [copy.title, copy.description, copy.hashtags.join(" ")].filter(Boolean).join("\n\n");
  return (
    <div className="ae-in-pub">
      <CopyRow label="Título" text={copy.title} big />
      <CopyRow label="Descripción" text={copy.description} />
      {copy.hashtags.length > 0 && <CopyRow label="Hashtags" text={copy.hashtags.join(" ")} chips={copy.hashtags} />}
      {copy.coverText && <CopyRow label="Texto de portada" text={copy.coverText} />}
      <CopyButton text={all} label="Copiar todo" wide />
    </div>
  );
}

function CopyRow({ label, text, big, chips }: { label: string; text: string; big?: boolean; chips?: string[] }) {
  if (!text) return null;
  return (
    <div className="ae-in-pub__row">
      <div className="ae-in-pub__label">
        <span>{label}</span>
        <CopyButton text={text} label={`Copiar ${label.toLowerCase()}`} />
      </div>
      {chips ? (
        <div className="ae-in-pub__tags">
          {chips.map((h) => (
            <span key={h}>{h}</span>
          ))}
        </div>
      ) : (
        <p className={clsx("ae-in-pub__text", big && "is-big")}>{text}</p>
      )}
    </div>
  );
}

function CopyButton({ text, label, wide }: { text: string; label: string; wide?: boolean }) {
  const [done, setDone] = useState(false);
  const run = async () => {
    const ok = await copyText(text);
    if (ok) {
      setDone(true);
      setTimeout(() => setDone(false), 1400);
    }
  };
  if (wide) {
    return (
      <Button size="sm" tone="ink" icon={done ? <Check size={14} /> : <Copy size={14} />} onClick={() => void run()}>
        {done ? "¡Copiado!" : label}
      </Button>
    );
  }
  return <IconButton size="sm" label={done ? "¡Copiado!" : label} icon={done ? <Check size={13} /> : <Copy size={13} />} onClick={() => void run()} />;
}
