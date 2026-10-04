/**
 * Resolución del dueño (owner_id) de cada petición.
 *
 * Por defecto se toma del header configurado en `env.ownerHeader` (X-Owner-Id) o, si no viene,
 * del parámetro `?owner=` (necesario para <video src>, <img src> y EventSource, que no pueden mandar
 * headers). Sin ninguno de los dos, el dueño es "local".
 *
 * Integración con Zyra: pasa tu propio `OwnerResolver` a `buildApp({ resolveOwner })`, por ejemplo uno
 * que verifique el JWT de la sesión y devuelva el id del usuario. Si el resolver lanza un
 * `UserFacingError` con status 401/403, la API responde ese error.
 */
import type { FastifyRequest } from "fastify";
import type { Env } from "../env.js";
import { DEFAULT_OWNER, sanitizeOwnerId } from "./sanitize.js";

export { DEFAULT_OWNER, sanitizeOwnerId, createScrubber } from "./sanitize.js";
export type { Scrubber } from "./sanitize.js";

/** Devuelve el id del dueño (ya saneado) para la petición. */
export type OwnerResolver = (request: FastifyRequest) => string | Promise<string>;

export function createHeaderOwnerResolver(env: Pick<Env, "ownerHeader">): OwnerResolver {
  const header = env.ownerHeader.toLowerCase();
  return (request) => {
    const raw = request.headers[header];
    const fromHeader = sanitizeOwnerId(Array.isArray(raw) ? raw[0] : raw);
    if (fromHeader) return fromHeader;
    const query = request.query as Record<string, unknown> | undefined;
    const fromQuery = sanitizeOwnerId(query?.owner);
    return fromQuery ?? DEFAULT_OWNER;
  };
}
