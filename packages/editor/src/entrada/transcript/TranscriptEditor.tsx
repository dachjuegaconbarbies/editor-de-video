/**
 * Editor de transcripción sincronizado con el reproductor del clip.
 *
 * - Clic en una palabra → el reproductor salta a ese momento. Mientras reproduce, la palabra que
 *   suena se resalta y el texto la sigue.
 * - Arrastrar (o Mayús+clic, o Mayús+flechas) selecciona una frase → "Quitar", "Debe ir", "Resaltar".
 * - Doble clic (o E) corrige una palabra; se guarda con PATCH /transcripts/:id/words y, si está
 *   prendido, en el glosario ("Guardado en tu glosario: Sira → Zyra").
 * - Muletillas atenuadas, palabras dudosas subrayadas, palabras clave marcadas, separación por hablante.
 * - Teclado: Espacio reproduce/pausa · ←/→ mueven · Mayús extiende · Q/D/R marcan · E corrige · Esc limpia.
 */
import type { Asset, Keyword, Transcript, TranscriptWord } from "@autoeditor/shared";
import clsx from "clsx";
import { AudioLines, Eraser, Highlighter, LoaderCircle, Pencil, RefreshCw, Scissors, Star, TriangleAlert, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent, type ReactElement } from "react";
import { messageOf } from "../../api/errors.js";
import { formatDuration, plural } from "../../lib/format.js";
import { useActions, useApi, useEditorShallow } from "../../store/context.js";
import { Button, EmptyState, IconButton, Kbd, Switch } from "../../ui/index.js";
import { kindIcon } from "../../stages/material/assets.js";
import { useEscape } from "../dom.js";
import { ClipPlayer, formatTime, type ClipPlayerHandle } from "../media/ClipPlayer.js";
import {
  activeWordIndex,
  correctedText,
  glossaryPair,
  groupParagraphs,
  isLowConfidence,
  keywordPositions,
  markEdits,
  moveSelection,
  normalizeRange,
  rangeText,
  sameWordEdits,
  speakerLabels,
  transcriptStats,
  type Paragraph,
  type WordMark,
} from "./model.js";
import { useTranscriptSave } from "./useTranscriptSave.js";

export const LANG_LABELS: Record<string, string> = { es: "Español", en: "Inglés", pt: "Portugués", fr: "Francés", it: "Italiano", de: "Alemán", auto: "Automático" };

/** Pedido para saltar a un lugar (p. ej. desde una palabra clave). */
export interface TranscriptJump {
  assetId: string;
  from: number;
  to: number;
  n: number;
}

type Sel = { a: number; b: number } | null;

const MARK_ACTIONS: { mark: WordMark; label: string; key: string; icon: ReactElement; help: string }[] = [
  { mark: "quitar", label: "Quitar", key: "Q", icon: <Scissors size={14} aria-hidden />, help: "Claude corta esta parte del video." },
  { mark: "debe-ir", label: "Debe ir", key: "D", icon: <Star size={14} aria-hidden />, help: "Claude la incluye sí o sí." },
  { mark: "resaltar", label: "Resaltar", key: "R", icon: <Highlighter size={14} aria-hidden />, help: "Se destaca en subtítulos y con un gráfico o zoom." },
];

/** Clips con transcripción (o transcribiéndose), en el orden del material. */
export function useTranscriptClips() {
  const { transcripts, assets } = useEditorShallow((s) => ({ transcripts: s.transcripts, assets: s.assets }));
  return useMemo(() => {
    const out: { asset: Asset; transcript: Transcript }[] = [];
    for (const a of assets) {
      const t = transcripts.find((x) => x.assetId === a.id);
      if (t) out.push({ asset: a, transcript: t });
    }
    return out;
  }, [transcripts, assets]);
}

export function TranscriptEditor({ jump }: { jump?: TranscriptJump | null }) {
  const clips = useTranscriptClips();
  const { keywords, transcription } = useEditorShallow((s) => ({ keywords: s.keywords, transcription: s.settings.transcription }));
  const [assetId, setAssetId] = useState<string | null>(null);
  const current = clips.find((c) => c.asset.id === assetId) ?? clips.find((c) => c.transcript.status === "listo") ?? clips[0];

  useEffect(() => {
    if (jump && clips.some((c) => c.asset.id === jump.assetId)) setAssetId(jump.assetId);
  }, [jump, clips]);

  if (!current) {
    return (
      <EmptyState icon={<AudioLines size={22} />} title="Todavía no hay transcripción">
        {transcription.enabled ? "Aparece sola en cuanto subas un video o una nota de voz con alguien hablando. Cada palabra trae su tiempo exacto." : "La transcripción está apagada en este proyecto."}
      </EmptyState>
    );
  }
  return (
    <div className="ae-in-tx">
      {clips.length > 1 && <ClipPicker clips={clips} value={current.asset.id} onChange={setAssetId} />}
      <ClipTranscript key={current.transcript.id} asset={current.asset} transcript={current.transcript} keywords={keywords} jump={jump && jump.assetId === current.asset.id ? jump : null} />
    </div>
  );
}

function ClipPicker({ clips, value, onChange }: { clips: { asset: Asset; transcript: Transcript }[]; value: string; onChange: (id: string) => void }) {
  const api = useApi();
  return (
    <div className="ae-in-tx__clips" role="tablist" aria-label="Clip a revisar">
      {clips.map(({ asset, transcript }) => {
        const thumb = api.assetThumbnailUrl(asset);
        const on = asset.id === value;
        return (
          <button key={asset.id} type="button" role="tab" aria-selected={on} className={clsx("ae-in-tx__clip", on && "is-on")} onClick={() => onChange(asset.id)} title={asset.originalName}>
            <span className="ae-in-tx__clipthumb">{thumb ? <img src={thumb} alt="" /> : kindIcon(asset, 14)}</span>
            <span className="ae-in-tx__clipname">{asset.originalName}</span>
            {transcript.status === "transcribiendo" || transcript.status === "pendiente" ? (
              <LoaderCircle size={12} className="ae-spin" aria-label="Transcribiendo" />
            ) : transcript.status === "error" ? (
              <TriangleAlert size={12} aria-label="Error" />
            ) : (
              <span className="ae-in-tx__clipn">{transcript.words.length}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function ClipTranscript({ asset, transcript, keywords, jump }: { asset: Asset; transcript: Transcript; keywords: Keyword[]; jump: TranscriptJump | null }) {
  const api = useApi();
  const { toast, updateSettings } = useActions();
  const transcription = useEditorShallow((s) => s.settings.transcription);
  const save = useTranscriptSave();
  const player = useRef<ClipPlayerHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const words = transcript.words;
  const [active, setActive] = useState(-1);
  const activeRef = useRef(-1);
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState<Sel>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [glossary, setGlossary] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const dragging = useRef(false);
  const moved = useRef(false);

  const paragraphs = useMemo(() => groupParagraphs(transcript), [transcript]);
  const kwPos = useMemo(() => keywordPositions(words, keywords), [words, keywords]);
  const speakers = useMemo(() => speakerLabels(words), [words]);
  const stats = useMemo(() => transcriptStats(transcript), [transcript]);
  const range = sel ? normalizeRange(sel.a, sel.b) : null;

  const onTime = useCallback(
    (t: number) => {
      const idx = activeWordIndex(words, t);
      if (idx !== activeRef.current) {
        activeRef.current = idx;
        setActive(idx);
      }
    },
    [words],
  );

  // Sigue a la palabra que suena (solo mientras reproduce).
  useEffect(() => {
    if (!playing || active < 0 || !box.current) return;
    const el = box.current.querySelector<HTMLElement>(`[data-p="${active}"]`);
    if (!el) return;
    const b = box.current.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < b.top + 24 || r.bottom > b.bottom - 24) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active, playing]);

  // Saltar desde fuera (p. ej. una palabra clave).
  useEffect(() => {
    if (!jump) return;
    setSel({ a: jump.from, b: jump.to });
    const w = words[jump.from];
    if (w) player.current?.seek(w.start);
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>(`[data-p="${jump.from}"]`)?.scrollIntoView({ block: "center" }));
  }, [jump, words]);

  useEscape(
    box,
    () => {
      if (editing != null) return true;
      if (!sel) return false;
      setSel(null);
      return true;
    },
    true,
  );

  const seekTo = (p: number, play = false) => {
    const w = words[p];
    if (w) player.current?.seek(Math.max(0, w.start - 0.02), play);
  };

  const applyMark = (mark: WordMark | null) => {
    if (!range) return;
    const edits = markEdits(words, range, mark);
    if (!edits.length) return;
    void save(transcript.id, edits, false);
  };

  const commitEdit = async (p: number, typed: string) => {
    setEditing(null);
    box.current?.focus({ preventScroll: true });
    const w = words[p];
    if (!w) return;
    const next = correctedText(w.text, typed);
    if (next === w.text) return;
    const ok = await save(transcript.id, [{ i: w.i, text: next }], glossary);
    if (!ok) return;
    const pair = glossaryPair(w.original ?? w.text, next);
    const others = sameWordEdits(words, w.text, next, w.i);
    const msg = glossary && pair ? `Guardado en tu glosario: ${pair.wrong} → ${pair.right}` : "Palabra corregida.";
    toast({
      kind: "exito",
      text: others.length ? `${msg} Aparece ${plural(others.length, "vez más", "veces más")}.` : msg,
      action: others.length ? { label: `Corregir ${others.length === 1 ? "la otra" : `las otras ${others.length}`}`, run: () => void save(transcript.id, others, false) } : undefined,
    });
  };

  const retranscribe = async () => {
    setRetrying(true);
    try {
      await api.retranscribe(asset.id);
      toast({ kind: "info", text: `Volviendo a transcribir “${asset.originalName}”… Tus correcciones del glosario se aplican solas.` });
    } catch (err) {
      toast({ kind: "error", text: `No se pudo volver a transcribir: ${messageOf(err)}` });
    } finally {
      setRetrying(false);
    }
  };

  // ------------------------------------------------------------------ Ratón (delegado)
  const posOf = (e: { target: EventTarget }) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-p]");
    return el ? Number(el.dataset.p) : null;
  };
  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const p = posOf(e);
    if (p == null || editing != null) return;
    e.preventDefault();
    box.current?.focus({ preventScroll: true });
    if (e.shiftKey && sel) {
      setSel({ a: sel.a, b: p });
      return;
    }
    dragging.current = true;
    moved.current = false;
    setSel({ a: p, b: p });
    const up = () => {
      dragging.current = false;
      window.removeEventListener("mouseup", up);
      if (!moved.current) seekTo(p);
    };
    window.addEventListener("mouseup", up);
  };
  const onMouseOver = (e: MouseEvent) => {
    if (!dragging.current) return;
    const p = posOf(e);
    if (p == null) return;
    setSel((s) => {
      if (!s || s.b === p) return s;
      moved.current = true;
      return { a: s.a, b: p };
    });
  };
  const onDoubleClick = (e: MouseEvent) => {
    const p = posOf(e);
    if (p != null) {
      setSel({ a: p, b: p });
      setEditing(p);
    }
  };

  // ------------------------------------------------------------------ Teclado
  const onKeyDown = (e: KeyboardEvent) => {
    if (editing != null || e.target !== box.current) return;
    const key = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (key === "arrowright" || key === "arrowleft") {
      e.preventDefault();
      const next = moveSelection(sel, key === "arrowright" ? 1 : -1, e.shiftKey, words.length);
      setSel(next);
      if (next && !e.shiftKey) {
        seekTo(next.b);
        box.current?.querySelector<HTMLElement>(`[data-p="${next.b}"]`)?.scrollIntoView({ block: "nearest" });
      }
    } else if (key === " ") {
      e.preventDefault();
      player.current?.toggle();
    } else if (key === "enter" && range) {
      e.preventDefault();
      seekTo(range[0], true);
    } else if ((key === "e" || key === "f2") && sel) {
      e.preventDefault();
      setEditing(sel.b);
    } else if (key === "q" || key === "delete" || key === "backspace") {
      e.preventDefault();
      applyMark("quitar");
    } else if (key === "d") {
      e.preventDefault();
      applyMark("debe-ir");
    } else if (key === "r") {
      e.preventDefault();
      applyMark("resaltar");
    } else if (key === "x") {
      e.preventDefault();
      applyMark(null);
    }
  };
  const onCopy = (e: ClipboardEvent) => {
    if (!range) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", rangeText(words, range));
  };

  const lastEnd = words[words.length - 1]?.end ?? 0;
  const busy = transcript.status === "transcribiendo" || transcript.status === "pendiente";

  return (
    <div className="ae-in-tx__body">
      <div className="ae-in-tx__left">
        <ClipPlayer ref={player} asset={asset} size="md" onTime={onTime} onPlayingChange={setPlaying} fallbackDuration={lastEnd || undefined} />
        {transcript.status === "listo" && (
          <dl className="ae-in-tx__stats">
            <div>
              <dt>Palabras</dt>
              <dd>{stats.words}</dd>
            </div>
            <div>
              <dt>Duración</dt>
              <dd>{formatDuration(stats.duration)}</dd>
            </div>
            <div>
              <dt>Muletillas</dt>
              <dd>{stats.fillers}</dd>
            </div>
            <div>
              <dt>Corregidas</dt>
              <dd>{stats.edited}</dd>
            </div>
          </dl>
        )}
        <div className="ae-in-tx__opts">
          <label className="ae-in-tx__lang">
            <span>Idioma</span>
            <select
              className="ae-input ae-input--sm"
              value={transcription.language}
              onChange={(e) => updateSettings((d) => void (d.transcription.language = e.target.value))}
              aria-label="Idioma de la transcripción"
            >
              {["auto", "es", "en", "pt", "fr", "it", "de"].map((l) => (
                <option key={l} value={l}>
                  {LANG_LABELS[l]}
                </option>
              ))}
            </select>
          </label>
          <Switch label="Separar por hablante" checked={transcription.diarization} onChange={(v) => updateSettings((d) => void (d.transcription.diarization = v))} />
          <Button size="sm" tone="ghost" icon={retrying ? <LoaderCircle size={14} className="ae-spin" /> : <RefreshCw size={14} />} onClick={() => void retranscribe()} disabled={retrying || busy}>
            Volver a transcribir
          </Button>
          <p className="ae-help">Detectado: {LANG_LABELS[transcript.language] ?? transcript.language} · {transcript.provider === "demo" ? "transcripción de prueba" : transcript.model || transcript.provider}</p>
        </div>
      </div>

      <div className="ae-in-tx__right">
        <SelectionBar
          words={words}
          range={range}
          onMark={applyMark}
          onEdit={() => sel && setEditing(sel.b)}
          onPlay={() => range && seekTo(range[0], true)}
          onClear={() => setSel(null)}
        />
        {busy ? (
          <div className="ae-in-tx__busy" role="status">
            <LoaderCircle size={16} className="ae-spin" aria-hidden /> Transcribiendo “{asset.originalName}”… las palabras aparecen en cuanto termine.
            <div className="ae-in-tx__skeleton" aria-hidden>
              <span />
              <span />
              <span />
            </div>
          </div>
        ) : transcript.status === "error" ? (
          <div className="ae-in-tx__error" role="alert">
            <TriangleAlert size={16} aria-hidden />
            <div>
              <b>No se pudo transcribir este clip.</b>
              <p>{transcript.error ?? "Intenta de nuevo; si sigue fallando, revisa que el archivo tenga audio."}</p>
            </div>
            <Button size="sm" tone="ink" icon={<RefreshCw size={14} />} onClick={() => void retranscribe()} disabled={retrying}>
              Reintentar
            </Button>
          </div>
        ) : words.length === 0 ? (
          <EmptyState compact icon={<AudioLines size={20} />} title="Sin palabras">
            No detectamos voz en este clip. Si sí hay alguien hablando, vuelve a transcribir.
          </EmptyState>
        ) : (
          <div
            ref={box}
            className={clsx("ae-in-tx__words", dragging.current && "is-dragging")}
            tabIndex={0}
            role="group"
            aria-label={`Transcripción de ${asset.originalName}. Clic en una palabra para saltar; arrastra para elegir una frase; doble clic para corregir.`}
            onMouseDown={onMouseDown}
            onMouseOver={onMouseOver}
            onDoubleClick={onDoubleClick}
            onKeyDown={onKeyDown}
            onCopy={onCopy}
          >
            {paragraphs.map((para) => (
              <ParagraphView
                key={para.id}
                para={para}
                words={words}
                active={active >= para.from && active <= para.to ? active : -1}
                selFrom={range && range[1] >= para.from && range[0] <= para.to ? range[0] : -1}
                selTo={range && range[1] >= para.from && range[0] <= para.to ? range[1] : -1}
                editing={editing != null && editing >= para.from && editing <= para.to ? editing : -1}
                kwPos={kwPos}
                speaker={para.speaker ? (speakers.get(para.speaker) ?? null) : null}
                onSeek={(p) => seekTo(p, true)}
                onCommit={commitEdit}
                onCancel={() => {
                  setEditing(null);
                  box.current?.focus({ preventScroll: true });
                }}
              />
            ))}
          </div>
        )}
        <div className="ae-in-tx__foot">
          <Legend />
          <Switch label="Guardar correcciones en mi glosario" checked={glossary} onChange={setGlossary} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- Barra de selección

function SelectionBar({
  words,
  range,
  onMark,
  onEdit,
  onPlay,
  onClear,
}: {
  words: TranscriptWord[];
  range: [number, number] | null;
  onMark: (m: WordMark | null) => void;
  onEdit: () => void;
  onPlay: () => void;
  onClear: () => void;
}) {
  if (!range) {
    return (
      <div className="ae-in-tx__bar is-hint">
        <span>
          <b>Clic</b> en una palabra para saltar ahí · <b>arrastra</b> para elegir una frase · <b>doble clic</b> para corregir
        </span>
        <span className="ae-in-tx__keys" aria-hidden>
          <Kbd>Espacio</Kbd> reproduce
        </span>
      </div>
    );
  }
  const [a, b] = range;
  const slice = words.slice(a, b + 1);
  const n = slice.length;
  const marks = new Set(slice.map((w) => w.mark));
  const text = rangeText(words, range);
  return (
    <div className="ae-in-tx__bar" role="toolbar" aria-label="Acciones de la selección">
      <button type="button" className="ae-in-tx__seltext" onClick={onPlay} title="Reproducir desde aquí (Enter)">
        <span className="ae-in-tx__selq">“{text.length > 64 ? `${text.slice(0, 62)}…` : text}”</span>
        <span className="ae-in-tx__seltime">
          {plural(n, "palabra", "palabras")} · {formatTime(slice[0]!.start)}–{formatTime(slice[n - 1]!.end)}
        </span>
      </button>
      <div className="ae-in-tx__actions">
        {MARK_ACTIONS.map((m) => {
          const on = marks.size === 1 && marks.has(m.mark);
          return (
            <button key={m.mark} type="button" className={clsx("ae-in-markbtn", `is-${m.mark}`, on && "is-on")} aria-pressed={on} onClick={() => onMark(m.mark)} title={`${m.help} (${m.key})${on ? " · clic otra vez para quitar la marca" : ""}`}>
              {m.icon}
              <span>{m.label}</span>
              <kbd>{m.key}</kbd>
            </button>
          );
        })}
        {n === 1 && (
          <button type="button" className="ae-in-markbtn" onClick={onEdit} title="Corregir la palabra (E o doble clic)">
            <Pencil size={14} aria-hidden />
            <span>Corregir</span>
            <kbd>E</kbd>
          </button>
        )}
        {[...marks].some(Boolean) && <IconButton size="sm" label="Limpiar marcas (X)" icon={<Eraser size={14} />} onClick={() => onMark(null)} />}
        <IconButton size="sm" label="Quitar selección (Esc)" icon={<X size={14} />} onClick={onClear} />
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="ae-in-tx__legend" aria-label="Qué significa cada color">
      <span>
        <i className="is-quitar" /> Quitar
      </span>
      <span>
        <i className="is-debe-ir" /> Debe ir
      </span>
      <span>
        <i className="is-resaltar" /> Resaltar
      </span>
      <span>
        <i className="is-kw" /> Palabra clave
      </span>
      <span>
        <i className="is-filler" /> Muletilla
      </span>
      <span>
        <i className="is-doubt" /> Revisar
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------- Párrafo (memo)

interface ParagraphProps {
  para: Paragraph;
  words: TranscriptWord[];
  active: number;
  selFrom: number;
  selTo: number;
  editing: number;
  kwPos: Set<number>;
  speaker: { label: string; n: number } | null;
  onSeek: (p: number) => void;
  onCommit: (p: number, text: string) => void;
  onCancel: () => void;
}

const ParagraphView = memo(function ParagraphView({ para, words, active, selFrom, selTo, editing, kwPos, speaker, onSeek, onCommit, onCancel }: ParagraphProps) {
  const items: ReactElement[] = [];
  for (let p = para.from; p <= para.to; p++) {
    const w = words[p]!;
    if (p === editing) {
      items.push(<WordInput key={w.i} word={w} onCommit={(t) => onCommit(p, t)} onCancel={onCancel} />);
      continue;
    }
    const selected = selFrom !== -1 && p >= selFrom && p <= selTo;
    const edited = w.original != null && w.original !== w.text;
    items.push(
      <span
        key={w.i}
        data-p={p}
        className={clsx(
          "ae-in-w",
          w.mark && `is-${w.mark}`,
          w.filler && "is-filler",
          isLowConfidence(w) && !edited && "is-doubt",
          kwPos.has(p) && "is-kw",
          edited && "is-edited",
          p === active && "is-active",
          selected && "is-sel",
          selected && p === selFrom && "is-sel-start",
          selected && p === selTo && "is-sel-end",
        )}
        title={edited ? `Antes: “${w.original}”` : isLowConfidence(w) ? "Poca seguridad: revisa esta palabra" : undefined}
      >
        {w.text}
      </span>,
    );
    if (p < para.to) items.push(<span key={`s${w.i}`} className={clsx("ae-in-ws", selected && p < selTo && "is-sel")}> </span>);
  }
  return (
    <p className={clsx("ae-in-para", speaker && `has-speaker ae-in-para--s${((speaker.n - 1) % 4) + 1}`)}>
      <span className="ae-in-para__head">
        <button type="button" className="ae-in-para__time" onClick={() => onSeek(para.from)} title="Reproducir desde aquí" tabIndex={-1}>
          {formatTime(para.start)}
        </button>
        {speaker && <span className="ae-in-para__speaker">{speaker.label}</span>}
      </span>
      <span className="ae-in-para__text">{items}</span>
    </p>
  );
});

function WordInput({ word, onCommit, onCancel }: { word: TranscriptWord; onCommit: (text: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(word.text);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  useEscape(ref, () => {
    done.current = true;
    onCancel();
  });
  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit(value);
  };
  return (
    <span className="ae-in-wedit">
      <input
        ref={ref}
        className="ae-in-wedit__input"
        value={value}
        aria-label={`Corregir “${word.text}”`}
        style={{ width: `${Math.max(3, value.length + 1)}ch` }}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          e.stopPropagation();
        }}
        onBlur={commit}
        onMouseDown={(e) => e.stopPropagation()}
      />
      <span className="ae-in-wedit__hint" aria-hidden>
        Enter guarda · Esc cancela
      </span>
    </span>
  );
}
