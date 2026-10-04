/**
 * PROCESO: el trabajo en curso etapa por etapa (Analizando → Transcribiendo → Planeando →
 * Generando con IA → Motion graphics → Render → Revisión de calidad), con barra de progreso,
 * tiempo transcurrido y restante, cancelar y reintentar.
 */
import { STAGE_LABELS, type Job, type PipelineStage } from "@autoeditor/shared";
import clsx from "clsx";
import { Check, CircleAlert, LoaderCircle, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { formatSecondsShort } from "../../lib/format.js";
import { useController, useEditor } from "../../store/context.js";
import { Button, ProgressBar } from "../../ui/index.js";

const BASE: PipelineStage[] = ["analizando", "transcribiendo", "planeando", "esperando-aprobacion", "generando-ia", "motion-graphics", "render", "revision-calidad"];

export function usePipelineStages(job: Job | null): PipelineStage[] {
  const settings = useEditor((s) => s.settings);
  const kie = settings.engines.kie;
  return BASE.filter((st) => {
    if (st === "esperando-aprobacion") return settings.instruction.reviewPlan;
    if (st === "generando-ia") return kie || job?.stage === "generando-ia";
    if (st === "motion-graphics") return settings.tools.motionGraphics.enabled || job?.stage === "motion-graphics";
    if (job && job.type !== "generar" && (st === "analizando" || st === "transcribiendo")) return false;
    return true;
  });
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function ProcessView({ job, compact }: { job: Job; compact?: boolean }) {
  const controller = useController();
  const stages = usePipelineStages(job);
  const running = job.status === "corriendo" || job.status === "en-cola" || job.status === "esperando";
  const now = useNow(running);
  const started = job.startedAt ? Date.parse(job.startedAt) : Date.parse(job.createdAt);
  const elapsed = Math.max(0, (now - started) / 1000);
  const remaining = job.estimatedSeconds != null ? Math.max(0, job.estimatedSeconds - elapsed) : null;
  const current = job.stage ? stages.indexOf(job.stage) : -1;
  const failed = job.status === "error";
  const title = job.type === "corregir" ? "Aplicando tu corrección" : job.type === "exportar" ? "Exportando" : "Generando tu video";
  return (
    <div className={clsx("ae-process", compact && "ae-process--compact", failed && "is-error")} aria-live="polite">
      <div className="ae-process__title">{failed ? "Algo falló" : title}</div>
      <ProgressBar value={job.status === "en-cola" ? null : job.progress} label="Progreso" tone={failed ? "coral" : "purple"} />
      <div className="ae-process__times">
        <span>{formatSecondsShort(elapsed)} transcurridos</span>
        {remaining != null && running && <span>~{formatSecondsShort(remaining)} restantes</span>}
      </div>
      <ol className="ae-process__steps">
        {stages.map((st, i) => {
          const state = failed && i === current ? "error" : current === -1 ? "pendiente" : i < current ? "hecho" : i === current ? "actual" : "pendiente";
          if (compact && state === "pendiente" && i > current + 2) return null;
          return (
            <li key={st} className={clsx("ae-step", `is-${state}`)}>
              <span className="ae-step__icon" aria-hidden>
                {state === "hecho" ? <Check size={12} strokeWidth={3} /> : state === "actual" ? <LoaderCircle size={12} className="ae-spin" /> : state === "error" ? <CircleAlert size={12} /> : <span className="ae-step__dot" />}
              </span>
              <span className="ae-step__label">{STAGE_LABELS[st]}</span>
            </li>
          );
        })}
      </ol>
      {job.message && !failed && <div className="ae-process__msg">{job.message}</div>}
      {failed && <div className="ae-process__err">{job.error ?? "No se pudo completar. Lo demás quedó guardado."}</div>}
      <div className="ae-process__actions">
        {failed ? (
          <Button size="sm" tone="ink" icon={<RotateCcw size={14} />} onClick={() => void controller.retryJob(job.id)} className="nodrag">
            Reintentar
          </Button>
        ) : (
          running && (
            <Button size="sm" tone="ghost" icon={<X size={14} />} onClick={() => void controller.cancelJob(job.id)} className="nodrag">
              Cancelar
            </Button>
          )
        )}
      </div>
    </div>
  );
}
