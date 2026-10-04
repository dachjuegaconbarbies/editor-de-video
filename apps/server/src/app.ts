/**
 * Arma la aplicación Fastify con todo su contexto. Se usa desde `index.ts` (servidor real) y desde
 * las pruebas (`app.inject`). También es el punto de montaje para integrarla en otro backend
 * (p. ej. Zyra): `buildApp({ resolveOwner, env })` devuelve `{ app, ctx }`.
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { API_PREFIX } from "@autoeditor/shared";
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from "fastify";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { createHeaderOwnerResolver, createScrubber, type OwnerResolver } from "./auth/index.js";
import { loadConfig, type AppConfig } from "./config/index.js";
import type { AppContext, CoreContext } from "./context.js";
import { createSqliteDb } from "./db/index.js";
import type { Db } from "./db/types.js";
import { loadEnv, type Env } from "./env.js";
import { EventBus } from "./events/bus.js";
import { registerSseShutdown } from "./events/sse.js";
import { JobQueue } from "./jobs/queue.js";
import { createMemoryApi } from "./memory/index.js";
import { createPipeline } from "./pipeline/index.js";
import { apiNotFound, registerErrorHandling } from "./routes/errors.js";
import { captureRawBodies } from "./routes/http.js";
import { registerApiRoutes } from "./routes/index.js";
import { SERVER_VERSION } from "./routes/system.js";
import { createServices } from "./services/container.js";
import { UserFacingError, type Services } from "./services/types.js";
import { createStyleApi } from "./styles/index.js";

export type { AppContext } from "./context.js";
export type { OwnerResolver } from "./auth/index.js";

export interface BuildAppOptions {
  /** Sobrescribe variables de entorno (p. ej. `dataDir` temporal en pruebas). */
  env?: Partial<Env>;
  /** Configuración ya cargada (por defecto se lee de /config). */
  config?: AppConfig;
  /** Resolver de dueño propio (p. ej. verificar el JWT de Zyra). */
  resolveOwner?: OwnerResolver;
  /** Reemplaza servicios concretos (pruebas o integraciones). */
  services?: Partial<Services>;
  /** Base de datos propia (p. ej. Postgres); por defecto SQLite en `<dataDir>/autoeditor.db`. */
  db?: Db;
  /** Logger de Fastify (false = silencio, útil en pruebas). */
  logger?: FastifyServerOptions["logger"];
  /** Arrancar la cola de trabajos (por defecto sí). */
  startQueue?: boolean;
  /** Servir la interfaz compilada: true / false / "auto" (si existe `webDist/index.html` o en producción). */
  serveWeb?: boolean | "auto";
}

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
}

const JSON_BODY_LIMIT = 10 * 1024 * 1024;

export async function buildApp(opts: BuildAppOptions = {}): Promise<BuiltApp> {
  const env = loadEnv(opts.env);
  const config = opts.config ?? loadConfig(env);
  mkdirSync(env.dataDir, { recursive: true });

  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: JSON_BODY_LIMIT,
    // Sin las líneas automáticas por petición (index.ts registra una línea legible propia).
    logController: new LogController({ disableRequestLogging: true }),
    // Al apagar se cierran también las conexiones abiertas (descargas largas, SSE).
    forceCloseConnections: true,
    routerOptions: { ignoreTrailingSlash: true },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const log = app.log;
  for (const w of config.warnings) log.warn(w);

  // --- Contexto -------------------------------------------------------------
  const db = opts.db ?? createSqliteDb({ dataDir: env.dataDir });
  const services = await createServices(env, config, log, opts.services);
  const events = new EventBus();
  const scrub = createScrubber(env);
  const queue = new JobQueue({ db, events, log, concurrency: env.jobConcurrency, scrub });
  const core: CoreContext = {
    env,
    config,
    db,
    services,
    queue,
    events,
    resolveOwner: opts.resolveOwner ?? createHeaderOwnerResolver(env),
    scrub,
    log,
  };
  const ctx = core as AppContext;
  ctx.memory = createMemoryApi(ctx);
  ctx.styles = createStyleApi(ctx);
  ctx.pipeline = createPipeline(ctx);

  // --- Plugins ---------------------------------------------------------------
  await app.register(cors, {
    origin: env.corsOrigins.includes("*") ? true : env.corsOrigins,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposedHeaders: ["Content-Disposition", "Content-Range", "Accept-Ranges", "Content-Length", "ETag"],
  });
  await app.register(multipart, { limits: { fileSize: env.maxUploadBytes, files: 5, fields: 20, parts: 40, fieldSize: 64 * 1024 } });

  // JSON tolerante: un cuerpo vacío con Content-Type JSON cuenta como "sin cuerpo".
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: JSON_BODY_LIMIT }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, undefined);
    try {
      // Se descartan claves peligrosas (contaminación de prototipos).
      done(null, JSON.parse(text, (k, v: unknown) => (k === "__proto__" || k === "constructor" ? undefined : v)));
    } catch {
      done(new UserFacingError("json-invalido", "El cuerpo de la petición no es JSON válido", 400), undefined);
    }
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "Autoeditor de video con IA — API",
        version: SERVER_VERSION,
        description:
          "Todo lo que hace la interfaz se puede hacer con esta API. El dueño se toma del header `X-Owner-Id` (o `?owner=`); en local es \"local\". Los trabajos largos avisan su progreso por SSE en `/projects/{projectId}/events`. Ninguna respuesta incluye llaves de API.",
      },
      tags: [
        { name: "Sistema" },
        { name: "Proyectos" },
        { name: "Material" },
        { name: "Transcripción" },
        { name: "Palabras clave" },
        { name: "Generación" },
        { name: "Plan" },
        { name: "Trabajos" },
        { name: "Eventos en vivo" },
        { name: "Versiones" },
        { name: "Estilos" },
        { name: "Marcas" },
        { name: "Memoria" },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: `${API_PREFIX}/docs` });

  captureRawBodies(app);
  registerErrorHandling(app, ctx);
  registerSseShutdown(app, ctx);
  await registerApiRoutes(app, ctx);

  // --- Interfaz compilada (producción o si existe el build) ------------------
  const indexHtml = path.join(env.webDist, "index.html");
  const serveWeb = opts.serveWeb === undefined || opts.serveWeb === "auto" ? env.nodeEnv === "production" || existsSync(indexHtml) : opts.serveWeb;
  if (serveWeb && existsSync(indexHtml)) {
    await app.register(fastifyStatic, { root: env.webDist, prefix: "/", wildcard: true, index: ["index.html"] });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return apiNotFound(request, reply);
      if (request.method === "GET" || request.method === "HEAD") return reply.type("text/html; charset=utf-8").sendFile("index.html");
      return reply.code(404).send({ error: "no-encontrado", message: "No encontré esa ruta" });
    });
  } else {
    if (serveWeb) log.warn("No encontré la interfaz compilada (apps/web/dist); corre `pnpm --filter @autoeditor/web build`.");
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return apiNotFound(request, reply);
      return reply.code(404).send({ error: "no-encontrado", message: "No encontré esa ruta. La API vive en /api/v1 (documentación en /api/v1/docs)." });
    });
  }

  // --- Apagado ordenado -----------------------------------------------------
  app.addHook("onClose", async () => {
    await queue.stop({ timeoutMs: 10_000 });
    await db.close();
  });

  if (opts.startQueue !== false) await queue.start();
  return { app, ctx };
}
