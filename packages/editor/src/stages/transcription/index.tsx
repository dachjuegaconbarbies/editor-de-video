/**
 * Etapa TRANSCRIPCIÓN, SUBTÍTULOS Y PALABRAS CLAVE (versión base; la ola 2 la profundiza).
 * - Transcripción palabra por palabra (resumen en el lienzo, texto completo en la vista enfocada).
 * - Palabras clave como chips editables.
 * - Subtítulos con su ON/OFF y una vista previa del estilo.
 */
import type { CaptionStyle, Keyword, Transcript } from "@autoeditor/shared";
import clsx from "clsx";
import { AudioLines, Plus } from "lucide-react";
import { nanoid } from "nanoid";
import { useMemo, useState } from "react";
import { truncate } from "../../lib/format.js";
import { useActions, useApi, useEditor, useEditorShallow, useStageStates } from "../../store/context.js";
import { Chip, EmptyState, Field, OnOffFlag, PostIt, SectionLabel, Segmented, StageCard, Switch } from "../../ui/index.js";
import type { StageProps } from "../material/index.js";

const LANG_LABELS: Record<string, string> = { es: "Español", en: "Inglés", pt: "Portugués", auto: "Automático" };

const KW_TONE: Record<Keyword["category"], "purple" | "mint" | "coral" | "yellow" | "peach" | "neutral"> = {
  gancho: "coral",
  cta: "coral",
  cifra: "yellow",
  nombre: "peach",
  beneficio: "mint",
  tema: "purple",
  otro: "neutral",
};

function transcriptText(t: Transcript): string {
  return t.words.map((w) => w.text).join(" ").replace(/\s+([,.;:!?])/g, "$1");
}

export function TranscriptionStage({ variant }: StageProps) {
  const states = useStageStates();
  const { openFocus } = useActions();
  const st = states.transcripcion;
  if (variant === "focus") return <TranscriptionFocus />;
  return (
    <StageCard title="Transcripción" variant="compact" status={st.status} hint={st.hint} onOpen={() => openFocus("transcripcion")} width={296}>
      <TranscriptionCompact />
    </StageCard>
  );
}

function TranscriptionCompact() {
  const { transcripts, keywords, captions } = useEditorShallow((s) => ({ transcripts: s.transcripts, keywords: s.keywords, captions: s.settings.captions }));
  const { updateSettings } = useActions();
  const ready = transcripts.filter((t) => t.status === "listo" && t.words.length);
  const first = ready[0];
  const words = ready.reduce((s, t) => s + t.words.length, 0);
  const enabledKw = keywords.filter((k) => k.enabled);
  return (
    <div className="ae-stack">
      {first ? (
        <PostIt className="ae-transcript-note">
          <div className="ae-transcript-note__meta">
            {LANG_LABELS[first.language] ?? first.language} · {words} palabras
          </div>
          <p>“{truncate(transcriptText(first), 150)}”</p>
        </PostIt>
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
              <Chip key={k.id} size="sm" tone={KW_TONE[k.category]}>
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
          <span className="ae-help">{captions.enabled ? captionModeLabel(captions.style.mode) : "Sin subtítulos"}</span>
        </div>
        <OnOffFlag
          checked={captions.enabled}
          label="Subtítulos"
          onChange={(v) =>
            updateSettings((d) => {
              d.captions.enabled = v;
            })
          }
        />
      </div>
      {captions.enabled && <CaptionPreview style={captions.style} />}
    </div>
  );
}

function captionModeLabel(mode: CaptionStyle["mode"]) {
  return mode === "palabra" ? "Palabra por palabra" : mode === "frase" ? "Por frase" : "Por bloque";
}

export function CaptionPreview({ style, frameUrl, large }: { style: CaptionStyle; frameUrl?: string | null; large?: boolean }) {
  const text = ["ASÍ SE VEN", "TUS", "SUBTÍTULOS"];
  const fmt = (t: string) => (style.uppercase ? t.toUpperCase() : t.charAt(0) + t.slice(1).toLowerCase());
  return (
    <div className={clsx("ae-capprev", large && "ae-capprev--lg", `ae-capprev--${style.position}`)} style={frameUrl ? { backgroundImage: `linear-gradient(rgba(0,0,0,.15), rgba(0,0,0,.35)), url("${frameUrl}")` } : undefined} aria-label="Vista previa de subtítulos">
      <span
        className={clsx("ae-capprev__text", style.background === "caja" && "has-box")}
        style={{
          color: style.primaryColor,
          fontFamily: `"${style.font.family}", var(--ae-font)`,
          fontWeight: style.font.weight,
          WebkitTextStroke: style.background === "ninguno" && style.outlineWidth ? `${Math.min(2, style.outlineWidth / 4)}px ${style.outlineColor}` : undefined,
          background: style.background === "caja" ? style.boxColor : undefined,
        }}
      >
        {fmt(text[0]!)} <span style={{ color: style.highlightColor }}>{fmt(text[1]!)}</span> {fmt(text[2]!)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------- Vista enfocada

function TranscriptionFocus() {
  const { transcripts, keywords, captions, assets, projectId } = useEditorShallow((s) => ({
    transcripts: s.transcripts,
    keywords: s.keywords,
    captions: s.settings.captions,
    assets: s.assets,
    projectId: s.project?.id ?? null,
  }));
  const { updateSettings, setKeywords } = useActions();
  const api = useApi();
  const [kwText, setKwText] = useState("");
  const ready = transcripts.filter((t) => t.status === "listo");
  const frameAsset = assets.find((a) => a.category === "crudo-video" && a.analysis.role !== "b-roll") ?? assets.find((a) => a.category === "crudo-video");
  const frameUrl = frameAsset ? api.assetThumbnailUrl(frameAsset) : null;
  const kwSet = useMemo(() => new Set(keywords.filter((k) => k.enabled).map((k) => k.text.toLowerCase())), [keywords]);

  const saveKeywords = (next: Keyword[]) => {
    setKeywords(next);
    if (projectId) void api.putKeywords(projectId, next).catch(() => undefined);
  };
  const addKeyword = () => {
    const t = kwText.trim();
    if (!t) return;
    saveKeywords([...keywords, { id: nanoid(8), text: t, category: "otro", source: "usuario", enabled: true, occurrences: [], score: 1 }]);
    setKwText("");
  };
  const setStyle = (fn: (s: CaptionStyle) => void) => updateSettings((d) => fn(d.captions.style));

  return (
    <div className="ae-trans-focus">
      <section className="ae-panel ae-trans-focus__text" aria-label="Transcripción">
        <header className="ae-panel__head">
          <h3>Transcripción</h3>
          {ready[0] && <span className="ae-help">{LANG_LABELS[ready[0].language] ?? ready[0].language}</span>}
        </header>
        {ready.length === 0 ? (
          <EmptyState icon={<AudioLines size={22} />} title="Todavía no hay transcripción">
            Aparece en cuanto subas material con voz. Cada palabra trae su tiempo exacto.
          </EmptyState>
        ) : (
          ready.map((t) => {
            const asset = assets.find((a) => a.id === t.assetId);
            return (
              <div key={t.id} className="ae-transcript">
                <div className="ae-transcript__file">{asset?.originalName ?? "Archivo"}</div>
                <p className="ae-transcript__words">
                  {t.words.map((w) => (
                    <span
                      key={w.i}
                      className={clsx("ae-word", w.mark && `is-${w.mark}`, w.filler && "is-filler", kwSet.has(w.text.toLowerCase().replace(/[.,!?¿¡]/g, "")) && "is-keyword")}
                      title={`${w.start.toFixed(2)} s`}
                    >
                      {w.text}{" "}
                    </span>
                  ))}
                </p>
              </div>
            );
          })
        )}
      </section>
      <div className="ae-trans-focus__side">
        <section className="ae-panel" aria-label="Palabras clave">
          <header className="ae-panel__head">
            <h3>Palabras clave</h3>
            <span className="ae-count">{keywords.filter((k) => k.enabled).length}</span>
          </header>
          <p className="ae-help">Se resaltan en los subtítulos y guían dónde van gráficos, zooms, SFX y B-roll.</p>
          <div className="ae-row ae-row--wrap">
            {keywords.map((k) => (
              <Chip
                key={k.id}
                tone={k.enabled ? KW_TONE[k.category] : "outline"}
                className={clsx(!k.enabled && "is-disabled")}
                onRemove={() => saveKeywords(keywords.filter((x) => x.id !== k.id))}
                removeLabel={`Quitar ${k.text}`}
              >
                {k.text}
              </Chip>
            ))}
          </div>
          <div className="ae-row">
            <input className="ae-input ae-input--sm ae-grow" placeholder="Agregar palabra o frase" aria-label="Agregar palabra clave" value={kwText} onChange={(e) => setKwText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addKeyword()} />
            <button type="button" className="ae-btn ae-btn--ghost ae-btn--sm" onClick={addKeyword}>
              <Plus size={14} aria-hidden />
              <span className="ae-btn__label">Agregar</span>
            </button>
          </div>
        </section>
        <section className="ae-panel" aria-label="Subtítulos">
          <header className="ae-panel__head">
            <h3>Subtítulos</h3>
            <OnOffFlag checked={captions.enabled} label="Subtítulos" onChange={(v) => updateSettings((d) => void (d.captions.enabled = v))} />
          </header>
          <CaptionPreview style={captions.style} frameUrl={frameUrl} large />
          <Field label="Estilo">
            <Segmented
              label="Estilo de subtítulos"
              value={captions.style.mode}
              onChange={(mode) => setStyle((s) => void (s.mode = mode))}
              options={[
                { value: "palabra", label: "Palabra por palabra" },
                { value: "frase", label: "Por frase" },
                { value: "bloque", label: "Por bloque" },
              ]}
            />
          </Field>
          <Field label="Posición">
            <Segmented
              label="Posición de subtítulos"
              value={captions.style.position}
              onChange={(position) => setStyle((s) => void (s.position = position))}
              options={[
                { value: "arriba", label: "Arriba" },
                { value: "centro", label: "Centro" },
                { value: "abajo", label: "Abajo" },
              ]}
            />
          </Field>
          <Switch label="Mayúsculas" checked={captions.style.uppercase} onChange={(v) => setStyle((s) => void (s.uppercase = v))} />
          <Switch label="Resaltar palabras clave" checked={captions.style.highlightKeywords} onChange={(v) => setStyle((s) => void (s.highlightKeywords = v))} />
          <Switch label="Exportar .srt y .vtt" checked={captions.exportFiles} onChange={(v) => updateSettings((d) => void (d.captions.exportFiles = v))} />
        </section>
      </div>
    </div>
  );
}

/** Útil para otras etapas: ¿hay voz transcrita? */
export function useHasTranscript() {
  return useEditor((s) => s.transcripts.some((t) => t.status === "listo" && t.words.length > 0));
}
