/**
 * Opciones de cada herramienta (vista enfocada de HERRAMIENTAS): solo lo relevante, con valores por
 * defecto y ayudas breves. Las herramientas con decisiones visuales o de costo tienen su panel propio
 * (B-roll con mini-ilustraciones, motion graphics manual, IA con modelo y costo, música, cintillos…);
 * el resto usa el formulario genérico de toolMeta.
 */
import { deriveEngines, type ManualGraphic, type ToolKey, type ToolSettings } from "@autoeditor/shared";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Info, Plus, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { nanoid } from "nanoid";
import type { ReactNode } from "react";
import { useActions, useEditor, useEditorShallow } from "../../store/context.js";
import { Field, IconButton, Segmented } from "../../ui/index.js";
import { TOOL_OPTIONS, type ToolOption } from "../../stages/tools/toolMeta.js";
import { aiCostEstimate, effectiveModel, formatCost, kieMissing, kieModelsFor, kieReasons, joinEs, type KieKind } from "./engines.js";

type ToolValue<K extends ToolKey> = ToolSettings[K];

/** Modifica una herramienta (y la prende si estaba apagada). */
function useToolSetter<K extends ToolKey>(key: K) {
  const { updateSettings } = useActions();
  return (fn: (t: ToolValue<K>) => void) =>
    updateSettings((d) => {
      fn(d.tools[key]);
      d.tools[key].enabled = true;
    });
}

export function ToolOptionsPanel({ toolKey }: { toolKey: ToolKey }) {
  const enabled = useEditor((s) => s.settings.tools[toolKey].enabled);
  const body = (() => {
    switch (toolKey) {
      case "broll":
        return <BrollPanel />;
      case "motionGraphics":
        return <MotionPanel />;
      case "aiImages":
        return <AiImagesPanel />;
      case "aiVideos":
        return <AiVideosPanel />;
      case "music":
        return <MusicPanel />;
      case "sfx":
        return <SfxPanel />;
      case "voiceover":
        return <VoiceoverPanel />;
      case "lowerThirds":
        return <LowerThirdsPanel />;
      case "cta":
        return <CtaPanel />;
      case "loudness":
        return <LoudnessPanel />;
      default:
        return <GenericPanel toolKey={toolKey} />;
    }
  })();
  return (
    <div className={clsx("ae-in-toolopts", !enabled && "is-off")}>
      {!enabled && <p className="ae-in-toolopts__off">Está apagada. Cambiar cualquier opción la prende.</p>}
      {body}
    </div>
  );
}

// ---------------------------------------------------------------------------- Genérico

function GenericPanel({ toolKey }: { toolKey: ToolKey }) {
  const tool = useEditor((s) => s.settings.tools[toolKey]) as unknown as Record<string, unknown>;
  const set = useToolSetter(toolKey);
  const options = TOOL_OPTIONS[toolKey] ?? [];
  if (!options.length) return <p className="ae-help">No necesita ajustes: Claude la aplica con criterio de editor.</p>;
  return (
    <div className="ae-fields">
      {options.map((opt) => (
        <OptionField key={opt.field} option={opt} value={tool[opt.field]} onChange={(v) => set((t) => void ((t as unknown as Record<string, unknown>)[opt.field] = v))} />
      ))}
    </div>
  );
}

export function OptionField({ option, value, onChange }: { option: ToolOption; value: unknown; onChange: (v: unknown) => void }) {
  if (option.type === "enum") {
    return (
      <Field label={option.label} hint={option.help}>
        <Segmented label={option.label} value={String(value ?? "")} onChange={onChange} options={option.options} wrap />
      </Field>
    );
  }
  if (option.type === "multi") {
    const list = Array.isArray(value) ? (value as string[]) : [];
    return (
      <Field label={option.label}>
        <div className="ae-row ae-row--wrap">
          {option.options.map((o) => {
            const on = list.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                className={clsx("ae-toolbtn", on && "is-on")}
                onClick={() => {
                  const next = on ? list.filter((x) => x !== o.value) : [...list, o.value];
                  if (next.length) onChange(next);
                }}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </Field>
    );
  }
  if (option.type === "number") {
    const n = typeof value === "number" ? value : option.min;
    return (
      <label className="ae-in-range">
        <span className="ae-in-range__label">
          {option.label}
          <b>
            {n}
            {option.suffix ? ` ${option.suffix}` : ""}
          </b>
        </span>
        <input type="range" className="ae-range" min={option.min} max={option.max} step={option.step ?? 1} value={n} aria-label={option.label} onChange={(e) => onChange(Number(e.target.value))} />
      </label>
    );
  }
  return (
    <Field label={option.label}>
      {option.multiline ? (
        <textarea className="ae-input ae-textarea" rows={4} value={String(value ?? "")} placeholder={option.placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className="ae-input" value={String(value ?? "")} placeholder={option.placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  );
}

function Hint({ tone = "info", children }: { tone?: "info" | "warn" | "ai"; children: ReactNode }) {
  return (
    <div className={clsx("ae-in-hint", `is-${tone}`)}>
      {tone === "warn" ? <TriangleAlert size={14} aria-hidden /> : tone === "ai" ? <Sparkles size={14} aria-hidden /> : <Info size={14} aria-hidden />}
      <span>{children}</span>
    </div>
  );
}

function RangeRow({ label, value, min, max, step = 1, suffix, onChange, help }: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (v: number) => void; help?: string }) {
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
      {help && <span className="ae-help">{help}</span>}
    </label>
  );
}

// ---------------------------------------------------------------------------- Aviso de Kie AI

/** Aviso cuando algo usa Kie AI pero no hay llave (o es la demo). */
export function KieNotice({ compact }: { compact?: boolean }) {
  const { config, settings } = useEditorShallow((s) => ({ config: s.config, settings: s.settings }));
  const on = deriveEngines(settings).kie;
  if (!on || !kieMissing(config)) return null;
  return (
    <Hint tone="warn">
      <b>Sin llave de Kie AI: se usarán marcadores de prueba.</b>
      {!compact && <> {config?.demoMode ? "Estás en la demostración: no se gastan créditos." : "Agrega KIE_API_KEY en el archivo .env del servidor para generar de verdad."}</>}
    </Hint>
  );
}

function ModelSelect({ kind, value, onChange, label = "Modelo" }: { kind: KieKind; value: string; onChange: (id: string) => void; label?: string }) {
  const config = useEditor((s) => s.config);
  const models = kieModelsFor(config, kind);
  const eff = effectiveModel(config, kind, value);
  if (!models.length) return <Hint>No hay modelos de este tipo en config/models.json.</Hint>;
  return (
    <Field label={label} hint={eff && !eff.verified ? "Precio sin verificar: revisa config/providers.json." : undefined}>
      <select className="ae-input ae-input--sm" value={eff?.id ?? ""} aria-label={label} onChange={(e) => onChange(e.target.value)}>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label} · {formatCost(m.costUsd)} c/u{m.isDefault ? " (recomendado)" : ""}
          </option>
        ))}
      </select>
    </Field>
  );
}

function CostLine() {
  const { config, settings } = useEditorShallow((s) => ({ config: s.config, settings: s.settings }));
  const est = aiCostEstimate(settings, config);
  if (!est.lines.length) return null;
  return (
    <div className="ae-in-cost" aria-label="Costo aproximado de lo generado con IA">
      <span>Costo aproximado con IA</span>
      <b>{formatCost(est.total)}</b>
      <span className="ae-in-cost__detail">{est.lines.map((l) => `${l.label}: ${formatCost(l.usd)}`).join(" · ")}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------- B-roll

const LAYOUTS: { value: ToolSettings["broll"]["layout"]; label: string; help: string }[] = [
  { value: "auto", label: "Auto", help: "Claude elige según el momento." },
  { value: "pantalla-completa", label: "Corte completo", help: "El B-roll tapa la pantalla; se sigue oyendo la voz." },
  { value: "fondo", label: "De fondo", help: "El B-roll de fondo y la persona en un recuadro." },
  { value: "pip", label: "En recuadro", help: "La persona sigue en pantalla y el B-roll va en un recuadro." },
];

function LayoutArt({ layout }: { layout: ToolSettings["broll"]["layout"] }) {
  const person = (x: number, y: number, s: number) => (
    <g fill="#1f1f1f">
      <circle cx={x} cy={y} r={4.2 * s} />
      <path d={`M${x - 8 * s} ${y + 15 * s} Q${x} ${y + 3 * s} ${x + 8 * s} ${y + 15 * s} Z`} />
    </g>
  );
  return (
    <svg viewBox="0 0 36 56" width="36" height="56" aria-hidden className="ae-in-layoutart">
      <rect x="0.75" y="0.75" width="34.5" height="54.5" rx="5" fill="#f3f2ef" stroke="#cfcfcf" strokeWidth="1.5" />
      {layout === "auto" && (
        <>
          <rect x="4" y="4" width="28" height="22" rx="3" fill="#8b7cf0" opacity="0.85" />
          {person(18, 36, 1)}
          <path d="M27 6 l1.2 2.6 2.6 1.2 -2.6 1.2 -1.2 2.6 -1.2 -2.6 -2.6 -1.2 2.6 -1.2z" fill="#fff" />
        </>
      )}
      {layout === "pantalla-completa" && (
        <>
          <rect x="2" y="2" width="32" height="52" rx="4" fill="#8b7cf0" />
          <path d="M6 44 h24" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity="0.8" />
          <path d="M6 48 h14" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity="0.8" />
        </>
      )}
      {layout === "fondo" && (
        <>
          <rect x="2" y="2" width="32" height="52" rx="4" fill="#8b7cf0" />
          <rect x="5" y="31" width="15" height="20" rx="3" fill="#fbe8d6" stroke="#fff" strokeWidth="1.2" />
          {person(12.5, 38, 0.62)}
        </>
      )}
      {layout === "pip" && (
        <>
          {person(18, 30, 1.25)}
          <rect x="19" y="5" width="13" height="16" rx="2.5" fill="#8b7cf0" stroke="#fff" strokeWidth="1.2" />
        </>
      )}
    </svg>
  );
}

function BrollPanel() {
  const { broll, assets } = useEditorShallow((s) => ({ broll: s.settings.tools.broll, assets: s.assets }));
  const set = useToolSetter("broll");
  const withBroll = assets.filter((a) => a.category === "crudo-video" && a.analysis.status === "listo" && (a.analysis.role === "b-roll" || a.analysis.brollSegments.length > 0));
  const segments = withBroll.reduce((n, a) => n + Math.max(1, a.analysis.brollSegments.length), 0);
  return (
    <div className="ae-fields">
      <Field label="De dónde sale" hint={broll.source !== "material" ? "Con IA se prende Kie AI en el recuadro de motores." : "Usa las tomas de apoyo detectadas en tu material."}>
        <Segmented
          label="De dónde sale el B-roll"
          value={broll.source}
          onChange={(source) => set((t) => void (t.source = source))}
          options={[
            { value: "material", label: "Mi material" },
            { value: "ia", label: "IA" },
            { value: "ambos", label: "Ambos" },
          ]}
        />
      </Field>
      {broll.source !== "ia" &&
        (withBroll.length ? (
          <Hint>
            Detectamos <b>{segments}</b> {segments === 1 ? "toma" : "tomas"} de apoyo en {withBroll.length === 1 ? "1 archivo" : `${withBroll.length} archivos`}.
          </Hint>
        ) : (
          <Hint tone="warn">Todavía no detectamos B-roll en tu material. Sube tomas de apoyo (paisaje, producto, detalle) o elige “IA”.</Hint>
        ))}
      <Field label="Frecuencia" hint="Qué tan seguido aparece sobre lo que se dice.">
        <Segmented
          label="Frecuencia del B-roll"
          value={broll.frequency}
          onChange={(frequency) => set((t) => void (t.frequency = frequency))}
          options={[
            { value: "baja", label: "Baja" },
            { value: "media", label: "Media" },
            { value: "alta", label: "Alta" },
          ]}
        />
      </Field>
      <Field label="Cómo se ve">
        <div className="ae-in-layouts" role="radiogroup" aria-label="Cómo se ve el B-roll">
          {LAYOUTS.map((l) => (
            <button key={l.value} type="button" role="radio" aria-checked={broll.layout === l.value} className={clsx("ae-in-layout", broll.layout === l.value && "is-on")} onClick={() => set((t) => void (t.layout = l.value))} title={l.help}>
              <LayoutArt layout={l.value} />
              <span className="ae-in-layout__label">{l.label}</span>
              <span className="ae-in-layout__help">{l.help}</span>
            </button>
          ))}
        </div>
      </Field>
      {broll.source !== "material" && <KieNotice />}
    </div>
  );
}

// ---------------------------------------------------------------------------- Motion graphics

const ENGINES: { value: ToolSettings["motionGraphics"]["engine"]; label: string; help: string }[] = [
  { value: "hyperframes", label: "HyperFrames", help: "Animaciones HTML de calidad, con tu estilo." },
  { value: "builtin", label: "Básico", help: "Textos y formas simples, siempre disponible." },
  { value: "remotion", label: "Remotion", help: "Opcional." },
];

function MotionPanel() {
  const { mg, config } = useEditorShallow((s) => ({ mg: s.settings.tools.motionGraphics, config: s.config }));
  const set = useToolSetter("motionGraphics");
  const remotionReady = !!config?.capabilities.remotion.ready;
  const hfReady = config ? config.capabilities.hyperframes.ready : true;
  const update = (id: string, patch: Partial<ManualGraphic>) => set((t) => void (t.items = t.items.map((x) => (x.id === id ? { ...x, ...patch } : x))));
  const move = (i: number, dir: -1 | 1) =>
    set((t) => {
      const j = i + dir;
      if (j < 0 || j >= t.items.length) return;
      const items = [...t.items];
      [items[i], items[j]] = [items[j]!, items[i]!];
      t.items = items;
    });
  return (
    <div className="ae-fields">
      <Field label="Modo" hint={mg.mode === "automatico" ? "Claude decide qué gráficos van y dónde (cifras, palabras clave, títulos)." : "Tú dices qué gráficos quieres; Claude los anima con tu estilo."}>
        <Segmented
          label="Modo de motion graphics"
          value={mg.mode}
          onChange={(mode) => set((t) => void (t.mode = mode))}
          options={[
            { value: "automatico", label: "Automático" },
            { value: "manual", label: "Manual" },
          ]}
        />
      </Field>
      {mg.mode === "manual" && (
        <div className="ae-in-mglist">
          {mg.items.length === 0 && <p className="ae-help">Agrega los gráficos que quieres ver. Si no pones momento, Claude lo elige.</p>}
          {mg.items.map((g, i) => (
            <div key={g.id} className="ae-in-mgitem">
              <span className="ae-in-mgitem__n">{i + 1}</span>
              <div className="ae-in-mgitem__body">
                <input className="ae-input ae-input--sm" placeholder="Qué gráfico (p. ej. “contador que sube a 10 000 clientes”)" aria-label={`Gráfico ${i + 1}: descripción`} value={g.description} onChange={(e) => update(g.id, { description: e.target.value })} />
                <div className="ae-in-mgitem__row">
                  <label className="ae-in-mini">
                    <span>Momento</span>
                    <input
                      className="ae-input ae-input--sm"
                      type="number"
                      min={0}
                      step={0.5}
                      placeholder="Claude decide"
                      aria-label={`Gráfico ${i + 1}: momento en segundos`}
                      value={g.at ?? ""}
                      onChange={(e) => update(g.id, { at: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) })}
                    />
                    <em>s</em>
                  </label>
                  <label className="ae-in-mini">
                    <span>Duración</span>
                    <input type="range" className="ae-range" min={1} max={10} step={0.5} value={g.duration} aria-label={`Gráfico ${i + 1}: duración`} onChange={(e) => update(g.id, { duration: Number(e.target.value) })} />
                    <b>{g.duration} s</b>
                  </label>
                </div>
              </div>
              <div className="ae-in-mgitem__tools">
                <IconButton size="sm" label="Subir" icon={<ArrowUp size={13} />} disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButton size="sm" label="Bajar" icon={<ArrowDown size={13} />} disabled={i === mg.items.length - 1} onClick={() => move(i, 1)} />
                <IconButton size="sm" label={`Quitar gráfico ${i + 1}`} icon={<Trash2 size={13} />} onClick={() => set((t) => void (t.items = t.items.filter((x) => x.id !== g.id)))} />
              </div>
            </div>
          ))}
          <button type="button" className="ae-in-addrow" onClick={() => set((t) => void (t.items = [...t.items, { id: nanoid(8), description: "", at: null, duration: 3 }]))}>
            <Plus size={14} aria-hidden /> Agregar gráfico
          </button>
        </div>
      )}
      <Field label="Motor">
        <div className="ae-in-engines" role="radiogroup" aria-label="Motor de motion graphics">
          {ENGINES.map((e) => {
            const disabled = e.value === "remotion" && !remotionReady;
            const on = mg.engine === e.value;
            return (
              <button key={e.value} type="button" role="radio" aria-checked={on} disabled={disabled} className={clsx("ae-in-enginecard", on && "is-on")} onClick={() => set((t) => void (t.engine = e.value))}>
                <span className="ae-in-enginecard__name">
                  {e.label}
                  {e.value === "hyperframes" && <span className="ae-in-tag">recomendado</span>}
                </span>
                <span className="ae-in-enginecard__help">{disabled ? "Apagado por licencia: Remotion pide licencia para empresas. Se puede prender en la configuración." : e.value === "hyperframes" && !hfReady ? "No está instalado: se usará el básico. Corre pnpm instalar." : e.help}</span>
              </button>
            );
          })}
        </div>
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------- IA imágenes / videos

const IMAGE_STYLES = ["fotográfico, natural", "cinematográfico", "ilustración plana", "3D suave", "acuarela"];

function AiImagesPanel() {
  const ai = useEditor((s) => s.settings.tools.aiImages);
  const set = useToolSetter("aiImages");
  return (
    <div className="ae-fields">
      <RangeRow label="Máximo de imágenes" value={ai.max} min={1} max={30} onChange={(v) => set((t) => void (t.max = v))} help="Claude usa menos si no hacen falta." />
      <Field label="Estilo">
        <input className="ae-input ae-input--sm" value={ai.style} placeholder="fotográfico, natural" aria-label="Estilo de las imágenes" onChange={(e) => set((t) => void (t.style = e.target.value))} />
        <div className="ae-row ae-row--wrap ae-row--tight ae-in-presets">
          {IMAGE_STYLES.map((s) => (
            <button key={s} type="button" className={clsx("ae-toolbtn", ai.style === s && "is-on")} aria-pressed={ai.style === s} onClick={() => set((t) => void (t.style = s))}>
              {s}
            </button>
          ))}
        </div>
      </Field>
      <OptionField
        option={{ field: "usage", label: "Para qué", type: "multi", options: [{ value: "broll", label: "B-roll" }, { value: "fondo", label: "Fondos" }, { value: "portada", label: "Portada" }] }}
        value={ai.usage}
        onChange={(v) => set((t) => void (t.usage = v as typeof t.usage))}
      />
      <ModelSelect kind="imagen" value={ai.model} onChange={(id) => set((t) => void (t.model = id))} />
      <CostLine />
      <KieNotice />
    </div>
  );
}

function AiVideosPanel() {
  const ai = useEditor((s) => s.settings.tools.aiVideos);
  const set = useToolSetter("aiVideos");
  return (
    <div className="ae-fields">
      <RangeRow label="Máximo de clips" value={ai.max} min={1} max={10} onChange={(v) => set((t) => void (t.max = v))} />
      <RangeRow label="Duración de cada clip" value={ai.duration} min={2} max={15} suffix="s" onChange={(v) => set((t) => void (t.duration = v))} help="Los clips largos tardan más y cuestan más." />
      <ModelSelect kind="video" value={ai.model} onChange={(id) => set((t) => void (t.model = id))} />
      <CostLine />
      <KieNotice />
    </div>
  );
}

// ---------------------------------------------------------------------------- Audio

function MusicPanel() {
  const { music, hasMusic } = useEditorShallow((s) => ({ music: s.settings.tools.music, hasMusic: s.assets.some((a) => a.category === "musica") }));
  const set = useToolSetter("music");
  return (
    <div className="ae-fields">
      <Field label="Qué música">
        <Segmented
          label="Fuente de la música"
          value={music.source}
          onChange={(source) => set((t) => void (t.source = source))}
          options={[
            { value: "mia", label: "La mía" },
            { value: "biblioteca", label: "Biblioteca" },
            { value: "ia", label: "Con IA" },
          ]}
        />
      </Field>
      {music.source === "mia" && !hasMusic && <Hint tone="warn">No subiste música. Súbela en MATERIAL › Elementos del video, o elige “Biblioteca”.</Hint>}
      {music.source === "ia" && <ModelSelect kind="musica" value="" onChange={() => undefined} label="Modelo (Kie AI)" />}
      <RangeRow label="Volumen bajo la voz" value={music.gainDb} min={-40} max={0} suffix="dB" onChange={(v) => set((t) => void (t.gainDb = v))} help="-16 dB es un buen punto: se oye sin tapar la voz." />
      {music.source === "ia" && <KieNotice />}
    </div>
  );
}

function SfxPanel() {
  const sfx = useEditor((s) => s.settings.tools.sfx);
  const set = useToolSetter("sfx");
  return (
    <div className="ae-fields">
      <Field label="De dónde salen" hint="Si subiste tus efectos en MATERIAL, Claude los usa primero.">
        <Segmented
          label="Fuente de los efectos"
          value={sfx.source}
          onChange={(source) => set((t) => void (t.source = source))}
          options={[
            { value: "biblioteca", label: "Biblioteca" },
            { value: "ia", label: "Con IA" },
          ]}
        />
      </Field>
      <Field label="Cantidad">
        <Segmented
          label="Cantidad de efectos"
          value={sfx.density}
          onChange={(density) => set((t) => void (t.density = density))}
          options={[
            { value: "baja", label: "Pocos" },
            { value: "media", label: "Normal" },
            { value: "alta", label: "Muchos" },
          ]}
        />
      </Field>
      {sfx.source === "ia" && (
        <>
          <CostLine />
          <KieNotice />
        </>
      )}
    </div>
  );
}

const VOICES = ["Femenina, cálida", "Masculina, grave", "Juvenil, energética", "Neutra, profesional"];

function VoiceoverPanel() {
  const vo = useEditor((s) => s.settings.tools.voiceover);
  const set = useToolSetter("voiceover");
  return (
    <div className="ae-fields">
      <Field label="Voz">
        <input className="ae-input ae-input--sm" value={vo.voice} placeholder="Femenina, cálida, español neutro" aria-label="Voz" onChange={(e) => set((t) => void (t.voice = e.target.value))} />
        <div className="ae-row ae-row--wrap ae-row--tight ae-in-presets">
          {VOICES.map((v) => (
            <button key={v} type="button" className={clsx("ae-toolbtn", vo.voice === v && "is-on")} aria-pressed={vo.voice === v} onClick={() => set((t) => void (t.voice = v))}>
              {v}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Guion de la voz" hint="Vacío = Claude lo escribe a partir de tu instrucción y tu guion.">
        <textarea className="ae-input ae-textarea" rows={4} value={vo.script} aria-label="Guion de la voz en off" onChange={(e) => set((t) => void (t.script = e.target.value))} />
      </Field>
      <CostLine />
      <KieNotice />
    </div>
  );
}

function LoudnessPanel() {
  const lo = useEditor((s) => s.settings.tools.loudness);
  const set = useToolSetter("loudness");
  const presets: { v: number; label: string }[] = [
    { v: -14, label: "Redes (-14)" },
    { v: -16, label: "Podcast (-16)" },
    { v: -23, label: "TV (-23)" },
  ];
  return (
    <div className="ae-fields">
      <RangeRow label="Volumen objetivo" value={lo.targetLufs} min={-30} max={-8} suffix="LUFS" onChange={(v) => set((t) => void (t.targetLufs = v))} help="Todo el video queda al mismo volumen, sin saltos." />
      <div className="ae-row ae-row--wrap ae-row--tight">
        {presets.map((p) => (
          <button key={p.v} type="button" className={clsx("ae-toolbtn", lo.targetLufs === p.v && "is-on")} aria-pressed={lo.targetLufs === p.v} onClick={() => set((t) => void (t.targetLufs = p.v))}>
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- Texto

function LowerThirdsPanel() {
  const lt = useEditor((s) => s.settings.tools.lowerThirds);
  const set = useToolSetter("lowerThirds");
  return (
    <div className="ae-fields">
      <div className="ae-in-grid2">
        <Field label="Nombre">
          <input className="ae-input ae-input--sm" value={lt.name} placeholder="Ana Pérez" aria-label="Nombre" onChange={(e) => set((t) => void (t.name = e.target.value))} />
        </Field>
        <Field label="Cargo">
          <input className="ae-input ae-input--sm" value={lt.role} placeholder="Fundadora de Zyra" aria-label="Cargo" onChange={(e) => set((t) => void (t.role = e.target.value))} />
        </Field>
      </div>
      <div className="ae-in-ltprev" aria-label="Vista previa del cintillo">
        <span className="ae-in-ltprev__bar" />
        <span className="ae-in-ltprev__text">
          <b>{lt.name || "Ana Pérez"}</b>
          <span>{lt.role || "Fundadora de Zyra"}</span>
        </span>
      </div>
      <p className="ae-help">Aparece unos segundos cuando la persona empieza a hablar. Usa los colores y la tipografía de tu marca si la prendiste.</p>
    </div>
  );
}

const CTAS = ["Sígueme para más", "Link en mi perfil", "Escríbenos por DM", "Guarda este video"];

function CtaPanel() {
  const cta = useEditor((s) => s.settings.tools.cta);
  const set = useToolSetter("cta");
  return (
    <div className="ae-fields">
      <Field label="Texto del cierre" hint="Vacío = Claude lo propone según tu instrucción.">
        <input className="ae-input ae-input--sm" value={cta.text} placeholder="Sígueme para más tips" aria-label="Texto del llamado a la acción" onChange={(e) => set((t) => void (t.text = e.target.value))} />
      </Field>
      <div className="ae-row ae-row--wrap ae-row--tight">
        {CTAS.map((c) => (
          <button key={c} type="button" className={clsx("ae-toolbtn", cta.text === c && "is-on")} aria-pressed={cta.text === c} onClick={() => set((t) => void (t.text = c))}>
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- Motores (explicación)

/** Explica por qué Kie AI está prendido y avisa si no hay llave. */
export function EnginesExplain() {
  const { settings, config } = useEditorShallow((s) => ({ settings: s.settings, config: s.config }));
  const reasons = kieReasons(settings);
  return (
    <div className="ae-in-engexplain">
      {reasons.length ? (
        <p>
          <b>Kie AI</b> se prendió solo porque usas {joinEs(reasons)}.
        </p>
      ) : (
        <p>
          <b>Kie AI</b> se prende solo cuando una herramienta usa IA generativa (IA imágenes, IA videos, voz en off, o B-roll, música o efectos con IA).
        </p>
      )}
      {!config?.capabilities.remotion.ready && (
        <p>
          <b>Remotion</b> queda apagado por licencia; HyperFrames hace los motion graphics.
        </p>
      )}
      <CostLine />
      <KieNotice />
    </div>
  );
}
