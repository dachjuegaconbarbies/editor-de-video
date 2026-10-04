/**
 * Barra superior del editor: logo "Autoeditor", nombre del proyecto editable, indicador de guardado,
 * deshacer/rehacer, "Lo que Claude aprendió", chip de estimado (abre el desglose) y GENERAR.
 */
import clsx from "clsx";
import { Brain, Clock, Cloud, CloudOff, Coins, House, LoaderCircle, Redo2, TriangleAlert, Undo2, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EstimateBreakdown } from "../stages/instruction/index.js";
import { useActions, useActiveJob, useController, useEditor, useEditorShallow, useEstimate, useHistory, useWarnings } from "../store/context.js";
import { IconButton, Popover, PurpleButton, Tooltip } from "../ui/index.js";

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <span className="ae-logo">
      <span className="ae-logo__mark" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      {!compact && <span className="ae-logo__text">Autoeditor</span>}
    </span>
  );
}

function ProjectName() {
  const name = useEditor((s) => s.project?.name ?? "");
  const { setProjectName } = useActions();
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  return (
    <input
      className="ae-projname"
      value={draft}
      aria-label="Nombre del proyecto"
      placeholder="Proyecto sin título"
      size={Math.max(12, Math.min(40, draft.length + 1))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft.trim() !== name && setProjectName(draft.trim() || "Proyecto sin título")}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(name);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

export function SaveIndicator() {
  const { save, demo } = useEditorShallow((s) => ({ save: s.save, demo: s.demo }));
  const controller = useController();
  const map = {
    inactivo: { icon: <Cloud size={14} />, text: "", cls: "" },
    pendiente: { icon: <Cloud size={14} />, text: "Cambios sin guardar", cls: "is-pending" },
    guardando: { icon: <LoaderCircle size={14} className="ae-spin" />, text: "Guardando…", cls: "is-saving" },
    guardado: { icon: <Cloud size={14} />, text: demo ? "Guardado (demo)" : "Guardado", cls: "is-saved" },
    "sin-conexion": { icon: <CloudOff size={14} />, text: "Sin conexión", cls: "is-offline" },
    error: { icon: <TriangleAlert size={14} />, text: "No se guardó", cls: "is-error" },
  } as const;
  const v = map[save.status];
  if (!v.text) return null;
  const retry = save.status === "sin-conexion" || save.status === "error";
  return (
    <span className={clsx("ae-save", v.cls)} role="status" aria-live="polite" title={save.error ?? undefined}>
      {v.icon}
      <span className="ae-save__text">{v.text}</span>
      {retry && (
        <button type="button" className="ae-save__retry" onClick={() => void controller.flushSave()}>
          Reintentar
        </button>
      )}
    </span>
  );
}

function EstimateChip() {
  const est = useEstimate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  if (!est) return null;
  return (
    <div className="ae-estchip-wrap">
      <button ref={ref} type="button" className="ae-estchip" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)} title="Tiempo y costo estimados (clic para ver el desglose)">
        <Clock size={14} aria-hidden />
        <span>{est.label}</span>
        <span className="ae-estchip__sep" aria-hidden />
        <Coins size={14} aria-hidden />
        <span>{est.costLabel}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} label="Desglose del estimado" className="ae-estpop">
        <div className="ae-estpop__title">Tiempo y costo estimados</div>
        <EstimateBreakdown estimate={est} />
      </Popover>
    </div>
  );
}

export function TopBar({ onHome }: { onHome: () => void }) {
  const controller = useController();
  const { canUndo, canRedo } = useHistory();
  const { set, requestView } = useActions();
  const panel = useEditor((s) => s.panel);
  const rulesCount = useEditor((s) => s.rules.filter((r) => r.enabled).length);
  const job = useActiveJob();
  const warnings = useWarnings();
  const demo = useEditor((s) => s.demo);
  const block = warnings.find((w) => w.severity === "bloqueo");
  const busy = !!job && (job.status === "corriendo" || job.status === "en-cola");
  return (
    <header className="ae-topbar">
      <div className="ae-topbar__left">
        <Tooltip text="Inicio" side="bottom">
          <button type="button" className="ae-home-btn" onClick={onHome} aria-label="Ir al inicio">
            <Logo />
            <House size={16} className="ae-home-btn__icon" aria-hidden />
          </button>
        </Tooltip>
        <span className="ae-topbar__slash" aria-hidden>
          /
        </span>
        <ProjectName />
        {demo && <span className="ae-demo-badge">Demo</span>}
        <SaveIndicator />
      </div>
      <div className="ae-topbar__right">
        <div className="ae-history" role="group" aria-label="Deshacer y rehacer">
          <IconButton label="Deshacer (Ctrl+Z)" icon={<Undo2 size={16} />} disabled={!canUndo} onClick={() => controller.undo()} />
          <IconButton label="Rehacer (Ctrl+Shift+Z)" icon={<Redo2 size={16} />} disabled={!canRedo} onClick={() => controller.redo()} />
        </div>
        <button type="button" className={clsx("ae-learned-btn", panel === "aprendido" && "is-active")} onClick={() => set({ panel: panel === "aprendido" ? null : "aprendido" })} aria-expanded={panel === "aprendido"}>
          <Brain size={15} aria-hidden />
          <span className="ae-learned-btn__text">Lo que Claude aprendió</span>
          {rulesCount > 0 && <span className="ae-count">{rulesCount}</span>}
        </button>
        <EstimateChip />
        <PurpleButton
          icon={<WandSparkles size={16} aria-hidden />}
          disabled={!!block || busy}
          loading={busy}
          title={block?.text ?? (busy ? "Ya se está generando." : "Generar (Ctrl+Enter)")}
          onClick={() => {
            void controller.generate();
            requestView("resultado");
          }}
          className="ae-topbar__generate"
        >
          {busy ? "Generando…" : "Generar"}
        </PurpleButton>
      </div>
    </header>
  );
}
