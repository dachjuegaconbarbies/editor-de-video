/**
 * Verificaciones de una receta propuesta por Claude que van más allá del esquema: que use material que
 * existe, rangos dentro de cada archivo, plantillas conocidas y los máximos de IA de las herramientas.
 * Y el informe (métricas + avisos) que se le devuelve a Claude para que se autocorrija.
 */
import type { AiRequest, MotionTemplate, ProjectSettings, Recipe } from "@autoeditor/shared";
import { clipDuration, durationMeetsTarget } from "@autoeditor/shared";
import type { EditInput } from "../../services/types.js";
import { deterministicChecks, editorialWarnings } from "../shared/checks.js";
import { recipeMetrics } from "../shared/recipe-ops.js";
import { round2 } from "../shared/text.js";

/** Qué pedidos de IA permiten las herramientas prendidas y cuántos. */
export function aiAllowance(settings: ProjectSettings): Record<AiRequest["kind"], { allowed: boolean; max: number; why: string }> {
  const t = settings.tools;
  const brollAi = t.broll.enabled && t.broll.source !== "material";
  return {
    imagen: {
      allowed: t.aiImages.enabled || brollAi,
      max: t.aiImages.enabled ? t.aiImages.max : brollAi ? 4 : 0,
      why: "prende «Imágenes con IA» (o b-roll con fuente IA)",
    },
    video: { allowed: t.aiVideos.enabled, max: t.aiVideos.enabled ? t.aiVideos.max : 0, why: "prende «Videos con IA»" },
    sfx: { allowed: t.sfx.enabled && t.sfx.source === "ia", max: 6, why: "prende «Efectos de sonido» con fuente IA" },
    voz: { allowed: t.voiceover.enabled, max: 3, why: "prende «Voz en off»" },
    musica: { allowed: t.music.enabled && t.music.source === "ia", max: 1, why: "prende «Música» con fuente IA" },
  };
}

/** Errores de referencias: assets inexistentes, rangos fuera del archivo, plantillas desconocidas, máximos de IA. */
export function materialErrors(recipe: Recipe, input: EditInput, extraTemplates: MotionTemplate[]): string[] {
  const errors: string[] = [];
  const assets = new Map(input.assets.map((a) => [a.id, a]));
  const aiIds = new Set(recipe.ai.map((a) => a.id));
  const known = (id: string) => assets.has(id) || aiIds.has(id);

  recipe.tracks.video.forEach((c, i) => {
    const a = assets.get(c.assetId);
    if (!a) return void errors.push(`tracks.video[${i}] (${c.id}): el archivo ${c.assetId} no existe en el material.`);
    if (a.kind !== "video" && a.kind !== "imagen") errors.push(`tracks.video[${i}] (${c.id}): ${c.assetId} es ${a.kind}; la secuencia principal solo admite videos y fotos.`);
    if (a.kind === "imagen" && c.stillDuration == null) errors.push(`tracks.video[${i}] (${c.id}): es una foto; define stillDuration (segundos en pantalla).`);
    if (a.kind === "video") {
      if (c.sourceOut <= c.sourceIn) errors.push(`tracks.video[${i}] (${c.id}): sourceOut (${c.sourceOut}) debe ser mayor que sourceIn (${c.sourceIn}).`);
      const d = a.probe.duration;
      if (d != null && c.sourceOut > d + 0.05) errors.push(`tracks.video[${i}] (${c.id}): sourceOut ${c.sourceOut} s pasa del final del archivo (${round2(d)} s).`);
    }
  });
  recipe.tracks.overlays.forEach((o, i) => {
    if (!known(o.assetId)) errors.push(`tracks.overlays[${i}] (${o.id}): el archivo ${o.assetId} no existe.`);
    const a = assets.get(o.assetId);
    if (a?.kind === "video" && a.probe.duration != null && o.sourceIn + (o.end - o.start) > a.probe.duration + 0.05) {
      errors.push(`tracks.overlays[${i}] (${o.id}): el b-roll dura ${round2(a.probe.duration)} s y pides de ${o.sourceIn} a ${round2(o.sourceIn + o.end - o.start)} s.`);
    }
  });
  recipe.tracks.audio.music.forEach((m, i) => !known(m.assetId) && errors.push(`tracks.audio.music[${i}]: el archivo ${m.assetId} no existe.`));
  recipe.tracks.audio.sfx.forEach((s, i) => !known(s.assetId) && errors.push(`tracks.audio.sfx[${i}]: el archivo ${s.assetId} no existe.`));
  recipe.tracks.audio.voiceover.forEach((v, i) => !known(v.assetId) && errors.push(`tracks.audio.voiceover[${i}]: el archivo ${v.assetId} no existe.`));

  const templates = new Set([...input.toolbox.motionTemplates(), ...extraTemplates].map((t) => t.id));
  recipe.tracks.graphics.forEach((g, i) => {
    if (!templates.has(g.templateId)) errors.push(`tracks.graphics[${i}] (${g.id}): la plantilla ${g.templateId} no existe (usa listar_plantillas o escribe una).`);
  });

  const allow = aiAllowance(input.settings);
  for (const kind of Object.keys(allow) as AiRequest["kind"][]) {
    const n = recipe.ai.filter((a) => a.kind === kind && !a.resultAssetId && a.usage !== "portada").length;
    if (!n) continue;
    if (!allow[kind].allowed) errors.push(`Hay ${n} pedido(s) de IA de tipo ${kind}, pero esa herramienta está apagada (${allow[kind].why}).`);
    else if (n > allow[kind].max) errors.push(`Hay ${n} pedidos de IA de tipo ${kind}; el máximo de las herramientas es ${allow[kind].max}.`);
  }
  return errors;
}

/** Informe para Claude tras una propuesta válida: métricas, objetivo de duración, revisión y avisos editoriales. */
export function proposalReport(recipe: Recipe, input: EditInput): { text: string; durationOk: boolean } {
  const m = recipeMetrics(recipe);
  const target = durationMeetsTarget(recipe);
  const qa = deterministicChecks(recipe, input.rules, input.settings).filter((c) => !c.ok && c.check !== "Duración objetivo");
  const warnings = editorialWarnings(recipe, { transcripts: input.transcripts, assets: input.assets, settings: input.settings });
  const longest = recipe.tracks.video.reduce((mx, c) => Math.max(mx, clipDuration(c)), 0);
  const lines = [
    `Duración: ${m.duration} s. ${target.ok ? "Cumple" : "NO cumple"} el objetivo: ${target.detail}`,
    `Clips: ${m.clips} (plano promedio ${m.averageShot} s, el más largo ${round2(longest)} s; objetivo de ritmo ${recipe.style.targetShotLength} s).`,
    `B-roll: ${m.brollSeconds} s (${Math.round(m.brollCoverage * 100)} % del video)${input.settings.tools.broll.enabled ? "" : " — la herramienta de b-roll está apagada"}.`,
    `Textos: ${m.texts} · gráficos: ${m.graphics} · palabras de subtítulos: ${m.captionWords} · pedidos de IA: ${m.aiRequests} (US$${m.aiCostUsd}).`,
  ];
  if (qa.length) lines.push(`Revisión automática:\n${qa.map((c) => `- ${c.check}: ${c.detail}`).join("\n")}`);
  if (warnings.length) lines.push(`Avisos editoriales (corrígelos):\n${warnings.slice(0, 20).map((w) => `- ${w}`).join("\n")}${warnings.length > 20 ? `\n- …y ${warnings.length - 20} más` : ""}`);
  return { text: lines.join("\n"), durationOk: target.ok };
}
