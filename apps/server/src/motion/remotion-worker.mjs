/**
 * Proceso aparte para renderizar un gráfico con Remotion (bundle + Chrome + ffmpeg propio de Remotion).
 * Se lanza con child_process.fork desde motion/remotion.ts. JS plano, sin TypeScript.
 *
 *   ← { type: "render", bundleDir, entry, inputProps, outputPath, browserExecutable, chromeMode, concurrency }
 *   ← { type: "abort" }
 *   → { type: "progress", progress (0-100), message }
 *   → { type: "done" }
 *   → { type: "error", name, message }
 */
import { existsSync } from "node:fs";
import { bundle } from "@remotion/bundler";
import { makeCancelSignal, renderMedia, selectComposition } from "@remotion/renderer";

const send = (msg) => {
  try {
    process.send?.(msg);
  } catch {
    // El padre ya no escucha.
  }
};
const cancel = makeCancelSignal();
let started = false;

process.on("message", async (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "abort") {
    cancel.cancel();
    return;
  }
  if (msg.type !== "render" || started) return;
  started = true;
  try {
    let serveUrl = msg.bundleDir;
    if (!existsSync(`${msg.bundleDir}/index.html`)) {
      await bundle({
        entryPoint: msg.entry,
        outDir: msg.bundleDir,
        onProgress: (p) => send({ type: "progress", progress: p * 0.3, message: "Preparando Remotion" }),
      });
    }
    const common = {
      serveUrl,
      inputProps: msg.inputProps,
      browserExecutable: msg.browserExecutable ?? undefined,
      chromeMode: msg.chromeMode ?? undefined,
      logLevel: "error",
    };
    const composition = await selectComposition({ ...common, id: "Graphic" });
    await renderMedia({
      ...common,
      composition,
      codec: "prores",
      proResProfile: "4444",
      imageFormat: "png",
      pixelFormat: "yuva444p10le",
      outputLocation: msg.outputPath,
      overwrite: true,
      concurrency: msg.concurrency ?? 2,
      cancelSignal: cancel.cancelSignal,
      onProgress: ({ progress }) => send({ type: "progress", progress: 30 + progress * 70, message: "Renderizando el gráfico con Remotion" }),
    });
    send({ type: "done" });
    setTimeout(() => process.exit(0), 50);
  } catch (err) {
    send({ type: "error", name: err?.name ?? "Error", message: err?.message ?? String(err) });
    setTimeout(() => process.exit(1), 50);
  }
});
