/**
 * "¿Cómo quieres el video?" (texto opcional + formato y duración en chips) y "Opciones":
 * interruptores apagados por defecto; al prender uno aparecen solo sus 1–3 ajustes clave.
 */
import type { ProjectSettings } from "@autoeditor/shared";
import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { loadGoogleFont } from "../entrada/dom.js";
import { useActions, useEditor, useEditorShallow } from "../store/context.js";
import { Segmented } from "../ui/index.js";
import { activePreset, CAPTION_PRESETS, DURATION_CHIPS, durationLabel, FORMAT_CHIPS, type CaptionPreset } from "./logic.js";

const EXAMPLES = ["Reel dinámico con subtítulos grandes", "Quita donde me equivoco", "Tono tranquilo y elegante"];

// ---------------------------------------------------------------------------- ¿Cómo quieres el video?

export function HowSection() {
  const { text, format, duration, mode } = useEditorShallow((s) => ({
    text: s.settings.instruction.text,
    format: s.settings.instruction.format,
    duration: s.settings.instruction.targetDuration,
    mode: s.settings.instruction.durationMode,
  }));
  const { updateSettings } = useActions();
  const id = useId();
  const custom = duration != null && !DURATION_CHIPS.includes(duration);
  const [customOpen, setCustomOpen] = useState(custom);
  const [customDraft, setCustomDraft] = useState(custom && duration ? String(duration) : "");

  const setDuration = (d: number | null) =>
    updateSettings((s) => {
      s.instruction.targetDuration = d;
      s.instruction.durationMode = d == null ? "auto" : s.instruction.durationMode === "auto" ? "aproximada" : s.instruction.durationMode;
    });

  const applyCustom = (raw: string) => {
    const n = Math.round(Number(raw.replace(",", ".")));
    if (Number.isFinite(n) && n >= 3 && n <= 1800) setDuration(n);
  };

  return (
    <section className="ae-how" aria-labelledby={`${id}-t`}>
      <label id={`${id}-t`} htmlFor={`${id}-text`} className="ae-how__title">
        ¿Cómo quieres el video? <span className="ae-optional">opcional</span>
      </label>
      <textarea
        id={`${id}-text`}
        className="ae-input ae-how__text"
        rows={3}
        placeholder="Cuéntale a Claude qué quieres: el tono, qué no debe faltar, qué quitar… Si lo dejas vacío, edita en automático."
        value={text}
        maxLength={4000}
        onChange={(e) => updateSettings((s) => void (s.instruction.text = e.target.value))}
      />
      {!text.trim() && (
        <div className="ae-sexamples" aria-label="Ejemplos">
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="ae-sexample" onClick={() => updateSettings((s) => void (s.instruction.text = ex))}>
              {ex}
            </button>
          ))}
        </div>
      )}

      <div className="ae-how__grid">
        <div className="ae-how__group">
          <span className="ae-how__label" id={`${id}-f`}>
            Formato
          </span>
          <div className="ae-chips" role="radiogroup" aria-labelledby={`${id}-f`}>
            {FORMAT_CHIPS.map((f) => (
              <button
                key={f.value}
                type="button"
                role="radio"
                aria-checked={format === f.value}
                className={clsx("ae-fchip", format === f.value && "is-on")}
                title={f.hint}
                onClick={() => updateSettings((s) => void (s.instruction.format = f.value))}
              >
                <span className={clsx("ae-fchip__shape", `is-${f.value.replace(":", "x")}`)} aria-hidden />
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="ae-how__group">
          <span className="ae-how__label" id={`${id}-d`}>
            Duración
          </span>
          <div className="ae-chips" role="radiogroup" aria-labelledby={`${id}-d`}>
            {DURATION_CHIPS.map((d) => (
              <button
                key={String(d)}
                type="button"
                role="radio"
                aria-checked={!customOpen && duration === d}
                className={clsx("ae-dchip", !customOpen && duration === d && "is-on")}
                onClick={() => {
                  setCustomOpen(false);
                  setDuration(d);
                }}
              >
                {durationLabel(d)}
              </button>
            ))}
            <button type="button" role="radio" aria-checked={customOpen} className={clsx("ae-dchip", customOpen && "is-on")} onClick={() => setCustomOpen(true)}>
              Otra
            </button>
          </div>
          {customOpen && (
            <div className="ae-custom">
              <input
                className="ae-input ae-custom__input"
                inputMode="numeric"
                placeholder="p. ej. 75"
                value={customDraft}
                aria-label="Duración en segundos"
                autoFocus
                onChange={(e) => {
                  setCustomDraft(e.target.value);
                  applyCustom(e.target.value);
                }}
              />
              <span>segundos</span>
            </div>
          )}
          {duration != null && (
            <Segmented
              size="sm"
              label="Qué tan exacta"
              className="ae-how__mode"
              value={mode === "exacta" ? "exacta" : "aproximada"}
              onChange={(v) => updateSettings((s) => void (s.instruction.durationMode = v))}
              options={[
                { value: "aproximada", label: "Aproximada", title: "Puede variar unos segundos para no cortar frases" },
                { value: "exacta", label: "Exacta", title: "Dura exactamente lo que pides" },
              ]}
            />
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------- Opciones

type Draft = ProjectSettings;

interface OptionDef {
  key: string;
  label: string;
  help: string;
  on: (s: Draft) => boolean;
  set: (d: Draft, on: boolean) => void;
  ai?: boolean;
  Settings?: () => ReactNode;
}

const OPTIONS: OptionDef[] = [
  {
    key: "captions",
    label: "Subtítulos y textos",
    help: "Palabra por palabra o por frase, con las palabras clave resaltadas.",
    on: (s) => s.captions.enabled,
    set: (d, on) => {
      d.captions.enabled = on;
      d.tools.titles.enabled = on;
    },
    Settings: CaptionSettings,
  },
  {
    key: "broll",
    label: "B-roll automático",
    help: "Tomas de apoyo de fondo o como corte sobre lo que dices.",
    on: (s) => s.tools.broll.enabled,
    set: (d, on) => void (d.tools.broll.enabled = on),
    Settings: BrollSettings,
  },
  {
    key: "music",
    label: "Música",
    help: "Baja sola cuando hablas.",
    on: (s) => s.tools.music.enabled,
    set: (d, on) => void (d.tools.music.enabled = on),
    Settings: MusicSettings,
  },
  {
    key: "clean",
    label: "Quitar silencios y muletillas",
    help: "Pausas largas, “eh”, “este”, arranques en falso.",
    on: (s) => s.tools.removeSilences.enabled || s.tools.removeFillers.enabled,
    set: (d, on) => {
      d.tools.removeSilences.enabled = on;
      d.tools.removeFillers.enabled = on;
    },
    Settings: CleanSettings,
  },
  {
    key: "zooms",
    label: "Zooms / punch-in",
    help: "Acercamientos en las frases importantes.",
    on: (s) => s.tools.zooms.enabled,
    set: (d, on) => void (d.tools.zooms.enabled = on),
    Settings: ZoomSettings,
  },
  {
    key: "motion",
    label: "Motion graphics",
    help: "Títulos y gráficos animados con HyperFrames.",
    on: (s) => s.tools.motionGraphics.enabled,
    set: (d, on) => {
      d.tools.motionGraphics.enabled = on;
      d.tools.motionGraphics.mode = "automatico";
    },
  },
  {
    key: "aiImages",
    label: "IA imágenes",
    help: "Imágenes generadas para apoyar lo que dices.",
    ai: true,
    on: (s) => s.tools.aiImages.enabled,
    set: (d, on) => void (d.tools.aiImages.enabled = on),
    Settings: AiImageSettings,
  },
  {
    key: "aiVideos",
    label: "IA videos",
    help: "Clips cortos generados con IA.",
    ai: true,
    on: (s) => s.tools.aiVideos.enabled,
    set: (d, on) => void (d.tools.aiVideos.enabled = on),
    Settings: AiVideoSettings,
  },
];

export function OptionsSection() {
  const settings = useEditor((s) => s.settings);
  const kieReady = useEditor((s) => s.demo || !!s.config?.capabilities.kie);
  const { updateSettings } = useActions();
  const [open, setOpen] = useState(false);
  const id = useId();
  const onList = OPTIONS.filter((o) => o.on(settings));
  return (
    <section className={clsx("ae-options", open && "is-open")}>
      <button type="button" className="ae-options__toggle" aria-expanded={open} aria-controls={`${id}-list`} onClick={() => setOpen((v) => !v)}>
        <span className="ae-options__title">Opciones</span>
        <span className="ae-options__summary">{onList.length ? onList.map((o) => o.label).join(" · ") : "Todo en automático"}</span>
        <ChevronDown size={16} className={clsx("ae-chev", open && "is-open")} aria-hidden />
      </button>
      {open && (
        <ul id={`${id}-list`} className="ae-options__list">
          {OPTIONS.map((o) => {
            const on = o.on(settings);
            const Settings = o.Settings;
            return (
              <li key={o.key} className={clsx("ae-opt", on && "is-on")}>
                <div className="ae-opt__row">
                  <span className="ae-opt__text">
                    <span className="ae-opt__label">
                      {o.label}
                      {o.ai && <span className="ae-aitag">IA</span>}
                    </span>
                    <span className="ae-opt__help">{o.help}</span>
                  </span>
                  <button type="button" role="switch" aria-checked={on} aria-label={o.label} className={clsx("ae-switch__track", on && "is-on")} onClick={() => updateSettings((d) => o.set(d, !on))}>
                    <span className="ae-switch__thumb" />
                  </button>
                </div>
                {on && Settings && (
                  <div className="ae-opt__settings">
                    <Settings />
                  </div>
                )}
                {on && o.ai && !kieReady && <p className="ae-opt__warn">Para generar con IA falta configurar la llave de Kie AI en el servidor. Sin ella, Claude edita sin esta opción.</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------- Ajustes clave de cada opción

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ae-optrow">
      <span className="ae-optrow__label">{label}</span>
      {children}
    </div>
  );
}

function CaptionSettings() {
  const style = useEditor((s) => s.settings.captions.style);
  const { updateSettings } = useActions();
  const current = activePreset(style);
  useEffect(() => {
    for (const p of CAPTION_PRESETS) if (p.style.font?.googleFont) loadGoogleFont(p.style.font.googleFont);
  }, []);
  return (
    <>
      <div className="ae-presets" role="radiogroup" aria-label="Estilo de texto">
        {CAPTION_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={current === p.id}
            className={clsx("ae-preset", current === p.id && "is-on")}
            title={p.hint}
            onClick={() => updateSettings((d) => void (d.captions.style = { ...d.captions.style, ...p.style }))}
          >
            <PresetThumb preset={p} />
            <span className="ae-preset__label">{p.label}</span>
          </button>
        ))}
      </div>
      <Row label="Ritmo">
        <Segmented
          size="sm"
          label="Cómo aparecen"
          value={style.mode}
          onChange={(v) => updateSettings((d) => void (d.captions.style.mode = v))}
          options={[
            { value: "palabra", label: "Palabra" },
            { value: "frase", label: "Frase" },
            { value: "bloque", label: "Bloque" },
          ]}
        />
      </Row>
    </>
  );
}

function PresetThumb({ preset }: { preset: CaptionPreset }) {
  const s = preset.sample;
  return (
    <span className={clsx("ae-preset__thumb", s.top && "is-top")} aria-hidden>
      <span className={clsx("ae-preset__words", s.box && "is-box")}>
        <span className="ae-preset__lead" style={{ fontFamily: s.leadFont, textTransform: s.upper ? "uppercase" : undefined }}>
          {s.lead}
        </span>
        <span className="ae-preset__key" style={{ fontFamily: s.keyFont, color: s.keyColor, fontStyle: s.keyItalic ? "italic" : undefined, textTransform: s.upper ? "uppercase" : undefined }}>
          {s.key}
        </span>
      </span>
    </span>
  );
}

function BrollSettings() {
  const b = useEditor((s) => s.settings.tools.broll);
  const { updateSettings } = useActions();
  return (
    <>
      <Row label="De dónde">
        <Segmented
          size="sm"
          label="De dónde sale el B-roll"
          value={b.source}
          onChange={(v) => updateSettings((d) => void (d.tools.broll.source = v))}
          options={[
            { value: "material", label: "Tu material" },
            { value: "ia", label: "IA" },
            { value: "ambos", label: "Ambos" },
          ]}
        />
      </Row>
      <Row label="Cuánto">
        <Segmented
          size="sm"
          label="Cuánto B-roll"
          value={b.frequency}
          onChange={(v) => updateSettings((d) => void (d.tools.broll.frequency = v))}
          options={[
            { value: "baja", label: "Poco" },
            { value: "media", label: "Normal" },
            { value: "alta", label: "Mucho" },
          ]}
        />
      </Row>
    </>
  );
}

function MusicSettings() {
  const m = useEditor((s) => s.settings.tools.music);
  const hasMusic = useEditor((s) => s.assets.some((a) => a.category === "musica"));
  const { updateSettings } = useActions();
  return (
    <>
      <Row label="Cuál">
        <Segmented
          size="sm"
          label="De dónde sale la música"
          value={m.source}
          onChange={(v) => updateSettings((d) => void (d.tools.music.source = v))}
          options={[
            { value: "mia", label: "La mía" },
            { value: "biblioteca", label: "Biblioteca" },
            { value: "ia", label: "IA" },
          ]}
        />
      </Row>
      {m.source === "mia" && !hasMusic && <p className="ae-opt__note">Suelta tu canción abajo, en “Todo lo demás”.</p>}
      <Row label="Volumen">
        <input
          type="range"
          className="ae-range"
          min={-30}
          max={-6}
          step={1}
          value={m.gainDb}
          aria-label="Volumen de la música"
          aria-valuetext={m.gainDb <= -22 ? "Muy bajo" : m.gainDb <= -16 ? "Bajo" : m.gainDb <= -11 ? "Medio" : "Alto"}
          onChange={(e) => updateSettings((d) => void (d.tools.music.gainDb = Number(e.target.value)))}
        />
      </Row>
    </>
  );
}

function CleanSettings() {
  const a = useEditor((s) => s.settings.tools.removeSilences.aggressiveness);
  const { updateSettings } = useActions();
  return (
    <Row label="Qué tanto">
      <Segmented
        size="sm"
        label="Qué tanto quitar"
        value={a}
        onChange={(v) => updateSettings((d) => void (d.tools.removeSilences.aggressiveness = v))}
        options={[
          { value: "suave", label: "Suave" },
          { value: "media", label: "Normal" },
          { value: "agresiva", label: "Al grano" },
        ]}
      />
    </Row>
  );
}

function ZoomSettings() {
  const z = useEditor((s) => s.settings.tools.zooms.intensity);
  const { updateSettings } = useActions();
  return (
    <Row label="Intensidad">
      <Segmented
        size="sm"
        label="Intensidad de los zooms"
        value={z}
        onChange={(v) => updateSettings((d) => void (d.tools.zooms.intensity = v))}
        options={[
          { value: "sutil", label: "Sutil" },
          { value: "media", label: "Media" },
          { value: "fuerte", label: "Fuerte" },
        ]}
      />
    </Row>
  );
}

function AiImageSettings() {
  const ai = useEditor((s) => s.settings.tools.aiImages);
  const { updateSettings } = useActions();
  return (
    <>
      <Row label="Cuántas">
        <Segmented
          size="sm"
          label="Cuántas imágenes"
          value={String(Math.min(ai.max, 8)) as "2" | "4" | "8"}
          onChange={(v) => updateSettings((d) => void (d.tools.aiImages.max = Number(v)))}
          options={[
            { value: "2", label: "2" },
            { value: "4", label: "4" },
            { value: "8", label: "8" },
          ]}
        />
      </Row>
      <Row label="Estilo">
        <input className="ae-input ae-input--sm" value={ai.style} aria-label="Estilo de las imágenes" placeholder="fotográfico, natural" onChange={(e) => updateSettings((d) => void (d.tools.aiImages.style = e.target.value))} />
      </Row>
    </>
  );
}

function AiVideoSettings() {
  const ai = useEditor((s) => s.settings.tools.aiVideos);
  const { updateSettings } = useActions();
  return (
    <>
      <Row label="Cuántos">
        <Segmented
          size="sm"
          label="Cuántos clips"
          value={String(Math.min(ai.max, 4)) as "1" | "2" | "4"}
          onChange={(v) => updateSettings((d) => void (d.tools.aiVideos.max = Number(v)))}
          options={[
            { value: "1", label: "1" },
            { value: "2", label: "2" },
            { value: "4", label: "4" },
          ]}
        />
      </Row>
      <Row label="Duración">
        <Segmented
          size="sm"
          label="Duración de cada clip"
          value={ai.duration >= 8 ? "10" : "5"}
          onChange={(v) => updateSettings((d) => void (d.tools.aiVideos.duration = Number(v)))}
          options={[
            { value: "5", label: "5 s" },
            { value: "10", label: "10 s" },
          ]}
        />
      </Row>
    </>
  );
}
