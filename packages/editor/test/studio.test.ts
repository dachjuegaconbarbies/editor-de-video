/**
 * Estudio: lógica pura (qué va arriba y abajo, categoría automática, tomas repetidas, resumen de
 * lo que Claude detectó, valores por defecto) sin React.
 */
import { Asset, AssetAnalysis, MediaProbe, type AssetCategory, type Transcript } from "@autoeditor/shared";
import { describe, expect, it } from "vitest";
import {
  activePreset,
  CAPTION_PRESETS,
  detectRepeatedTakes,
  extraChip,
  groupFilesByCategory,
  inferExtraCategory,
  insightsLine,
  isLongClip,
  materialInsights,
  splitMaterial,
  studioDefaultSettings,
} from "../src/studio/logic.js";
import { preflightWarnings } from "../src/store/derive.js";
import { defaultProjectSettings } from "@autoeditor/shared";

let seq = 0;
function asset(category: AssetCategory, over: { kind?: Asset["kind"]; order?: number; duration?: number; analysis?: Partial<AssetAnalysis>; name?: string } = {}): Asset {
  seq++;
  return Asset.parse({
    id: `a${seq}`,
    ownerId: "local",
    projectId: "p1",
    category,
    kind: over.kind ?? "video",
    originalName: over.name ?? `archivo-${seq}.mp4`,
    mimeType: "video/mp4",
    sizeBytes: 1000,
    storageKey: `p1/a${seq}`,
    probe: MediaProbe.parse({ duration: over.duration ?? 20 }),
    analysis: AssetAnalysis.parse({ status: "listo", ...over.analysis }),
    order: over.order ?? 0,
    createdAt: `2026-10-08T00:00:0${seq % 10}.000Z`,
  });
}

const words = (text: string, start = 0, gapEvery = 0) =>
  text.split(" ").map((t, i) => ({ text: t, start: start + i * 0.4 + (gapEvery && i >= gapEvery ? 1.2 : 0), end: start + i * 0.4 + 0.35 + (gapEvery && i >= gapEvery ? 1.2 : 0) }));

describe("estudio: material arriba y abajo", () => {
  it("arriba solo el clip base (en su orden); abajo todo lo demás menos lo interno", () => {
    const b2 = asset("clip-base", { order: 1 });
    const b1 = asset("clip-base", { order: 0 });
    const broll = asset("crudo-video");
    const music = asset("musica", { kind: "audio" });
    const render = asset("render");
    const { base, extras } = splitMaterial([b2, broll, music, b1, render]);
    expect(base.map((a) => a.id)).toEqual([b1.id, b2.id]);
    expect(extras.map((a) => a.id).sort()).toEqual([broll.id, music.id].sort());
  });

  it("la categoría de lo de abajo sale sola del tipo de archivo", () => {
    expect(inferExtraCategory({ name: "toma.mov", type: "video/quicktime" })).toBe("crudo-video");
    expect(inferExtraCategory({ name: "cancion.mp3", type: "audio/mpeg" })).toBe("musica");
    expect(inferExtraCategory({ name: "whoosh.wav", type: "audio/wav" })).toBe("sfx");
    expect(inferExtraCategory({ name: "logo-marca.png", type: "image/png" })).toBe("logo");
    expect(inferExtraCategory({ name: "foto.jpg", type: "image/jpeg" })).toBe("grafico");
    expect(inferExtraCategory({ name: "guion.txt", type: "text/plain" })).toBe("guion");
    expect(inferExtraCategory({ name: "Marca.ttf", type: "" })).toBe("fuente");
    expect(inferExtraCategory({ name: "datos.zip", type: "application/zip" })).toBeNull();
    const { groups, rejected } = groupFilesByCategory([
      { name: "a.mp4", type: "video/mp4" },
      { name: "b.mp4", type: "video/mp4" },
      { name: "x.zip", type: "" },
    ]);
    expect(groups.get("crudo-video")).toHaveLength(2);
    expect(rejected).toHaveLength(1);
  });

  it("chip B-ROLL solo cuando el análisis lo detectó", () => {
    expect(extraChip(asset("crudo-video", { analysis: { role: "b-roll" } })).label).toBe("B-ROLL");
    expect(extraChip(asset("crudo-video", { analysis: { role: "desconocido" } })).label).toBe("Clip");
    expect(extraChip(asset("musica", { kind: "audio" })).label).toBe("Música");
  });

  it("clip largo a partir de 4 minutos", () => {
    expect(isLongClip(asset("clip-base", { duration: 3600 }))).toBe(true);
    expect(isLongClip(asset("clip-base", { duration: 45 }))).toBe(false);
  });
});

describe("estudio: tomas repetidas", () => {
  it("detecta una frase dicha dos veces (arranque en falso) y se queda con la última", () => {
    const w = [...words("Primero prepara todo con… perdón.", 0), ...words("Primero prepara todo con calma.", 4), ...words("Segundo enfócate en lo importante.", 8)];
    const takes = detectRepeatedTakes(w);
    expect(takes).toHaveLength(1);
    expect(takes[0]!.count).toBe(2);
    expect(takes[0]!.phrase).toContain("calma");
    expect(takes[0]!.starts).toEqual([0, 4]);
  });

  it("no marca frases distintas", () => {
    const w = [...words("Hola hoy te muestro algo.", 0), ...words("Son tres pasos muy simples.", 3), ...words("Sígueme para más.", 6)];
    expect(detectRepeatedTakes(w)).toEqual([]);
  });
});

describe("estudio: lo que Claude detectó", () => {
  it("resume clips, tomas repetidas, tomas de apoyo y pausas", () => {
    const base = [
      asset("clip-base", { analysis: { role: "mixto", brollSegments: [{ start: 10, end: 14, score: 0.8, description: "Manos", tags: [] }], silences: [[2, 4], [6, 8]] } }),
      asset("clip-base", { analysis: { role: "a-roll" } }),
    ];
    const extras = [asset("crudo-video", { analysis: { role: "b-roll", brollSegments: [] } })];
    const t: Pick<Transcript, "assetId" | "status" | "words">[] = [
      { assetId: base[0]!.id, status: "listo", words: [...words("Primero prepara todo con… perdón.", 0), ...words("Primero prepara todo con calma.", 4)].map((x, i) => ({ ...x, i, probability: 1, speaker: null, mark: null, original: null, filler: false })) },
    ];
    const ins = materialInsights(base, extras, t);
    expect(ins.ready).toBe(true);
    expect(ins.clips).toBe(2);
    expect(ins.repeatedTakes).toBe(1);
    expect(ins.supportShots).toBe(2);
    expect(insightsLine(ins)).toBe("2 clips · 1 toma repetida · 2 tomas de apoyo · 4 s de pausas");
  });

  it("mientras se analiza no hay resumen", () => {
    const ins = materialInsights([asset("clip-base", { analysis: { status: "analizando" } })], [], []);
    expect(ins.ready).toBe(false);
    expect(ins.analyzing).toBe(1);
  });
});

describe("estudio: valores por defecto y avisos", () => {
  it("todo apagado menos quitar silencios y muletillas", () => {
    const s = studioDefaultSettings();
    expect(s.captions.enabled).toBe(false);
    expect(s.tools.broll.enabled).toBe(false);
    expect(s.tools.music.enabled).toBe(false);
    expect(s.tools.zooms.enabled).toBe(false);
    expect(s.tools.motionGraphics.enabled).toBe(false);
    expect(s.tools.aiImages.enabled).toBe(false);
    expect(s.tools.aiVideos.enabled).toBe(false);
    expect(s.tools.removeSilences.enabled).toBe(true);
    expect(s.tools.removeFillers.enabled).toBe(true);
    expect(s.instruction.format).toBe("9:16");
    expect(s.engines.kie).toBe(false);
    // No contamina los valores por defecto compartidos.
    expect(defaultProjectSettings().tools.zooms.enabled).toBe(true);
    expect(defaultProjectSettings().captions.enabled).toBe(true);
  });

  it("los presets de texto se reconocen", () => {
    const s = defaultProjectSettings();
    const p = CAPTION_PRESETS.find((x) => x.id === "caja")!;
    expect(activePreset({ ...s.captions.style, ...p.style })).toBe("caja");
  });

  it("sin clip base ni otro material no se puede generar; con clip base sí", () => {
    const s = defaultProjectSettings();
    expect(preflightWarnings(s, []).some((w) => w.severity === "bloqueo")).toBe(true);
    expect(preflightWarnings(s, [asset("clip-base")]).some((w) => w.severity === "bloqueo")).toBe(false);
  });
});
