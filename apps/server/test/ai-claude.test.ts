/**
 * Editor con Claude SIN llamar a la API: construcción de prompts y herramientas (prefijo estable para la
 * caché), herramientas del plan y de la corrección contra el material real de data/muestras, y el bucle
 * agéntico completo con un cliente del SDK cuyo fetch está simulado (respuestas JSON, sin streaming).
 */
import Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import jsonpatch, { type Operation } from "fast-json-patch";
import { changesOutsideAreas, diffRecipes, parseRecipe, type Recipe } from "@autoeditor/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createClaudeEditor, createDemoEditor } from "../src/ai/index.js";
import { createClaudeBrain } from "../src/ai/claude/editor.js";
import { SYSTEM_CORRECT, SYSTEM_PLAN } from "../src/ai/prompts/editor.js";
import { correctionMessage, planUserMessage } from "../src/ai/prompts/context.js";
import { correctDone, correctTools, newCorrectSession } from "../src/ai/tools/correct.js";
import { newPlanSession, planTools } from "../src/ai/tools/plan.js";
import { toPatchOps } from "../src/ai/tools/common.js";
import { UserFacingError, type CorrectionInput, type EditInput } from "../src/services/types.js";
import { loadSampleMaterial, makeEditInput, makeSettings, samplesAvailable, type SampleMaterial } from "./ai-fixtures.js";
import { testDeps } from "./ai-deps.js";

const haveSamples = samplesAvailable();
const d = haveSamples ? describe : describe.skip;

let material: SampleMaterial;
let planInput: EditInput;
let current: Recipe;

beforeAll(async () => {
  if (!haveSamples) return;
  material = await loadSampleMaterial();
  const settings = makeSettings({ instruction: { text: "Video corto y dinámico sobre Zyra", targetDuration: 15, durationMode: "exacta" } });
  planInput = makeEditInput(material, settings);
  current = (await createDemoEditor(testDeps()).plan(planInput)).recipe;
}, 60_000);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = BetaRunnableTool<any>;
const byName = (tools: AnyTool[], name: string) => tools.find((t) => t.name === name)!;
const run = (tools: AnyTool[], name: string, args: unknown) => byName(tools, name).run(byName(tools, name).parse(args));
const definitions = (tools: AnyTool[]) => JSON.stringify(tools.map(({ run: _r, parse: _p, ...def }) => def));

function applyPatch(recipe: Recipe, patch: { op: string; path: string; value?: unknown; from?: string }[]): Recipe {
  return parseRecipe(jsonpatch.applyPatch(structuredClone(recipe), patch as Operation[], true, false).newDocument);
}

const correctionInput = (correction: string, at: number | null = null): CorrectionInput => ({ ...planInput, current, correction, at, history: [] });

// ---------------------------------------------------------------------------
// Cliente simulado del SDK
// ---------------------------------------------------------------------------

interface FakeTurn {
  content: unknown[];
  stop_reason?: string;
  stop_details?: unknown;
  status?: number;
}

function fakeClaude(turns: FakeTurn[]) {
  const bodies: Record<string, unknown>[] = [];
  const headers: Headers[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    headers.push(new Headers(init?.headers));
    const turn = turns.shift();
    if (!turn) throw new Error("La prueba no esperaba más peticiones a Claude");
    if (turn.status && turn.status !== 200) {
      return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "límite" } }), { status: turn.status, headers: { "content-type": "application/json" } });
    }
    const message = {
      id: `msg_${bodies.length}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: turn.content,
      stop_reason: turn.stop_reason ?? (turn.content.some((c) => (c as { type: string }).type === "tool_use") ? "tool_use" : "end_turn"),
      stop_sequence: null,
      stop_details: turn.stop_details ?? null,
      container: null,
      usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
    };
    return new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json", "request-id": "req_prueba" } });
  }) as typeof fetch;
  const client = new Anthropic({ apiKey: "sk-prueba", fetch: fetchImpl, maxRetries: 0 });
  return { client, bodies, headers };
}

const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
/** Respuesta en streaming (SSE) como la manda la API, para probar el camino por defecto (stream: true). */
function sseMessage(content: ({ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown })[], stopReason: string): string {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  let out = ev("message_start", {
    type: "message_start",
    message: { id: "msg_s", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
  content.forEach((block, index) => {
    if (block.type === "text") {
      out += ev("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      out += ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else {
      out += ev("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      out += ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    out += ev("content_block_stop", { type: "content_block_stop", index });
  });
  out += ev("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 40 } });
  return out + ev("message_stop", { type: "message_stop" });
}

function fakeStreamingClaude(turns: string[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const sse = turns.shift();
    if (!sse) throw new Error("La prueba no esperaba más peticiones a Claude");
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { client: new Anthropic({ apiKey: "sk-prueba", fetch: fetchImpl, maxRetries: 0 }), bodies };
}

const deps = () => testDeps({ anthropicApiKey: "sk-prueba", demoMode: false });

// ---------------------------------------------------------------------------

d("Claude: prompts y herramientas (prefijo estable)", () => {
  it("el sistema no lleva fechas ni ids y el mensaje del usuario no lleva rutas de archivos", () => {
    for (const s of [SYSTEM_PLAN, SYSTEM_CORRECT]) {
      expect(s).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(s).toContain("tracks");
    }
    const msg = planUserMessage(planInput);
    expect(msg).toContain("id=a-roll");
    expect(msg).toContain("rol=b-roll");
    expect(msg).toContain("15 s, modo \"exacta\"");
    expect(msg).not.toContain("proyectos/");
    expect(msg).not.toContain("/home/");
  });

  it("herramientas strict, en orden fijo e idénticas entre proyectos (la caché funciona)", () => {
    const a = planTools(planInput, newPlanSession(40), { kie: testDeps().providers.kie, model: "claude-opus-5-5" });
    const other = makeEditInput(material, makeSettings({ instruction: { text: "otro", targetDuration: 30, durationMode: "aproximada" } }));
    const b = planTools(other, newPlanSession(10), { kie: testDeps().providers.kie, model: "claude-opus-5-5" });
    expect(a.map((t) => t.name)).toEqual([
      "ver_material", "leer_transcripcion", "ver_fotogramas", "borrador_automatico", "proponer_receta",
      "ver_fotogramas_propuesta", "listar_plantillas", "guia_hyperframes", "escribir_plantilla", "pedir_generacion_ia", "terminar",
    ]);
    expect(definitions(a)).toBe(definitions(b));
    for (const t of a) {
      const def = t as AnyTool & { strict?: boolean; input_schema: Record<string, unknown> };
      expect(def.strict).toBe(true);
      expect(def.input_schema.additionalProperties).toBe(false);
      expect(def.input_schema.$schema).toBeUndefined();
    }
    const c = correctTools(correctionInput("x"), newCorrectSession(10), { kie: testDeps().providers.kie });
    expect(c.map((t) => t.name).at(-1)).toBe("enviar_parche");
  });

  it("el mensaje de corrección anclada ubica el clip, el archivo y la palabra que se oye", () => {
    const msg = correctionMessage(correctionInput("quita este corte", 3));
    expect(msg).toMatch(/segundo 3 \(0:03\) del video final/);
    expect(msg).toMatch(/del archivo a-roll/);
    expect(msg).toMatch(/Se oye/);
  });
});

d("Claude: herramientas del plan", () => {
  const kie = () => testDeps().providers.kie;

  it("borrador → proponer_receta valida, materializa subtítulos y devuelve métricas; terminar entrega", async () => {
    const session = newPlanSession(40);
    const tools = planTools(planInput, session, { kie: kie(), model: "claude-opus-5-5" });
    expect(String(await run(tools, "terminar", { resumen: "x", escenas: [] }))).toMatch(/No hay ninguna propuesta/);
    expect(String(await run(tools, "borrador_automatico", {}))).toMatch(/Receta:/);

    expect(String(await run(tools, "proponer_receta", { receta_json: "{ no es json", notas: "" }))).toMatch(/no es JSON válido/);
    const bad = structuredClone(current) as Recipe;
    bad.tracks.video[0]!.assetId = "no-existe";
    expect(String(await run(tools, "proponer_receta", { receta_json: JSON.stringify(bad), notas: "" }))).toMatch(/no-existe no existe/);
    expect(session.recipe).toBeNull();

    const report = String(await run(tools, "proponer_receta", { receta_json: JSON.stringify(current), notas: "Gancho con Zyra" }));
    expect(report).toMatch(/válida y guardada/);
    expect(report).toMatch(/Cumple el objetivo/);
    expect(session.recipe?.meta.generator).toBe("claude");
    expect(session.recipe?.notes).toBe("Gancho con Zyra");
    expect(session.recipe?.tracks.captions.words.length).toBeGreaterThan(10);

    const frames = await run(tools, "ver_fotogramas_propuesta", { tiempos: [0, 2, 99] });
    expect(Array.isArray(frames) && frames.filter((b) => b.type === "image")).toHaveLength(3);

    expect(String(await run(tools, "terminar", { resumen: "Listo", escenas: [{ titulo: "Gancho", inicio: 0, fin: 3, notas: "" }] }))).toMatch(/entregada/);
    expect(session.done?.outline[0]?.title).toBe("Gancho");
  });

  it("leer_transcripcion muestra índices, pausas y la muletilla; ver_fotogramas devuelve imágenes", async () => {
    const tools = planTools(planInput, newPlanSession(40), { kie: kie(), model: "m" });
    const text = String(await run(tools, "leer_transcripcion", { asset_id: "a-roll", desde: 0, hasta: 30 }));
    expect(text).toMatch(/\[0\] /);
    expect(text).toMatch(/pausa 2\.\d+ s/);
    expect(text.toLowerCase()).toContain(" eh");
    const frames = await run(tools, "ver_fotogramas", { asset_id: "b-roll-1", tiempos: [1, 2] });
    expect(Array.isArray(frames) && frames.some((b) => b.type === "image")).toBe(true);
    expect(planInput.toolbox).toHaveProperty("calls");
  });

  it("pedir_generacion_ia respeta herramientas y máximos, y el pedido entra en la siguiente propuesta", async () => {
    const off = planTools(planInput, newPlanSession(40), { kie: kie(), model: "m" });
    expect(String(await run(off, "pedir_generacion_ia", { tipo: "imagen", prompt: "oficina", prompt_negativo: null, modelo: null, uso: "broll", desde: 1, hasta: 3, duracion: null }))).toMatch(/apagada/);

    const input = makeEditInput(material, makeSettings({ tools: { aiImages: { enabled: true, max: 1 } } }));
    const session = newPlanSession(40);
    const tools = planTools(input, session, { kie: kie(), model: "m" });
    const args = { tipo: "imagen", prompt: "oficina luminosa", prompt_negativo: null, modelo: null, uso: "broll", desde: 1, hasta: 3, duracion: null };
    expect(String(await run(tools, "pedir_generacion_ia", args))).toMatch(/Pedido creado/);
    expect(String(await run(tools, "pedir_generacion_ia", args))).toMatch(/máximo/);
    const plain = { ...structuredClone(current), ai: [] };
    expect(String(await run(tools, "proponer_receta", { receta_json: JSON.stringify(plain), notas: "" }))).toMatch(/válida/);
    expect(session.recipe?.ai).toHaveLength(1);
    expect(session.recipe?.ai[0]?.costUsd).toBeGreaterThan(0);
    expect(session.recipe?.ai[0]?.placeAt).toEqual({ start: 1, end: 3 });
  });
});

d("Claude: herramientas de corrección (regla de oro)", () => {
  const kie = () => testDeps().providers.kie;
  const fontOps = [
    { op: "replace", path: "/style/titleFont/family", from: null, valor_json: JSON.stringify("Montserrat") },
    { op: "replace", path: "/tracks/captions/style/font/family", from: null, valor_json: JSON.stringify("Montserrat") },
  ];

  it("un parche que toca algo fuera de lo pedido se rechaza con el detalle; el correcto se verifica", async () => {
    const session = newCorrectSession(16);
    const tools = correctTools(correctionInput("cambia la tipografía por una más bonita"), session, { kie: kie() });
    const outside = String(
      await run(tools, "enviar_parche", {
        operaciones: [...fontOps, { op: "replace", path: "/tracks/audio/mix/duckingDb", from: null, valor_json: "-20" }],
        areas: ["estilo", "subtitulos"],
        resumen: "Tipografía nueva",
        regla_sugerida: null,
        pregunta_aclaratoria: null,
      }),
    );
    expect(outside).toMatch(/fuera de lo pedido/);
    expect(outside).toMatch(/audio/);
    expect(session.result).toBeNull();
    expect(session.attempts).toBe(1);

    const ok = String(
      await run(tools, "enviar_parche", {
        operaciones: fontOps,
        areas: ["estilo", "subtitulos"],
        resumen: "Puse Montserrat en títulos y subtítulos",
        regla_sugerida: { texto: "Títulos siempre en Montserrat", check_json: JSON.stringify({ type: "fuente-titulos", family: "Montserrat" }) },
        pregunta_aclaratoria: null,
      }),
    );
    expect(ok).toMatch(/verificado/);
    expect(correctDone(session)).toBe(true);
    const after = applyPatch(current, session.result!.verification.patch);
    expect(changesOutsideAreas(diffRecipes(current, after), ["estilo", "subtitulos"])).toEqual([]);
    expect(after.style.titleFont.family).toBe("Montserrat");
    expect(after.tracks.video).toEqual(current.tracks.video);
    expect(session.result!.ruleSuggestion?.check).toEqual({ type: "fuente-titulos", family: "Montserrat" });
  });

  it("valor_json inválido, parche vacío y tres fallas terminan la sesión", async () => {
    const session = newCorrectSession(16);
    const tools = correctTools(correctionInput("quita la música"), session, { kie: kie() });
    const send = (ops: unknown[]) => run(tools, "enviar_parche", { operaciones: ops, areas: ["audio"], resumen: "", regla_sugerida: null, pregunta_aclaratoria: null });
    expect(String(await send([{ op: "replace", path: "/tracks/audio/music/0/gainDb", from: null, valor_json: "muy bajo" }]))).toMatch(/no es JSON válido/);
    expect(String(await send([{ op: "replace", path: "/tracks/audio/music/0/gainDb", from: null, valor_json: String(current.tracks.audio.music[0]!.gainDb) }]))).toMatch(/no cambia nada/);
    expect(String(await send([{ op: "remove", path: "/tracks/video/0", from: null, valor_json: null }]))).toMatch(/fuera de lo pedido/);
    expect(correctDone(session)).toBe(true);
    expect(toPatchOps([{ op: "move", path: "/a", from: null, valor_json: null }]).errors[0]).toMatch(/from/);
  });
});

d("Claude: bucle agéntico con el SDK (fetch simulado)", () => {
  it("corrección: reintenta tras la verificación, entrega un parche que pasa la regla de oro y cuenta el costo", async () => {
    const fontOps = [{ op: "replace", path: "/style/titleFont/family", from: null, valor_json: JSON.stringify("Poppins") }];
    const fake = fakeClaude([
      { content: [{ type: "text", text: "Reviso la receta." }, toolUse("t1", "ver_receta", { seccion: "estilo" }), toolUse("t1b", "ver_fotogramas_video", { tiempos: [1.5] })] },
      { content: [toolUse("t2", "enviar_parche", { operaciones: [...fontOps, { op: "remove", path: "/tracks/audio/music/0", from: null, valor_json: null }], areas: ["estilo"], resumen: "x", regla_sugerida: null, pregunta_aclaratoria: null })] },
      { content: [toolUse("t3", "enviar_parche", { operaciones: fontOps, areas: ["estilo"], resumen: "Títulos en Poppins", regla_sugerida: null, pregunta_aclaratoria: null })] },
    ]);
    const brain = createClaudeBrain(deps(), { client: fake.client, stream: false });
    const calls = (planInput.toolbox as unknown as { calls: string[] }).calls;
    const before = calls.length;
    const res = await brain.correct(correctionInput("pon los títulos en Poppins"));
    // Cada herramienta corre una sola vez por turno (el runner reutiliza lo que ya ejecutamos).
    expect(calls.slice(before)).toEqual(["previewFrame:1.5"]);
    expect(res.clarifyingQuestion).toBeNull();
    expect(res.summary).toBe("Títulos en Poppins");
    const after = applyPatch(current, res.patch);
    expect(changesOutsideAreas(diffRecipes(current, after), res.areas)).toEqual([]);
    expect(after.style.titleFont.family).toBe("Poppins");
    expect(after.tracks.audio).toEqual(current.tracks.audio);
    // Sin petición extra después de enviar el parche correcto.
    expect(fake.bodies).toHaveLength(3);
    expect(res.usage).toMatchObject({ inputTokens: 3600, outputTokens: 900, cacheReadTokens: 15000, model: "claude-opus-5-5" });
    expect(res.usage.costUsd).toBeCloseTo((3600 * 4 + 900 * 20 + 15000 * 0.2) / 1e6, 6);

    // Forma de la petición: modelo, esfuerzo, caché, respaldo, tool_choice auto, sin thinking ni prefill.
    const body = fake.bodies[0]!;
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect(body.fallbacks).toBe("default");
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body).not.toHaveProperty("thinking");
    expect(fake.headers[0]!.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect((body.messages as { role: string }[]).at(-1)?.role).toBe("user");
    expect((body.tools as { strict?: boolean }[]).every((t) => t.strict === true)).toBe(true);
    // El historial solo crece (append-only): la tercera petición empieza con los mensajes de la primera.
    const m0 = body.messages as unknown[];
    const m2 = fake.bodies[2]!.messages as unknown[];
    expect(m2.slice(0, m0.length)).toEqual(m0);
  });

  it("streaming (camino por defecto): corrección y revisión estructurada con eventos SSE", async () => {
    const ops = [{ op: "replace", path: "/tracks/captions/style/fontSize", from: null, valor_json: "90" }];
    const fake = fakeStreamingClaude([
      sseMessage([{ type: "text", text: "Agrando los subtítulos." }, { type: "tool_use", id: "s1", name: "enviar_parche", input: { operaciones: ops, areas: ["subtitulos"], resumen: "Subtítulos más grandes", regla_sugerida: null, pregunta_aclaratoria: null } }], "tool_use"),
      sseMessage([{ type: "text", text: JSON.stringify({ checks: [{ check: "Legibilidad", ok: true, detail: "Se lee bien." }], fix_patch: null }) }], "end_turn"),
    ]);
    const brain = createClaudeBrain(deps(), { client: fake.client });
    const res = await brain.correct(correctionInput("subtítulos más grandes"));
    expect(res.summary).toBe("Subtítulos más grandes");
    expect(applyPatch(current, res.patch).tracks.captions.style.fontSize).toBe(90);
    expect(fake.bodies[0]!.stream).toBe(true);
    expect(fake.bodies[0]!.max_tokens).toBe(64000);
    const qa = await brain.review({ recipe: current, rules: [], settings: planInput.settings, frames: [{ t: 0, base64: "AAAA", mediaType: "image/jpeg" }] });
    expect(qa.checks.some((c) => c.check === "Legibilidad" && c.ok)).toBe(true);
    expect(fake.bodies).toHaveLength(2);
  });

  it("plan: propone la receta, termina con escenas y no hace peticiones de más", async () => {
    const fake = fakeClaude([
      { content: [toolUse("p1", "proponer_receta", { receta_json: JSON.stringify(current), notas: "Edición con gancho" })] },
      { content: [toolUse("p2", "terminar", { resumen: "Abrí con la frase de Zyra y quité la pausa.", escenas: [{ titulo: "Gancho", inicio: 0, fin: 4, notas: "" }, { titulo: "Cierre", inicio: 4, fin: 15, notas: "CTA" }] })] },
    ]);
    const progress: number[] = [];
    const res = await createClaudeBrain(deps(), { client: fake.client, stream: false }).plan(planInput, { onProgress: (p) => progress.push(p) });
    expect(fake.bodies).toHaveLength(2);
    expect(res.summary).toMatch(/Zyra/);
    expect(res.recipe.meta.generator).toBe("claude");
    expect(res.scenes.map((s) => s.title)).toEqual(["Gancho", "Cierre"]);
    expect(res.scenes[0]!.clips.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(1);
  });

  it("plan: si Claude se detiene sin terminar, se le recuerda una vez; sin propuesta da un error claro", async () => {
    const fake = fakeClaude([{ content: [{ type: "text", text: "Creo que ya está." }] }, { content: [{ type: "text", text: "Listo." }] }]);
    const err = await createClaudeBrain(deps(), { client: fake.client, stream: false }).plan(planInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as UserFacingError).code).toBe("claude-sin-receta");
    expect(fake.bodies).toHaveLength(2);
    const last = (fake.bodies[1]!.messages as { role: string; content: unknown }[]).at(-1)!;
    expect(last.role).toBe("user");
    expect(String(last.content)).toMatch(/proponer_receta/);
  });

  it("rechazo (stop_reason refusal) y errores de la API se convierten en mensajes claros en español", async () => {
    const refusal = fakeClaude([{ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "x" } }]);
    await expect(createClaudeBrain(deps(), { client: refusal.client, stream: false }).correct(correctionInput("x"))).rejects.toMatchObject({ code: "claude-rechazo" });
    const limited = fakeClaude([{ content: [], status: 429 }]);
    await expect(createClaudeBrain(deps(), { client: limited.client, stream: false }).plan(planInput)).rejects.toMatchObject({ code: "claude-limite" });
    const badKey = fakeClaude([{ content: [], status: 401 }]);
    await expect(createClaudeBrain(deps(), { client: badKey.client, stream: false }).plan(planInput)).rejects.toMatchObject({ code: "claude-llave-invalida" });
  });

  it("revisión: salida estructurada + comprobaciones deterministas (duración objetivo y reglas)", async () => {
    const out = { checks: [{ check: "Encuadre", ok: true, detail: "La persona está centrada." }], fix_patch: null };
    const fake = fakeClaude([{ content: [{ type: "text", text: JSON.stringify(out) }] }]);
    const res = await createClaudeBrain(deps(), { client: fake.client, stream: false }).review({
      recipe: current,
      rules: [],
      settings: planInput.settings,
      frames: [{ t: 1, base64: "AAAA", mediaType: "image/jpeg" }],
    });
    expect(res.checks.find((c) => c.check === "Duración objetivo")?.ok).toBe(true);
    expect(res.checks.find((c) => c.check === "Encuadre")?.ok).toBe(true);
    expect((fake.bodies[0]!.output_config as { format?: { type: string } }).format?.type).toBe("json_schema");
  });

  it("palabras clave con el modelo ayudante: solo apariciones reales en la transcripción", async () => {
    const out = {
      palabras: [
        { texto: "Zyra", categoria: "nombre", puntaje: 0.9, apariciones: [{ asset_id: "a-roll", indice_palabra: 0 }] },
        { texto: "subtítulos", categoria: "tema", puntaje: 0.7, apariciones: [] },
        { texto: "palabra inventada", categoria: "tema", puntaje: 0.5, apariciones: [{ asset_id: "a-roll", indice_palabra: 9999 }] },
      ],
      publicar: { titulo: "Edita con Zyra", descripcion: "Cómo editar más rápido.", hashtags: ["zyra", "#edicion de video"], portada: "Edita rápido" },
    };
    const fake = fakeClaude([{ content: [{ type: "text", text: JSON.stringify(out) }] }]);
    const res = await createClaudeBrain(deps(), { client: fake.client, stream: false }).detectKeywords({ transcripts: material.transcripts, settings: planInput.settings, existing: [], glossary: [] });
    expect(fake.bodies[0]!.model).toBe("claude-sonnet-5-5");
    expect((fake.bodies[0]!.output_config as { effort: string }).effort).toBe("low");
    const texts = res.keywords.map((k) => k.text);
    expect(texts).toContain("Zyra");
    expect(texts).toContain("subtítulos");
    expect(texts).not.toContain("palabra inventada");
    const zyra = res.keywords.find((k) => k.text === "Zyra")!;
    const words = material.transcripts[0]!.words;
    for (const o of zyra.occurrences) expect(words.find((w) => w.i === o.wordIndex)?.text.toLowerCase()).toMatch(/zyra/);
    expect(res.publishCopy.hashtags).toEqual(["#zyra", "#ediciondevideo"]);
    expect(res.usage.model).toBe("claude-sonnet-5-5");
  });
});

describe("Claude: fábrica", () => {
  it("sin llave o en modo demo no hay editor con Claude", () => {
    expect(createClaudeEditor(testDeps())).toBeNull();
    expect(createClaudeEditor(testDeps({ anthropicApiKey: "sk-x", demoMode: true }))).toBeNull();
    const brain = createClaudeEditor(testDeps({ anthropicApiKey: "sk-x", demoMode: false }));
    expect(brain?.kind).toBe("claude");
    expect(brain?.model).toBe("claude-opus-5-5");
  });
});
