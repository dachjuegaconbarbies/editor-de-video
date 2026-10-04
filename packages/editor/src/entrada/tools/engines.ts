/**
 * Reglas de los motores explicadas (lógica pura): por qué se prendió Kie AI, si hay llave, costo
 * aproximado de lo generado con IA y modelos disponibles por tipo (leídos de /config).
 */
import type { ProjectSettings, PublicConfig } from "@autoeditor/shared";

export type KieKind = "imagen" | "video" | "musica" | "voz" | "sfx";

/** Herramientas que prenden Kie AI ahora mismo (en el orden del catálogo). */
export function kieReasons(settings: ProjectSettings): string[] {
  const t = settings.tools;
  const out: string[] = [];
  if (t.broll.enabled && t.broll.source !== "material") out.push("B-roll con IA");
  if (t.music.enabled && t.music.source === "ia") out.push("Música con IA");
  if (t.sfx.enabled && t.sfx.source === "ia") out.push("Efectos con IA");
  if (t.voiceover.enabled) out.push("Voz en off con IA");
  if (t.aiImages.enabled) out.push("IA imágenes");
  if (t.aiVideos.enabled) out.push("IA videos");
  return out;
}

/** Une una lista en español: "a", "a y b", "a, b y c". */
export function joinEs(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

/** ¿Hay que avisar que Kie AI no está configurado (se usarán marcadores de prueba)? */
export function kieMissing(config: PublicConfig | null): boolean {
  return !config || config.demoMode || !config.capabilities.kie;
}

export interface KieModelView {
  id: string;
  label: string;
  costUsd: number;
  verified: boolean;
  isDefault: boolean;
}

/** Modelos activos de un tipo, con el predeterminado primero. */
export function kieModelsFor(config: PublicConfig | null, kind: KieKind): KieModelView[] {
  if (!config) return [];
  const def = config.pricing.kieDefaults[kind];
  return config.kieModels
    .filter((m) => m.kind === kind && m.enabled)
    .map((m) => ({ id: m.id, label: m.label, costUsd: m.costUsd, verified: m.verified, isDefault: m.id === def }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.costUsd - b.costUsd);
}

/** Modelo efectivo (el elegido o el predeterminado). */
export function effectiveModel(config: PublicConfig | null, kind: KieKind, chosen: string): KieModelView | null {
  const list = kieModelsFor(config, kind);
  return list.find((m) => m.id === chosen) ?? list.find((m) => m.isDefault) ?? list[0] ?? null;
}

/** Costo aproximado (USD) de lo que se generaría con IA según la configuración. */
export function aiCostEstimate(settings: ProjectSettings, config: PublicConfig | null): { lines: { label: string; usd: number }[]; total: number } {
  const t = settings.tools;
  const lines: { label: string; usd: number }[] = [];
  if (t.aiImages.enabled) {
    const m = effectiveModel(config, "imagen", t.aiImages.model);
    if (m) lines.push({ label: `${t.aiImages.max} ${t.aiImages.max === 1 ? "imagen" : "imágenes"}`, usd: m.costUsd * t.aiImages.max });
  }
  if (t.aiVideos.enabled) {
    const m = effectiveModel(config, "video", t.aiVideos.model);
    if (m) lines.push({ label: `${t.aiVideos.max} ${t.aiVideos.max === 1 ? "clip" : "clips"} de ${t.aiVideos.duration} s`, usd: m.costUsd * t.aiVideos.max });
  }
  if (t.voiceover.enabled) {
    const m = effectiveModel(config, "voz", "");
    if (m) lines.push({ label: "Voz en off", usd: m.costUsd });
  }
  if (t.sfx.enabled && t.sfx.source === "ia") {
    const m = effectiveModel(config, "sfx", "");
    const n = t.sfx.density === "alta" ? 8 : t.sfx.density === "media" ? 5 : 3;
    if (m) lines.push({ label: `~${n} efectos`, usd: m.costUsd * n });
  }
  if (t.music.enabled && t.music.source === "ia") {
    const m = effectiveModel(config, "musica", "");
    if (m) lines.push({ label: "Música", usd: m.costUsd });
  }
  return { lines, total: lines.reduce((s, l) => s + l.usd, 0) };
}

export function formatCost(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return "< $0.01";
  return `$${usd.toFixed(2)}`;
}
