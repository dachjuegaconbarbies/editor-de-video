/**
 * Mapa del material del proyecto (columna, orden sugerido, fragmentos de habla / b-roll / tomas
 * repetidas / tiempos muertos). La función pura vive en ai/shared/material-map.ts; aquí se le suman
 * las horas de grabación (metadatos del archivo) y se guarda para que la interfaz lo muestre.
 */
import type { Asset, Recipe } from "@autoeditor/shared";
import type { AppContext } from "../context.js";
import { buildMaterialMap, type MaterialMap } from "../ai/shared/material-map.js";
import { ffprobeJson } from "../media/probe.js";
import { nowIso } from "../db/util.js";
import type { ProjectData } from "./project-data.js";

export const materialMapKey = (projectId: string) => `material-map:${projectId}`;

/** Lo que se guarda y devuelve la API: el mapa + el orden que de verdad se usó en la última edición. */
export interface MaterialMapRecord {
  map: MaterialMap;
  /** Orden de los clips de la columna en la última versión generada (null si aún no se genera). */
  usedOrder: string[] | null;
  usedOrderReason: string | null;
  updatedAt: string;
}

const recordedCache = new Map<string, string | null>();

/** Hora de grabación de los metadatos (creation_time o la fecha de QuickTime de iPhone). */
export async function recordingTime(ctx: AppContext, asset: Asset): Promise<string | null> {
  const cacheKey = `${asset.id}:${asset.sha256 ?? asset.sizeBytes}`;
  if (recordedCache.has(cacheKey)) return recordedCache.get(cacheKey)!;
  let value: string | null = null;
  try {
    const out = await ffprobeJson(ctx.env.ffprobePath, await ctx.services.storage.localPath(asset.storageKey));
    const tags = [out.format?.tags ?? {}, ...(out.streams ?? []).map((st) => st.tags ?? {})];
    for (const t of tags) {
      const entry = Object.entries(t).find(([k]) => /^(com\.apple\.quicktime\.creationdate|creation_time|date)$/i.test(k));
      if (entry && !Number.isNaN(Date.parse(entry[1]))) {
        value = new Date(Date.parse(entry[1])).toISOString();
        if (/quicktime/i.test(entry[0])) break;
      }
    }
  } catch {
    value = null;
  }
  // Fechas "cero" que escriben algunos programas no sirven para ordenar.
  if (value && value.startsWith("1970-")) value = null;
  recordedCache.set(cacheKey, value);
  return value;
}

/** Calcula el mapa del material con las horas de grabación de los clips candidatos a columna. */
export async function computeMaterialMap(ctx: AppContext, data: Pick<ProjectData, "assets" | "transcripts" | "settings">): Promise<MaterialMap> {
  const candidates = data.assets.filter((a) => a.kind === "video" && (a.category === "clip-base" || a.category === "crudo-video"));
  const recordedAt: Record<string, string | null> = {};
  for (const a of candidates) recordedAt[a.id] = await recordingTime(ctx, a);
  const script = data.settings.context.script.enabled || data.settings.context.script.text.trim() ? data.settings.context.script.text : "";
  return buildMaterialMap({ assets: data.assets, transcripts: data.transcripts.filter((t) => t.status === "listo"), script, recordedAt });
}

/** Orden en que aparecen los clips de la columna en una receta (primera aparición). */
export function orderInRecipe(recipe: Recipe, map: MaterialMap): string[] {
  const column = new Set(map.clips.map((c) => c.assetId));
  const seen: string[] = [];
  for (const c of recipe.tracks.video) if (column.has(c.assetId) && !seen.includes(c.assetId)) seen.push(c.assetId);
  return seen;
}

export async function saveMaterialMap(ctx: AppContext, ownerId: string, projectId: string, record: Omit<MaterialMapRecord, "updatedAt">): Promise<MaterialMapRecord> {
  const full = { ...record, updatedAt: nowIso() };
  await ctx.db.kv.set(ownerId, materialMapKey(projectId), full);
  return full;
}

export async function loadMaterialMap(ctx: AppContext, ownerId: string, projectId: string): Promise<MaterialMapRecord | null> {
  return ctx.db.kv.get<MaterialMapRecord>(ownerId, materialMapKey(projectId));
}

/** Motivo del orden usado en la versión (si el editor cambió el sugerido, se dice). */
export function usedOrderReason(map: MaterialMap, used: string[], generator: "claude" | "demo" | "manual"): string {
  const suggested = map.order.assetIds.filter((id) => used.includes(id));
  const same = suggested.length === used.length && suggested.every((id, i) => id === used[i]);
  if (same) return map.order.reason;
  return generator === "claude" ? "orden narrativo elegido por Claude" : "orden ajustado al armar la edición";
}
