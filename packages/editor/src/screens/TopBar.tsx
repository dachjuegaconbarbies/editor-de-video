/**
 * Barra superior del editor, limpia: logo (vuelve al inicio), nombre del proyecto editable,
 * indicador de guardado, "Lo que Claude aprendió" y ayuda. GENERAR vive dentro del estudio.
 */
import clsx from "clsx";
import { Brain, CircleHelp, Cloud, CloudOff, House, LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useActions, useController, useEditor, useEditorShallow } from "../store/context.js";
import { IconButton, Tooltip } from "../ui/index.js";

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

export function TopBar({ onHome, onHelp }: { onHome: () => void; onHelp: () => void }) {
  const { set } = useActions();
  const panel = useEditor((s) => s.panel);
  const rulesCount = useEditor((s) => s.rules.filter((r) => r.enabled).length);
  const demo = useEditor((s) => s.demo);
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
        <button type="button" className={clsx("ae-learned-btn", panel === "aprendido" && "is-active")} onClick={() => set({ panel: panel === "aprendido" ? null : "aprendido" })} aria-expanded={panel === "aprendido"}>
          <Brain size={15} aria-hidden />
          <span className="ae-learned-btn__text">Lo que Claude aprendió</span>
          {rulesCount > 0 && <span className="ae-count">{rulesCount}</span>}
        </button>
        <IconButton label="Ayuda" icon={<CircleHelp size={17} />} onClick={onHelp} className="ae-topbar__help" />
      </div>
    </header>
  );
}
