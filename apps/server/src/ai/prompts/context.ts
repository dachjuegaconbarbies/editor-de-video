/**
 * Contexto del proyecto para los mensajes del usuario (la parte VARIABLE de cada petición):
 * instrucción, formato, duración objetivo, herramientas prendidas, marca, estilo guardado, reglas
 * aprendidas, glosario, palabras clave, modelos de IA disponibles y el inventario del material.
 * Nunca incluye rutas de archivos ni claves de almacenamiento.
 */
import type { Asset, Recipe, ToolSettings } from "@autoeditor/shared";
import { PLATFORM_LABELS, RESOLUTIONS, SAFE_ZONES, timelineToSource } from "@autoeditor/shared";
import type { CorrectionInput, EditInput } from "../../services/types.js";
import { compactRecipe } from "../shared/recipe-ops.js";
import { round2 } from "../shared/text.js";
import { wordsByAsset } from "../shared/transcript.js";

const json = (v: unknown) => JSON.stringify(v);

/** Herramientas prendidas con sus opciones (las apagadas solo se listan por nombre). */
export function describeTools(tools: ToolSettings): string {
  const on: string[] = [];
  const off: string[] = [];
  for (const [key, value] of Object.entries(tools) as [keyof ToolSettings, ToolSettings[keyof ToolSettings]][]) {
    const { enabled, ...opts } = value as { enabled: boolean } & Record<string, unknown>;
    if (enabled) on.push(`- ${key}${Object.keys(opts).length ? `: ${json(opts)}` : ""}`);
    else off.push(key);
  }
  return `Prendidas:\n${on.join("\n") || "- (ninguna)"}\nApagadas (no las uses): ${off.join(", ") || "ninguna"}`;
}

/** Una línea por archivo del material (sin rutas). */
export function materialInventory(assets: Asset[]): string {
  if (!assets.length) return "(sin material)";
  return assets
    .map((a) => {
      const p = a.probe;
      const parts = [
        `id=${a.id}`,
        `«${a.originalName}»`,
        a.category,
        a.kind,
        p.duration != null ? `${round2(p.duration)} s` : "",
        p.width && p.height ? `${p.width}x${p.height}` : "",
        a.kind === "video" ? (p.hasAudio ? "con audio" : "sin audio") : "",
        a.analysis.role !== "desconocido" ? `rol=${a.analysis.role}` : "",
        a.analysis.brollSegments.length ? `${a.analysis.brollSegments.length} fragmentos de b-roll` : "",
        a.priority === "debe-aparecer" ? "PRIORIDAD: debe-aparecer" : "",
        a.note ? `nota del usuario: «${a.note}»` : "",
        a.analysis.description ? `descripción: ${a.analysis.description}` : "",
      ].filter(Boolean);
      return `- ${parts.join(" · ")}`;
    })
    .join("\n");
}

/** Detalle de un archivo para la herramienta ver_material. */
export function assetDetail(a: Asset): Record<string, unknown> {
  const an = a.analysis;
  return {
    id: a.id,
    nombre: a.originalName,
    categoria: a.category,
    tipo: a.kind,
    prioridad: a.priority,
    nota: a.note,
    probe: a.probe,
    analisis: {
      estado: an.status,
      rol: an.role,
      descripcion: an.description,
      tieneVoz: an.hasSpeech,
      loudnessLufs: an.loudness,
      cambiosDeEscena: an.scenes.map(round2),
      silencios: an.silences.map(([s, e]) => [round2(s), round2(e)]),
      fragmentosBroll: an.brollSegments,
      rostros: an.faces.length
        ? { muestras: an.faces.length, xPromedio: round2(an.faces.reduce((s, f) => s + f.x, 0) / an.faces.length), primeras: an.faces.slice(0, 6) }
        : null,
      fotogramasClave: an.keyframes.map((k) => round2(k.t)),
    },
  };
}

function transcriptsSummary(input: EditInput): string {
  const byAsset = wordsByAsset(input.transcripts);
  if (!byAsset.size) return "(no hay transcripciones listas)";
  const names = new Map(input.assets.map((a) => [a.id, a.originalName]));
  return [...byAsset.entries()]
    .map(([assetId, words]) => {
      const marks = words.filter((w) => w.mark).length;
      const fillers = words.filter((w) => w.filler).length;
      const first = words.slice(0, 18).map((w) => w.text).join(" ");
      return `- ${assetId} («${names.get(assetId) ?? assetId}»): ${words.length} palabras, ${round2(words[0]!.start)}–${round2(words[words.length - 1]!.end)} s` +
        `${marks ? `, ${marks} con marca del usuario` : ""}${fillers ? `, ${fillers} muletillas detectadas` : ""}. Empieza: «${first}…»`;
    })
    .join("\n");
}

/** Contexto completo del proyecto (primer mensaje del usuario en planear y corregir). */
export function projectContext(input: EditInput): string {
  const s = input.settings;
  const ins = s.instruction;
  const res = RESOLUTIONS[ins.format];
  const safe = SAFE_ZONES[ins.platform];
  const sections: string[] = [];

  sections.push(`## Instrucción del usuario\n${ins.text.trim() || "(sin instrucción escrita: haz la mejor edición posible con el material)"}`);
  sections.push(
    `## Formato\n${ins.format} (${res.width}x${res.height}) para ${PLATFORM_LABELS[ins.platform]}; tono: ${ins.tone || "dinámico"}.\n` +
      `Zona segura de la plataforma (fracción del cuadro que tapa la interfaz): arriba ${safe.top}, abajo ${safe.bottom}, izquierda ${safe.left}, derecha ${safe.right}.`,
  );
  sections.push(
    `## Duración objetivo\n${ins.targetDuration != null && ins.durationMode !== "auto" ? `${ins.targetDuration} s, modo "${ins.durationMode}" (${ins.durationMode === "exacta" ? "±0.5 s" : "±15 %"}).` : ins.targetDuration != null ? `Referencia de ${ins.targetDuration} s (modo auto: decide según el material).` : "Auto: decide según el material."}`,
  );
  sections.push(`## Herramientas\n${describeTools(s.tools)}`);
  sections.push(`## Subtítulos\n${s.captions.enabled ? `Prendidos. Estilo pedido: ${json(s.captions.style)}` : "Apagados (tracks.captions.enabled = false)."}`);

  const ctx = s.context;
  if (ctx.script.enabled && ctx.script.text.trim()) {
    sections.push(`## Guion (${ctx.script.follow === "estricto" ? "seguirlo al pie de la letra" : "guía flexible"})\n${ctx.script.text.trim()}`);
  }
  if (ctx.brand.enabled || input.brand) {
    const b = input.brand;
    const inline = ctx.brand.inline;
    sections.push(
      `## Marca\n${json({
        nombre: b?.name || inline.name,
        logos: b?.logoAssetIds ?? inline.logoAssetIds,
        fuentesSubidas: b?.fontAssetIds ?? inline.fontAssetIds,
        googleFonts: b?.googleFonts ?? inline.googleFonts,
        colores: b?.colors ?? inline.colors,
        intro: b?.introAssetId ?? inline.introAssetId,
        outro: b?.outroAssetId ?? inline.outroAssetId,
        notas: b?.notes || inline.notes,
      })}`,
    );
  }
  if (ctx.references.enabled && (ctx.references.links.length || ctx.references.imageAssetIds.length)) {
    const links = ctx.references.links.map((l) => `- ${l.kind}: ${l.url}${l.likes ? ` — le gusta: «${l.likes}»` : ""}${l.analysis ? `\n  Análisis: ${l.analysis}` : ""}`);
    sections.push(`## Referencias\n${links.join("\n")}${ctx.references.imageAssetIds.length ? `\nImágenes de referencia (assets): ${ctx.references.imageAssetIds.join(", ")}` : ""}`);
  }
  if (input.style) {
    const v = input.style.version;
    sections.push(
      `## Estilo guardado en uso (versión ${v.number})\nSigue esta ficha de reglas del estilo:\n${input.style.skillMarkdown.trim() || v.rulesMarkdown.trim()}\n\n` +
        `Tokens del estilo: ${json(v.preset.styleTokens)}${v.preset.baseInstruction ? `\nInstrucción base del estilo: ${v.preset.baseInstruction}` : ""}`,
    );
  }
  if (input.baseRecipe) {
    sections.push(`## Receta base (del estilo o versión anterior): respétala y adáptala al material nuevo\n${json(compactRecipe(input.baseRecipe))}`);
  }
  const rules = input.rules.filter((r) => r.enabled);
  if (rules.length) {
    sections.push(`## Reglas aprendidas del usuario (aplícalas siempre)\n${rules.map((r) => `- [${r.id}] ${r.text}${r.check ? ` (comprobación: ${json(r.check)})` : ""}`).join("\n")}`);
  }
  if (input.glossary.length) {
    sections.push(`## Glosario (así se escriben estos términos)\n${input.glossary.map((g) => `- ${g.term}${g.variants.length ? ` (no: ${g.variants.join(", ")})` : ""}`).join("\n")}`);
  }
  const kws = input.keywords.filter((k) => k.enabled);
  if (kws.length) {
    sections.push(`## Palabras clave\n${kws.map((k) => `- «${k.text}» (${k.category}, puntaje ${round2(k.score)}, ${k.occurrences.length} apariciones${k.occurrences[0] ? `, primera en ${k.occurrences[0].assetId} @ ${round2(k.occurrences[0].t)} s` : ""})`).join("\n")}`);
  }
  if (input.aiModels.length && (s.tools.aiImages.enabled || s.tools.aiVideos.enabled || (s.tools.broll.enabled && s.tools.broll.source !== "material"))) {
    sections.push(
      `## Modelos de IA generativa disponibles (Kie AI)\n${input.aiModels
        .filter((m) => m.enabled)
        .map((m) => `- ${m.id} (${m.kind}, ${m.label}): ~US$${m.costUsd} por generación, ~${m.typicalSeconds} s`)
        .join("\n")}\nMáximos: ${s.tools.aiImages.enabled ? `${s.tools.aiImages.max} imágenes (estilo: ${s.tools.aiImages.style})` : "imágenes apagadas"}; ${s.tools.aiVideos.enabled ? `${s.tools.aiVideos.max} videos de ${s.tools.aiVideos.duration} s` : "videos apagados"}.`,
    );
  }
  sections.push(`## Material\n${materialInventory(input.assets)}`);
  sections.push(`## Transcripciones\n${transcriptsSummary(input)}`);
  return sections.join("\n\n");
}

export function planUserMessage(input: EditInput): string {
  return `${projectContext(input)}\n\nHaz la edición: revisa el material, propón la receta con proponer_receta hasta que quede sin errores, revisa fotogramas de la propuesta y llama a terminar.`;
}

export function revisePlanMessage(input: EditInput, current: Recipe, feedback: string): string {
  return (
    `${projectContext(input)}\n\n## Plan propuesto (receta actual)\n${json(compactRecipe(current))}\n\n` +
    `## Ajuste que pidió el usuario al plan\n${feedback.trim()}\n\n` +
    `Ajusta el plan: propón la receta corregida con proponer_receta (parte de la actual y cambia lo pedido) y llama a terminar con un resumen de lo que cambiaste.`
  );
}

/** Qué hay en el segundo `at` del video final (clip, archivo, palabras que se oyen). */
export function anchorContext(recipe: Recipe, at: number, input: EditInput): string {
  const src = timelineToSource(recipe, at);
  const fmt = `${Math.floor(at / 60)}:${String(Math.floor(at % 60)).padStart(2, "0")}`;
  if (!src) return `El usuario ancló la corrección al segundo ${round2(at)} (${fmt}) del video, pero en ese instante no hay clip principal.`;
  const clipIdx = recipe.tracks.video.findIndex((c) => c.id === src.clipId);
  const name = input.assets.find((a) => a.id === src.assetId)?.originalName ?? src.assetId;
  const words = wordsByAsset(input.transcripts).get(src.assetId) ?? [];
  const near = words.filter((w) => w.end >= src.time - 2 && w.start <= src.time + 2);
  const heard = near.map((w) => (w.start <= src.time && w.end >= src.time ? `[${w.text}]` : w.text)).join(" ");
  const caption = recipe.tracks.captions.words.filter((w) => w.end >= at - 1.5 && w.start <= at + 1.5).map((w) => w.text).join(" ");
  const overlays = [
    ...recipe.tracks.text.map((t, i) => ({ t, path: `/tracks/text/${i}`, label: `texto «${t.text}»` })),
    ...recipe.tracks.graphics.map((t, i) => ({ t, path: `/tracks/graphics/${i}`, label: `gráfico ${t.templateId}` })),
    ...recipe.tracks.overlays.map((t, i) => ({ t, path: `/tracks/overlays/${i}`, label: `${t.kind} ${t.assetId}` })),
  ].filter((o) => o.t.start <= at && o.t.end >= at);
  return (
    `El usuario ancló la corrección al segundo ${round2(at)} (${fmt}) del video final. Ahí se ve el clip #${clipIdx} (id ${src.clipId}, ruta /tracks/video/${clipIdx}) ` +
    `del archivo ${src.assetId} («${name}»), en el segundo ${round2(src.time)} del original.` +
    (heard ? `\nSe oye (la palabra de ese instante entre corchetes): «${heard}».` : "") +
    (caption ? `\nSubtítulos alrededor: «${caption}».` : "") +
    (overlays.length ? `\nEncima hay: ${overlays.map((o) => `${o.label} (${o.path})`).join(", ")}.` : "")
  );
}

export function correctionMessage(input: CorrectionInput): string {
  const history = input.history.slice(-8);
  const parts = [
    projectContext(input),
    `## Receta actual (resumen; usa ver_receta para ver secciones completas con sus rutas)\n${json(recipeOutline(input.current))}`,
    history.length ? `## Correcciones anteriores (la más reciente al final)\n${history.map((h) => `- «${h.correction}» → ${h.summary}`).join("\n")}` : "",
    input.at != null ? `## Momento anclado\n${anchorContext(input.current, input.at, input)}` : "",
    `## Corrección que pide el usuario\n${input.correction.trim()}`,
    `Aplica la corrección con enviar_parche (parche mínimo, solo las áreas necesarias).`,
  ];
  return parts.filter(Boolean).join("\n\n");
}

/** Resumen de la receta: cuántos elementos hay en cada pista y sus datos principales (para ubicar rutas). */
export function recipeOutline(recipe: Recipe): Record<string, unknown> {
  const t = recipe.tracks;
  return {
    duracion: recipe.duration,
    formato: recipe.format,
    objetivo: recipe.target,
    estilo: { titleFont: recipe.style.titleFont.family, bodyFont: recipe.style.bodyFont.family, palette: recipe.style.palette, defaultTransition: recipe.style.defaultTransition, targetShotLength: recipe.style.targetShotLength, textCase: recipe.style.textCase },
    video: t.video.map((c, i) => `#${i} ${c.id}: ${c.assetId} ${round2(c.sourceIn)}–${round2(c.sourceOut)} → ${round2(c.start)} s${c.zoom ? " zoom" : ""}${c.transitionIn.type !== "corte" ? ` ${c.transitionIn.type}` : ""}`),
    overlays: t.overlays.map((o, i) => `#${i} ${o.id}: ${o.kind} ${o.assetId} ${round2(o.start)}–${round2(o.end)} ${o.layout}`),
    texto: t.text.map((x, i) => `#${i} ${x.id}: ${x.kind} «${x.text}» ${round2(x.start)}–${round2(x.end)}${x.font ? ` ${x.font.family}` : ""}`),
    graficos: t.graphics.map((g, i) => `#${i} ${g.id}: ${g.templateId} ${round2(g.start)}–${round2(g.end)}`),
    subtitulos: { enabled: t.captions.enabled, style: t.captions.style, palabras: t.captions.words.length, overrides: t.captions.overrides },
    audio: { music: t.audio.music, sfx: t.audio.sfx.map((x, i) => `#${i} ${x.kind} ${x.assetId} @${round2(x.at)} ${x.gainDb} dB`), voiceover: t.audio.voiceover.length, mix: t.audio.mix },
    ia: recipe.ai.map((a, i) => `#${i} ${a.kind} ${a.model} «${a.prompt.slice(0, 60)}» ${a.status}`),
  };
}
