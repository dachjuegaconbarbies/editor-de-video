/**
 * Registro de TODAS las rutas de la API bajo /api/v1 (ver `ROUTES` en @autoeditor/shared/api).
 * El dueño de cada petición se resuelve aquí (hook onRequest) con el OwnerResolver del contexto.
 */
import { API_PREFIX } from "@autoeditor/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { sanitizeOwnerId } from "../auth/index.js";
import type { AppContext } from "../context.js";
import { registerSseRoute } from "../events/sse.js";
import { UserFacingError } from "../services/types.js";
import { assetRoutes } from "./assets.js";
import { brandRoutes } from "./brands.js";
import { apiNotFound } from "./errors.js";
import { generationRoutes } from "./generation.js";
import { keywordRoutes } from "./keywords.js";
import { memoryRoutes } from "./memory.js";
import { projectRoutes } from "./projects.js";
import { styleRoutes } from "./styles.js";
import { systemRoutes } from "./system.js";
import { transcriptRoutes } from "./transcripts.js";
import { versionRoutes } from "./versions.js";

export async function registerApiRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await app.register(
    async (api) => {
      api.decorateRequest("ownerId", "");
      api.addHook("onRequest", async (request) => {
        const raw = await ctx.resolveOwner(request);
        const owner = sanitizeOwnerId(raw);
        if (!owner) throw new UserFacingError("sin-usuario", "No se pudo identificar al usuario", 401);
        request.ownerId = owner;
      });

      const zapp = api.withTypeProvider<ZodTypeProvider>();
      for (const mod of [systemRoutes, projectRoutes, assetRoutes, transcriptRoutes, keywordRoutes, generationRoutes, versionRoutes, styleRoutes, brandRoutes, memoryRoutes]) {
        await mod(zapp, ctx);
      }
      registerSseRoute(zapp, ctx);

      // Especificación OpenAPI en JSON (la interfaz interactiva vive en /api/v1/docs).
      api.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

      api.setNotFoundHandler(apiNotFound);
    },
    { prefix: API_PREFIX },
  );
}
