/**
 * Etapa ELEMENTOS Y HERRAMIENTAS.
 * - Paleta flotante morada arriba de la tarjeta: cada botón agrega o quita su herramienta.
 * - Dentro de la etapa: las herramientas prendidas, agrupadas (Edición, Texto, Audio, IA).
 * - Recuadro rosa de motores (Kie AI se prende solo según deriveEngines).
 * - Vista enfocada: catálogo completo con su ON/OFF y las opciones de cada herramienta.
 */
import { TOOL_CATALOG, TOOL_GROUP_LABELS, deriveEngines, type ToolGroup, type ToolKey } from "@autoeditor/shared";
import clsx from "clsx";
import { ChevronDown, LayoutGrid } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRef, useState } from "react";
import { useActions, useEditor, useEditorShallow } from "../../store/context.js";
import { EnginesBox, type EngineView, Field, OnOffFlag, Popover, PurpleButton, Segmented, SectionLabel, StageCard } from "../../ui/index.js";
import type { StageProps } from "../material/index.js";
import { CATALOG_BY_KEY, GROUP_ICONS, QUICK_TOOLS, TOOL_ICONS, TOOL_OPTIONS, toolValueSummary, type ToolOption } from "./toolMeta.js";

const GROUPS: ToolGroup[] = ["edicion", "texto", "audio", "ia"];

export function useToggleTool() {
  const { updateSettings } = useActions();
  return (key: ToolKey, enabled: boolean) =>
    updateSettings((d) => {
      d.tools[key].enabled = enabled;
    });
}

/** Vista de los motores con sus reglas (Kie automático, Remotion opcional por licencia). */
export function useEngineViews(): EngineView[] {
  const { settings, remotionReady } = useEditorShallow((s) => ({ settings: s.settings, remotionReady: !!s.config?.capabilities.remotion.ready }));
  const { updateSettings } = useActions();
  const engines = deriveEngines(settings);
  const mg = settings.tools.motionGraphics;
  return [
    {
      key: "kie",
      name: "Kie AI",
      on: engines.kie,
      lockedReason: engines.kie ? "Prendido solo: una herramienta usa IA generativa." : "Se prende solo al usar IA imágenes, IA videos o audio/B-roll con IA.",
    },
    {
      key: "hyperframes",
      name: "HyperFrames",
      on: engines.hyperframes,
      note: "Motion graphics (preferido)",
      onChange: (v) =>
        updateSettings((d) => {
          if (d.tools.motionGraphics.enabled) d.tools.motionGraphics.engine = v ? "hyperframes" : "builtin";
          else d.engines.hyperframes = v;
        }),
    },
    {
      key: "remotion",
      name: "Remotion",
      on: engines.remotion,
      lockedReason: remotionReady ? undefined : "Opcional y apagado por licencia.",
      note: "Opcional",
      onChange: (v) =>
        updateSettings((d) => {
          if (v) {
            d.tools.motionGraphics.enabled = true;
            d.tools.motionGraphics.engine = "remotion";
          } else if (mg.engine === "remotion") d.tools.motionGraphics.engine = "hyperframes";
        }),
    },
  ];
}

export function ToolsStage({ variant, target }: StageProps & { target?: string }) {
  const { openFocus } = useActions();
  const enabledCount = useEditor((s) => Object.values(s.settings.tools).filter((t) => t.enabled).length);
  if (variant === "focus") return <ToolsFocus initial={target as ToolKey | undefined} />;
  return (
    <StageCard
      title="Herramientas"
      variant="compact"
      status="listo"
      statusLabel={`${enabledCount} prendidas`}
      onOpen={() => openFocus("herramientas")}
      width={324}
      above={<ToolPalette />}
    >
      <ToolsCompact />
    </StageCard>
  );
}

// ---------------------------------------------------------------------------- Paleta flotante

function ToolPalette() {
  const tools = useEditor((s) => s.settings.tools);
  const toggle = useToggleTool();
  const [open, setOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="ae-palette nodrag" role="toolbar" aria-label="Paleta de herramientas">
      {QUICK_TOOLS.map((key) => {
        const Icon = TOOL_ICONS[key];
        const on = tools[key].enabled;
        return (
          <PurpleButton key={key} size="sm" active={on} aria-pressed={on} icon={<Icon size={13} aria-hidden />} onClick={() => toggle(key, !on)} title={`${CATALOG_BY_KEY[key].label}: ${on ? "quitar" : "agregar"}`}>
            {CATALOG_BY_KEY[key].short}
          </PurpleButton>
        );
      })}
      <div className="ae-palette__more">
        <PurpleButton ref={moreRef} size="sm" icon={<LayoutGrid size={13} aria-hidden />} iconRight={<ChevronDown size={12} aria-hidden />} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          Todas
        </PurpleButton>
        <Popover open={open} onClose={() => setOpen(false)} anchor={moreRef} label="Todas las herramientas" className="ae-palette__pop nowheel">
          {GROUPS.map((g) => (
            <div key={g} className="ae-palette__group">
              <div className="ae-palette__glabel">{TOOL_GROUP_LABELS[g]}</div>
              <div className="ae-palette__grid">
                {TOOL_CATALOG.filter((t) => t.group === g).map((t) => {
                  const Icon = TOOL_ICONS[t.key];
                  const on = tools[t.key].enabled;
                  return (
                    <button key={t.key} type="button" aria-pressed={on} className={clsx("ae-toolbtn", on && "is-on")} onClick={() => toggle(t.key, !on)} title={t.help}>
                      <Icon size={14} aria-hidden />
                      <span>{t.short}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </Popover>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- Compacto

function ToolsCompact() {
  const tools = useEditor((s) => s.settings.tools);
  const { openFocus } = useActions();
  const engines = useEngineViews();
  const reduce = useReducedMotion();
  return (
    <div className="ae-stack">
      {GROUPS.map((g) => {
        const items = TOOL_CATALOG.filter((t) => t.group === g && tools[t.key].enabled);
        if (!items.length) return null;
        const GIcon = GROUP_ICONS[g];
        return (
          <div key={g} className="ae-toolgroup">
            <SectionLabel>
              <GIcon size={12} aria-hidden /> {TOOL_GROUP_LABELS[g]}
            </SectionLabel>
            <motion.div layout={!reduce} className="ae-row ae-row--wrap ae-row--tight">
              <AnimatePresence initial={false}>
                {items.map((t) => {
                  const Icon = TOOL_ICONS[t.key];
                  const value = toolValueSummary(t.key, tools[t.key] as Record<string, unknown>);
                  return (
                    <motion.button
                      layout={!reduce}
                      key={t.key}
                      type="button"
                      className={clsx("ae-toolchip nodrag", (t.usesAi || t.group === "ia") && "is-ai")}
                      initial={{ opacity: 0, scale: 0.85 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.85 }}
                      transition={{ duration: reduce ? 0 : 0.16 }}
                      onClick={() => openFocus("herramientas", t.key)}
                      title={`${t.label}${value ? ` · ${value}` : ""}: ${t.help} (clic para ajustar)`}
                    >
                      <Icon size={12} aria-hidden />
                      <span>{t.short}</span>
                    </motion.button>
                  );
                })}
              </AnimatePresence>
            </motion.div>
          </div>
        );
      })}
      <EnginesBox engines={engines} size="sm" />
    </div>
  );
}

// ---------------------------------------------------------------------------- Vista enfocada

function ToolsFocus({ initial }: { initial?: ToolKey }) {
  const tools = useEditor((s) => s.settings.tools);
  const toggle = useToggleTool();
  const engines = useEngineViews();
  const [selected, setSelected] = useState<ToolKey>(initial && CATALOG_BY_KEY[initial] ? initial : "broll");
  const meta = CATALOG_BY_KEY[selected];
  const SelIcon = TOOL_ICONS[selected];
  return (
    <div className="ae-tools-focus">
      <div className="ae-tools-focus__list">
        {GROUPS.map((g) => (
          <section key={g} className="ae-panel ae-panel--flush" aria-label={TOOL_GROUP_LABELS[g]}>
            <header className="ae-panel__head">
              <h3>{TOOL_GROUP_LABELS[g]}</h3>
            </header>
            {TOOL_CATALOG.filter((t) => t.group === g).map((t) => {
              const Icon = TOOL_ICONS[t.key];
              const on = tools[t.key].enabled;
              return (
                <div key={t.key} className={clsx("ae-toolrow", selected === t.key && "is-selected", on && "is-on")}>
                  <button type="button" className="ae-toolrow__main" onClick={() => setSelected(t.key)} aria-current={selected === t.key || undefined}>
                    <span className={clsx("ae-toolrow__icon", (t.usesAi || t.group === "ia") && "is-ai")}>
                      <Icon size={16} aria-hidden />
                    </span>
                    <span className="ae-toolrow__text">
                      <span className="ae-toolrow__label">{t.label}</span>
                      <span className="ae-toolrow__help">{t.help}</span>
                    </span>
                  </button>
                  <OnOffFlag checked={on} label={t.label} onChange={(v) => toggle(t.key, v)} />
                </div>
              );
            })}
          </section>
        ))}
      </div>
      <aside className="ae-tools-focus__side">
        <section className="ae-panel ae-tooldetail" aria-label={`Opciones de ${meta.label}`}>
          <header className="ae-panel__head">
            <h3>
              <SelIcon size={18} aria-hidden /> {meta.label}
            </h3>
            <OnOffFlag checked={tools[selected].enabled} label={meta.label} onChange={(v) => toggle(selected, v)} />
          </header>
          <p className="ae-help">{meta.help}</p>
          <ToolOptions toolKey={selected} />
        </section>
        <EnginesBox engines={engines} />
      </aside>
    </div>
  );
}

function ToolOptions({ toolKey }: { toolKey: ToolKey }) {
  const tool = useEditor((s) => s.settings.tools[toolKey]) as Record<string, unknown> & { enabled: boolean };
  const { updateSettings } = useActions();
  const options = TOOL_OPTIONS[toolKey] ?? [];
  const setField = (field: string, value: unknown) =>
    updateSettings((d) => {
      (d.tools[toolKey] as Record<string, unknown>)[field] = value;
      if (!d.tools[toolKey].enabled) d.tools[toolKey].enabled = true;
    });
  if (!options.length) return <p className="ae-help">No necesita ajustes: Claude la aplica con criterio de editor.</p>;
  return (
    <div className={clsx("ae-fields", !tool.enabled && "is-dimmed")}>
      {options.map((opt) => (
        <OptionField key={opt.field} option={opt} value={tool[opt.field]} onChange={(v) => setField(opt.field, v)} />
      ))}
    </div>
  );
}

function OptionField({ option, value, onChange }: { option: ToolOption; value: unknown; onChange: (v: unknown) => void }) {
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
              <button key={o.value} type="button" aria-pressed={on} className={clsx("ae-toolbtn", on && "is-on")} onClick={() => onChange(on ? list.filter((x) => x !== o.value) : [...list, o.value])}>
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
      <Field label={`${option.label}: ${n}${option.suffix ? ` ${option.suffix}` : ""}`}>
        <input type="range" className="ae-range" min={option.min} max={option.max} step={option.step ?? 1} value={n} aria-label={option.label} onChange={(e) => onChange(Number(e.target.value))} />
      </Field>
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

