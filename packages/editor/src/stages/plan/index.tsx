/**
 * PLAN DE EDICIÓN (solo con "Revisar plan antes de renderizar"): storyboard de Claude con escenas,
 * duración, textos, música, gráficos y lo que se generará con IA. Se aprueba o se piden ajustes.
 * Versión base (la ola 2 la profundiza).
 */
import { formatUsd } from "@autoeditor/shared";
import { ClipboardList, Send, WandSparkles } from "lucide-react";
import { useState } from "react";
import { formatSecondsShort } from "../../lib/format.js";
import { useActions, useController, useEditor, useStageStates } from "../../store/context.js";
import { Button, Chip, EmptyState, PurpleButton, StageCard } from "../../ui/index.js";
import type { StageProps } from "../material/index.js";

export function PlanStage({ variant }: StageProps) {
  const states = useStageStates();
  const { openFocus } = useActions();
  const st = states.plan;
  if (variant === "focus") return <PlanBody focus />;
  return (
    <StageCard title="Plan de edición" variant="compact" status={st.status} hint={st.hint} onOpen={() => openFocus("plan")} width={280}>
      <PlanBody />
    </StageCard>
  );
}

function PlanBody({ focus }: { focus?: boolean }) {
  const plan = useEditor((s) => s.pendingPlan);
  const controller = useController();
  const [feedback, setFeedback] = useState("");
  const [asking, setAsking] = useState(false);
  if (!plan) {
    return (
      <EmptyState compact={!focus} icon={<ClipboardList size={20} />} title="El plan aparece aquí">
        Al pulsar GENERAR, Claude te muestra el storyboard antes de renderizar para no gastar tiempo ni créditos en un video mal planteado.
      </EmptyState>
    );
  }
  const scenes = focus ? plan.scenes : plan.scenes.slice(0, 5);
  const total = plan.scenes.reduce((s, sc) => s + (sc.end - sc.start), 0);
  const pending = plan.status === "pendiente";
  return (
    <div className="ae-stack">
      {plan.summary && <p className="ae-plan__summary">{plan.summary}</p>}
      <div className="ae-row ae-row--wrap ae-row--tight">
        <Chip size="sm" tone="outline">
          {plan.scenes.length} escenas
        </Chip>
        <Chip size="sm" tone="outline">
          {formatSecondsShort(total)}
        </Chip>
        {plan.estimatedCostUsd > 0 && (
          <Chip size="sm" tone="purple">
            IA {formatUsd(plan.estimatedCostUsd)}
          </Chip>
        )}
      </div>
      <ol className="ae-scenes">
        {scenes.map((sc, i) => (
          <li key={sc.id} className="ae-scene">
            <span className="ae-scene__n">{i + 1}</span>
            <div className="ae-scene__main">
              <div className="ae-scene__title">{sc.title}</div>
              {focus && (
                <div className="ae-scene__detail">
                  {sc.onScreenText.length > 0 && <span>Texto: “{sc.onScreenText.join(" · ")}”</span>}
                  {sc.music && <span>Música: {sc.music}</span>}
                  {sc.graphics.length > 0 && <span>Gráficos: {sc.graphics.join(", ")}</span>}
                  {sc.ai.map((a, j) => (
                    <span key={j}>
                      IA ({a.kind}): “{a.prompt}” {a.costUsd != null ? `· ${formatUsd(a.costUsd)}` : ""}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <span className="ae-scene__dur">{formatSecondsShort(sc.end - sc.start)}</span>
          </li>
        ))}
        {!focus && plan.scenes.length > scenes.length && <li className="ae-mini-note">+{plan.scenes.length - scenes.length} escenas más</li>}
      </ol>
      {pending && (
        <>
          {asking && (
            <textarea
              className="ae-input ae-textarea nodrag nowheel"
              rows={3}
              placeholder="¿Qué ajusto? (p. ej. “empieza con la frase del precio”)"
              aria-label="Ajustes al plan"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              data-autofocus
            />
          )}
          <div className="ae-plan__actions">
            <PurpleButton size="md" block icon={<WandSparkles size={15} />} onClick={() => void controller.approvePlan(plan.id)} className="nodrag">
              Aprobar y renderizar
            </PurpleButton>
            {asking ? (
              <Button
                tone="coral"
                size="sm"
                block
                icon={<Send size={14} />}
                disabled={!feedback.trim()}
                className="nodrag"
                onClick={() => {
                  void controller.revisePlan(plan.id, feedback.trim());
                  setFeedback("");
                  setAsking(false);
                }}
              >
                Enviar ajuste
              </Button>
            ) : (
              <Button tone="ghost" size="sm" block onClick={() => setAsking(true)} className="nodrag">
                Pedir ajustes con texto
              </Button>
            )}
          </div>
        </>
      )}
      {plan.status === "aprobado" && <Chip tone="mint">Plan aprobado</Chip>}
      {plan.status === "ajustando" && <Chip tone="purple">Claude está ajustando el plan…</Chip>}
    </div>
  );
}
