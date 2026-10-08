/**
 * Pantalla principal del editor: la PIZARRA (gris con cuadrícula) con el ESTUDIO (panel blanco
 * centrado) y, a la derecha, las versiones. Dentro del estudio, de arriba a abajo: clip base,
 * todo lo demás, "¿Cómo quieres el video?", opciones, GENERAR y el progreso en vivo.
 * En móvil todo se apila (estudio arriba, versiones abajo).
 */
import { STAGE_LABELS, type Job } from "@autoeditor/shared";
import clsx from "clsx";
import { Check, CircleAlert, Clock, Coins, LoaderCircle, RotateCcw, WandSparkles, X } from "lucide-react";
import { useMemo } from "react";
import { formatSecondsShort } from "../lib/format.js";
import { isActive, jobClock, pipelineStagesFor } from "../salida/logic.js";
import { useActiveJob, useController, useEditor, useEditorShallow, useEstimate, useWarnings } from "../store/context.js";
import { Button, ProgressBar } from "../ui/index.js";
import { BaseClips } from "./BaseClips.js";
import { Extras } from "./Extras.js";
import { useNow } from "./hooks.js";
import { HowSection, OptionsSection } from "./HowAndOptions.js";
import { VersionsLane } from "./Versions.js";

export function StudioBoard() {
  const hasVersions = useEditor((s) => s.versions.length > 0);
  return (
    <div className="ae-board">
      <div className={clsx("ae-board__inner", hasVersions && "has-versions")}>
        <div className="ae-studio" role="region" aria-label="Estudio">
          <BaseClips />
          <Extras />
          <HowSection />
          <OptionsSection />
          <GenerateSection />
        </div>
        <VersionsLane />
      </div>
    </div>
  );
}

function GenerateSection() {
  const controller = useController();
  const job = useActiveJob();
  const failedJob = useEditor((s) => (s.failedJobId ? (s.jobs[s.failedJobId] ?? null) : null));
  const { uploading, hasVersions, pendingPlan } = useEditorShallow((s) => ({
    uploading: s.uploads.some((u) => u.status === "subiendo"),
    hasVersions: s.versions.length > 0,
    pendingPlan: s.pendingPlan && s.pendingPlan.status === "pendiente" ? s.pendingPlan : null,
  }));
  const est = useEstimate();
  const warnings = useWarnings();
  const block = warnings.find((w) => w.severity === "bloqueo");
  const notice = warnings.find((w) => w.severity === "aviso" && w.id === "duracion");
  const generating = !!job && job.type === "generar" && isActive(job);
  const shownJob = generating ? job : job && job.type === "generar" && (job.status === "error" || job.status === "cancelado") ? job : failedJob && failedJob.type === "generar" ? failedJob : null;
  const busy = isActive(job);
  const reason = block?.text ?? (uploading ? "Espera a que terminen de subir tus archivos." : busy && !generating ? "Espera a que termine la corrección en curso." : null);

  return (
    <section className={clsx("ae-generate", !shownJob && "is-sticky")} aria-label="Generar">
      {pendingPlan && (
        <div className="ae-planwait" role="status">
          <span>Claude preparó un plan y espera tu visto bueno.</span>
          <Button size="sm" tone="ink" onClick={() => void controller.approvePlan(pendingPlan.id)}>
            Aprobar y renderizar
          </Button>
        </div>
      )}
      {!generating && (
        <div className="ae-generate__sticky">
          <div className="ae-generate__row">
          <button type="button" className="ae-genbtn" disabled={!!reason || busy} onClick={() => void controller.generate()} aria-describedby={reason ? "ae-gen-reason" : undefined}>
            <WandSparkles size={20} aria-hidden />
            <span>{hasVersions ? "Generar de nuevo" : "Generar video"}</span>
          </button>
          {est && (
            <span className="ae-sestimate" title="Tiempo y costo estimados">
              <span>
                <Clock size={14} aria-hidden /> {est.label}
              </span>
              <span>
                <Coins size={14} aria-hidden /> {est.costLabel}
              </span>
            </span>
          )}
          </div>
          {reason && (
            <p id="ae-gen-reason" className="ae-generate__reason">
              {reason}
            </p>
          )}
        </div>
      )}
      {!generating && !reason && notice && <p className="ae-generate__reason is-soft">{notice.text}</p>}
      {!generating && !reason && hasVersions && !shownJob && <p className="ae-generate__reason is-soft">Para ajustar una versión usa “Corregir” en su tarjeta: solo cambia lo que pidas.</p>}
      {shownJob && <StudioProgress job={shownJob} />}
    </section>
  );
}

function StudioProgress({ job }: { job: Job }) {
  const controller = useController();
  const { reviewPlan, kie, motion } = useEditorShallow((s) => ({ reviewPlan: s.settings.instruction.reviewPlan, kie: s.settings.engines.kie, motion: s.settings.tools.motionGraphics.enabled }));
  const running = isActive(job);
  const now = useNow(running);
  const { elapsed, remaining } = jobClock(job, now);
  const stages = useMemo(() => pipelineStagesFor({ type: job.type, reviewPlan, kie, motion, current: job.stage }), [job.type, job.stage, reviewPlan, kie, motion]);
  const current = job.stage ? stages.indexOf(job.stage) : -1;
  const failed = job.status === "error";
  const cancelled = job.status === "cancelado";
  const jobId = job.id;
  return (
    <div className={clsx("ae-live", failed && "is-error", cancelled && "is-cancelled")} aria-live="polite">
      <div className="ae-live__head">
        <span className="ae-live__title">{failed ? "No se pudo terminar" : cancelled ? "Cancelaste la generación" : job.status === "esperando" ? "Esperando tu aprobación" : "Claude está editando tu video"}</span>
        <span className="ae-live__times">
          {formatSecondsShort(elapsed)}
          {running && remaining != null && <> · quedan ~{formatSecondsShort(Math.max(1, remaining))}</>}
        </span>
      </div>
      <ProgressBar value={job.status === "en-cola" ? null : job.progress} label="Progreso de la generación" tone={failed ? "coral" : "purple"} />
      <ol className="ae-live__stages">
        {stages.map((st, i) => {
          const state = (failed || cancelled) && i === current ? "error" : current === -1 ? (job.status === "listo" ? "hecho" : "pendiente") : i < current || job.status === "listo" ? "hecho" : i === current ? "actual" : "pendiente";
          return (
            <li key={st} className={clsx("ae-light", `is-${state}`)}>
              <span className="ae-light__dot" aria-hidden>
                {state === "hecho" ? <Check size={11} strokeWidth={3} /> : state === "actual" ? <LoaderCircle size={11} className="ae-spin" /> : state === "error" ? <CircleAlert size={11} /> : null}
              </span>
              <span className="ae-light__label">{STAGE_LABELS[st]}</span>
            </li>
          );
        })}
      </ol>
      {job.message && running && <p className="ae-live__msg">{job.message}</p>}
      {failed && <p className="ae-live__err">{job.error ?? "Algo falló en el proceso. Tu material y tus ajustes siguen guardados."}</p>}
      <div className="ae-live__actions">
        {running ? (
          <Button size="sm" tone="ghost" icon={<X size={14} />} onClick={() => void controller.cancelJob(job.id)}>
            Cancelar
          </Button>
        ) : (
          (failed || cancelled) && (
            <Button size="sm" tone="ink" icon={<RotateCcw size={14} />} onClick={() => void (failed ? controller.retryJob(jobId) : controller.generate())}>
              {failed ? "Reintentar" : "Generar otra vez"}
            </Button>
          )
        )}
      </div>
    </div>
  );
}
