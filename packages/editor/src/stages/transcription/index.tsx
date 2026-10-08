/**
 * Etapa TRANSCRIPCIÓN, SUBTÍTULOS Y PALABRAS CLAVE.
 * - Lienzo: extracto de la transcripción, palabras clave activas y subtítulos (ON/OFF + miniatura en vivo).
 * - Vista enfocada, en pestañas:
 *   · Transcripción: editor sincronizado con el reproductor (saltar, resaltar, marcar, corregir → glosario).
 *   · Palabras clave: chips por categoría + texto sugerido para publicar.
 *   · Subtítulos: estilo con vista previa en vivo sobre un fotograma real y zonas seguras.
 */
import type { Keyword, Transcript } from "@autoeditor/shared";
import clsx from "clsx";
import { AudioLines, Captions, KeyRound, LoaderCircle, Megaphone } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { truncate } from "../../lib/format.js";
import { useActions, useEditor, useEditorShallow, useStageStates } from "../../store/context.js";
import { Chip, EmptyState, OnOffFlag, PostIt, SectionLabel, StageCard } from "../../ui/index.js";
import { CaptionLivePreview, CaptionStyler } from "../../entrada/captions/CaptionStyler.js";
import { KW_TONE, KeywordsPanel, PublishCopyCard } from "../../entrada/transcript/KeywordsPanel.js";
import { LANG_LABELS, TranscriptEditor, type TranscriptJump } from "../../entrada/transcript/TranscriptEditor.js";
import type { StageProps } from "../material/index.js";

const CHIP_TONE: Record<string, "purple" | "mint" | "coral" | "yellow" | "peach" | "neutral" | "ink"> = {
  coral: "coral",
  purple: "purple",
  peach: "peach",
  yellow: "yellow",
  mint: "mint",
  ink: "ink",
  neutral: "neutral",
};

export const kwChipTone = (c: Keyword["category"]) => CHIP_TONE[KW_TONE[c]] ?? "neutral";

function transcriptText(t: Transcript): string {
  return t.words
    .filter((w) => w.mark !== "quitar")
    .map((w) => w.text)
    .join(" ")
    .replace(/\s+([,.;:!?])/g, "$1");
}

export function TranscriptionStage({ variant }: StageProps) {
  const states = useStageStates();
  const { openFocus } = useActions();
  const st = states.transcripcion;
  if (variant === "focus") return <TranscriptionFocus />;
  return (
    <StageCard title="Transcripción" variant="compact" status={st.status} hint={st.status === "vacio" ? undefined : st.hint} onOpen={() => openFocus("transcripcion")} width={296}>
      <TranscriptionCompact />
    </StageCard>
  );
}

// ---------------------------------------------------------------------------- Compacto (lienzo)

function TranscriptionCompact() {
  const { transcripts, keywords, captions } = useEditorShallow((s) => ({ transcripts: s.transcripts, keywords: s.keywords, captions: s.settings.captions }));
  const { updateSettings, openFocus } = useActions();
  const ready = transcripts.filter((t) => t.status === "listo" && t.words.length);
  const busy = transcripts.filter((t) => t.status === "transcribiendo" || t.status === "pendiente").length;
  const first = ready[0];
  const words = ready.reduce((s, t) => s + t.words.length, 0);
  const enabledKw = keywords.filter((k) => k.enabled);
  return (
    <div className="ae-stack">
      {first ? (
        <PostIt className="ae-transcript-note">
          <div className="ae-transcript-note__meta">
            {LANG_LABELS[first.language] ?? first.language} · {words} palabras{ready.length > 1 ? ` · ${ready.length} clips` : ""}
          </div>
          <p>“{truncate(transcriptText(first), 150)}”</p>
        </PostIt>
      ) : busy ? (
        <div className="ae-in-txmini" role="status">
          <LoaderCircle size={14} className="ae-spin" aria-hidden /> Transcribiendo {busy === 1 ? "1 clip" : `${busy} clips`}…
        </div>
      ) : (
        <EmptyState compact icon={<AudioLines size={20} />} title="Sin transcripción todavía">
          Aparece en cuanto subas material con voz. Podrás corregir palabras y se guardan en tu glosario.
        </EmptyState>
      )}
      <div>
        <SectionLabel extra={enabledKw.length > 0 ? <span className="ae-count">{enabledKw.length}</span> : null}>Palabras clave</SectionLabel>
        {enabledKw.length ? (
          <div className="ae-row ae-row--wrap ae-row--tight">
            {enabledKw.slice(0, 7).map((k) => (
              <Chip key={k.id} size="sm" tone={kwChipTone(k.category)}>
                {k.text}
              </Chip>
            ))}
            {enabledKw.length > 7 && (
              <Chip size="sm" tone="outline">
                +{enabledKw.length - 7}
              </Chip>
            )}
          </div>
        ) : (
          <p className="ae-help">Claude las detecta al transcribir (tema, cifras, gancho, llamado a la acción).</p>
        )}
      </div>
      <div className="ae-subrow">
        <div className="ae-subrow__label">
          <span>Subtítulos</span>
          <span className="ae-help">{captions.enabled ? `${captionModeLabel(captions.style.mode)} · ${captions.style.font.family}` : "Sin subtítulos"}</span>
        </div>
        <OnOffFlag checked={captions.enabled} label="Subtítulos" onChange={(v) => updateSettings((d) => void (d.captions.enabled = v))} />
      </div>
      {captions.enabled && (
        <button type="button" className="ae-in-capmini nodrag" onClick={() => openFocus("transcripcion", "subtitulos")} aria-label="Ajustar el estilo de los subtítulos">
          <CaptionLivePreview interactive={false} showSafe={false} maxHeight={150} />
          <span className="ae-in-capmini__text">
            <b>Así se verán</b>
            <span>
              {captions.style.uppercase ? "Mayúsculas" : "Normal"} · {captions.style.position === "abajo" ? "abajo" : captions.style.position === "arriba" ? "arriba" : "al centro"}
              {captions.style.highlightKeywords ? " · resalta palabras clave" : ""}
            </span>
            <span className="ae-in-capmini__cta">Ajustar estilo →</span>
          </span>
        </button>
      )}
    </div>
  );
}

function captionModeLabel(mode: "palabra" | "frase" | "bloque") {
  return mode === "palabra" ? "Palabra por palabra" : mode === "frase" ? "Por frase" : "Por bloque";
}

// ---------------------------------------------------------------------------- Vista enfocada

type Tab = "texto" | "palabras" | "subtitulos";

function TranscriptionFocus() {
  const target = useEditor((s) => s.focus?.target);
  const { transcripts, keywords, captionsOn } = useEditorShallow((s) => ({ transcripts: s.transcripts, keywords: s.keywords, captionsOn: s.settings.captions.enabled }));
  const [tab, setTab] = useState<Tab>(target === "subtitulos" ? "subtitulos" : target === "palabras" ? "palabras" : "texto");
  const [jump, setJump] = useState<TranscriptJump | null>(null);
  const words = transcripts.reduce((s, t) => s + (t.status === "listo" ? t.words.length : 0), 0);
  const busy = transcripts.some((t) => t.status === "transcribiendo" || t.status === "pendiente");
  const tabs: { id: Tab; label: string; icon: ReactNode; badge: ReactNode }[] = [
    { id: "texto", label: "Transcripción", icon: <AudioLines size={15} aria-hidden />, badge: busy ? <LoaderCircle size={12} className="ae-spin" aria-label="Transcribiendo" /> : words ? <span className="ae-count">{words}</span> : null },
    { id: "palabras", label: "Palabras clave", icon: <KeyRound size={15} aria-hidden />, badge: keywords.length ? <span className="ae-count">{keywords.filter((k) => k.enabled).length}</span> : null },
    { id: "subtitulos", label: "Subtítulos", icon: <Captions size={15} aria-hidden />, badge: <span className={clsx("ae-in-tabs__flag", captionsOn && "is-on")}>{captionsOn ? "ON" : "OFF"}</span> },
  ];
  return (
    <div className="ae-in-transfocus">
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <div className="ae-in-transfocus__panel" role="tabpanel" aria-label={tabs.find((t) => t.id === tab)?.label}>
        {tab === "texto" && <TranscriptEditor jump={jump} />}
        {tab === "palabras" && (
          <div className="ae-in-kwlayout">
            <section className="ae-panel" aria-label="Palabras clave">
              <header className="ae-panel__head">
                <h3>
                  <KeyRound size={17} aria-hidden /> Palabras clave
                </h3>
              </header>
              <KeywordsPanel
                onJump={(j) => {
                  setJump(j);
                  setTab("texto");
                }}
              />
            </section>
            <section className="ae-panel ae-in-pubpanel" aria-label="Texto para publicar">
              <header className="ae-panel__head">
                <h3>
                  <Megaphone size={17} aria-hidden /> Texto para publicar
                </h3>
              </header>
              <PublishCopyCard />
            </section>
          </div>
        )}
        {tab === "subtitulos" && <CaptionStyler />}
      </div>
    </div>
  );
}

function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; icon: ReactNode; badge?: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const n = (i + dir + tabs.length) % tabs.length;
    onChange(tabs[n]!.id);
    refs.current[n]?.focus();
  };
  return (
    <div className="ae-in-tabs" role="tablist" aria-label="Secciones">
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          tabIndex={value === t.id ? 0 : -1}
          className={clsx("ae-in-tabs__tab", value === t.id && "is-on")}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.icon}
          <span>{t.label}</span>
          {t.badge}
        </button>
      ))}
    </div>
  );
}

/** Útil para otras etapas: ¿hay voz transcrita? */
export function useHasTranscript() {
  return useEditor((s) => s.transcripts.some((t) => t.status === "listo" && t.words.length > 0));
}
