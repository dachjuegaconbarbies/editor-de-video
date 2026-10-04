/**
 * COLA DE TRABAJOS persistente (en la base de datos) con concurrencia limitada.
 *
 * - `enqueue()` guarda el trabajo "en-cola"; el planificador lo toma cuando hay lugar.
 * - Cada trabajo tiene su AbortController: `cancel()` lo aborta (el handler debe respetar `signal`).
 * - `ctx.stage(etapa, progreso, mensaje)` actualiza la fila, mide el tiempo real por etapa
 *   (`stageTimings`, para recalibrar el estimador) y emite `job.stage` + `job.updated` por SSE.
 * - Un handler puede devolver `{ status: "esperando" }` (p. ej. esperando que apruebes el plan);
 *   `resume()` lo vuelve a poner en cola con datos nuevos en `input` y el handler continúa.
 * - `retry()` vuelve a encolar un trabajo con error o cancelado (conserva `result` parcial para que
 *   el handler pueda saltarse lo que ya hizo).
 * - Al arrancar, lo que estaba "corriendo" se marca con error: el servidor se reinició.
 */
import type { EstimateStage, Job, JobType, PipelineStage } from "@autoeditor/shared";
import { Job as JobSchema, STAGE_LABELS } from "@autoeditor/shared";
import type { Db } from "../db/types.js";
import { newId, nowIso } from "../db/util.js";
import type { EventBus } from "../events/bus.js";
import { UserFacingError, type Log } from "../services/types.js";

export const RESTART_MESSAGE = "Se interrumpió porque el servidor se reinició — puedes reintentarlo";
export const SHUTDOWN_MESSAGE = "Se interrumpió porque el servidor se apagó — puedes reintentarlo";
export const CANCELLED_MESSAGE = "Cancelado";

const ESTIMATE_STAGES: readonly EstimateStage[] = ["analizando", "transcribiendo", "planeando", "generando-ia", "motion-graphics", "render", "revision-calidad"];

export interface JobContext {
  /** Copia del trabajo al empezar este intento (incluye `input`, `result` parcial y `attempts`). */
  readonly job: Job;
  readonly signal: AbortSignal;
  readonly log: Log;
  /** Cambia de etapa (y mide la anterior). `progress` = progreso total 0..1. */
  stage(stage: PipelineStage, progress?: number, message?: string): Promise<void>;
  /** Actualiza el progreso dentro de la etapa actual (se guarda como máximo ~4 veces por segundo). */
  progress(progress: number, message?: string): Promise<void>;
  /** Suma costo real (USD) del trabajo. */
  addCost(usd: number): Promise<void>;
  /** Fusiona datos en `result` (útil para reanudar o reintentar sin repetir pasos). */
  setResult(partial: Record<string, unknown>): Promise<void>;
  /** Lanza si el trabajo fue cancelado. */
  throwIfAborted(): void;
}

export type JobOutcome =
  | { status?: "listo"; result?: Record<string, unknown>; message?: string }
  | { status: "esperando"; stage?: PipelineStage; message: string; result?: Record<string, unknown> };

export type JobHandler = (ctx: JobContext) => Promise<JobOutcome | void>;

export interface EnqueueOptions {
  ownerId: string;
  projectId: string | null;
  estimatedSeconds?: number | null;
}

interface Running {
  controller: AbortController;
  /** Motivo del aborto: cancelado por la persona o apagado del servidor. */
  reason: "cancel" | "shutdown" | null;
  promise: Promise<void>;
}

export interface JobQueueDeps {
  db: Db;
  events: EventBus;
  log: Log;
  concurrency: number;
  /** Limpia textos de error antes de guardarlos (sin rutas ni llaves). */
  scrub?: (text: string) => string;
  /** Intervalo de sondeo de seguridad (ms). */
  pollMs?: number;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const isFinal = (s: Job["status"]) => s === "listo" || s === "error" || s === "cancelado";

export class JobQueue {
  private readonly handlers = new Map<JobType, JobHandler>();
  private readonly running = new Map<string, Running>();
  private started = false;
  private stopping = false;
  private pumping = false;
  private pumpAgain = false;
  private timer: NodeJS.Timeout | null = null;
  private idleWaiters: (() => void)[] = [];
  private readonly scrub: (text: string) => string;

  constructor(private readonly deps: JobQueueDeps) {
    this.scrub = deps.scrub ?? ((t) => t);
  }

  get concurrency(): number {
    return Math.max(1, this.deps.concurrency);
  }

  registerHandler(type: JobType, handler: JobHandler, opts: { replace?: boolean } = {}): void {
    if (this.handlers.has(type) && !opts.replace) throw new Error(`Ya hay un handler para trabajos "${type}"`);
    this.handlers.set(type, handler);
    if (this.started) this.kick();
  }

  hasHandler(type: JobType): boolean {
    return this.handlers.has(type);
  }

  // ------------------------------------------------------------------ API pública

  async enqueue(type: JobType, input: Record<string, unknown>, opts: EnqueueOptions): Promise<Job> {
    const job = JobSchema.parse({
      id: newId("job"),
      ownerId: opts.ownerId,
      projectId: opts.projectId,
      type,
      status: "en-cola",
      message: "En cola",
      input,
      estimatedSeconds: opts.estimatedSeconds ?? null,
      createdAt: nowIso(),
    });
    const created = await this.deps.db.jobs.create(opts.ownerId, job);
    this.emit(created);
    this.kick();
    return created;
  }

  async get(ownerId: string, jobId: string): Promise<Job | null> {
    return this.deps.db.jobs.get(ownerId, jobId);
  }

  async cancel(ownerId: string, jobId: string): Promise<Job> {
    const job = await this.mustGet(ownerId, jobId);
    if (isFinal(job.status)) return job;
    // Primero se marca en la base (así ya no se puede tomar de la cola) y luego se aborta si corre.
    const updated = await this.deps.db.jobs.update(ownerId, job.id, (cur) =>
      isFinal(cur.status) ? cur : { ...cur, status: "cancelado", message: "Cancelado por ti", error: null, finishedAt: nowIso() },
    );
    const run = this.running.get(job.id);
    if (run) {
      run.reason = "cancel";
      run.controller.abort(new UserFacingError("cancelado", CANCELLED_MESSAGE, 409));
    }
    if (updated) this.emit(updated);
    return updated ?? job;
  }

  async retry(ownerId: string, jobId: string): Promise<Job> {
    const job = await this.mustGet(ownerId, jobId);
    if (job.status !== "error" && job.status !== "cancelado") {
      throw new UserFacingError("no-reintentable", "Solo se puede reintentar un trabajo que falló o se canceló", 409);
    }
    if (this.running.has(job.id)) throw new UserFacingError("ocupado", "El trabajo todavía se está deteniendo; intenta en unos segundos", 409);
    const updated = await this.deps.db.jobs.update(ownerId, job.id, {
      status: "en-cola",
      stage: null,
      progress: 0,
      message: "En cola para reintentar",
      error: null,
      stageTimings: {},
      finishedAt: null,
    });
    if (!updated) throw new UserFacingError("no-encontrado", "No encontré ese trabajo", 404);
    this.emit(updated);
    this.kick();
    return updated;
  }

  /** Reanuda un trabajo "esperando" (p. ej. al aprobar el plan) fusionando datos en su input. */
  async resume(ownerId: string, jobId: string, input: Record<string, unknown> = {}): Promise<Job> {
    const job = await this.mustGet(ownerId, jobId);
    if (job.status !== "esperando") throw new UserFacingError("no-esperando", "Este trabajo no está esperando una respuesta", 409);
    const updated = await this.deps.db.jobs.update(ownerId, job.id, (cur) => ({
      ...cur,
      status: "en-cola",
      message: "Continuando…",
      input: { ...cur.input, ...input },
    }));
    if (!updated) throw new UserFacingError("no-encontrado", "No encontré ese trabajo", 404);
    this.emit(updated);
    this.kick();
    return updated;
  }

  /** Arranca el planificador. Marca como interrumpido lo que quedó "corriendo". */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    const interrupted = await this.deps.db.jobs.systemMarkInterrupted(["corriendo"], RESTART_MESSAGE);
    for (const job of interrupted) this.emit(job);
    if (interrupted.length) this.deps.log.warn({ count: interrupted.length }, "Trabajos interrumpidos por reinicio del servidor");
    const pollMs = this.deps.pollMs ?? 2000;
    this.timer = setInterval(() => this.kick(), pollMs);
    this.timer.unref();
    this.kick();
  }

  /**
   * Detiene el planificador: deja de tomar trabajos, espera a los que corren hasta `timeoutMs`
   * y luego los aborta (quedan con error "se interrumpió…", reintentables).
   */
  async stop(opts: { timeoutMs?: number } = {}): Promise<void> {
    if (!this.started) return;
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const all = () => Promise.allSettled([...this.running.values()].map((r) => r.promise));
    if (this.running.size > 0) {
      const timedOut = await Promise.race([all().then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), timeoutMs).unref())]);
      if (timedOut) {
        for (const run of this.running.values()) {
          run.reason = run.reason ?? "shutdown";
          run.controller.abort(new UserFacingError("interrumpido", SHUTDOWN_MESSAGE, 503));
        }
        await Promise.race([all(), new Promise((r) => setTimeout(r, 2000).unref())]);
      }
    }
    // Lo que no alcanzó a cerrarse queda marcado para reintentar.
    for (const id of [...this.running.keys()]) {
      const updated = await this.deps.db.jobs.systemUpdate(id, { status: "error", error: SHUTDOWN_MESSAGE, message: SHUTDOWN_MESSAGE, finishedAt: nowIso() });
      if (updated) this.emit(updated);
    }
    this.running.clear();
    this.started = false;
  }

  /** Resuelve cuando no hay trabajos corriendo ni en cola procesables (útil en pruebas). */
  onIdle(): Promise<void> {
    if (this.running.size === 0 && !this.pumping) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  runningCount(): number {
    return this.running.size;
  }

  // ------------------------------------------------------------------ planificador

  private kick(): void {
    if (!this.started || this.stopping) return;
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    void this.pump().finally(() => {
      this.pumping = false;
      if (this.pumpAgain) {
        this.pumpAgain = false;
        this.kick();
      } else {
        this.checkIdle();
      }
    });
  }

  private async pump(): Promise<void> {
    while (!this.stopping && this.running.size < this.concurrency) {
      let job: Job | null;
      try {
        job = await this.deps.db.jobs.systemClaimNext([...this.handlers.keys()]);
      } catch (err) {
        this.deps.log.error({ err }, "No se pudo leer la cola de trabajos");
        return;
      }
      if (!job) return;
      this.launch(job);
    }
  }

  private checkIdle(): void {
    if (this.running.size === 0 && !this.pumping) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach((w) => w());
    }
  }

  private launch(job: Job): void {
    const handler = this.handlers.get(job.type);
    const controller = new AbortController();
    const run: Running = { controller, reason: null, promise: Promise.resolve() };
    this.running.set(job.id, run);
    this.emit(job);
    run.promise = this.execute(job, handler, run).finally(() => {
      this.running.delete(job.id);
      this.kick();
      this.checkIdle();
    });
  }

  private async execute(job: Job, handler: JobHandler | undefined, run: Running): Promise<void> {
    const { db, log } = this.deps;
    const ownerId = job.ownerId;
    // El tiempo previo a la primera etapa (o mientras esperaba aprobación) no se mide.
    let currentStage: PipelineStage | null = null;
    let stageStartedAt = Date.now();
    const timings: Record<string, number> = { ...job.stageTimings };
    let cost = job.costUsd;
    let lastWrite = 0;
    let lastProgress = job.progress;

    /** Acumula el tiempo de la etapa en curso. */
    const closeStage = () => {
      if (currentStage) {
        const secs = (Date.now() - stageStartedAt) / 1000;
        timings[currentStage] = Math.round(((timings[currentStage] ?? 0) + secs) * 1000) / 1000;
      }
      stageStartedAt = Date.now();
    };

    const persist = async (patch: Partial<Job>, force = true) => {
      const now = Date.now();
      if (!force && now - lastWrite < 250) return;
      lastWrite = now;
      // Si ya se canceló (o se apagó), no pisamos ese estado con progreso tardío.
      if (run.reason) return;
      const updated = await db.jobs.update(ownerId, job.id, (cur) => (isFinal(cur.status) ? cur : { ...cur, ...patch }));
      if (updated && !isFinal(updated.status)) this.emit(updated);
    };

    const ctx: JobContext = {
      job: structuredClone(job),
      signal: run.controller.signal,
      log,
      stage: async (stage, progress, message) => {
        if (run.reason) return;
        closeStage();
        currentStage = stage;
        const label = message ?? STAGE_LABELS[stage];
        const p = progress === undefined ? undefined : clamp01(progress);
        if (p !== undefined) lastProgress = p;
        if (job.projectId) this.deps.events.emit(job.projectId, { type: "job.stage", jobId: job.id, stage, message: label, progress: lastProgress });
        await persist({ stage, message: label, stageTimings: { ...timings }, ...(p === undefined ? {} : { progress: p }) });
      },
      progress: async (progress, message) => {
        lastProgress = clamp01(progress);
        await persist({ progress: lastProgress, ...(message ? { message } : {}) }, false);
      },
      addCost: async (usd) => {
        if (!Number.isFinite(usd) || usd <= 0) return;
        cost = Math.round((cost + usd) * 1e6) / 1e6;
        await persist({ costUsd: cost });
      },
      setResult: async (partial) => {
        if (run.reason) return;
        await db.jobs.update(ownerId, job.id, (cur) => ({ ...cur, result: { ...(cur.result ?? {}), ...partial } }));
      },
      throwIfAborted: () => {
        if (run.controller.signal.aborted) throw run.controller.signal.reason ?? new UserFacingError("cancelado", CANCELLED_MESSAGE, 409);
      },
    };

    try {
      if (!handler) throw new UserFacingError("sin-handler", "No hay quien procese este tipo de trabajo", 500);
      // Pudo cancelarse justo entre que se tomó de la cola y que arrancó.
      const fresh = await db.jobs.get(ownerId, job.id);
      if (!fresh || fresh.status === "cancelado") return;
      const outcome = (await handler(ctx)) ?? {};
      closeStage();
      if (run.reason) return this.finishAborted(job, run, timings);
      if (outcome.status === "esperando") {
        const updated = await db.jobs.update(ownerId, job.id, (cur) =>
          isFinal(cur.status)
            ? cur
            : {
                ...cur,
                status: "esperando",
                stage: outcome.stage ?? "esperando-aprobacion",
                message: outcome.message,
                stageTimings: timings,
                costUsd: cost,
                result: { ...(cur.result ?? {}), ...(outcome.result ?? {}) },
              },
        );
        if (updated) this.emit(updated);
        return;
      }
      const updated = await db.jobs.update(ownerId, job.id, (cur) =>
        isFinal(cur.status)
          ? cur
          : {
              ...cur,
              status: "listo",
              stage: "listo",
              progress: 1,
              message: outcome.message ?? "Listo",
              error: null,
              stageTimings: timings,
              costUsd: cost,
              result: { ...(cur.result ?? {}), ...(outcome.result ?? {}) },
              finishedAt: nowIso(),
            },
      );
      if (updated) {
        this.emit(updated);
        if (updated.status === "listo") await this.recordCalibration(updated);
      }
    } catch (err) {
      closeStage();
      if (run.reason || run.controller.signal.aborted) return this.finishAborted(job, run, timings);
      const message = this.errorMessage(err, currentStage);
      if (!(err instanceof UserFacingError)) log.error({ err, jobId: job.id, type: job.type }, "Falló un trabajo");
      const updated = await db.jobs.update(ownerId, job.id, (cur) =>
        isFinal(cur.status) ? cur : { ...cur, status: "error", error: message, message, stageTimings: timings, costUsd: cost, finishedAt: nowIso() },
      );
      if (updated) this.emit(updated);
    }
  }

  private async finishAborted(job: Job, run: Running, timings: Record<string, number>): Promise<void> {
    const shutdown = run.reason === "shutdown";
    const updated = await this.deps.db.jobs.update(job.ownerId, job.id, (cur) => {
      if (!shutdown && cur.status === "cancelado") return { ...cur, stageTimings: timings };
      return shutdown
        ? { ...cur, status: "error", error: SHUTDOWN_MESSAGE, message: SHUTDOWN_MESSAGE, stageTimings: timings, finishedAt: nowIso() }
        : { ...cur, status: "cancelado", message: "Cancelado por ti", stageTimings: timings, finishedAt: cur.finishedAt ?? nowIso() };
    });
    if (updated) this.emit(updated);
  }

  private errorMessage(err: unknown, stage: PipelineStage | null): string {
    if (err instanceof UserFacingError) return this.scrub(err.userMessage);
    const raw = err instanceof Error ? err.message : String(err);
    const where = stage ? ` en «${STAGE_LABELS[stage]}»` : "";
    const detail = this.scrub(raw).split("\n")[0]?.slice(0, 300) ?? "";
    return `Algo falló${where}${detail ? `: ${detail}` : ""}. Puedes reintentarlo.`;
  }

  /** Alimenta el estimador con los tiempos reales si el trabajo traía su estimación por etapa. */
  private async recordCalibration(job: Job): Promise<void> {
    const lines = job.input.estimateLines;
    if (!lines || typeof lines !== "object") return;
    for (const stage of ESTIMATE_STAGES) {
      const est = Number((lines as Record<string, unknown>)[stage]);
      const actual = job.stageTimings[stage];
      if (!Number.isFinite(est) || est <= 0 || !actual || actual <= 0) continue;
      try {
        await this.deps.db.calibration.record(job.ownerId, stage, est, actual);
      } catch (err) {
        this.deps.log.warn({ err, stage }, "No se pudo guardar la calibración");
      }
    }
  }

  private async mustGet(ownerId: string, jobId: string): Promise<Job> {
    const job = await this.deps.db.jobs.get(ownerId, jobId);
    if (!job) throw new UserFacingError("no-encontrado", "No encontré ese trabajo", 404);
    return job;
  }

  private emit(job: Job): void {
    if (job.projectId) this.deps.events.emit(job.projectId, { type: "job.updated", job });
  }
}
