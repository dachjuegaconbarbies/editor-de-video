/**
 * Panel "Lo que Claude aprendió" (versión base; la ola 2 agrega métricas, edición y glosario).
 * Cada regla muestra de dónde salió y se puede apagar o borrar. Nada se aprende sin revisión.
 */
import type { MemoryRule } from "@autoeditor/shared";
import clsx from "clsx";
import { Brain, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRef } from "react";
import { formatRelative } from "../lib/format.js";
import { useActions, useController, useEditor } from "../store/context.js";
import { Chip, EmptyState, IconButton, Switch, useFocusTrap } from "../ui/index.js";

const SOURCE_LABELS: Record<MemoryRule["source"]["type"], string> = {
  correccion: "De una corrección",
  calificacion: "De tus 👍/👎",
  manual: "La escribiste tú",
  glosario: "Del glosario",
  "palabras-clave": "De palabras clave",
  plan: "De un plan",
  exportacion: "De lo que exportaste",
};

const SCOPE_LABELS: Record<MemoryRule["scope"], string> = { global: "Siempre", marca: "Esta marca", estilo: "Este estilo", proyecto: "Este proyecto" };

export function LearnedPanel() {
  const open = useEditor((s) => s.panel === "aprendido");
  const { set } = useActions();
  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          className="ae-drawer"
          aria-label="Lo que Claude aprendió"
          initial={{ x: 24, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 24, opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
        >
          <DrawerBody onClose={() => set({ panel: null })} />
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function DrawerBody({ onClose }: { onClose: () => void }) {
  const rules = useEditor((s) => s.rules);
  const controller = useController();
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose);
  return (
    <div ref={ref} className="ae-drawer__inner" tabIndex={-1}>
      <header className="ae-drawer__head">
        <h2>
          <Brain size={18} aria-hidden /> Lo que Claude aprendió
        </h2>
        <IconButton label="Cerrar panel" icon={<X size={18} />} onClick={onClose} />
      </header>
      <p className="ae-help">Reglas cortas que Claude revisa antes de cada edición. Puedes apagarlas o borrarlas cuando quieras.</p>
      {rules.length === 0 ? (
        <EmptyState icon={<Brain size={22} />} title="Todavía no aprendí nada">
          Cuando corrijas un video te preguntaré con un toque si lo recuerdo: solo este proyecto, este estilo o siempre.
        </EmptyState>
      ) : (
        <ul className="ae-rules">
          {rules.map((r) => (
            <li key={r.id} className={clsx("ae-rule", !r.enabled && "is-off")}>
              <div className="ae-rule__main">
                <div className="ae-rule__text">{r.text}</div>
                <div className="ae-rule__meta">
                  <Chip size="sm" tone="outline">
                    {SCOPE_LABELS[r.scope]}
                  </Chip>
                  <span>{SOURCE_LABELS[r.source.type]}</span>
                </div>
                {r.source.excerpt && <div className="ae-rule__excerpt">“{r.source.excerpt}”</div>}
                <div className="ae-rule__foot">
                  {formatRelative(r.updatedAt)}
                  {r.timesApplied > 0 && ` · aplicada ${r.timesApplied} ${r.timesApplied === 1 ? "vez" : "veces"}`}
                </div>
              </div>
              <div className="ae-rule__actions">
                <Switch label={<span className="ae-sr">{r.enabled ? "Apagar regla" : "Prender regla"}</span>} checked={r.enabled} onChange={(v) => void controller.toggleRule(r.id, v)} />
                <IconButton label="Borrar regla" icon={<Trash2 size={15} />} onClick={() => void controller.deleteRule(r.id)} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
