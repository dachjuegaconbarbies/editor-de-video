/**
 * Utilidades HTTP compartidas por las rutas: tipo de la instancia con zod, envío de archivos del
 * almacenamiento con soporte de Range (necesario para reproducir video en el navegador) y nombres
 * de descarga legibles.
 */
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerDefault } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { AppContext } from "../context.js";
import { UserFacingError } from "../services/types.js";

export type ZodApp = FastifyInstance<RawServerDefault, RawRequestDefaultExpression, RawReplyDefaultExpression, FastifyBaseLogger, ZodTypeProvider>;

export type RouteModule = (app: ZodApp, ctx: AppContext) => Promise<void> | void;

declare module "fastify" {
  interface FastifyRequest {
    /** Dueño resuelto para esta petición (saneado). */
    ownerId: string;
  }
}

export function ownerOf(request: FastifyRequest): string {
  return request.ownerId;
}

// ---------------------------------------------------------------------------
// Cuerpo "crudo" (antes de validar)
// ---------------------------------------------------------------------------
// Zod 4 rellena con valores por defecto los campos ausentes de un esquema `.partial()`; en un PATCH
// eso pisaría datos guardados. Por eso se guarda el cuerpo original y se aplican solo los campos
// que el cliente mandó de verdad.

const rawBodies = new WeakMap<FastifyRequest, Record<string, unknown>>();

/** Registra el hook que recuerda el cuerpo original de cada petición. */
export function captureRawBodies(app: FastifyInstance): void {
  app.addHook("preValidation", async (request) => {
    const body = request.body;
    if (body && typeof body === "object" && !Array.isArray(body)) rawBodies.set(request, body as Record<string, unknown>);
  });
}

/** Claves que mandó el cliente (en la raíz o dentro de `path`, p. ej. "settings"). */
export function sentKeys(request: FastifyRequest, path?: string): Set<string> {
  let node: unknown = rawBodies.get(request);
  if (path) node = node && typeof node === "object" ? (node as Record<string, unknown>)[path] : undefined;
  return new Set(node && typeof node === "object" && !Array.isArray(node) ? Object.keys(node) : []);
}

/** Se queda solo con los campos del cuerpo validado que el cliente mandó. */
export function onlySent<T extends object>(request: FastifyRequest, body: T, path?: string): Partial<T> {
  const keys = sentKeys(request, path);
  return Object.fromEntries(Object.entries(body).filter(([k, v]) => keys.has(k) && v !== undefined)) as Partial<T>;
}

export function notFound(what: string): UserFacingError {
  return new UserFacingError("no-encontrado", `No encontré ${what}`, 404);
}

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

/** Interpreta un header Range de un solo intervalo. null = sin Range; "invalido" = 416. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "invalido" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)(?:,.*)?$/i.exec(header.trim());
  if (!m) return "invalido";
  const [, a = "", b = ""] = m;
  if (a === "" && b === "") return "invalido";
  let start: number;
  let end: number;
  if (a === "") {
    // Sufijo: los últimos N bytes.
    const n = Number(b);
    if (!Number.isFinite(n) || n <= 0) return "invalido";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "invalido";
  return { start, end };
}

// ---------------------------------------------------------------------------
// Descargas
// ---------------------------------------------------------------------------

/** Nombre de archivo legible y seguro: "Mi proyecto" → "mi-proyecto". */
export function readableName(name: string, fallback = "video"): string {
  const s = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return s || fallback;
}

/** Content-Disposition con nombre ASCII y variante UTF-8 (RFC 5987). */
export function contentDisposition(filename: string, type: "attachment" | "inline" = "attachment"): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export interface SendFileOptions {
  contentType: string;
  /** Si viene, se descarga con ese nombre. */
  downloadName?: string;
  cacheSeconds?: number;
}

/** Envía un archivo del almacenamiento respetando Range (206) y con Accept-Ranges. */
export async function sendStorageFile(ctx: AppContext, request: FastifyRequest, reply: FastifyReply, key: string, opts: SendFileOptions): Promise<FastifyReply> {
  const stat = await ctx.services.storage.stat(key);
  if (!stat) throw notFound("el archivo en el almacenamiento");
  const size = stat.sizeBytes;
  const etag = `"${size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
  reply.header("Accept-Ranges", "bytes");
  reply.header("ETag", etag);
  reply.header("Cache-Control", `private, max-age=${opts.cacheSeconds ?? 3600}`);
  if (request.headers["if-none-match"] === etag && !request.headers.range) return reply.code(304).send();

  const range = parseRange(request.headers.range, size);
  if (range === "invalido") {
    reply.header("Content-Range", `bytes */${size}`);
    return reply.code(416).type("application/json; charset=utf-8").send({ error: "rango-invalido", message: "El rango pedido no es válido para este archivo" });
  }
  reply.header("Content-Type", opts.contentType);
  if (opts.downloadName) reply.header("Content-Disposition", contentDisposition(opts.downloadName));
  if (range) {
    reply.code(206);
    reply.header("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    reply.header("Content-Length", String(range.end - range.start + 1));
    return reply.send(ctx.services.storage.createReadStream(key, range));
  }
  reply.header("Content-Length", String(size));
  return reply.send(ctx.services.storage.createReadStream(key));
}
