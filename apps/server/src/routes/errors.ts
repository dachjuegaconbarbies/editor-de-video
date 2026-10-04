/**
 * Manejo uniforme de errores: SIEMPRE `{ error, message, details? }` con mensaje en español.
 * Nunca se filtra el stack ni ninguna llave (los textos pasan por el "scrubber").
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";
import { ZodError } from "zod";
import type { ApiError } from "@autoeditor/shared";
import type { AppContext } from "../context.js";
import { UserFacingError } from "../services/types.js";
import { InvalidStorageKeyError } from "../storage/local.js";

interface Issue {
  path: string;
  message: string;
}

function zodIssues(err: ZodError): Issue[] {
  return err.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}

const STATUS_MESSAGES: Record<number, string> = {
  400: "La petición no es válida",
  401: "Necesitas iniciar sesión",
  403: "No tienes permiso para esto",
  404: "No encontré lo que buscas",
  405: "Método no permitido",
  406: "Formato de respuesta no soportado",
  409: "Hay un conflicto con el estado actual",
  413: "El archivo o la petición es demasiado grande",
  415: "Tipo de contenido no soportado",
  416: "El rango pedido no es válido",
  429: "Demasiadas peticiones; espera un momento",
  501: "Esta función aún no está disponible",
  503: "El servicio no está disponible en este momento",
};

export function registerErrorHandling(app: FastifyInstance, ctx: AppContext): void {
  const mb = Math.round(ctx.env.maxUploadBytes / (1024 * 1024));

  app.setErrorHandler((error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
    // Siempre JSON (aunque la ruta ya hubiera puesto otro Content-Type, p. ej. video/mp4).
    const send = (status: number, body: ApiError) => {
      reply.removeHeader("content-disposition");
      reply.removeHeader("content-length");
      return reply.code(status).type("application/json; charset=utf-8").send(body);
    };

    if (error instanceof UserFacingError) {
      return send(error.status, { error: error.code, message: ctx.scrub(error.userMessage), ...(error.details !== undefined ? { details: error.details } : {}) });
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      const details = error.validation.map((v) => ({ path: String(v.instancePath ?? "").replace(/^\//, "").replace(/\//g, "."), message: v.message ?? "inválido" }));
      return send(400, { error: "datos-invalidos", message: "Datos inválidos", details });
    }
    if (error instanceof ZodError) {
      return send(400, { error: "datos-invalidos", message: "Datos inválidos", details: zodIssues(error) });
    }
    if (error instanceof InvalidStorageKeyError) {
      return send(400, { error: "ruta-invalida", message: "Ruta de archivo inválida" });
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, "La respuesta no cumple su esquema");
      return send(500, { error: "error-interno", message: "Ocurrió un error inesperado en el servidor. Intenta de nuevo." });
    }
    const fe = error as FastifyError;
    if (fe.code === "FST_REQ_FILE_TOO_LARGE" || fe.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return send(413, { error: "demasiado-grande", message: `El archivo supera el límite de ${mb} MB` });
    }
    if (fe.code === "FST_ERR_CTP_INVALID_JSON_BODY" || fe.code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
      return send(400, { error: "json-invalido", message: "El cuerpo de la petición no es JSON válido" });
    }
    if (fe.code === "FST_INVALID_MULTIPART_CONTENT_TYPE") {
      return send(415, { error: "multipart-requerido", message: "Envía el archivo como multipart/form-data" });
    }
    const status = typeof fe.statusCode === "number" && fe.statusCode >= 400 && fe.statusCode < 600 ? fe.statusCode : 500;
    if (status < 500) {
      return send(status, { error: `http-${status}`, message: STATUS_MESSAGES[status] ?? "La petición no es válida" });
    }
    request.log.error({ err: { message: ctx.scrub(error.message), code: fe.code } }, "Error no controlado");
    return send(status === 500 ? 500 : status, {
      error: status === 500 ? "error-interno" : `http-${status}`,
      message: status === 500 ? "Ocurrió un error inesperado en el servidor. Intenta de nuevo." : (STATUS_MESSAGES[status] ?? "Error del servidor"),
    });
  });
}

/** 404 de la API (JSON en español). */
export function apiNotFound(_request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.code(404).type("application/json; charset=utf-8").send({ error: "no-encontrado", message: "No encontré esa ruta de la API" } satisfies ApiError);
}
