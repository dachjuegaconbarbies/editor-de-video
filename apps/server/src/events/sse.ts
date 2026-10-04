/**
 * Endpoint SSE: GET /api/v1/projects/:projectId/events  (text/event-stream)
 *
 * - Valida que el proyecto sea del dueño.
 * - Al conectar envía el estado del trabajo activo (si hay) para que una pestaña recién abierta
 *   (o recargada) retome el progreso.
 * - Manda un `ping` cada 15 s para que proxies y navegadores no corten la conexión.
 * - Cada mensaje va como `data: <ServerEvent JSON>` sin campo `event:` (todos llegan a `onmessage`).
 * - Limpia los oyentes al cerrar.
 */
import type { ServerEvent } from "@autoeditor/shared";
import type { FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { notFound, type ZodApp } from "../routes/http.js";

const PING_MS = 15_000;

/** Conexiones abiertas por instancia de la app (se cierran al apagar para no bloquear el cierre). */
const openStreams = new WeakMap<AppContext, Set<ServerResponse>>();

function streamsOf(ctx: AppContext): Set<ServerResponse> {
  let set = openStreams.get(ctx);
  if (!set) {
    set = new Set();
    openStreams.set(ctx, set);
  }
  return set;
}

export function closeAllStreams(ctx: AppContext): void {
  const set = streamsOf(ctx);
  for (const res of set) {
    try {
      res.end();
    } catch {
      // ya estaba cerrada
    }
  }
  set.clear();
}

export function registerSseRoute(app: ZodApp, ctx: AppContext): void {
  app.get(
    "/projects/:projectId/events",
    {
      schema: {
        tags: ["Eventos en vivo"],
        summary: "Eventos en vivo del proyecto (SSE)",
        description: "text/event-stream. Cada mensaje es un ServerEvent en JSON (job.updated, job.stage, asset.updated, transcript.updated, version.created…). Ping cada 15 s.",
        params: z.object({ projectId: z.string().min(1) }),
      },
    },
    async (request, reply) => {
      const owner = request.ownerId;
      const project = await ctx.db.projects.get(owner, request.params.projectId);
      if (!project) throw notFound("ese proyecto");
      const activeJob = await ctx.db.jobs.activeForProject(owner, project.id);

      const res = reply.raw;
      // Se toma el control de la respuesta: los headers que pusieron otros hooks (CORS) se copian a mano.
      reply.hijack();
      const inherited: Record<string, string | number | string[]> = {};
      for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) inherited[k] = v;
      res.writeHead(200, {
        ...inherited,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
      const streams = streamsOf(ctx);
      streams.add(res);

      const send = (event: ServerEvent) => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      res.write("retry: 3000\n\n");
      send({ type: "ping", at: new Date().toISOString() });
      if (activeJob) send({ type: "job.updated", job: activeJob });

      const unsubscribe = ctx.events.subscribe(project.id, send);
      const timer = setInterval(() => send({ type: "ping", at: new Date().toISOString() }), PING_MS);
      timer.unref();

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(timer);
        unsubscribe();
        streams.delete(res);
      };
      // Ojo: en Node ≥16 el "close" de la petición se emite al terminar de leerla; el de la respuesta es el bueno.
      res.on("close", cleanup);
      res.on("error", cleanup);
    },
  );
}

/** Cierra las conexiones SSE antes de apagar (si no, `app.close()` esperaría para siempre). */
export function registerSseShutdown(app: FastifyInstance, ctx: AppContext): void {
  app.addHook("preClose", async () => {
    closeAllStreams(ctx);
  });
}
