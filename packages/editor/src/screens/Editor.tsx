/**
 * Pantalla del editor: barra superior + ESTUDIO (pizarra con el panel blanco y las versiones a la
 * derecha) + panel "Lo que Claude aprendió" + ayuda y atajos. La vista de nodos (diagrama) queda
 * como "Vista avanzada", escondida en la ayuda.
 */
import { ArrowLeft, ArrowRight, Workflow } from "lucide-react";
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
import { StudioBoard } from "../studio/StudioBoard.js";
import { LearnedPanel } from "./LearnedPanel.js";
import { Stepper } from "./Stepper.js";
import { TopBar } from "./TopBar.js";

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

function useShortcuts(openHelp: () => void, advanced: boolean) {
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
        } else if (!advanced) {
          return;
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
  }, [controller, store, openHelp, advanced]);
}

export function EditorScreen() {
  const controller = useController();
  const view = useEditor((s) => s.view);
  const { set } = useActions();
  const [help, setHelp] = useState(false);
  const advanced = view === "avanzada";
  useShortcuts(() => setHelp(true), advanced);
  return (
    <div className="ae-editor">
      <TopBar onHome={() => void controller.closeProject()} onHelp={() => setHelp(true)} />
      <main className={advanced ? "ae-editor__canvas" : "ae-editor__canvas ae-editor__canvas--studio"}>
        {advanced ? (
          <>
            <FlowCanvas />
            <Stepper />
            <Button size="sm" tone="ink" icon={<ArrowLeft size={14} />} className="ae-back-studio" onClick={() => set({ view: "estudio", focus: null })}>
              Volver al estudio
            </Button>
          </>
        ) : (
          <StudioBoard />
        )}
        <RuleSuggestion />
      </main>
      <LearnedPanel />
      {advanced && <FocusView />}
      <HelpModal
        open={help}
        onClose={() => setHelp(false)}
        advanced={advanced}
        onToggleAdvanced={() => {
          set({ view: advanced ? "estudio" : "avanzada", focus: null });
          setHelp(false);
        }}
      />
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

function HelpModal({ open, onClose, advanced, onToggleAdvanced }: { open: boolean; onClose: () => void; advanced: boolean; onToggleAdvanced: () => void }) {
  const rows: [string[], string][] = [
    [["Ctrl", "Enter"], "Generar"],
    [["Ctrl", "Z"], "Deshacer un cambio de ajustes"],
    [["Ctrl", "Shift", "Z"], "Rehacer"],
    [["Ctrl", "S"], "Guardar ahora (también se guarda solo)"],
    [["Alt", "↑ / ↓"], "Reordenar un clip base con el foco"],
    [["Esc"], "Cerrar ventanas"],
  ];
  return (
    <Modal open={open} onClose={onClose} title="Cómo funciona" width={520}>
      <ol className="ae-howto">
        <li>
          <b>Sube tu clip base</b> arriba (el video principal). Puede traer de todo: Claude identifica lo que hablas, las tomas de apoyo y las tomas repetidas.
        </li>
        <li>
          <b>Suelta lo demás</b> abajo si quieres: otros clips, fotos, música, logos o referencias. No tienes que etiquetar nada.
        </li>
        <li>
          <b>Toca GENERAR.</b> Verás el progreso en vivo y tu V1 aparecerá a la derecha.
        </li>
        <li>
          <b>Corrige con texto</b> (“quita este corte”). Sale V2 y solo cambia lo que pediste.
        </li>
      </ol>
      <h3 className="ae-help__h">Atajos de teclado</h3>
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
      <div className="ae-help__adv">
        <Button size="sm" tone="ghost" icon={<Workflow size={14} />} onClick={onToggleAdvanced}>
          {advanced ? "Volver al estudio" : "Vista avanzada (diagrama de nodos)"}
        </Button>
      </div>
    </Modal>
  );
}
