/**
 * Auto-acomodo izquierda → derecha con elkjs (algoritmo "layered", dirección RIGHT).
 *
 * - Usa los tamaños MEDIDOS de cada nodo (o los estimados antes de medir).
 * - Cada nodo tiene un puerto de entrada (izquierda) y uno de salida (derecha) centrados, así las
 *   flechas de la columna principal quedan rectas y las tarjetas alineadas por su centro.
 * - Las etiquetas de las flechas (correcciones V1 → V2) reservan su espacio entre columnas.
 * - Respeta el orden del modelo (los chips de contexto no se reordenan al prender/apagar).
 */
import type ELKConstructor from "elkjs/lib/elk-api.js";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";

export interface LayoutNodeInput {
  id: string;
  width: number;
  height: number;
}

export interface LayoutEdgeInput {
  id: string;
  source: string;
  target: string;
  /** Tamaño de la etiqueta sobre la flecha (si tiene). */
  label?: { width: number; height: number };
}

export interface LayoutResult {
  positions: Record<string, { x: number; y: number }>;
  width: number;
  height: number;
}

export interface LayoutOptions {
  /** Separación horizontal entre columnas (px). */
  layerGap?: number;
  /** Separación vertical entre nodos de la misma columna (px). */
  nodeGap?: number;
}

type ElkInstance = InstanceType<typeof ELKConstructor>;
let elk: Promise<ElkInstance> | null = null;
/** elkjs pesa ~1.5 MB: se carga bajo demanda (chunk aparte) la primera vez que se acomoda. */
const getElk = () =>
  (elk ??= import("elkjs/lib/elk.bundled.js").then((m) => {
    const Ctor = (m.default ?? m) as typeof ELKConstructor;
    return new Ctor();
  }));

export async function layoutGraph(nodes: LayoutNodeInput[], edges: LayoutEdgeInput[], options: LayoutOptions = {}): Promise<LayoutResult> {
  const ids = new Set(nodes.map((n) => n.id));
  const layerGap = options.layerGap ?? 96;
  const nodeGap = options.nodeGap ?? 40;

  const children: ElkNode[] = nodes.map((n) => {
    const w = Math.max(1, Math.round(n.width));
    const h = Math.max(1, Math.round(n.height));
    return {
      id: n.id,
      width: w,
      height: h,
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
      ports: [
        { id: `${n.id}__in`, x: 0, y: Math.round(h / 2), width: 1, height: 1, layoutOptions: { "elk.port.side": "WEST" } },
        { id: `${n.id}__out`, x: w - 1, y: Math.round(h / 2), width: 1, height: 1, layoutOptions: { "elk.port.side": "EAST" } },
      ],
    };
  });

  const elkEdges: ElkExtendedEdge[] = edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({
      id: e.id,
      sources: [`${e.source}__out`],
      targets: [`${e.target}__in`],
      labels: e.label ? [{ id: `${e.id}__label`, text: " ", width: Math.round(e.label.width), height: Math.round(e.label.height) }] : undefined,
    }));

  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": String(layerGap),
      "elk.spacing.nodeNode": String(nodeGap),
      "elk.spacing.edgeNode": "24",
      "elk.spacing.edgeEdge": "14",
      "elk.spacing.edgeLabel": "10",
      "elk.layered.spacing.edgeNodeBetweenLayers": "28",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
      "elk.edgeLabels.inline": "true",
      "elk.padding": "[top=48,left=48,bottom=48,right=48]",
    },
    children,
    edges: elkEdges,
  };

  const out = await (await getElk()).layout(graph);
  const positions: Record<string, { x: number; y: number }> = {};
  for (const c of out.children ?? []) positions[c.id] = { x: Math.round(c.x ?? 0), y: Math.round(c.y ?? 0) };
  return { positions, width: out.width ?? 0, height: out.height ?? 0 };
}

export interface Rect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pares de rectángulos que se enciman (con margen opcional). Útil en pruebas y como verificación. */
export function findOverlaps(rects: Rect[], margin = 0): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      const overlap =
        a.x < b.x + b.width + margin && b.x < a.x + a.width + margin && a.y < b.y + b.height + margin && b.y < a.y + a.height + margin;
      if (overlap) out.push([a.id, b.id]);
    }
  }
  return out;
}
