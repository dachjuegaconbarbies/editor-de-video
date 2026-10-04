/** Biblioteca de marcas (identidad reutilizable: logos, tipografías, paleta, intro/outro…). */
import { Brand, BrandBody, type BrandsResponse } from "@autoeditor/shared";
import { z } from "zod";
import { newId, nowIso } from "../db/util.js";
import { notFound, onlySent, type RouteModule } from "./http.js";

const BrandParams = z.object({ brandId: z.string().min(1) });
const BrandPatch = BrandBody.partial();

export const brandRoutes: RouteModule = (app, ctx) => {
  const { db } = ctx;
  const tags = ["Marcas"];

  app.get("/brands", { schema: { tags, summary: "Marcas guardadas" } }, async (request): Promise<BrandsResponse> => {
    return { brands: await db.brands.list(request.ownerId, {}, { orderBy: "updatedAt", desc: true }) };
  });

  app.post("/brands", { schema: { tags, summary: "Crear marca", body: BrandBody } }, async (request, reply) => {
    const owner = request.ownerId;
    const now = nowIso();
    const brand = await db.brands.create(owner, Brand.parse({ ...request.body, id: newId("brd"), ownerId: owner, createdAt: now, updatedAt: now }));
    return reply.code(201).send(brand);
  });

  app.get("/brands/:brandId", { schema: { tags, summary: "Detalle de una marca", params: BrandParams } }, async (request) => {
    const brand = await db.brands.get(request.ownerId, request.params.brandId);
    if (!brand) throw notFound("esa marca");
    return brand;
  });

  app.patch("/brands/:brandId", { schema: { tags, summary: "Editar marca", params: BrandParams, body: BrandPatch } }, async (request) => {
    // Solo los campos que llegaron (BrandBody.partial() rellena valores por defecto en los ausentes).
    const patch = onlySent(request, request.body);
    const updated = await db.brands.update(request.ownerId, request.params.brandId, (b) => ({ ...b, ...patch }));
    if (!updated) throw notFound("esa marca");
    return updated;
  });

  app.delete("/brands/:brandId", { schema: { tags, summary: "Borrar marca", params: BrandParams } }, async (request) => {
    const ok = await db.brands.delete(request.ownerId, request.params.brandId);
    if (!ok) throw notFound("esa marca");
    return { ok: true };
  });
};
