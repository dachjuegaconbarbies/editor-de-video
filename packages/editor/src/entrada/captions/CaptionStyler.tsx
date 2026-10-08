/**
 * Estilo de SUBTÍTULOS con vista previa EN VIVO sobre un fotograma real del video
 * (GET /assets/:id/frame?t=…), con las zonas seguras de la plataforma (SAFE_ZONES) como guía,
 * el texto real de la transcripción y la animación elegida. Todo cambio se guarda en
 * settings.captions (autoguardado + deshacer).
 */
import { PLATFORM_LABELS, type Asset, type CaptionStyle, type Platform, type ProjectSettings } from "@autoeditor/shared";
import clsx from "clsx";
import { CircleCheck, Pause, Play, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useActions, useApi, useEditorShallow } from "../../store/context.js";
import { Field, OnOffFlag, Segmented, Switch } from "../../ui/index.js";
import { fontFamilyFromFile, loadFontFile, loadGoogleFont, useElementWidth } from "../dom.js";
import { formatTime } from "../media/ClipPlayer.js";
import { captionPreviewLayout, captionWordsFromTranscript, displayText, emojiFor, lineAt, previewLines, SAMPLE_WORDS, wordInLine } from "./layout.js";

const FONT_CHOICES = ["Inter", "Montserrat", "Poppins", "Bebas Neue", "Anton", "Oswald", "Archivo Black", "Roboto", "Lato", "DM Sans", "Space Grotesk", "Raleway", "Playfair Display"];
const PLATFORMS: Platform[] = ["tiktok", "reels", "shorts", "youtube", "linkedin"];
const LANGS: { value: string; label: string }[] = [
  { value: "", label: "Sin traducción" },
  { value: "en", label: "Inglés" },
  { value: "pt", label: "Portugués" },
  { value: "fr", label: "Francés" },
  { value: "it", label: "Italiano" },
  { value: "de", label: "Alemán" },
];

/** Datos para la vista previa: fotograma real, palabras reales, plataforma y formato. */
function usePreviewData() {
  const { assets, transcripts, keywords, captions, instruction, brand } = useEditorShallow((s) => ({
    assets: s.assets,
    transcripts: s.transcripts,
    keywords: s.keywords,
    captions: s.settings.captions,
    instruction: s.settings.instruction,
    brand: s.settings.context.brand,
  }));
  const frameAsset: Asset | undefined =
    assets.find((a) => a.category === "crudo-video" && (a.analysis.role === "a-roll" || a.analysis.role === "mixto")) ?? assets.find((a) => a.category === "crudo-video");
  const transcript = (frameAsset && transcripts.find((t) => t.assetId === frameAsset.id && t.status === "listo" && t.words.length)) || transcripts.find((t) => t.status === "listo" && t.words.length);
  const kwTexts = useMemo(() => keywords.filter((k) => k.enabled).map((k) => k.text), [keywords]);
  const words = useMemo(
    () => (transcript ? captionWordsFromTranscript(transcript.words, kwTexts, captions.style.highlightKeywords) : SAMPLE_WORDS.map((w) => ({ ...w, highlight: captions.style.highlightKeywords && w.highlight }))),
    [transcript, kwTexts, captions.style.highlightKeywords],
  );
  const frameFor = transcript ? assets.find((a) => a.id === transcript.assetId) : frameAsset;
  return { frameAsset: frameFor ?? frameAsset, words, captions, instruction, brand, hasTranscript: !!transcript, assets };
}

// ---------------------------------------------------------------------------- Vista previa

export function CaptionLivePreview({
  maxHeight = 520,
  showSafe = true,
  interactive = true,
  className,
}: {
  maxHeight?: number;
  showSafe?: boolean;
  interactive?: boolean;
  className?: string;
}) {
  const api = useApi();
  const { frameAsset, words, captions, instruction, assets } = usePreviewData();
  const style = captions.style;
  const wrap = useRef<HTMLDivElement>(null);
  const avail = useElementWidth(wrap, 300);
  const aspect = instruction.format;
  const ratio = aspect === "9:16" ? 9 / 16 : aspect === "16:9" ? 16 / 9 : aspect === "4:5" ? 4 / 5 : 1;
  const width = Math.max(120, Math.min(avail, maxHeight * ratio));
  const lines = useMemo(() => previewLines(words, style), [words, style]);
  const longest = useMemo(() => lines.reduce((m, l) => Math.max(m, l.text.length), 0), [lines]);
  const layout = captionPreviewLayout(style, instruction.platform, aspect, width, longest || undefined);
  const firstT = words[0]?.start ?? 0;
  const lastT = words[words.length - 1]?.end ?? 4;
  const [t, setT] = useState(firstT + 0.3);
  const [playing, setPlaying] = useState(false);
  const [frameT, setFrameT] = useState(Math.round((firstT + 0.3) * 10) / 10);
  const raf = useRef(0);

  // Reproduce el texto (no el video) para ver la animación.
  useEffect(() => {
    if (!playing) return;
    let last = 0;
    const tick = (now: number) => {
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      let done = false;
      setT((cur) => {
        const next = cur + dt;
        if (next >= lastT) done = true;
        return next >= lastT ? lastT : next;
      });
      if (done) {
        setPlaying(false);
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, lastT]);

  // El fotograma se pide con calma (no en cada cuadro).
  useEffect(() => {
    if (playing) return;
    const id = setTimeout(() => setFrameT(Math.round(t * 10) / 10), 220);
    return () => clearTimeout(id);
  }, [t, playing]);

  // Tipografía para la vista previa (Google Fonts o archivo subido).
  const fontAsset = style.font.assetId ? assets.find((a) => a.id === style.font.assetId) : undefined;
  useEffect(() => {
    if (fontAsset) loadFontFile(style.font.family, api.assetFileUrl(fontAsset));
    else loadGoogleFont(style.font.googleFont ?? style.font.family);
  }, [api, fontAsset, style.font.family, style.font.googleFont]);

  const frameUrl = frameAsset ? (api.isDemo ? api.assetThumbnailUrl(frameAsset) : api.assetFrameUrl(frameAsset, frameT)) : null;
  const li = lineAt(lines, t);
  const line = li >= 0 ? lines[li] : undefined;
  const wi = line ? wordInLine(line, t) : -1;
  const emoji = style.emojis && line ? emojiFor(line.text) : null;
  const visible = captions.enabled && line && (t <= line.end + 0.6 || !playing);

  const posStyle: CSSProperties = {
    left: layout.safe.left,
    right: layout.safe.right,
    ...(layout.anchor.edge === "bottom" ? { bottom: layout.anchor.offset } : layout.anchor.edge === "top" ? { top: layout.anchor.offset } : { top: "50%", transform: "translateY(-50%)" }),
  };
  const textStyle: CSSProperties = {
    fontFamily: `"${style.font.family}", var(--ae-font)`,
    fontWeight: style.font.weight,
    fontSize: Math.max(6, layout.fontPx),
    color: style.primaryColor,
    maxWidth: layout.maxTextWidth,
    WebkitTextStroke: style.outlineWidth > 0 && style.background !== "caja" ? `${Math.max(0.6, layout.outlinePx * 2)}px ${style.outlineColor}` : undefined,
    textShadow: style.background === "sombra" ? `0 ${Math.max(1, layout.fontPx * 0.06)}px ${Math.max(2, layout.fontPx * 0.22)}px rgba(0,0,0,.65)` : undefined,
  };

  return (
    <div ref={wrap} className={clsx("ae-in-cap", className)}>
      <div className="ae-in-cap__stage" style={{ width, height: layout.height }}>
        {frameUrl ? <img className="ae-in-cap__frame" src={frameUrl} alt="" draggable={false} /> : <div className="ae-in-cap__frame is-empty" />}
        {showSafe && (
          <div className="ae-in-cap__safe" aria-hidden>
            <span className="is-top" style={{ height: layout.safe.top }} />
            <span className="is-bottom" style={{ height: layout.safe.bottom }} />
            <span className="is-left" style={{ top: layout.safe.top, bottom: layout.safe.bottom, width: layout.safe.left }} />
            <span className="is-right" style={{ top: layout.safe.top, bottom: layout.safe.bottom, width: layout.safe.right }} />
            <span className="ae-in-cap__safebox" style={{ top: layout.safe.top, bottom: layout.safe.bottom, left: layout.safe.left, right: layout.safe.right }} />
          </div>
        )}
        {visible && line && (
          <div className="ae-in-cap__pos" style={posStyle}>
            <div key={`${li}-${style.animation}`} className={clsx("ae-in-cap__text", `is-anim-${style.animation}`, style.uppercase && "is-upper", style.background === "caja" && "has-box")} style={{ ...textStyle, background: style.background === "caja" ? style.boxColor : undefined }}>
              {line.words.map((w, i) => {
                const isActive = style.mode === "palabra" && i === wi;
                const hl = (w.highlight && style.highlightKeywords) || isActive;
                const hs = style.highlightStyle;
                return (
                  <span key={i} className={clsx("ae-in-cap__w", hl && `is-hl is-hl-${hs}`, isActive && "is-active")} style={hl ? (hs === "caja" ? { background: style.highlightColor, color: "#111", WebkitTextStroke: "0" } : { color: style.highlightColor }) : undefined}>
                    {displayText(w.text, style.uppercase)}
                    {i < line.words.length - 1 ? " " : ""}
                  </span>
                );
              })}
              {emoji && <span className="ae-in-cap__emoji"> {emoji}</span>}
            </div>
          </div>
        )}
        {!captions.enabled && <div className="ae-in-cap__off">Sin subtítulos</div>}
      </div>
      {interactive && (
        <div className="ae-in-cap__ctrl">
          <button type="button" className="ae-in-player__btn" onClick={() => (t >= lastT - 0.05 ? (setT(firstT), setPlaying(true)) : setPlaying((v) => !v))} aria-label={playing ? "Pausar la prueba" : "Probar la animación"} title={playing ? "Pausar" : "Probar la animación"}>
            {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
          </button>
          <input
            type="range"
            className="ae-in-player__scrub"
            min={firstT}
            max={lastT}
            step={0.05}
            value={Math.min(lastT, Math.max(firstT, t))}
            aria-label="Momento del video para la vista previa"
            style={{ ["--ae-pct" as string]: `${((t - firstT) / Math.max(0.1, lastT - firstT)) * 100}%` }}
            onChange={(e) => {
              setPlaying(false);
              setT(Number(e.target.value));
            }}
          />
          <span className="ae-in-player__time">{formatTime(t)}</span>
        </div>
      )}
      {interactive && captions.enabled && <FitNote fits={layout.fits} detail={layout.detail} suggested={layout.suggestedFontSize} />}
    </div>
  );
}

function FitNote({ fits, detail, suggested }: { fits: boolean; detail: string; suggested: number | null }) {
  const { updateSettings } = useActions();
  return (
    <div className={clsx("ae-in-cap__fit", fits ? "is-ok" : "is-warn")} role={fits ? undefined : "alert"}>
      {fits ? <CircleCheck size={14} aria-hidden /> : <TriangleAlert size={14} aria-hidden />}
      <span>{detail}</span>
      {!fits && suggested && (
        <button type="button" className="ae-in-cap__fix" onClick={() => updateSettings((d) => void (d.captions.style.fontSize = suggested))}>
          Usar {suggested} px
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- Controles

export function CaptionStyler() {
  const { updateSettings } = useActions();
  const { captions, instruction, brand, assets, hasTranscript } = usePreviewData();
  const [safe, setSafe] = useState(true);
  const style = captions.style;
  const set = (fn: (s: CaptionStyle) => void) => updateSettings((d) => fn(d.captions.style));
  const setCap = (fn: (c: ProjectSettings["captions"]) => void) => updateSettings((d) => fn(d.captions));
  const brandFonts = brand.enabled ? brand.inline.googleFonts : [];
  const fontFiles = brand.enabled ? brand.inline.fontAssetIds.map((id) => assets.find((a) => a.id === id)).filter((a): a is Asset => !!a) : [];
  const fontValue = style.font.assetId ? `file:${style.font.assetId}` : style.font.family;
  const fontOptions: { value: string; label: string }[] = [
    ...fontFiles.map((a) => ({ value: `file:${a.id}`, label: `${fontFamilyFromFile(a.originalName)} (tu archivo)` })),
    ...brandFonts.filter((f) => !FONT_CHOICES.includes(f)).map((f) => ({ value: f, label: `${f} (tu marca)` })),
    ...FONT_CHOICES.map((f) => ({ value: f, label: brandFonts.includes(f) ? `${f} (tu marca)` : f })),
  ];
  if (!fontOptions.some((o) => o.value === fontValue)) fontOptions.unshift({ value: fontValue, label: style.font.family });

  return (
    <div className="ae-in-capstudio">
      <div className="ae-in-capstudio__preview">
        <div className="ae-in-capstudio__platforms" role="group" aria-label="Plataforma (zonas seguras)">
          {PLATFORMS.map((p) => (
            <button key={p} type="button" aria-pressed={instruction.platform === p} className={clsx("ae-in-pill", instruction.platform === p && "is-on")} onClick={() => updateSettings((d) => void (d.instruction.platform = p))}>
              {PLATFORM_LABELS[p].replace("Instagram ", "").replace("YouTube Shorts", "Shorts")}
            </button>
          ))}
        </div>
        <CaptionLivePreview showSafe={safe} maxHeight={500} />
        <div className="ae-in-capstudio__under">
          <Switch label="Ver zonas seguras" description="Donde la app pone botones y textos encima." checked={safe} onChange={setSafe} />
          {!hasTranscript && <p className="ae-help">Texto de ejemplo: cuando haya transcripción verás tus propias palabras.</p>}
        </div>
      </div>

      <div className={clsx("ae-in-capstudio__controls", !captions.enabled && "is-dimmed")}>
        <div className="ae-in-capstudio__onoff">
          <div>
            <b>Subtítulos</b>
            <span className="ae-help">{captions.enabled ? "Se queman en el video y se exportan como archivo." : "El video sale sin subtítulos."}</span>
          </div>
          <OnOffFlag checked={captions.enabled} label="Subtítulos" onChange={(v) => setCap((c) => void (c.enabled = v))} />
        </div>

        <Group title="Cómo aparecen">
          <Segmented
            label="Modo de subtítulos"
            value={style.mode}
            onChange={(mode) => set((s) => void (s.mode = mode))}
            options={[
              { value: "palabra", label: "Palabra", title: "Karaoke: se ilumina cada palabra al decirla." },
              { value: "frase", label: "Frase", title: "Una frase corta a la vez." },
              { value: "bloque", label: "Bloque", title: "Hasta 2 líneas fijas, estilo clásico." },
            ]}
          />
          <Field label="Animación">
            <Segmented
              size="sm"
              label="Animación"
              value={style.animation}
              onChange={(animation) => set((s) => void (s.animation = animation))}
              options={[
                { value: "ninguna", label: "Ninguna" },
                { value: "pop", label: "Pop" },
                { value: "fundido", label: "Fundido" },
                { value: "rebote", label: "Rebote" },
              ]}
            />
          </Field>
        </Group>

        <Group title="Letra">
          <div className="ae-in-grid2">
            <Field label="Tipografía">
              <select
                className="ae-input ae-input--sm"
                value={fontValue}
                aria-label="Tipografía de los subtítulos"
                onChange={(e) => {
                  const v = e.target.value;
                  set((s) => {
                    if (v.startsWith("file:")) {
                      const a = fontFiles.find((x) => x.id === v.slice(5));
                      s.font = { ...s.font, family: a ? fontFamilyFromFile(a.originalName) : s.font.family, assetId: a?.id ?? null, googleFont: null };
                    } else s.font = { ...s.font, family: v, assetId: null, googleFont: v };
                  });
                }}
              >
                {fontOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Grosor">
              <Segmented
                size="sm"
                label="Grosor de la letra"
                value={String(style.font.weight)}
                onChange={(w) => set((s) => void (s.font.weight = Number(w)))}
                options={[
                  { value: "500", label: "Normal" },
                  { value: "700", label: "Negrita" },
                  { value: "900", label: "Extra" },
                ]}
              />
            </Field>
          </div>
          <Range label="Tamaño" value={style.fontSize} min={24} max={140} suffix="px" onChange={(v) => set((s) => void (s.fontSize = v))} />
          <Switch label="Mayúsculas" checked={style.uppercase} onChange={(v) => set((s) => void (s.uppercase = v))} />
        </Group>

        <Group title="Colores y fondo">
          <div className="ae-in-grid3">
            <ColorField label="Texto" value={style.primaryColor} onChange={(c) => set((s) => void (s.primaryColor = c))} />
            <ColorField label="Resaltado" value={style.highlightColor} onChange={(c) => set((s) => void (s.highlightColor = c))} />
            <ColorField label="Contorno" value={style.outlineColor} onChange={(c) => set((s) => void (s.outlineColor = c))} />
          </div>
          <Range label="Contorno" value={style.outlineWidth} min={0} max={14} suffix="px" onChange={(v) => set((s) => void (s.outlineWidth = v))} />
          <Field label="Fondo">
            <Segmented
              size="sm"
              label="Fondo de los subtítulos"
              value={style.background}
              onChange={(background) => set((s) => void (s.background = background))}
              options={[
                { value: "ninguno", label: "Ninguno" },
                { value: "caja", label: "Caja" },
                { value: "sombra", label: "Sombra" },
              ]}
            />
          </Field>
          {style.background === "caja" && <ColorField label="Color de la caja" value={style.boxColor} alpha onChange={(c) => set((s) => void (s.boxColor = c))} />}
        </Group>

        <Group title="Posición">
          <Segmented
            size="sm"
            label="Posición de los subtítulos"
            value={style.position}
            onChange={(position) => set((s) => void (s.position = position))}
            options={[
              { value: "arriba", label: "Arriba" },
              { value: "centro", label: "Centro" },
              { value: "abajo", label: "Abajo" },
            ]}
          />
          <Range label="Margen extra" value={style.marginV} min={0} max={400} step={10} suffix="px" onChange={(v) => set((s) => void (s.marginV = v))} />
          <div className="ae-in-grid2">
            <Range label="Máx. caracteres por línea" value={style.maxCharsPerLine} min={8} max={42} onChange={(v) => set((s) => void (s.maxCharsPerLine = v))} />
            <Range label="Máx. líneas" value={style.maxLines} min={1} max={3} onChange={(v) => set((s) => void (s.maxLines = v))} />
          </div>
        </Group>

        <Group title="Palabras clave y extras">
          <Switch label="Resaltar palabras clave" description="Las que activaste en PALABRAS CLAVE." checked={style.highlightKeywords} onChange={(v) => set((s) => void (s.highlightKeywords = v))} />
          {style.highlightKeywords && (
            <Segmented
              size="sm"
              label="Cómo se resaltan"
              value={style.highlightStyle}
              onChange={(highlightStyle) => set((s) => void (s.highlightStyle = highlightStyle))}
              options={[
                { value: "color", label: "Color" },
                { value: "escala", label: "Más grande" },
                { value: "caja", label: "Caja" },
              ]}
            />
          )}
          <Switch label="Emojis" description="Un emoji que acompaña la frase cuando aplica." checked={style.emojis} onChange={(v) => set((s) => void (s.emojis = v))} />
        </Group>

        <Group title="Idioma y archivos">
          <Field label="Traducir los subtítulos" hint="Opcional: el audio queda igual.">
            <select className="ae-input ae-input--sm" value={captions.translateTo ?? ""} aria-label="Traducir los subtítulos a" onChange={(e) => setCap((c) => void (c.translateTo = e.target.value || null))}>
              {LANGS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </Field>
          <Switch label="Exportar archivos .srt y .vtt" description="Se descargan junto con el video al exportar." checked={captions.exportFiles} onChange={(v) => setCap((c) => void (c.exportFiles = v))} />
        </Group>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ae-in-group" aria-label={title}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function Range({ label, value, min, max, step = 1, suffix, onChange }: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (v: number) => void }) {
  return (
    <label className="ae-in-range">
      <span className="ae-in-range__label">
        {label}
        <b>
          {value}
          {suffix ? ` ${suffix}` : ""}
        </b>
      </span>
      <input type="range" className="ae-range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** Selector de color con campo hex (con alfa opcional para la caja). */
export function ColorField({ label, value, onChange, alpha }: { label: string; value: string; onChange: (hex: string) => void; alpha?: boolean }) {
  const rgb = value.slice(0, 7);
  const aa = value.length === 9 ? value.slice(7) : "FF";
  const [text, setText] = useState(rgb.toUpperCase());
  useEffect(() => setText(rgb.toUpperCase()), [rgb]);
  const emit = (hex: string, a = aa) => onChange(alpha ? `${hex.toUpperCase()}${a.toUpperCase()}` : hex.toUpperCase());
  return (
    <div className="ae-in-color">
      <span className="ae-in-color__label">{label}</span>
      <span className="ae-in-color__row">
        <label className="ae-in-color__swatch" style={{ background: value }}>
          <input type="color" value={rgb} aria-label={`${label}: elegir color`} onChange={(e) => emit(e.target.value)} />
        </label>
        <input
          className="ae-input ae-input--sm ae-in-color__hex"
          value={text}
          aria-label={`${label}: código hex`}
          maxLength={7}
          spellCheck={false}
          onChange={(e) => {
            const v = e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`;
            setText(v.toUpperCase());
            if (HEX6.test(v)) emit(v);
          }}
          onBlur={() => setText(rgb.toUpperCase())}
        />
      </span>
      {alpha && (
        <input
          type="range"
          className="ae-range"
          min={0}
          max={255}
          value={parseInt(aa, 16)}
          aria-label={`${label}: opacidad`}
          onChange={(e) => emit(rgb, Number(e.target.value).toString(16).padStart(2, "0"))}
        />
      )}
    </div>
  );
}
