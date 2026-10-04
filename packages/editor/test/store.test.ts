import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, unwrap } from "../src/api/client.js";
import { ApiRequestError } from "../src/api/errors.js";
import { parseSseChunk } from "../src/api/sse.js";
import { createDemoApi } from "../src/demo/demoApi.js";
import { DEMO_PROJECT_ID, demoAssets, demoConfig, demoTranscripts } from "../src/fixtures/index.js";
import { createController } from "../src/store/controller.js";
import { computeEstimate, preflightWarnings, stageStates, summarizeMaterial } from "../src/store/derive.js";
import { createEditorStore } from "../src/store/editorStore.js";
import { freshSettings } from "../src/lib/settings.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("store: deshacer/rehacer solo de la configuración", () => {
  it("undo/redo restaura settings y no toca otros datos", async () => {
    const store = createEditorStore();
    const s = () => store.getState();
    s().updateSettings((d) => void (d.context.script.enabled = true));
    await new Promise((r) => setTimeout(r, 750)); // fuera de la ráfaga
    s().updateSettings((d) => void (d.instruction.targetDuration = 30));
    s().set({ panel: "aprendido" }); // UI: no entra al historial
    expect(store.temporal.getState().pastStates).toHaveLength(2);
    store.temporal.getState().undo();
    expect(s().settings.instruction.targetDuration).toBeNull();
    expect(s().settings.context.script.enabled).toBe(true);
    expect(s().panel).toBe("aprendido");
    store.temporal.getState().undo();
    expect(s().settings.context.script.enabled).toBe(false);
    store.temporal.getState().redo();
    expect(s().settings.context.script.enabled).toBe(true);
  });

  it("agrupa los cambios en ráfaga (escribir) en un solo paso", () => {
    const store = createEditorStore();
    for (const ch of "Hola mundo") store.getState().updateSettings((d) => void (d.instruction.text += ch));
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo();
    expect(store.getState().settings.instruction.text).toBe("");
  });

  it("los motores se derivan al cambiar herramientas", () => {
    const store = createEditorStore();
    store.getState().updateSettings((d) => void (d.tools.aiVideos.enabled = true));
    expect(store.getState().settings.engines.kie).toBe(true);
  });
});

describe("controlador: autoguardado con debounce", () => {
  it("guarda con PATCH tras ~600 ms y marca 'guardado'", async () => {
    const api = createDemoApi();
    const spy = vi.spyOn(api, "updateProject");
    const store = createEditorStore({ demo: true });
    const controller = createController(store, () => api, { autosaveMs: 50 });
    await controller.openProject(DEMO_PROJECT_ID);
    expect(store.getState().project?.id).toBe(DEMO_PROJECT_ID);
    store.getState().updateSettings((d) => void (d.instruction.text = "Nuevo texto"));
    expect(store.getState().save.status).toBe("pendiente");
    store.getState().updateSettings((d) => void (d.instruction.text = "Nuevo texto 2"));
    await vi.waitFor(() => expect(store.getState().save.status).toBe("guardado"), { timeout: 3000 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1].settings?.instruction?.text).toBe("Nuevo texto 2");
    controller.dispose();
  });

  it("si no hay conexión queda 'sin conexión'", async () => {
    const api = createDemoApi();
    const store = createEditorStore({ demo: true });
    const controller = createController(store, () => api, { autosaveMs: 10 });
    await controller.openProject(DEMO_PROJECT_ID);
    vi.spyOn(api, "updateProject").mockRejectedValue(new ApiRequestError("No hay conexión con el servidor.", 0, "red"));
    store.getState().setProjectName("Otro nombre");
    await vi.waitFor(() => expect(store.getState().save.status).toBe("sin-conexion"), { timeout: 3000 });
    controller.dispose();
  });
});

describe("derivados", () => {
  it("resumen de material y estimado instantáneo", () => {
    const material = summarizeMaterial(demoAssets, demoTranscripts);
    expect(material.videoMinutes).toBeGreaterThan(1);
    expect(material.photos).toBe(1);
    const settings = freshSettings();
    const base = computeEstimate(demoConfig, settings, demoAssets, demoTranscripts)!;
    settings.tools.aiVideos.enabled = true;
    const withAi = computeEstimate(demoConfig, settings, demoAssets, demoTranscripts)!;
    expect(withAi.seconds.expected).toBeGreaterThan(base.seconds.expected);
    expect(withAi.costUsd.expected).toBeGreaterThan(base.costUsd.expected);
    expect(base.label).toMatch(/min/);
  });

  it("avisa si la duración pedida supera el material", () => {
    const settings = freshSettings();
    settings.instruction.targetDuration = 600;
    const w = preflightWarnings(settings, demoAssets);
    expect(w.find((x) => x.id === "duracion")?.text).toMatch(/Pides 10 min/);
    expect(preflightWarnings(settings, []).find((x) => x.id === "sin-material")?.severity).toBe("bloqueo");
  });

  it("estado por etapa: vacío sin material, listo con material", () => {
    const empty = stageStates({ settings: freshSettings(), assets: [], uploads: [], transcripts: [], versions: [], activeJob: null, pendingPlan: null });
    expect(empty.material.status).toBe("vacio");
    expect(empty.resultado.hint).toMatch(/GENERAR/);
    const full = stageStates({ settings: freshSettings(), assets: demoAssets, uploads: [], transcripts: demoTranscripts, versions: [], activeJob: null, pendingPlan: null });
    expect(full.material.status).toBe("listo");
    expect(full.transcripcion.status).toBe("listo");
  });
});

describe("cliente de API", () => {
  it("usa el mensaje en español del servidor en los errores", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "no-encontrado", message: "No existe ese proyecto." }), { status: 404 }));
    const api = createApiClient({ baseUrl: "/api/v1/", ownerId: "ana", fetch: fetchMock as unknown as typeof fetch });
    await expect(api.getProject("x")).rejects.toMatchObject({ message: "No existe ese proyecto.", status: 404, code: "no-encontrado" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/projects/x");
    expect((init.headers as Record<string, string>)["X-Owner-Id"]).toBe("ana");
  });

  it("sin servidor da un error de red en español", async () => {
    const api = createApiClient({ baseUrl: "/api/v1", fetch: (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch });
    const err = await api.getConfig().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).isNetwork).toBe(true);
    expect((err as ApiRequestError).message).toBe("No hay conexión con el servidor.");
  });

  it("acepta respuestas envueltas o desnudas", () => {
    expect(unwrap<number[]>({ projects: [1, 2] }, "projects")).toEqual([1, 2]);
    expect(unwrap<number[]>([1, 2], "projects")).toEqual([1, 2]);
  });

  it("parsea eventos SSE (comentarios, varias líneas y resto pendiente)", () => {
    const { events, rest } = parseSseChunk(': ping\n\nevent: message\ndata: {"type":"ping",\ndata: "at":"x"}\n\ndata: {"type"');
    expect(events).toEqual([{ event: "message", data: '{"type":"ping",\n"at":"x"}' }]);
    expect(rest).toBe('data: {"type"');
  });
});
