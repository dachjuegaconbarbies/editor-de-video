/**
 * Etapa INSTRUCCIÓN PARA CLAUDE.
 * Caja grande + ejemplos, formato, DURACIÓN del video final (atajos 15/30/45/60/90 s, libre o
 * personalizada, con modo auto/aproximada/exacta), plataforma, tono, resumen, estimado con
 * desglose, "Revisar plan antes de renderizar" y GENERAR.
 */
import { DEFAULT_ASPECT_FOR_PLATFORM, PLATFORM_LABELS, formatUsd, type AspectRatio, type Estimate, type Platform, type ProjectSettings } from "@autoeditor/shared";
import clsx from "clsx";
import { Clock, Coins, Sparkles, TriangleAlert, WandSparkles } from "lucide-react";
import { useState } from "react";
import { formatSecondsShort } from "../../lib/format.js";
import { useActions, useActiveJob, useController, useEditor, useEditorShallow, useEstimate, useStageStates, useWarnings } from "../../store/context.js";
import { Field, PurpleButton, Segmented, StageCard, Switch } from "../../ui/index.js";
import type { StageProps } from "../material/index.js";

export const DURATION_PRESETS = [15, 30, 45, 60, 90] as const;

const EXAMPLES = [
  "Reel de 30 s con gancho fuerte en los primeros 3 segundos y subtítulos grandes.",
  "Resumen de mi podcast con los mejores momentos y B-roll de fondo.",
  "Anuncio del producto: problema, solución y llamado a la acción al final.",
];

const TONES = ["dinámico", "profesional", "divertido", "emotivo", "educativo", "minimalista"];

const FORMAT_OPTIONS: { value: AspectRatio; label: string }[] = [
  { value: "9:16", label: "9:16" },
  { value: "1:1", label: "1:1" },
  { value: "4:5", label: "4:5" },
  { value: "16:9", label: "16:9" },
];

function FormatIcon({ aspect }: { aspect: AspectRatio }) {
  const [w, h] = aspect.split(":").map(Number) as [number, number];
  const scale = 12 / Math.max(w, h);
  return <span className="ae-fmticon" style={{ width: Math.round(w * scale), height: Math.round(h * scale) }} aria-hidden />;
}

function useInstruction() {
  const instruction = useEditor((s) => s.settings.instruction);
  const { updateSettings } = useActions();
  const set = (fn: (d: ProjectSettings["instruction"]) => void) => updateSettings((d) => fn(d.instruction));
  return { instruction, set };
}

export function InstructionStage({ variant }: StageProps) {
  const states = useStageStates();
  const { openFocus } = useActions();
  const st = states.instruccion;
  if (variant === "focus") return <InstructionFocus />;
  return (
    <StageCard title="Instrucción para Claude" variant="compact" status={st.status} statusLabel={st.status === "vacio" ? "Opcional" : undefined} onOpen={() => openFocus("instruccion")} width={328}>
      <div className="ae-stack">
        <InstructionText rows={4} />
        <FormatField />
        <DurationField compact />
        <PlatformToneRow compact />
        <ReviewPlanSwitch />
        <Warnings />
        <EstimateLine />
        <GenerateButton />
      </div>
    </StageCard>
  );
}

function InstructionText({ rows }: { rows: number }) {
  const { instruction, set } = useInstruction();
  return (
    <div className="ae-instr">
      <textarea
        className="ae-input ae-textarea ae-instr__text nodrag nowheel"
        rows={rows}
        placeholder="Describe el video que quieres…"
        aria-label="Describe el video que quieres"
        value={instruction.text}
        onChange={(e) => set((d) => void (d.text = e.target.value))}
      />
      {!instruction.text.trim() && (
        <div className="ae-examples" aria-label="Ejemplos para empezar">
          {EXAMPLES.slice(0, rows > 6 ? 3 : 2).map((ex) => (
            <button key={ex} type="button" className="ae-example nodrag" onClick={() => set((d) => void (d.text = ex))}>
              <Sparkles size={12} aria-hidden />
              <span>{ex}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FormatField() {
  const { instruction, set } = useInstruction();
  return (
    <Field label="Formato">
      <Segmented
        size="sm"
        label="Formato del video"
        value={instruction.format}
        onChange={(format) => set((d) => void (d.format = format))}
        options={FORMAT_OPTIONS.map((o) => ({
          value: o.value,
          label: (
            <span className="ae-fmt">
              <FormatIcon aspect={o.value} />
              {o.label}
            </span>
          ),
        }))}
      />
    </Field>
  );
}

export function DurationField({ compact }: { compact?: boolean }) {
  const { instruction, set } = useInstruction();
  const value = instruction.targetDuration;
  const isPreset = value != null && (DURATION_PRESETS as readonly number[]).includes(value);
  const [custom, setCustom] = useState<string>(value != null && !isPreset ? String(value) : "");
  const choose = (v: number | null) =>
    set((d) => {
      d.targetDuration = v;
      if (v == null) d.durationMode = "auto";
      else if (d.durationMode === "auto") d.durationMode = "aproximada";
    });
  type DurOpt = "libre" | `${number}`;
  const segValue: DurOpt | null = value == null ? "libre" : isPreset ? (String(value) as DurOpt) : null;
  const modeNote =
    value == null
      ? "Claude elige la duración según el material."
      : instruction.durationMode === "exacta"
        ? `Exactamente ${value} s (±0.5 s).`
        : instruction.durationMode === "aproximada"
          ? `Entre ${formatSecondsShort(value * 0.85)} y ${formatSecondsShort(value * 1.15)}.`
          : `Cerca de ${value} s; Claude puede ajustarla si el material lo pide.`;
  return (
    <Field label="Duración del video final" hint={compact ? undefined : "Claude la respeta y la revisión de calidad la verifica."}>
      <div className="ae-dur">
        <Segmented<DurOpt>
          size="sm"
          label="Duración del video final"
          value={segValue}
          onChange={(v) => {
            setCustom("");
            choose(v === "libre" ? null : Number(v));
          }}
          options={[...DURATION_PRESETS.map((p) => ({ value: String(p) as DurOpt, label: `${p}s`, title: `${p} segundos` })), { value: "libre" as DurOpt, label: "Libre", title: "Claude decide según el material" }]}
        />
        <div className="ae-dur__row">
          <label className={clsx("ae-dur__custom", value != null && !isPreset && "is-active")}>
            <input
              className="ae-input ae-input--sm nodrag"
              inputMode="numeric"
              placeholder="Otra"
              aria-label="Duración personalizada en segundos"
              value={custom}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^\d]/g, "").slice(0, 4);
                setCustom(raw);
                const n = Number(raw);
                if (raw && n >= 3 && n <= 1800) choose(n);
              }}
            />
            <span>s</span>
          </label>
          {value != null && (
            <Segmented
              size="sm"
              label="Qué tan exacta"
              value={instruction.durationMode}
              onChange={(m) => set((d) => void (d.durationMode = m))}
              options={[
                { value: "aproximada", label: "Aprox.", title: "±15 %" },
                { value: "exacta", label: "Exacta", title: "±0.5 s" },
                { value: "auto", label: "Flexible", title: "Claude puede ajustarla" },
              ]}
            />
          )}
        </div>
        <div className="ae-dur__note">{modeNote}</div>
      </div>
    </Field>
  );
}

function PlatformToneRow({ compact }: { compact?: boolean }) {
  const { instruction, set } = useInstruction();
  return (
    <div className={clsx("ae-grid2", compact && "ae-grid2--tight")}>
      <Field label="Plataforma">
        <select
          className="ae-input ae-select ae-input--sm nodrag"
          value={instruction.platform}
          aria-label="Plataforma"
          onChange={(e) => {
            const platform = e.target.value as Platform;
            set((d) => {
              d.platform = platform;
              d.format = DEFAULT_ASPECT_FOR_PLATFORM[platform];
            });
          }}
        >
          {(Object.keys(PLATFORM_LABELS) as Platform[]).map((p) => (
            <option key={p} value={p}>
              {PLATFORM_LABELS[p]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Tono">
        <select className="ae-input ae-select ae-input--sm nodrag" value={TONES.includes(instruction.tone) ? instruction.tone : "__otro"} aria-label="Tono" onChange={(e) => set((d) => void (d.tone = e.target.value === "__otro" ? d.tone : e.target.value))}>
          {TONES.map((t) => (
            <option key={t} value={t}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </option>
          ))}
          {!TONES.includes(instruction.tone) && <option value="__otro">{instruction.tone}</option>}
        </select>
      </Field>
    </div>
  );
}

function ReviewPlanSwitch() {
  const { instruction, set } = useInstruction();
  return (
    <Switch
      className="nodrag"
      label="Revisar plan antes de renderizar"
      description="Ves el storyboard y lo apruebas antes de gastar tiempo y créditos."
      checked={instruction.reviewPlan}
      onChange={(v) => set((d) => void (d.reviewPlan = v))}
    />
  );
}

function Warnings() {
  const warnings = useWarnings().filter((w) => w.id !== "sin-material");
  if (!warnings.length) return null;
  return (
    <ul className="ae-warnings" aria-label="Avisos antes de generar">
      {warnings.map((w) => (
        <li key={w.id} className={clsx("ae-warning", w.severity === "bloqueo" && "is-block")}>
          <TriangleAlert size={14} aria-hidden />
          <span>{w.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function EstimateLine({ showBreakdown }: { showBreakdown?: boolean }) {
  const est = useEstimate();
  if (!est) return <div className="ae-estimate is-empty">El estimado aparece al conectar con el servidor.</div>;
  return (
    <div className="ae-estimate">
      <div className="ae-estimate__main">
        <span className="ae-estimate__item">
          <Clock size={14} aria-hidden /> {est.label}
        </span>
        <span className="ae-estimate__item">
          <Coins size={14} aria-hidden /> {est.costLabel}
        </span>
        <span className="ae-estimate__note">estimado</span>
      </div>
      {showBreakdown && <EstimateBreakdown estimate={est} />}
    </div>
  );
}

export function EstimateBreakdown({ estimate }: { estimate: Estimate }) {
  return (
    <div className="ae-breakdown">
      <table>
        <thead>
          <tr>
            <th scope="col">Paso</th>
            <th scope="col">Tiempo</th>
            <th scope="col">Costo</th>
          </tr>
        </thead>
        <tbody>
          {estimate.lines.map((l) => (
            <tr key={l.stage}>
              <td>
                <div className="ae-breakdown__label">{l.label}</div>
                <div className="ae-breakdown__detail">{l.detail}</div>
              </td>
              <td>{formatSecondsShort(l.seconds)}</td>
              <td>{l.costUsd > 0 ? formatUsd(l.costUsd) : "—"}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td>{estimate.label}</td>
            <td>{estimate.costLabel}</td>
          </tr>
        </tfoot>
      </table>
      <p className="ae-help">
        {estimate.calibrationSamples > 0
          ? `Calibrado con ${estimate.calibrationSamples} renders reales.`
          : "Se recalibra solo con los tiempos reales de cada render."}{" "}
        Costo = Claude + Kie AI.
      </p>
    </div>
  );
}

export function GenerateButton({ size = "lg" }: { size?: "md" | "lg" }) {
  const controller = useController();
  const job = useActiveJob();
  const warnings = useWarnings();
  const { connected, hasVersions } = useEditorShallow((s) => ({ connected: s.connection === "conectado" || s.demo, hasVersions: s.versions.length > 0 }));
  const block = warnings.find((w) => w.severity === "bloqueo");
  const busy = !!job && (job.status === "corriendo" || job.status === "en-cola");
  const disabled = !!block || busy || !connected;
  const reason = busy ? "Ya se está generando." : block ? block.text : !connected ? "Sin conexión con el servidor." : undefined;
  return (
    <div className="ae-generate">
      <PurpleButton size={size} block icon={<WandSparkles size={18} aria-hidden />} disabled={disabled} loading={busy} onClick={() => void controller.generate()} title={reason} className="ae-generate__btn nodrag">
        {busy ? "Generando…" : hasVersions ? "Generar de nuevo" : "Generar"}
      </PurpleButton>
      {reason && !busy && <div className="ae-generate__why">{reason}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------- Vista enfocada

function InstructionFocus() {
  const { assets, settings, rules } = useEditorShallow((s) => ({ assets: s.assets, settings: s.settings, rules: s.rules }));
  const est = useEstimate();
  const raw = assets.filter((a) => a.category.startsWith("crudo-"));
  const ctxOn = (["script", "brand", "references"] as const).filter((k) => settings.context[k].enabled);
  const toolsOn = Object.values(settings.tools).filter((t) => t.enabled).length;
  const activeRules = rules.filter((r) => r.enabled);
  const ctxNames = { script: "guion", brand: "marca", references: "referencias" } as const;
  return (
    <div className="ae-instr-focus">
      <section className="ae-panel" aria-label="Instrucción">
        <header className="ae-panel__head">
          <h3>Describe el video que quieres</h3>
        </header>
        <InstructionText rows={8} />
        <div className="ae-grid2">
          <FormatField />
          <PlatformToneRow />
        </div>
        <DurationField />
        <ReviewPlanSwitch />
      </section>
      <aside className="ae-instr-focus__side">
        <section className="ae-panel" aria-label="Lo que Claude va a usar">
          <header className="ae-panel__head">
            <h3>Lo que Claude va a usar</h3>
          </header>
          <ul className="ae-summary">
            <li>
              <b>Material:</b> {raw.length ? `${raw.length} archivos` : "falta subir"}
            </li>
            <li>
              <b>Contexto:</b> {ctxOn.length ? ctxOn.map((k) => ctxNames[k]).join(", ") : "ninguno (estructura y estilo neutro)"}
            </li>
            <li>
              <b>Herramientas:</b> {toolsOn} prendidas
            </li>
            <li>
              <b>Duración:</b>{" "}
              {settings.instruction.targetDuration == null
                ? "libre (Claude decide)"
                : `${settings.instruction.targetDuration} s · ${settings.instruction.durationMode === "exacta" ? "exacta" : settings.instruction.durationMode === "aproximada" ? "aproximada" : "flexible"}`}
            </li>
            <li>
              <b>Lo aprendido de ti:</b> {activeRules.length ? `${activeRules.length} reglas` : "todavía nada"}
            </li>
          </ul>
          <Warnings />
        </section>
        <section className="ae-panel" aria-label="Tiempo y costo estimados">
          <header className="ae-panel__head">
            <h3>Tiempo y costo estimados</h3>
          </header>
          {est ? <EstimateBreakdown estimate={est} /> : <p className="ae-help">El estimado aparece al conectar con el servidor.</p>}
        </section>
        <GenerateButton />
      </aside>
    </div>
  );
}
