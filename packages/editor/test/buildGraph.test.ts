// @vitest-environment node
import { Job, Recipe, Version, type ProjectSettings } from "@autoeditor/shared";
import { describe, expect, it } from "vitest";
import { buildGraph, VISIBLE_VERSIONS, type ContextNodeData, type GraphInput, type ResultNodeData, type StackNodeData, type ToolsNodeData } from "../src/canvas/buildGraph.js";
import { freshSettings } from "../src/lib/settings.js";

const recipe = Recipe.parse({ format: { aspect: "9:16", width: 1080, height: 1920 } });

function version(n: number, parent: number | null, correction: string | null = null) {
  return Version.parse({
    id: `v${n}`,
    ownerId: "o",
    projectId: "p",
    number: n,
    parentId: parent ? `v${parent}` : null,
    recipe,
    correction,
    status: "lista",
    createdAt: new Date(2026, 0, n).toISOString(),
  });
}

function input(patch: Partial<GraphInput> = {}, mutate?: (s: ProjectSettings) => void): GraphInput {
  const settings = freshSettings();
  mutate?.(settings);
  return { settings, assets: [], uploads: [], transcripts: [], versions: [], activeJob: null, pendingPlan: null, showAllVersions: false, ...patch };
}

const ids = (g: ReturnType<typeof buildGraph>) => g.nodes.map((n) => n.id);

describe("buildGraph", () => {
  it("arma el flujo base de izquierda a derecha", () => {
    const g = buildGraph(input());
    expect(ids(g)).toEqual(["material", "ctx-script", "ctx-brand", "ctx-references", "transcripcion", "herramientas", "instruccion", "resultado"]);
    const edgeIds = g.edges.map((e) => e.id);
    expect(edgeIds).toContain("transcripcion->herramientas");
    expect(edgeIds).toContain("herramientas->instruccion");
    expect(edgeIds).toContain("instruccion->resultado");
  });

  it("un interruptor apagado produce un chip y prendido produce un nodo desplegado", () => {
    const off = buildGraph(input());
    const chip = off.nodes.find((n) => n.id === "ctx-script")!;
    expect((chip.data as ContextNodeData).enabled).toBe(false);
    expect(chip.height).toBeLessThan(60);
    expect(off.edges.filter((e) => e.source === "ctx-script" || e.target === "ctx-script").every((e) => e.muted)).toBe(true);

    const on = buildGraph(input({}, (s) => void (s.context.script.enabled = true)));
    const node = on.nodes.find((n) => n.id === "ctx-script")!;
    expect((node.data as ContextNodeData).enabled).toBe(true);
    expect(node.height).toBeGreaterThan(200);
    expect(on.edges.filter((e) => e.source === "ctx-script" || e.target === "ctx-script").some((e) => e.muted)).toBe(false);
    // Los demás siguen como chips.
    expect((on.nodes.find((n) => n.id === "ctx-brand")!.data as ContextNodeData).enabled).toBe(false);
  });

  it("el nodo PLAN solo aparece con 'Revisar plan antes de renderizar'", () => {
    expect(ids(buildGraph(input()))).not.toContain("plan");
    const g = buildGraph(input({}, (s) => void (s.instruction.reviewPlan = true)));
    expect(ids(g)).toContain("plan");
    expect(g.edges.map((e) => e.id)).toEqual(expect.arrayContaining(["instruccion->plan", "plan->resultado"]));
  });

  it("herramientas prendidas y motores derivados (Kie AI se prende solo con IA)", () => {
    const g = buildGraph(input({}, (s) => void (s.tools.aiImages.enabled = true)));
    const tools = g.nodes.find((n) => n.id === "herramientas")!.data as ToolsNodeData;
    expect(tools.enabledTools).toContain("aiImages");
    expect(tools.enabledTools).toContain("broll");
    expect(tools.engines.kie).toBe(true);
    const plain = buildGraph(input()).nodes.find((n) => n.id === "herramientas")!.data as ToolsNodeData;
    expect(plain.engines.kie).toBe(false);
  });

  it("encadena versiones V1 → V2 → V3 con la corrección sobre la flecha", () => {
    const versions = [version(1, null), version(2, 1, "cambia la tipografía por una más bonita"), version(3, 2, "quita el último corte")];
    const g = buildGraph(input({ versions }));
    expect(ids(g)).not.toContain("resultado");
    expect(ids(g)).toEqual(expect.arrayContaining(["version-v1", "version-v2", "version-v3"]));
    const e12 = g.edges.find((e) => e.id === "version-v1->version-v2")!;
    expect(e12.label).toBe("cambia la tipografía por una más bonita");
    expect(g.edges.find((e) => e.id === "version-v2->version-v3")!.label).toBe("quita el último corte");
    expect(g.edges.find((e) => e.id === "instruccion->version-v1")).toBeTruthy();
  });

  it("apila las versiones viejas y muestra solo las últimas 3", () => {
    const versions = [1, 2, 3, 4, 5].map((n) => version(n, n > 1 ? n - 1 : null, n > 1 ? `corrección ${n}` : null));
    const g = buildGraph(input({ versions }));
    const shown = g.nodes.filter((n) => n.type === "version");
    expect(shown).toHaveLength(VISIBLE_VERSIONS);
    const stack = g.nodes.find((n) => n.id === "versions-stack")!;
    expect((stack.data as StackNodeData).count).toBe(2);
    expect((stack.data as StackNodeData).fromNumber).toBe(1);
    expect(g.edges.find((e) => e.id === "versions-stack->version-v3")!.label).toBe("corrección 3");
    const all = buildGraph(input({ versions, showAllVersions: true }));
    expect(all.nodes.filter((n) => n.type === "version")).toHaveLength(5);
    expect(ids(all)).not.toContain("versions-stack");
  });

  it("una corrección en proceso agrega la versión pendiente y anima su flecha", () => {
    const versions = [version(1, null)];
    const job = Job.parse({ id: "j", ownerId: "o", projectId: "p", type: "corregir", status: "corriendo", stage: "render", input: { versionId: "v1", text: "más rápido" }, createdAt: new Date().toISOString() });
    const g = buildGraph(input({ versions, activeJob: job }));
    const pending = g.nodes.find((n) => n.id === "version-pendiente")!;
    expect((pending.data as ResultNodeData).nextNumber).toBe(2);
    const edge = g.edges.find((e) => e.target === "version-pendiente")!;
    expect(edge.animated).toBe(true);
    expect(edge.label).toBe("más rápido");
  });

  it("ilumina la etapa en proceso al generar", () => {
    const job = Job.parse({ id: "j", ownerId: "o", projectId: "p", type: "generar", status: "corriendo", stage: "transcribiendo", createdAt: new Date().toISOString() });
    const g = buildGraph(input({ activeJob: job }));
    expect(g.nodes.find((n) => n.id === "transcripcion")!.data.processing).toBe(true);
    expect(g.edges.filter((e) => e.target === "transcripcion").every((e) => e.animated)).toBe(true);
  });
});
