/**
 * Mapa del material, tomas repetidas y orden automático de clips (funciones puras, sin red ni ffmpeg).
 */
import { AssetAnalysis, MediaProbe, Transcript, type Asset } from "@autoeditor/shared";
import { describe, expect, it } from "vitest";
import { buildMaterialMap, describeMaterialMap, subtractRanges } from "../src/ai/shared/material-map.js";
import { contentPosition, fileNumber, suggestClipOrder, type OrderClip } from "../src/ai/shared/clip-order.js";
import { detectRepeatedTakes, isFalseStart, takeTokens, textSimilarity, type TakePhrase } from "../src/ai/shared/takes.js";
import { buildDemoPlan } from "../src/ai/demo/planner.js";
import { makeEditInput, makeSettings, makeToolbox } from "./ai-fixtures.js";
import { testDeps } from "./ai-deps.js";

const NOW = "2026-10-08T10:00:00.000Z";

/** Frases del a-roll de muestra (tiempos reales de data/muestras/a-roll.mp4). */
const AROLL_WORDS: [string, number, number][] = [
  ["Hola,", 0.6, 0.926], ["soy", 1.146, 1.511], ["Ana", 1.571, 1.898], ["de", 1.958, 2.197], ["Zyra.", 2.257, 2.623],
  ["Hoy", 3.323, 3.612], ["te", 3.672, 3.913], ["voy", 3.973, 4.291], ["a", 4.351, 4.582], ["enseñar", 4.642, 5.2], ["tres", 5.378, 5.7],
  ["trucos", 5.804, 6.0], ["para", 6.086, 6.4], ["editar", 6.48, 6.7], ["videos", 6.774, 7.3], ["más", 7.419, 7.8], ["rápido.", 7.874, 8.4],
  ["Primero,", 8.825, 9.4], ["eh,", 9.535, 9.9], ["quita", 9.973, 10.2], ["los", 10.26, 10.6], ["silencios", 10.727, 11.5], ["largos.", 11.573, 12.1],
  ["Segundo,", 14.07, 14.8], ["usa", 14.945, 15.3], ["subtítulos", 15.387, 15.65], ["con", 15.704, 15.8], ["palabras", 15.811, 16.4], ["clave", 16.493, 16.9], ["resaltadas.", 17.002, 17.8],
  ["Y", 18.057, 18.3], ["tercero,", 18.342, 18.7], ["guarda", 18.727, 19.1], ["tu", 19.114, 19.4], ["estilo", 19.427, 19.6], ["para", 19.647, 20.0], ["reutilizarlo", 20.04, 20.28], ["en", 20.299, 20.6], ["cada", 20.693, 20.78], ["video.", 20.8, 21.5],
  ["Síguenos", 21.978, 22.6], ["para", 22.66, 23.0], ["más", 23.053, 23.4], ["consejos.", 23.509, 24.1],
];
const AROLL_DUR = 24.27;

function asset(id: string, over: Omit<Partial<Asset>, "analysis"> & { duration?: number; analysis?: Partial<AssetAnalysis> } = {}): Asset {
  const { duration, analysis, ...rest } = over;
  return {
    id,
    ownerId: "local",
    projectId: "prj_1",
    category: "clip-base",
    kind: "video",
    originalName: `${id}.mp4`,
    mimeType: "video/mp4",
    sizeBytes: 1000,
    storageKey: `local/prj_1/assets/${id}/${id}.mp4`,
    probe: MediaProbe.parse({ duration: duration ?? AROLL_DUR, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true }),
    analysis: AssetAnalysis.parse({ status: "listo", hasSpeech: true, role: "a-roll", ...analysis }),
    thumbnailKey: null,
    priority: "opcional",
    note: "",
    order: 0,
    sha256: null,
    createdAt: NOW,
    ...rest,
  };
}

function transcript(assetId: string, words: [string, number, number][]): Transcript {
  return Transcript.parse({
    id: `trn_${assetId}`,
    ownerId: "local",
    projectId: "prj_1",
    assetId,
    language: "es",
    provider: "demo",
    model: "demo",
    status: "listo",
    words: words.map(([text, start, end], i) => ({ i, text, start, end, probability: 1, filler: /^eh,?$/i.test(text) })),
    createdAt: NOW,
    updatedAt: NOW,
  });
}

/** Desplaza palabras en el tiempo. */
const shift = (words: [string, number, number][], dt: number) => words.map(([t, s, e]) => [t, s + dt, e + dt] as [string, number, number]);
/** Parte el a-roll entre dos segundos y lo lleva a 0. */
const slice = (from: number, to: number) => shift(AROLL_WORDS.filter(([, s]) => s >= from && s < to), -from);

describe("tomas repetidas (función pura)", () => {
  it("normaliza, compara y detecta arranques en falso", () => {
    expect(takeTokens("Primero, eh, quita los silencios.")).toEqual(["primero", "quita", "los", "silencios"]);
    expect(textSimilarity(takeTokens("hoy te voy a enseñar tres trucos"), takeTokens("Hoy te voy a enseñar tres trucos."))).toBe(1);
    expect(isFalseStart(takeTokens("hoy te voy a"), takeTokens("hoy te voy a enseñar tres trucos para editar"))).toBe(true);
    expect(isFalseStart(takeTokens("segundo usa subtítulos"), takeTokens("hoy te voy a enseñar tres trucos"))).toBe(false);
  });

  it("se queda con la última toma completa y sin tropiezos; no junta frases distintas", () => {
    const p = (id: string, start: number, text: string, extra: Partial<TakePhrase> = {}): TakePhrase => ({ id, assetId: "a", start, end: start + 2, text, ...extra });
    const phrases = [
      p("1", 0, "Hoy te voy a"),
      p("2", 3, "Hoy te voy a enseñar tres trucos para editar."),
      p("3", 7, "Hoy te voy a a enseñar tres trucos para editar.", { words: [{ text: "a", start: 7, end: 7.1 }, { text: "a", start: 7.2, end: 7.3 }] }),
      p("4", 11, "Hoy te voy a enseñar tres trucos para editar."),
      p("5", 15, "Primero, quita los silencios largos."),
      p("6", 19, "Segundo, usa subtítulos con palabras clave."),
    ];
    const res = detectRepeatedTakes(phrases);
    expect(res.groups).toHaveLength(1);
    const g = res.groups[0]!;
    expect(g.keepId).toBe("4");
    expect(g.discardIds.sort()).toEqual(["1", "2", "3"]);
    expect(g.falseStartIds).toContain("1");
    expect(g.reason).toMatch(/última completa/);
    expect(res.discarded.has("5") || res.discarded.has("6")).toBe(false);
  });

  it("es eficiente con material largo (1 h ≈ 900 frases)", () => {
    const phrases: TakePhrase[] = [];
    for (let i = 0; i < 900; i++) phrases.push({ id: `p${i}`, assetId: "a", start: i * 4, end: i * 4 + 3, text: `frase número ${i} sobre el tema ${i % 37} con palabras distintas ${i * 7}` });
    const t0 = performance.now();
    detectRepeatedTakes(phrases);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe("orden automático de clips", () => {
  const clip = (id: string, text: string, over: Partial<OrderClip> = {}): OrderClip => ({ assetId: id, name: `${id}.mp4`, createdAt: NOW, order: 0, recordedAt: null, text, ...over });
  const parts = {
    p1: AROLL_WORDS.filter(([, s]) => s < 13).map((w) => w[0]).join(" "),
    p2: AROLL_WORDS.filter(([, s]) => s >= 13 && s < 17.9).map((w) => w[0]).join(" "),
    p3: AROLL_WORDS.filter(([, s]) => s >= 17.9).map((w) => w[0]).join(" "),
  };
  // Subidos al revés: p3 primero.
  const reversed = () => [
    clip("c", parts.p3, { createdAt: "2026-10-08T10:00:00.000Z", order: 0 }),
    clip("b", parts.p2, { createdAt: "2026-10-08T10:00:01.000Z", order: 1 }),
    clip("a", parts.p1, { createdAt: "2026-10-08T10:00:02.000Z", order: 2 }),
  ];

  it("según el guion", () => {
    const script = "Hola, soy Ana de Zyra. Hoy te voy a enseñar tres trucos para editar videos más rápido. Primero, eh, quita los silencios largos. Segundo, usa subtítulos con palabras clave resaltadas. Y tercero, guarda tu estilo para reutilizarlo en cada video. Síguenos para más consejos.";
    const s = suggestClipOrder(reversed(), { script });
    expect(s.assetIds).toEqual(["a", "b", "c"]);
    expect(s.source).toBe("guion");
    expect(s.reason).toBe("según el guion");
  });

  it("sin guion: por el sentido de lo que se dice", () => {
    expect(contentPosition("Hola, soy Ana")!.pos).toBe(0);
    const s = suggestClipOrder(reversed());
    expect(s.assetIds).toEqual(["a", "b", "c"]);
    expect(s.source).toBe("contenido");
  });

  it("por hora de grabación y por número en el nombre; respeta el orden manual", () => {
    const silent = [clip("x", "", { recordedAt: "2026-10-01T10:05:00Z", name: "IMG_0009.MOV" }), clip("y", "", { recordedAt: "2026-10-01T10:01:00Z", name: "IMG_0010.MOV", createdAt: "2026-10-08T10:00:01.000Z" })];
    expect(suggestClipOrder(silent)).toMatchObject({ assetIds: ["y", "x"], source: "hora-grabacion", reason: "por hora de grabación" });
    const named = silent.map((c) => ({ ...c, recordedAt: null }));
    expect(fileNumber("toma 3 final.mp4")).toBe(3);
    expect(suggestClipOrder(named)).toMatchObject({ assetIds: ["x", "y"], source: "nombre" });
    const manual = [clip("m1", parts.p1, { order: 1 }), clip("m2", parts.p3, { order: 0, createdAt: "2026-10-08T10:00:05.000Z" })];
    expect(suggestClipOrder(manual)).toMatchObject({ assetIds: ["m2", "m1"], source: "manual", manual: true });
  });
});

describe("mapa del material", () => {
  it("clasifica por fragmentos un clip base que mezcla a-roll + b-roll + a-roll", () => {
    // a-roll (0–24.27) + b-roll mudo (24.27–32.27) + a-roll (32.27–56.54).
    const words = [...AROLL_WORDS, ...shift(AROLL_WORDS, AROLL_DUR + 8)];
    const mixed = asset("mix", { duration: AROLL_DUR * 2 + 8, analysis: { role: "mixto", brollSegments: [{ start: 24.6, end: 32.0, score: 0.8, description: "paisaje", tags: [] }] } });
    const map = buildMaterialMap({ assets: [mixed, asset("musica", { category: "musica", kind: "audio" })], transcripts: [transcript("mix", words)] });
    expect(map.base).toBe("clip-base");
    const broll = map.fragments.filter((f) => f.kind === "b-roll");
    expect(broll).toHaveLength(1);
    expect(broll[0]!.start).toBeGreaterThanOrEqual(24.27);
    expect(broll[0]!.end).toBeLessThanOrEqual(32.27 + 0.6);
    // Ninguna frase hablada cae dentro del b-roll y lo hablado queda (la mejor toma de cada frase).
    const speech = map.fragments.filter((f) => f.kind === "habla");
    expect(speech.every((f) => f.end <= 24.6 || f.start >= 32.0)).toBe(true);
    expect(speech.map((f) => f.text).join(" ")).toMatch(/Síguenos para más consejos/);
    expect(map.summary.repeatedTakes).toBeGreaterThan(0);
    expect(map.summary.text).toMatch(/^1 clip · \d+ tomas? repetidas? · 1 toma de apoyo detectada/);
    expect(map.support.map((s) => s.kind)).toEqual(["musica"]);
    expect(describeMaterialMap(map)).toMatch(/Tomas de apoyo DENTRO/);
  });

  it("grabación larga con la misma frase varias veces: queda una toma por frase (la última)", () => {
    const words = [...AROLL_WORDS, ...shift(AROLL_WORDS, AROLL_DUR), ...shift(AROLL_WORDS, AROLL_DUR * 2)];
    const long = asset("largo", { duration: AROLL_DUR * 3 });
    const map = buildMaterialMap({ assets: [long], transcripts: [transcript("largo", words)] });
    const kept = map.fragments.filter((f) => f.kind === "habla");
    const texts = kept.map((f) => f.text);
    expect(new Set(texts).size).toBe(texts.length);
    expect(kept.every((f) => f.start >= AROLL_DUR * 2 - 0.01)).toBe(true);
    expect(map.summary.repeatedTakes).toBe(kept.length * 2);
  });

  it("subtractRanges", () => {
    expect(subtractRanges([0, 10], [[2, 3], [5, 6]])).toEqual([[0, 2], [3, 5], [6, 10]]);
  });
});

describe("editor demo con el mapa del material", () => {
  it("3 clips base subidos al revés: la columna sale en orden y con la voz", () => {
    const deps = testDeps();
    const assets = [
      asset("c", { duration: AROLL_DUR - 17.9, createdAt: "2026-10-08T10:00:00.000Z", order: 0, originalName: "toma-c.mp4" }),
      asset("b", { duration: 17.9 - 13, createdAt: "2026-10-08T10:00:01.000Z", order: 1, originalName: "toma-b.mp4" }),
      asset("a", { duration: 13, createdAt: "2026-10-08T10:00:02.000Z", order: 2, originalName: "toma-a.mp4" }),
    ];
    const transcripts = [transcript("c", slice(17.9, 99)), transcript("b", slice(13, 17.9)), transcript("a", slice(0, 13))];
    const settings = makeSettings({ tools: { broll: { enabled: false }, music: { enabled: false } } as never });
    const base = makeEditInput({ assets, transcripts } as never, settings);
    const input = { ...base, assets, transcripts, toolbox: makeToolbox(transcripts) };
    const out = buildDemoPlan(input, { kie: deps.providers.kie });
    const firstSeen: string[] = [];
    for (const c of out.recipe.tracks.video) if (!firstSeen.includes(c.assetId)) firstSeen.push(c.assetId);
    expect(firstSeen).toEqual(["a", "b", "c"]);
    expect(out.summary).toMatch(/3 clips base por el sentido de lo que se dice/);
  });

  it("clip mixto: el b-roll mudo del propio clip nunca entra en la columna y sí se usa de apoyo", () => {
    const deps = testDeps();
    const words = [...AROLL_WORDS, ...shift(AROLL_WORDS, AROLL_DUR + 8)];
    const mixed = asset("mix", { duration: AROLL_DUR * 2 + 8, analysis: { role: "mixto", brollSegments: [{ start: 24.6, end: 32.0, score: 0.9, description: "paisaje", tags: [] }] } });
    const transcripts = [transcript("mix", words)];
    const settings = makeSettings({ tools: { broll: { enabled: true, source: "material", frequency: "alta", layout: "auto" }, music: { enabled: false } } as never });
    const base = makeEditInput({ assets: [mixed], transcripts } as never, settings);
    const out = buildDemoPlan({ ...base, assets: [mixed], transcripts, toolbox: makeToolbox(transcripts) }, { kie: deps.providers.kie });
    for (const c of out.recipe.tracks.video) expect(c.sourceOut <= 24.7 || c.sourceIn >= 31.9).toBe(true);
    expect(out.recipe.tracks.overlays.some((o) => o.assetId === "mix" && o.sourceIn >= 24.5 && o.sourceIn < 32)).toBe(true);
    // Cada frase aparece una sola vez (se descartó la toma repetida).
    const said = out.recipe.tracks.captions.words.map((w) => w.text).join(" ");
    expect(said.match(/Síguenos/g)?.length ?? 0).toBe(1);
  });
});
