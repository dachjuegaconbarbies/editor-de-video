/**
 * Proceso aparte para renderizar una composición con HyperFrames (@hyperframes/producer).
 *
 * Se lanza con child_process.fork desde motion/hyperframes.ts: así Chrome, sus hijos y los
 * console.log del motor quedan aislados del servidor. Es JS plano (sin TypeScript) para no
 * depender de un cargador al hacer fork.
 *
 * Mensajes:
 *   ← { type: "render", projectDir, outputPath, fps, format, quality, workers, chromePath }
 *   ← { type: "abort" }
 *   → { type: "progress", progress (0-100), status, message }
 *   → { type: "done", status, outcome, frames, warnings }
 *   → { type: "error", name, message }
 */
import { createRenderJob, executeRenderJob, resolveConfig } from "@hyperframes/producer";

const ctrl = new AbortController();
let started = false;

const send = (msg) => {
  try {
    process.send?.(msg);
  } catch {
    // El padre ya no escucha.
  }
};

process.on("message", async (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "abort") {
    ctrl.abort();
    return;
  }
  if (msg.type !== "render" || started) return;
  started = true;
  try {
    const producerConfig = msg.chromePath ? resolveConfig({ chromePath: msg.chromePath }) : undefined;
    const job = createRenderJob({
      fps: msg.fps,
      quality: msg.quality ?? "standard",
      format: msg.format ?? "png-sequence",
      workers: msg.workers ?? 2,
      ...(producerConfig ? { producerConfig } : {}),
    });
    await executeRenderJob(
      job,
      msg.projectDir,
      msg.outputPath,
      (j, message) => send({ type: "progress", progress: j.progress ?? 0, status: j.status, message: String(message ?? "") }),
      ctrl.signal,
    );
    send({
      type: "done",
      status: job.status,
      outcome: job.outcome,
      frames: job.totalFrames ?? null,
      warnings: (job.warnings ?? []).map((w) => (typeof w === "string" ? w : (w?.message ?? JSON.stringify(w)))),
    });
  } catch (err) {
    send({ type: "error", name: err?.name ?? "Error", message: err?.message ?? String(err) });
  } finally {
    // Da tiempo a que salga el último mensaje y termina (Chrome ya se cerró en executeRenderJob).
    setTimeout(() => process.exit(0), 100);
  }
});

process.on("disconnect", () => {
  ctrl.abort();
  setTimeout(() => process.exit(0), 2000);
});
