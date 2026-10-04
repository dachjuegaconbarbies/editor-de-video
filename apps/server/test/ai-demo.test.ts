/**
 * Editor DEMO (sin IA, sin red ni llaves) con el material real de data/muestras:
 * plan (silencios, muletillas, duración exacta, b-roll), correcciones con la regla de oro,
 * palabras clave, revisión de calidad y ficha de estilo.
 */
import jsonpatch, { type Operation } from "fast-json-patch";
import { changesOutsideAreas, clipDuration, diffRecipes, durationMeetsTarget, parseRecipe, type Recipe } from "@autoeditor/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createDemoEditor } from "../src/ai/index.js";
import type { CorrectionInput, EditorBrain } from "../src/services/types.js";
import { loadSampleMaterial, makeEditInput, makeSettings, samplesAvailable, type SampleMaterial } from "./ai-fixtures.js";
import { testDeps } from "./ai-deps.js";

const haveSamples = samplesAvailable();
const d = haveSamples ? describe : describe.skip;

let material: SampleMaterial;
let editor: EditorBrain;

beforeAll(async () => {
  if (!haveSamples) return;
  material = await loadSampleMaterial();
  editor = createDemoEditor(testDeps());
}, 60_000);

/** ¿Algún plano de la receta incluye el instante t (segundos del original) del a-roll? */
const covers = (recipe: Recipe, t: number, assetId = "a-roll") => recipe.tracks.video.some((c) => c.assetId === assetId && c.stillDuration == null && t > c.sourceIn && t < c.sourceOut);

function applyPatch(recipe: Recipe, patch: { op: string; path: string; value?: unknown; from?: string }[]): Recipe {
  const doc = jsonpatch.applyPatch(structuredClone(recipe), patch as Operation[], true, false).newDocument;
  return parseRecipe(doc);
}

async function planFor(over: Parameters<typeof makeSettings>[0] = {}, withKeywords = true) {
  const settings = makeSettings(over);
  // Como en el servidor: primero se detectan las palabras clave del proyecto y luego se planea.
  const keywords = withKeywords ? (await editor.detectKeywords({ transcripts: material.transcripts, settings, existing: [], glossary: [] })).keywords : [];
  const input = makeEditInput(material, settings, { keywords });
  const res = await editor.plan(input);
  return { input, res };
}

d("editor demo: plan", () => {
  it("arma una receta válida que quita la pausa de 2.2 s y la muletilla «eh» sin cortar palabras", async () => {
    const { res, input } = await planFor();
    const recipe = res.recipe;
    expect(input.toolbox.validateRecipe(recipe).ok).toBe(true);
    expect(recipe.meta.generator).toBe("demo");
    expect(recipe.tracks.video.length).toBeGreaterThan(3);
    // Pausa larga entre «largos.» (11.87) y «Segundo» (14.07).
    for (const t of [12.2, 13.0, 13.8]) expect(covers(recipe, t)).toBe(false);
    // «eh» en 9.54–9.75.
    expect(covers(recipe, 9.645)).toBe(false);
    expect(recipe.tracks.captions.words.some((w) => /^eh\b/i.test(w.text))).toBe(false);
    // Ningún corte cae dentro de una palabra.
    for (const w of material.words) {
      for (const c of recipe.tracks.video.filter((x) => x.assetId === "a-roll")) {
        expect(c.sourceIn > w.start + 0.03 && c.sourceIn < w.end - 0.03, `entrada ${c.sourceIn} dentro de «${w.text}»`).toBe(false);
        expect(c.sourceOut > w.start + 0.03 && c.sourceOut < w.end - 0.03, `salida ${c.sourceOut} dentro de «${w.text}»`).toBe(false);
      }
    }
    // Se conservan las palabras importantes.
    const text = recipe.tracks.captions.words.map((w) => w.text).join(" ");
    expect(text).toMatch(/Zyra/);
    expect(text).toMatch(/subtítulos/);
    expect(durationMeetsTarget(recipe).ok).toBe(true);
    expect(recipe.duration).toBeLessThan(material.words[material.words.length - 1]!.end);
    expect(res.scenes.length).toBeGreaterThan(0);
    expect(res.summary).toMatch(/muletilla/);
  });

  it("respeta la duración exacta de 15 s (±0.5) eligiendo las frases de más valor", async () => {
    const { res } = await planFor({ instruction: { targetDuration: 15, durationMode: "exacta" } });
    const recipe = res.recipe;
    expect(Math.abs(recipe.duration - 15)).toBeLessThanOrEqual(0.5);
    expect(durationMeetsTarget(recipe).ok).toBe(true);
    expect(recipe.target).toEqual({ duration: 15, mode: "exacta" });
    // El gancho (primera frase) se queda.
    expect(covers(recipe, 2.4)).toBe(true);
    expect(covers(recipe, 9.645)).toBe(false);
  });

  it("modo aproximado: ±15 %", async () => {
    const { res } = await planFor({ instruction: { targetDuration: 12, durationMode: "aproximada" } });
    expect(Math.abs(res.recipe.duration - 12)).toBeLessThanOrEqual(12 * 0.15);
    expect(durationMeetsTarget(res.recipe).ok).toBe(true);
  });

  it("inserta b-roll cuando la herramienta está prendida y no cuando está apagada", async () => {
    const on = (await planFor({ tools: { broll: { enabled: true, source: "material", frequency: "alta", layout: "auto" } } })).res.recipe;
    const brollOn = on.tracks.overlays.filter((o) => o.kind === "broll" || o.kind === "imagen");
    expect(brollOn.length).toBeGreaterThan(0);
    expect(brollOn.every((o) => ["b-roll-1", "b-roll-2", "foto"].includes(o.assetId))).toBe(true);
    expect(brollOn.every((o) => o.start >= 2.5 && o.end <= on.duration)).toBe(true);
    const off = (await planFor({ tools: { broll: { enabled: false, source: "material", frequency: "media", layout: "auto" } } })).res.recipe;
    expect(off.tracks.overlays.filter((o) => o.kind === "broll").length).toBe(0);
    const fondo = (await planFor({ tools: { broll: { enabled: true, source: "material", frequency: "media", layout: "fondo" } } })).res.recipe;
    expect(fondo.tracks.overlays.filter((o) => o.kind === "broll").every((o) => o.layout === "fondo-con-orador")).toBe(true);
  });

  it("vertical: reencuadra el horizontal con fondo desenfocado (sin rostros), música con ducking, título-gancho y subtítulos", async () => {
    const { res } = await planFor({ tools: { cta: { enabled: true, text: "" }, sfx: { enabled: true, source: "biblioteca", density: "media" } } });
    const r = res.recipe;
    expect(r.format).toMatchObject({ aspect: "9:16", width: 1080, height: 1920 });
    expect(r.tracks.video.filter((c) => c.assetId === "a-roll").every((c) => c.reframe.mode === "fondo-desenfocado")).toBe(true);
    expect(r.tracks.audio.music).toHaveLength(1);
    expect(r.tracks.audio.music[0]!.duck).toBe(true);
    expect(r.tracks.text.find((t) => t.kind === "titulo")?.text).toMatch(/3 trucos/i);
    expect(r.tracks.text.some((t) => t.kind === "cta") || r.tracks.graphics.some((g) => g.templateId === "cta-final")).toBe(true);
    expect(r.tracks.audio.sfx.length).toBeGreaterThan(0);
    expect(r.tracks.captions.words.length).toBeGreaterThan(20);
    expect(r.tracks.captions.words.some((w) => w.highlight)).toBe(true);
  });

  it("motion graphics automáticos y pedidos de IA respetando los máximos", async () => {
    const { res } = await planFor({
      tools: {
        motionGraphics: { enabled: true, mode: "automatico", engine: "hyperframes", items: [] },
        cta: { enabled: true, text: "Síguenos" },
        aiImages: { enabled: true, max: 2, style: "fotográfico", usage: ["broll"], model: "" },
        aiVideos: { enabled: true, max: 1, duration: 5, model: "" },
      },
    });
    const r = res.recipe;
    expect(r.tracks.graphics.map((g) => g.templateId)).toEqual(expect.arrayContaining(["cta-final"]));
    expect(r.ai.filter((a) => a.kind === "imagen").length).toBeLessThanOrEqual(2);
    expect(r.ai.filter((a) => a.kind === "video").length).toBeLessThanOrEqual(1);
    for (const a of r.ai) {
      expect(a.model).toBeTruthy();
      expect(a.costUsd).toBeGreaterThan(0);
      expect(a.prompt.length).toBeGreaterThan(20);
    }
  });

  it("sin material da un error claro en español", async () => {
    const input = makeEditInput({ ...material, assets: material.assets.filter((a) => a.kind === "audio") }, makeSettings());
    await expect(editor.plan(input)).rejects.toMatchObject({ code: "sin-material" });
  });
});

d("editor demo: correcciones (regla de oro)", () => {
  let current: Recipe;
  let base: Omit<CorrectionInput, "correction" | "current" | "at" | "history">;

  beforeAll(async () => {
    const { res, input } = await planFor({ tools: { cta: { enabled: true, text: "" } } });
    current = res.recipe;
    base = input;
  });

  async function correct(correction: string, at: number | null = null) {
    const res = await editor.correct({ ...base, current, correction, at, history: [] });
    const after = res.patch.length ? applyPatch(current, res.patch) : current;
    const changes = diffRecipes(current, after);
    return { res, after, changes, outside: changesOutsideAreas(changes, res.areas) };
  }

  it("«cambia la tipografía por una más bonita» solo toca estilo/subtítulos", async () => {
    const { res, after, changes, outside } = await correct("cambia la tipografía por una más bonita");
    expect(res.clarifyingQuestion).toBeNull();
    expect(res.patch.length).toBeGreaterThan(0);
    expect(res.areas.every((a) => a === "estilo" || a === "subtitulos")).toBe(true);
    expect(outside).toEqual([]);
    expect(changes.filter((c) => !c.derived).every((c) => c.area === "estilo" || c.area === "subtitulos")).toBe(true);
    expect(after.style.titleFont.family).not.toBe(current.style.titleFont.family);
    expect(after.tracks.video).toEqual(current.tracks.video);
    expect(after.tracks.audio).toEqual(current.tracks.audio);
    expect(after.tracks.captions.words).toEqual(current.tracks.captions.words);
    expect(res.summary).toMatch(/tipograf/i);
  });

  it("«ponla en Poppins» usa la nombrada y sugiere una regla verificable", async () => {
    const { res, after, outside } = await correct("ponle la tipografía Poppins a los títulos");
    expect(after.style.titleFont.family).toBe("Poppins");
    expect(outside).toEqual([]);
    expect(res.ruleSuggestion?.check).toEqual({ type: "fuente-titulos", family: "Poppins" });
  });

  it("«quita la música» solo toca audio", async () => {
    const { res, after, outside } = await correct("quita la música");
    expect(res.areas).toEqual(["audio"]);
    expect(outside).toEqual([]);
    expect(after.tracks.audio.music).toEqual([]);
    expect(after.tracks.video).toEqual(current.tracks.video);
    expect(after.style).toEqual(current.style);
  });

  it("«baja la música» baja el volumen y sugiere la regla", async () => {
    const { res, after, outside } = await correct("baja la música, tapa la voz");
    expect(outside).toEqual([]);
    expect(after.tracks.audio.music[0]!.gainDb).toBeLessThan(current.tracks.audio.music[0]!.gainDb);
    expect(res.ruleSuggestion?.check?.type).toBe("musica-volumen-max");
  });

  it("subtítulos más grandes / en minúsculas / amarillos solo tocan subtítulos", async () => {
    for (const text of ["subtítulos más grandes", "pon los subtítulos en minúsculas", "subtítulos en amarillo", "resalta las palabras clave en rojo"]) {
      const { res, outside } = await correct(text);
      expect(res.clarifyingQuestion, text).toBeNull();
      expect(res.areas, text).toEqual(["subtitulos"]);
      expect(outside, text).toEqual([]);
    }
  });

  it("«más rápido» parte planos entre palabras sin cambiar la duración", async () => {
    const { res, after, outside } = await correct("hazlo más rápido, se siente lento");
    expect(outside).toEqual([]);
    expect(res.areas).toEqual(expect.arrayContaining(["estilo"]));
    expect(after.style.targetShotLength).toBeLessThan(current.style.targetShotLength);
    expect(after.tracks.video.length).toBeGreaterThanOrEqual(current.tracks.video.length);
    expect(Math.abs(after.duration - current.duration)).toBeLessThan(0.01);
  });

  it("«que dure 15 segundos» reajusta los cortes y clava la duración", async () => {
    const { res, after, outside } = await correct("que dure 15 segundos");
    expect(outside).toEqual([]);
    expect(res.areas).toEqual(expect.arrayContaining(["cortes"]));
    expect(Math.abs(after.duration - 15)).toBeLessThanOrEqual(0.5);
    expect(after.target).toEqual({ duration: 15, mode: "exacta" });
    expect(after.style).toEqual(current.style);
    // El CTA sigue al final.
    const cta = after.tracks.text.find((t) => t.kind === "cta");
    if (cta) expect(cta.end).toBeCloseTo(after.duration, 2);
  });

  it("«en 0:XX quita este corte» une los planos de ese momento", async () => {
    const boundary = current.tracks.video.find((c, k) => k > 0 && c.start > 3)!;
    const { res, after, outside } = await correct(`en 0:${String(Math.round(boundary.start)).padStart(2, "0")} quita este corte`);
    expect(res.clarifyingQuestion).toBeNull();
    expect(outside).toEqual([]);
    expect(after.tracks.video.length).toBe(current.tracks.video.length - 1);
  });

  it("anclada con «at»: quita el fragmento de ese momento", async () => {
    const clip = current.tracks.video[2]!;
    const { after, outside } = await correct("quita esta parte", clip.start + clipDuration(clip) / 2);
    expect(outside).toEqual([]);
    expect(after.tracks.video.some((c) => c.id === clip.id)).toBe(false);
    expect(after.duration).toBeLessThan(current.duration);
  });

  it("sin b-roll / sin zoom / solo cortes / título nuevo", async () => {
    const a = await correct("quita el b-roll");
    expect(a.outside).toEqual([]);
    expect(a.after.tracks.overlays.filter((o) => o.kind === "broll")).toEqual([]);
    const b = await correct("sin zoom");
    expect(b.outside).toEqual([]);
    expect(b.after.tracks.video.every((c) => c.zoom === null)).toBe(true);
    const c = await correct("cambia el título por \"Edita en 3 pasos\"");
    expect(c.outside).toEqual([]);
    expect(c.res.areas).toEqual(["texto"]);
    expect(c.after.tracks.text.find((t) => t.kind === "titulo")?.text).toBe("Edita en 3 pasos");
  });

  it("si no entiende, pregunta amablemente y no cambia nada", async () => {
    const { res } = await correct("hmm no sé, algo no me convence");
    expect(res.patch).toEqual([]);
    expect(res.clarifyingQuestion).toMatch(/modo demo/);
    expect(res.clarifyingQuestion).toMatch(/ANTHROPIC_API_KEY/);
  });
});

d("editor demo: palabras clave, revisión y ficha de estilo", () => {
  it("detecta «Zyra» y «subtítulos» con apariciones reales y arma el texto para publicar", async () => {
    const { keywords, publishCopy, usage } = await editor.detectKeywords({ transcripts: material.transcripts, settings: makeSettings(), existing: [], glossary: [] });
    const zyra = keywords.find((k) => /zyra/i.test(k.text));
    const subs = keywords.find((k) => /subt[ií]tulos/i.test(k.text));
    expect(zyra).toBeDefined();
    expect(subs).toBeDefined();
    const words = material.transcripts[0]!.words;
    for (const k of [zyra!, subs!]) {
      expect(k.occurrences.length).toBeGreaterThan(0);
      for (const o of k.occurrences) {
        expect(o.assetId).toBe("a-roll");
        expect(words[o.wordIndex]!.text.toLowerCase()).toContain(k.text.split(" ")[0]!.toLowerCase().slice(0, 4));
        expect(o.t).toBeCloseTo(words[o.wordIndex]!.start, 3);
      }
    }
    expect(publishCopy.title.length).toBeGreaterThan(5);
    expect(publishCopy.hashtags.length).toBeGreaterThan(0);
    expect(publishCopy.hashtags.every((h) => h.startsWith("#"))).toBe(true);
    expect(usage.costUsd).toBe(0);
  });

  it("revisión determinista: duración objetivo, zona segura, tipografías y reglas con check", async () => {
    const { res, input } = await planFor({ instruction: { targetDuration: 15, durationMode: "exacta" } });
    const rules = [
      { id: "r1", ownerId: "local", scope: "global" as const, scopeId: null, text: "Títulos en Montserrat", check: { type: "fuente-titulos" as const, family: "Montserrat" }, source: { type: "manual" as const, refId: null, excerpt: "" }, enabled: true, timesApplied: 0, strength: 1, createdAt: "", updatedAt: "" },
    ];
    const qa = await editor.review({ recipe: res.recipe, rules, settings: input.settings, frames: [] });
    const byName = Object.fromEntries(qa.checks.map((c) => [c.check, c]));
    expect(byName["Duración objetivo"]?.ok).toBe(true);
    expect(byName["Subtítulos dentro de la zona segura"]?.ok).toBe(true);
    expect(byName["Tipografías disponibles"]?.ok).toBe(true);
    expect(byName["Regla: Títulos en Montserrat"]?.ok).toBe(false);
    expect(qa.fixPatch).not.toBeNull();
    const fixed = applyPatch(res.recipe, qa.fixPatch!);
    expect(fixed.style.titleFont.family).toBe("Montserrat");
  });

  it("ficha de estilo en markdown desde la receta y las correcciones", async () => {
    const { res, input } = await planFor();
    const out = await editor.styleRules({ recipe: res.recipe, settings: input.settings, corrections: [{ correction: "pon los títulos en Poppins", summary: "Cambié la tipografía a Poppins." }], rules: [], name: "Zyra tips" });
    expect(out.rulesMarkdown).toMatch(/^# Estilo: Zyra tips/);
    expect(out.rulesMarkdown).toMatch(/Poppins/);
    expect(out.rules.some((r) => /corte cada/.test(r))).toBe(true);
    const ref = await editor.analyzeReference({ imageBase64: "", mediaType: "image/jpeg", likes: "los colores" });
    expect(ref.analysis).toMatch(/ANTHROPIC_API_KEY/);
  });
});
