import { describe, expect, it } from "vitest";
import {
  Recipe,
  normalizeRecipe,
  diffRecipes,
  changesOutsideAreas,
  materializeCaptionWords,
  groupCaptionLines,
  toSrt,
  toVtt,
  estimate,
  defaultProjectSettings,
  EstimatorCoefficients,
  updateCalibration,
  sourceToTimeline,
  deriveEngines,
  canonicalJson,
} from "../src/index.js";

const base = () =>
  Recipe.parse({
    format: { aspect: "9:16", width: 1080, height: 1920, fps: 30 },
    tracks: {
      video: [
        { id: "c1", assetId: "a1", sourceIn: 0, sourceOut: 4 },
        { id: "c2", assetId: "a1", sourceIn: 10, sourceOut: 14, transitionIn: { type: "fundido", duration: 0.5 } },
        { id: "c3", assetId: "a2", sourceIn: 2, sourceOut: 5 },
      ],
      text: [{ id: "t1", kind: "titulo", text: "Hola", start: 1, end: 3 }],
    },
  });

describe("receta", () => {
  it("normaliza inicios con traslape de transiciones", () => {
    const r = normalizeRecipe(base());
    expect(r.tracks.video.map((c) => c.start)).toEqual([0, 3.5, 7.5]);
    expect(r.duration).toBe(10.5);
  });
  it("mapea tiempo de fuente a línea final", () => {
    const r = normalizeRecipe(base());
    expect(sourceToTimeline(r, "a1", 12)).toBe(5.5);
    expect(sourceToTimeline(r, "a1", 7)).toBeNull();
  });
  it("serialización canónica estable", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

describe("diff y regla de oro", () => {
  it("un cambio de tipografía solo toca el área estilo", () => {
    const a = normalizeRecipe(base());
    const b = structuredClone(a);
    b.style.titleFont.family = "Montserrat";
    const changes = diffRecipes(a, b);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.area).toBe("estilo");
    expect(changes[0]!.label).toContain("Montserrat");
    expect(changesOutsideAreas(changes, ["estilo"])).toHaveLength(0);
  });
  it("quitar un clip se reporta por id, inicios recalculados son derivados", () => {
    const a = normalizeRecipe(base());
    const b = normalizeRecipe({ ...a, tracks: { ...a.tracks, video: a.tracks.video.filter((c) => c.id !== "c2") } });
    const changes = diffRecipes(a, b);
    const direct = changes.filter((c) => !c.derived);
    expect(direct).toHaveLength(1);
    expect(direct[0]!.op).toBe("remove");
    expect(changesOutsideAreas(changes, ["cortes"])).toHaveLength(0);
  });
});

describe("subtítulos", () => {
  it("materializa palabras según cortes y resalta palabras clave", () => {
    const r = normalizeRecipe(base());
    const words = [
      { assetId: "a1", i: 0, text: "Bienvenidos", start: 0.2, end: 0.8 },
      { assetId: "a1", i: 1, text: "a", start: 0.9, end: 1.0 },
      { assetId: "a1", i: 2, text: "Zyra", start: 1.1, end: 1.6 },
      { assetId: "a1", i: 3, text: "fuera", start: 6, end: 6.5 },
      { assetId: "a1", i: 4, text: "dentro.", start: 11, end: 11.5 },
    ];
    const cw = materializeCaptionWords(r, words, ["zyra"]);
    expect(cw.map((w) => w.text)).toEqual(["Bienvenidos", "a", "Zyra", "dentro."]);
    expect(cw.find((w) => w.text === "Zyra")!.highlight).toBe(true);
    const lines = groupCaptionLines(cw, r.tracks.captions.style);
    expect(toSrt(lines)).toContain("-->");
    expect(toVtt(lines).startsWith("WEBVTT")).toBe(true);
  });
});

describe("estimador", () => {
  it("prender IA sube costo y tiempo; calibración ajusta", () => {
    const s = defaultProjectSettings();
    const coef = EstimatorCoefficients.parse({});
    const pricing = {
      editorModel: { inputUsdPerMTok: 4, outputUsdPerMTok: 20, cacheReadUsdPerMTok: 0.2 },
      helperModel: { inputUsdPerMTok: 2, outputUsdPerMTok: 10, cacheReadUsdPerMTok: 0.2 },
      kieModels: [{ id: "img", label: "Img", kind: "imagen" as const, api: "market" as const, model: "x", createPath: "", statusPath: "", defaults: {}, fieldMap: {}, costCredits: 8, costUsd: 0.04, typicalSeconds: 30, enabled: true, verified: false, notes: "" }],
      kieDefaults: { imagen: "img", video: "", musica: "", voz: "", sfx: "" },
    };
    const material = { videoMinutes: 3, speechMinutesPending: 3, unanalyzedMinutes: 0, photos: 0, inferredDurationSeconds: 45 };
    const e1 = estimate(s, material, coef, pricing);
    s.tools.aiImages.enabled = true;
    const e2 = estimate(s, material, coef, pricing);
    expect(e2.costUsd.expected).toBeGreaterThan(e1.costUsd.expected);
    expect(e1.label).toMatch(/min/);
    expect(deriveEngines(s).kie).toBe(true);
    const c = updateCalibration(undefined, 100, 150);
    expect(c.factor).toBeCloseTo(1.5);
  });
});
