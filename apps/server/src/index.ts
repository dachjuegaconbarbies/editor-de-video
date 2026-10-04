/**
 * Arranque real del servidor: escucha en env.host:env.port, log legible en español y apagado
 * ordenado (SIGINT/SIGTERM) que espera a los trabajos en curso y, si tardan, los interrumpe
 * dejándolos marcados para reintentar.
 */
import { Writable } from "node:stream";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";

// --- Log legible --------------------------------------------------------------

const LEVELS: Record<number, { label: string; color: string }> = {
  10: { label: "TRAZA", color: "\x1b[90m" },
  20: { label: "DEBUG", color: "\x1b[90m" },
  30: { label: "INFO ", color: "\x1b[36m" },
  40: { label: "AVISO", color: "\x1b[33m" },
  50: { label: "ERROR", color: "\x1b[31m" },
  60: { label: "FATAL", color: "\x1b[41m" },
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (color: string, s: string) => (useColor ? `${color}${s}\x1b[0m` : s);
const OMIT = new Set(["level", "time", "pid", "hostname", "msg", "reqId"]);

/** Convierte cada línea JSON de pino en "HH:MM:SS NIVEL mensaje clave=valor". */
function prettyStream(): Writable {
  return new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as Record<string, unknown>;
          const lvl = LEVELS[Number(o.level)] ?? LEVELS[30]!;
          const time = new Date(Number(o.time) || Date.now()).toLocaleTimeString("es-MX", { hour12: false });
          const extras = Object.entries(o)
            .filter(([k]) => !OMIT.has(k))
            .map(([k, v]) => {
              if (k === "err" && v && typeof v === "object") return `error=${JSON.stringify((v as { message?: string }).message ?? v)}`;
              return `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`;
            })
            .join(" ");
          const out = `${paint("\x1b[90m", time)} ${paint(lvl.color, lvl.label)} ${String(o.msg ?? "")}${extras ? " " + paint("\x1b[90m", extras) : ""}\n`;
          (Number(o.level) >= 50 ? process.stderr : process.stdout).write(out);
        } catch {
          process.stdout.write(line + "\n");
        }
      }
      cb();
    },
  });
}

// --- Arranque -----------------------------------------------------------------

async function main(): Promise<void> {
  const env = loadEnv();
  const level = process.env.LOG_LEVEL || "info";
  const { app, ctx } = await buildApp({ logger: { level, stream: prettyStream() } });

  // Una línea por petición que modifica algo (las de lectura quedan en debug para no saturar).
  app.addHook("onResponse", async (request, reply) => {
    const ms = Math.round(reply.elapsedTime);
    const msg = `${request.method} ${request.url.split("?")[0]} → ${reply.statusCode} (${ms} ms)`;
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") request.log.debug(msg);
    else request.log.info(msg);
  });

  try {
    await app.listen({ host: env.host, port: env.port, listenTextResolver: (address) => `Escuchando en ${address}` });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") app.log.error(`El puerto ${env.port} ya está en uso. Cierra la otra instancia o cambia PORT en .env.`);
    else app.log.error({ err }, "No se pudo arrancar el servidor");
    await app.close().catch(() => undefined);
    process.exit(1);
  }

  const shownHost = env.host === "0.0.0.0" || env.host === "::" ? "localhost" : env.host;
  const url = `http://${shownHost}:${env.port}`;
  app.log.info(`Autoeditor listo en ${url}`);
  app.log.info(`API en ${url}/api/v1 · documentación en ${url}/api/v1/docs`);
  app.log.info(ctx.env.demoMode || ctx.services.editor.kind === "demo" ? "Modo demo: sin llave de Claude (editor determinista, sin gastar créditos)" : `Editor: ${ctx.services.editor.model}`);

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) {
      app.log.warn("Segunda señal: salgo sin esperar.");
      process.exit(1);
    }
    closing = true;
    const running = ctx.queue.runningCount();
    app.log.info(`Recibí ${signal}: apagando${running ? ` (esperando ${running} trabajo${running === 1 ? "" : "s"} en curso)` : ""}…`);
    const force = setTimeout(() => {
      app.log.error("El apagado tardó demasiado; salgo.");
      process.exit(1);
    }, 20_000);
    force.unref();
    app
      .close()
      .then(() => {
        app.log.info("Servidor apagado. ¡Hasta luego!");
        process.exit(0);
      })
      .catch((err) => {
        app.log.error({ err }, "Error al apagar");
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main();
