// @vitest-environment node
import { Recipe, Version, type ProjectSettings } from "@autoeditor/shared";
import { describe, expect, it } from "vitest";
import { buildGraph, type GraphInput } from "../src/canvas/buildGraph.js";
import { labelSize } from "../src/canvas/edges/FlowEdge.js";
import { findOverlaps, layoutGraph, type Rect } from "../src/canvas/layout.js";
import { freshSettings } from "../src/lib/settings.js";

const recipe = Recipe.parse({ format: { aspect: "9:16", width: 1080, height: 1920 } });
const version = (n: number, correction: string | null) =>
  Version.parse({ id: `v${n}`, ownerId: "o", projectId: "p", number: n, parentId: n > 1 ? `v${n - 1}` : null, recipe, correction, status: "lista", createdAt: new Date().toISOString() });

function input(mutate?: (s: ProjectSettings) => void, patch: Partial<GraphInput> = {}): GraphInput {
  const settings = freshSettings();
  mutate?.(settings);
  return { settings, assets: [], uploads: [], transcripts: [], versions: [], activeJob: null, pendingPlan: null, showAllVersions: false, ...patch };
}

/** Acomoda con elk (tamaños ficticios: los estimados de buildGraph, opcionalmente alterados). */
async function layoutRects(gi: GraphInput, sizeOverride: Record<string, { width: number; height: number }> = {}) {
  const g = buildGraph(gi);
  const nodes = g.nodes.map((n) => ({ id: n.id, ...(sizeOverride[n.id] ?? { width: n.width, height: n.height }) }));
  const res = await layoutGraph(
    nodes,
    g.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, label: e.label ? labelSize(e.label) : undefined })),
  );
  const rects: Rect[] = nodes.map((n) => ({ id: n.id, x: res.positions[n.id]!.x, y: res.positions[n.id]!.y, width: n.width, height: n.height }));
  return { g, rects, res };
}

describe("layoutGraph (elk) sin solapes", () => {
  it("flujo base: ningún rectángulo se encima y va de izquierda a derecha", async () => {
    const { rects } = await layoutRects(input());
    expect(findOverlaps(rects)).toEqual([]);
    const x = (id: string) => rects.find((r) => r.id === id)!.x;
    expect(x("material")).toBeLessThan(x("ctx-script"));
    expect(x("ctx-script")).toBeLessThan(x("transcripcion"));
    expect(x("transcripcion")).toBeLessThan(x("herramientas"));
    expect(x("herramientas")).toBeLessThan(x("instruccion"));
    expect(x("instruccion")).toBeLessThan(x("resultado"));
  });

  it("con los tres interruptores prendidos, plan y varias versiones tampoco se encima nada", async () => {
    const versions = [1, 2, 3, 4, 5].map((n) => version(n, n > 1 ? `corrección número ${n} con un texto bastante largo para la etiqueta` : null));
    const gi = input(
      (s) => {
        s.context.script.enabled = true;
        s.context.brand.enabled = true;
        s.context.references.enabled = true;
        s.instruction.reviewPlan = true;
      },
      { versions },
    );
    const { rects } = await layoutRects(gi);
    expect(findOverlaps(rects)).toEqual([]);
    // Con margen de 16 px tampoco (respira).
    expect(findOverlaps(rects, -16)).toEqual([]);
  });

  it("al crecer un nodo (tamaño medido distinto) el acomodo sigue sin solapes", async () => {
    const gi = input((s) => void (s.context.references.enabled = true));
    const { rects } = await layoutRects(gi, { "ctx-references": { width: 420, height: 900 }, material: { width: 312, height: 760 } });
    expect(findOverlaps(rects)).toEqual([]);
  });

  it("deja espacio entre columnas para la corrección escrita sobre la flecha", async () => {
    const label = "cambia la tipografía por una más bonita";
    const { rects } = await layoutRects(input(undefined, { versions: [version(1, null), version(2, label)] }));
    const v1 = rects.find((r) => r.id === "version-v1")!;
    const v2 = rects.find((r) => r.id === "version-v2")!;
    expect(v2.x - (v1.x + v1.width)).toBeGreaterThanOrEqual(labelSize(label).width);
  });

  it("los chips de contexto quedan apilados en una misma columna entre MATERIAL y TRANSCRIPCIÓN", async () => {
    const { rects } = await layoutRects(input());
    const chips = rects.filter((r) => r.id.startsWith("ctx-"));
    const centers = chips.map((c) => c.x + c.width / 2);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(2);
    const ys = chips.map((c) => c.y).sort((a, b) => a - b);
    expect(ys[0]).toBeLessThan(ys[1]!);
  });
});

describe("findOverlaps", () => {
  it("detecta rectángulos encimados y respeta el margen", () => {
    expect(findOverlaps([{ id: "a", x: 0, y: 0, width: 10, height: 10 }, { id: "b", x: 5, y: 5, width: 10, height: 10 }])).toEqual([["a", "b"]]);
    expect(findOverlaps([{ id: "a", x: 0, y: 0, width: 10, height: 10 }, { id: "b", x: 10, y: 0, width: 10, height: 10 }])).toEqual([]);
    expect(findOverlaps([{ id: "a", x: 0, y: 0, width: 10, height: 10 }, { id: "b", x: 12, y: 0, width: 10, height: 10 }], 4)).toEqual([["a", "b"]]);
  });
});
