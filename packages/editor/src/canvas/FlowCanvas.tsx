/**
 * Lienzo del diagrama (React Flow).
 *
 * Flujo: estado → buildGraph (puro) → nodos de React Flow → el DOM se mide → elkjs acomoda con los
 * tamaños medidos → las posiciones se animan (interpolación suave). Se vuelve a acomodar al prender
 * o apagar cosas, al agregar versiones o cuando una tarjeta cambia de tamaño. Nada se encima.
 * Zoom, arrastre del lienzo, minimapa y controles; doble clic abre la tarjeta en vista enfocada.
 */
import {
  Background,
  BackgroundVariant,
  Controls,
  ControlButton,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import clsx from "clsx";
import { Expand } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { StageId } from "../lib/stages.js";
import { useActions, useActiveJob, useEditor, useEditorShallow } from "../store/context.js";
import { buildGraph, type AnyNodeData, type Graph, type GraphNode } from "./buildGraph.js";
import { edgeTypes, labelSize, type FlowEdgeData } from "./edges/FlowEdge.js";
import { layoutGraph } from "./layout.js";
import { nodeTypes } from "./nodes/index.js";

type RFNode = Node<AnyNodeData>;
type XY = { x: number; y: number };

const EDGE_COLOR = "#8A8A8A";
const EDGE_ACTIVE = "#7262EA";
const LAYOUT_MS = 380;

/** onNodeClick vacío: hace que React Flow deje pasar los clics a los controles de cada tarjeta. */
const noop = () => undefined;

const prefersReducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/** Ids de nodos a encuadrar para cada etapa (la etapa y sus vecinas). */
export function nodesForStage(graph: Graph, stage: StageId): string[] {
  const ids = graph.nodes.map((n) => n.id);
  const has = (id: string) => ids.includes(id);
  const ctx = ids.filter((id) => id.startsWith("ctx-"));
  const versions = ids.filter((id) => id.startsWith("version-") || id === "versions-stack");
  const result = has("resultado") ? ["resultado"] : versions.slice(0, 1);
  switch (stage) {
    case "material":
      return ["material", ...ctx, "transcripcion"];
    case "contexto":
      return ["material", ...ctx, "transcripcion"];
    case "transcripcion":
      return [...ctx, "transcripcion", "herramientas"];
    case "herramientas":
      return ["transcripcion", "herramientas", "instruccion"];
    case "instruccion":
      return ["herramientas", "instruccion", ...(has("plan") ? ["plan"] : result)];
    case "plan":
      return has("plan") ? ["instruccion", "plan", ...result] : ["instruccion", ...result];
    case "resultado":
      return [has("plan") ? "plan" : "instruccion", ...result, ...versions.slice(1, 2)];
    case "versiones":
      return versions.length ? versions.slice(-3) : result;
  }
}

/** Nodo principal de cada etapa (en pantallas angostas se encuadra solo ese). */
export function primaryNodesForStage(graph: Graph, stage: StageId): string[] {
  const ids = graph.nodes.map((n) => n.id);
  const versions = ids.filter((id) => id.startsWith("version-"));
  const result = ids.includes("resultado") ? ["resultado"] : versions.slice(0, 1);
  switch (stage) {
    case "contexto":
      return ids.filter((id) => id.startsWith("ctx-"));
    case "plan":
      return ids.includes("plan") ? ["plan"] : ["instruccion"];
    case "resultado":
      return result;
    case "versiones":
      return versions.length ? versions.slice(-1) : result;
    default:
      return [stage];
  }
}

/** Margen del encuadre: arriba deja libre el stepper flotante. */
const FIT_PADDING = { top: "92px", bottom: "36px", left: "40px", right: "40px" } as const;
const FIT_PADDING_NARROW = { top: "76px", bottom: "24px", left: "16px", right: "16px" } as const;

function useGraph(): Graph {
  const input = useEditorShallow((s) => ({
    settings: s.settings,
    assets: s.assets,
    uploads: s.uploads,
    transcripts: s.transcripts,
    versions: s.versions,
    pendingPlan: s.pendingPlan,
    showAllVersions: s.showAllVersions,
  }));
  const activeJob = useActiveJob();
  return useMemo(() => buildGraph({ ...input, activeJob }), [input, activeJob]);
}

function toEdge(e: Graph["edges"][number]): Edge<FlowEdgeData> {
  const color = e.animated ? EDGE_ACTIVE : e.muted ? "#B9B9B9" : EDGE_COLOR;
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    type: "flow",
    data: { label: e.label, animated: e.animated, muted: e.muted },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16, strokeWidth: 1.5 },
    focusable: false,
    selectable: false,
  };
}

function spawnPosition(g: GraphNode, graph: Graph, known: Map<string, RFNode>): XY {
  const incoming = graph.edges.find((e) => e.target === g.id && known.has(e.source));
  if (incoming) {
    const src = known.get(incoming.source)!;
    return { x: src.position.x + (src.measured?.width ?? 280) + 96, y: src.position.y };
  }
  return { x: 0, y: 0 };
}

export function FlowCanvas() {
  return (
    <ReactFlowProvider>
      <FlowInner />
    </ReactFlowProvider>
  );
}

function FlowInner() {
  const graph = useGraph();
  const rf = useReactFlow<RFNode, Edge<FlowEdgeData>>();
  const { openFocus, set } = useActions();
  const viewRequest = useEditor((s) => s.viewRequest);
  const activeStage = useEditor((s) => s.activeStage);
  const projectId = useEditor((s) => s.project?.id ?? null);
  const [nodes, setNodes] = useState<RFNode[]>([]);
  const [ready, setReady] = useState(false);
  const nodesRef = useRef<RFNode[]>([]);
  nodesRef.current = nodes;
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const animFrame = useRef<number | null>(null);
  const layoutSeq = useRef(0);
  const firstLayoutDone = useRef(false);
  const [animating, setAnimating] = useState(false);
  const [needsFit, setNeedsFit] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeStageRef = useRef(activeStage);
  activeStageRef.current = activeStage;

  // 1) Sincroniza el grafo con los nodos de React Flow (conserva posición y medidas).
  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return graph.nodes.map((g) => {
        const p = prevById.get(g.id);
        if (p) return { ...p, type: g.type, data: g.data };
        return {
          id: g.id,
          type: g.type,
          data: g.data,
          position: spawnPosition(g, graph, prevById),
          draggable: false,
          connectable: false,
          selectable: false,
          className: firstLayoutDone.current ? "ae-node-enter" : undefined,
          ariaLabel: `${g.data.stage}: doble clic o Enter para abrir en grande`,
        } satisfies RFNode;
      });
    });
  }, [graph]);

  const onNodesChange = useCallback((changes: NodeChange<RFNode>[]) => {
    // Solo aceptamos cambios de medidas (las posiciones las decide el acomodo automático).
    const dims = changes.filter((c) => c.type === "dimensions");
    if (dims.length) setNodes((ns) => applyNodeChanges(dims, ns));
  }, []);

  // 2) Anima las posiciones hacia el resultado del acomodo.
  const animateTo = useCallback((target: Record<string, XY>, duration: number) => {
    if (animFrame.current) cancelAnimationFrame(animFrame.current);
    const from = new Map(nodesRef.current.map((n) => [n.id, n.position]));
    const moved = nodesRef.current.some((n) => {
      const t = target[n.id];
      return t && (Math.abs(t.x - n.position.x) > 0.5 || Math.abs(t.y - n.position.y) > 0.5);
    });
    if (!moved) return;
    if (duration <= 0 || prefersReducedMotion()) {
      setNodes((ns) => ns.map((n) => (target[n.id] ? { ...n, position: target[n.id]! } : n)));
      return;
    }
    const start = performance.now();
    setAnimating(true);
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const k = easeOut(t);
      setNodes((ns) =>
        ns.map((n) => {
          const to = target[n.id];
          if (!to) return n;
          const f = from.get(n.id) ?? to;
          return { ...n, position: { x: f.x + (to.x - f.x) * k, y: f.y + (to.y - f.y) * k } };
        }),
      );
      if (t < 1) animFrame.current = requestAnimationFrame(step);
      else {
        animFrame.current = null;
        setAnimating(false);
      }
    };
    animFrame.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => () => {
    if (animFrame.current) cancelAnimationFrame(animFrame.current);
  }, []);

  // 3) Acomoda con elk cuando cambian la estructura o los tamaños medidos.
  const sizeKey = nodes.map((n) => `${n.id}:${Math.round(n.measured?.width ?? 0)}x${Math.round(n.measured?.height ?? 0)}`).join("|");
  const edgeKey = graph.edges.map((e) => `${e.id}:${e.label ?? ""}`).join("|");
  useEffect(() => {
    const current = nodesRef.current;
    if (!current.length || current.some((n) => !n.measured?.width || !n.measured?.height)) return;
    if (current.length !== graphRef.current.nodes.length) return;
    const seq = ++layoutSeq.current;
    const edges = graphRef.current.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, label: e.label ? labelSize(e.label) : undefined }));
    void layoutGraph(
      current.map((n) => ({ id: n.id, width: n.measured!.width!, height: n.measured!.height! })),
      edges,
    ).then((res) => {
      if (seq !== layoutSeq.current) return;
      const first = !firstLayoutDone.current;
      animateTo(res.positions, first ? 0 : LAYOUT_MS);
      if (first) {
        firstLayoutDone.current = true;
        // El encuadre inicial se hace cuando las posiciones ya están aplicadas (ver efecto de abajo).
        setNeedsFit(true);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizeKey, edgeKey]);

  const fitStage = useCallback(
    (target: StageId | "todo", duration = 450) => {
      const narrow = (containerRef.current?.clientWidth ?? 1200) < 640;
      const padding = narrow ? FIT_PADDING_NARROW : FIT_PADDING;
      if (target === "todo") {
        void rf.fitView({ padding, duration, maxZoom: 1 });
        return;
      }
      const pick = narrow ? primaryNodesForStage : nodesForStage;
      const ids = pick(graphRef.current, target).filter((id) => nodesRef.current.some((n) => n.id === id));
      if (!ids.length) return;
      void rf.fitView({ nodes: ids.map((id) => ({ id })), padding, duration, maxZoom: 1, minZoom: 0.35 });
    },
    [rf],
  );

  const fitInitial = useCallback(() => {
    const el = containerRef.current;
    const width = el?.clientWidth ?? 1200;
    const height = el?.clientHeight ?? 800;
    const xs = nodesRef.current.map((n) => n.position.x);
    const xe = nodesRef.current.map((n) => n.position.x + (n.measured?.width ?? 0));
    const ys = nodesRef.current.map((n) => n.position.y);
    const ye = nodesRef.current.map((n) => n.position.y + (n.measured?.height ?? 0));
    const gw = Math.max(...xe) - Math.min(...xs);
    const gh = Math.max(...ye) - Math.min(...ys);
    const zoom = Math.min((width - 80) / gw, (height - 130) / gh);
    if (zoom >= 0.72) fitStage("todo", 0);
    else fitStage(activeStageRef.current, 0);
  }, [fitStage]);

  // Encuadre inicial: todo si cabe legible; si no, la etapa actual y sus vecinas.
  useEffect(() => {
    if (!needsFit) return;
    const raf = requestAnimationFrame(() => {
      fitInitial();
      setNeedsFit(false);
      setReady(true);
    });
    return () => cancelAnimationFrame(raf);
  }, [needsFit, nodes, fitInitial]);

  // Pedidos explícitos de encuadre (stepper, atajos, GENERAR…).
  useEffect(() => {
    if (!viewRequest || !firstLayoutDone.current) return;
    fitStage(viewRequest.target);
  }, [viewRequest, fitStage]);

  // Al cambiar de proyecto se repite el encuadre inicial.
  useEffect(() => {
    firstLayoutDone.current = false;
    setReady(false);
  }, [projectId]);

  const openNode = useCallback(
    (node: RFNode) => {
      const d = node.data;
      const target = node.id.startsWith("ctx-") ? node.id : "versionId" in d ? String(d.versionId) : undefined;
      openFocus(d.stage, target);
    },
    [openFocus],
  );

  const onNodeDoubleClick = useCallback(
    (e: MouseEvent, node: RFNode) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, button, a, label, [contenteditable='true'], .ae-no-focus")) return;
      openNode(node);
    },
    [openNode],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const t = e.target as HTMLElement;
      if (e.key !== "Enter" || !t.classList.contains("react-flow__node")) return;
      const id = t.getAttribute("data-id");
      const node = nodesRef.current.find((n) => n.id === id);
      if (node) {
        e.preventDefault();
        openNode(node);
      }
    },
    [openNode],
  );

  const edges = useMemo(() => graph.edges.map(toEdge), [graph.edges]);

  return (
    <div ref={containerRef} className={clsx("ae-flow", ready && "is-ready", animating && "is-animating")} onKeyDown={onKeyDown}>
      <ReactFlow<RFNode, Edge<FlowEdgeData>>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={noop}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={() => set({ panel: null })}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        nodesFocusable
        edgesFocusable={false}
        zoomOnDoubleClick={false}
        panOnScroll
        selectionOnDrag={false}
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        colorMode="light"
        aria-label="Diagrama del flujo de edición"
      >
        <Background id="menor" variant={BackgroundVariant.Lines} gap={28} color="rgba(31,31,31,0.045)" lineWidth={1} />
        <Background id="mayor" variant={BackgroundVariant.Lines} gap={140} color="rgba(31,31,31,0.06)" lineWidth={1} />
        <MiniMap
          className="ae-minimap"
          style={{ width: 168, height: 112 }}
          pannable
          zoomable
          ariaLabel="Minimapa"
          nodeBorderRadius={10}
          maskColor="rgba(242,242,242,0.72)"
          nodeColor={(n) => (n.type === "version" ? "#BFEFD3" : n.type === "context" ? "#E9E9E9" : (n.data as AnyNodeData).processing ? "#D9D3FB" : "#FFFFFF")}
          nodeStrokeColor={(n) => ((n.data as AnyNodeData).processing ? "#7262EA" : "#3A3A3A")}
          nodeStrokeWidth={2}
        />
        <Controls className="ae-controls" showInteractive={false} showFitView={false} position="bottom-left" aria-label="Controles del lienzo">
          <ControlButton onClick={() => fitStage("todo")} title="Ver todo el diagrama (0)" aria-label="Ver todo el diagrama">
            <Expand size={14} />
          </ControlButton>
        </Controls>
      </ReactFlow>
    </div>
  );
}
