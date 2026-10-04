/**
 * Mini-diagrama del flujo (stepper): marca la etapa actual, muestra el estado de cada una y lleva
 * a cualquiera (encuadra su nodo en el lienzo). Doble clic la abre en vista enfocada.
 */
import clsx from "clsx";
import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import { STAGE_ORDER, STAGE_TITLES, STATUS_LABELS, type StageId } from "../lib/stages.js";
import { useActions, useEditor, useStageStates } from "../store/context.js";

export function Stepper() {
  const states = useStageStates();
  const active = useEditor((s) => s.activeStage);
  const reviewPlan = useEditor((s) => s.settings.instruction.reviewPlan);
  const { requestView, openFocus } = useActions();
  const stages = STAGE_ORDER.filter((s) => s !== "plan" || reviewPlan);
  return (
    <nav className="ae-stepper" aria-label="Etapas del flujo">
      <ol>
        {stages.map((id, i) => {
          const st = states[id];
          const isActive = id === active;
          return (
            <li key={id} className="ae-stepper__item">
              {i > 0 && <span className="ae-stepper__line" aria-hidden />}
              <button
                type="button"
                className={clsx("ae-step-pill", `is-${st.status}`, isActive && "is-active")}
                aria-current={isActive ? "step" : undefined}
                title={`${STAGE_TITLES[id]} · ${STATUS_LABELS[st.status]}: ${st.hint}`}
                onClick={() => requestView(id)}
                onDoubleClick={() => openFocus(id)}
              >
                <StepIcon stage={id} status={st.status} index={i + 1} />
                <span className="ae-step-pill__label">{STAGE_TITLES[id]}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepIcon({ status, index }: { stage: StageId; status: string; index: number }) {
  if (status === "listo")
    return (
      <span className="ae-step-pill__icon is-done" aria-hidden>
        <Check size={11} strokeWidth={3} />
      </span>
    );
  if (status === "procesando")
    return (
      <span className="ae-step-pill__icon is-busy" aria-hidden>
        <LoaderCircle size={12} className="ae-spin" />
      </span>
    );
  if (status === "error")
    return (
      <span className="ae-step-pill__icon is-error" aria-hidden>
        <CircleAlert size={12} />
      </span>
    );
  return (
    <span className={clsx("ae-step-pill__icon", status === "esperando" && "is-wait")} aria-hidden>
      {index}
    </span>
  );
}
