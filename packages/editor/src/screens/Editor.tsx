/**
 * Pantalla del editor: barra superior + lienzo con el stepper flotante + vista enfocada +
 * panel "Lo que Claude aprendió" + atajos de teclado.
 */
import { ArrowLeft, ArrowRight, Keyboard } from "lucide-react";
import { useEffect, useState } from "react";
import { FlowCanvas } from "../canvas/FlowCanvas.js";
import { STAGE_ORDER, STAGE_TITLES, type StageId } from "../lib/stages.js";
import { ContextStage } from "../stages/context/index.js";
import { InstructionStage } from "../stages/instruction/index.js";
import { MaterialStage } from "../stages/material/index.js";
import { PlanStage } from "../stages/plan/index.js";
import { ResultStage } from "../stages/result/index.js";
import { ToolsStage } from "../stages/tools/index.js";
import { TranscriptionStage } from "../stages/transcription/index.js";
import { useActions, useController, useEditor, useEditorContext } from "../store/context.js";
import { Button, FocusOverlay, IconButton, Kbd, Modal } from "../ui/index.js";
import { LearnedPanel } from "./LearnedPanel.js";
import { Stepper } from "./Stepper.js";
import { TopBar } from "./TopBar.js";

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

function useShortcuts(openHelp: () => void) {
  const controller = useController();
  const { store } = useEditorContext();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const typing = isTyping(e.target);
      const key = e.key.toLowerCase();
      if (mod && key === "z" && !typing) {
        e.preventDefault();
        if (e.shiftKey) controller.redo();
        else controller.undo();
      } else if (mod && key === "y" && !typing) {
        e.preventDefault();
        controller.redo();
      } else if (mod && key === "s") {
        e.preventDefault();
        void controller.flushSave();
      } else if (mod && key === "enter") {
        e.preventDefault();
        void controller.generate();
      } else if (!mod && !typing && !store.getState().focus) {
        if (e.key === "?") {
          e.preventDefault();
          openHelp();
        } else if (e.key === "0") store.getState().requestView("todo");
        else if (/^[1-8]$/.test(e.key)) {
          const visible = STAGE_ORDER.filter((s) => s !== "plan" || store.getState().settings.instruction.reviewPlan);
          const stage = visible[Number(e.key) - 1];
          if (stage) store.getState().requestView(stage);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [controller, store, openHelp]);
}

export function EditorScreen() {
  const controller = useController();
  const [help, setHelp] = useState(false);
  useShortcuts(() => setHelp(true));
  return (
    <div className="ae-editor">
      <TopBar onHome={() => void controller.closeProject()} />
      <main className="ae-editor__canvas">
        <FlowCanvas />
        <Stepper />
        <button type="button" className="ae-help-btn" onClick={() => setHelp(true)} aria-label="Atajos de teclado (?)" title="Atajos de teclado (?)">
          <Keyboard size={16} aria-hidden />
        </button>
        <RuleSuggestion />
      </main>
      <LearnedPanel />
      <FocusView />
      <ShortcutsModal open={help} onClose={() => setHelp(false)} />
    </div>
  );
}

function FocusView() {
  const focus = useEditor((s) => s.focus);
  const reviewPlan = useEditor((s) => s.settings.instruction.reviewPlan);
  const { closeFocus, openFocus, requestView } = useActions();
  const stages = STAGE_ORDER.filter((s) => s !== "plan" || reviewPlan);
  const idx = focus ? stages.indexOf(focus.stage) : -1;
  const prev = idx > 0 ? stages[idx - 1] : undefined;
  const next = idx >= 0 && idx < stages.length - 1 ? stages[idx + 1] : undefined;
  const close = () => {
    if (focus) requestView(focus.stage);
    closeFocus();
  };
  return (
    <FocusOverlay
      open={!!focus}
      onClose={close}
      label={focus ? `${STAGE_TITLES[focus.stage]} en vista enfocada` : "Vista enfocada"}
      title={
        focus && (
          <>
            <span className="ae-focus__tab">{STAGE_TITLES[focus.stage]}</span>
            <span className="ae-focus__step">
              Etapa {idx + 1} de {stages.length}
            </span>
          </>
        )
      }
      actions={
        <div className="ae-focus__nav">
          <IconButton label={prev ? `Anterior: ${STAGE_TITLES[prev]}` : "Anterior"} icon={<ArrowLeft size={16} />} disabled={!prev} onClick={() => prev && openFocus(prev)} />
          <IconButton label={next ? `Siguiente: ${STAGE_TITLES[next]}` : "Siguiente"} icon={<ArrowRight size={16} />} disabled={!next} onClick={() => next && openFocus(next)} />
        </div>
      }
    >
      {focus && <FocusContent stage={focus.stage} target={focus.target} />}
    </FocusOverlay>
  );
}

function FocusContent({ stage, target }: { stage: StageId; target?: string }) {
  switch (stage) {
    case "material":
      return <MaterialStage variant="focus" />;
    case "contexto":
      return <ContextStage variant="focus" target={target} />;
    case "transcripcion":
      return <TranscriptionStage variant="focus" />;
    case "herramientas":
      return <ToolsStage variant="focus" target={target} />;
    case "instruccion":
      return <InstructionStage variant="focus" />;
    case "plan":
      return <PlanStage variant="focus" />;
    case "resultado":
    case "versiones":
      return <ResultStage variant="focus" target={target} />;
  }
}

function RuleSuggestion() {
  const suggestion = useEditor((s) => s.ruleSuggestion);
  const { set, toast } = useActions();
  const controller = useController();
  const { getApi } = useEditorContext();
  if (!suggestion) return null;
  const remember = async (scope: "proyecto" | "estilo" | "global") => {
    set({ ruleSuggestion: null });
    try {
      await getApi().createRule({ text: suggestion.text, scope });
      void controller.loadRules();
      toast({ kind: "exito", text: "Listo, lo recordaré." });
    } catch {
      toast({ kind: "error", text: "No se pudo guardar la regla." });
    }
  };
  return (
    <div className="ae-suggest" role="dialog" aria-label="¿Lo recuerdo?">
      <div className="ae-suggest__text">
        <b>¿Lo recuerdo?</b> “{suggestion.text}”
      </div>
      <div className="ae-row">
        <Button size="sm" tone="ghost" onClick={() => void remember("proyecto")}>
          Solo este proyecto
        </Button>
        <Button size="sm" tone="ghost" onClick={() => void remember("estilo")}>
          Este estilo
        </Button>
        <Button size="sm" tone="ink" onClick={() => void remember("global")}>
          Siempre
        </Button>
        <Button size="sm" tone="plain" onClick={() => set({ ruleSuggestion: null })}>
          No
        </Button>
      </div>
    </div>
  );
}

function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rows: [string[], string][] = [
    [["Ctrl", "Z"], "Deshacer un cambio de configuración"],
    [["Ctrl", "Shift", "Z"], "Rehacer"],
    [["Ctrl", "S"], "Guardar ahora (también se guarda solo)"],
    [["Ctrl", "Enter"], "Generar"],
    [["1", "…", "8"], "Ir a una etapa"],
    [["0"], "Ver todo el diagrama"],
    [["Doble clic"], "Abrir una tarjeta en grande"],
    [["Enter"], "Abrir la tarjeta con foco"],
    [["Esc"], "Volver al diagrama"],
    [["Ctrl", "rueda"], "Zoom del lienzo (la rueda sola lo desplaza)"],
  ];
  return (
    <Modal open={open} onClose={onClose} title="Atajos de teclado" width={480}>
      <dl className="ae-shortcuts">
        {rows.map(([keys, text]) => (
          <div key={text} className="ae-shortcuts__row">
            <dt>
              {keys.map((k, i) => (
                <Kbd key={i}>{k}</Kbd>
              ))}
            </dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
