/**
 * buildGraph(state) → { nodes, edges }
 *
 * Función PURA que traduce el estado del proyecto al diagrama: etapas de izquierda a derecha,
 * chips/nodos de los interruptores de contexto, el nodo PLAN (solo con "Revisar plan") y una
 * tarjeta por versión (V1 → V2 → V3…) con la corrección escrita sobre la flecha.
 * Las posiciones NO se calculan aquí (eso lo hace `layout.ts` con elkjs); solo se dan tamaños
 * estimados para el primer acomodo y para las pruebas.
 */
import { deriveEngines, type Job, type PipelineStage, type ToolKey } from "@autoeditor/shared";
import { CONTEXT_KEYS, type ContextKey, type NodeStatus, type StageId } from "../lib/stages.js";
import { stageStates, type StageInput } from "../store/derive.js";

export type FlowNodeType = "material" | "context" | "transcripcion" | "herramientas" | "instruccion" | "plan" | "resultado" | "version" | "stack";

export interface BaseNodeData extends Record<string, unknown> {
  stage: StageId;
  status: NodeStatus;
  hint: string;
  /** Esta etapa es la que se está procesando ahora (se ilumina). */
  processing: boolean;
}

export interface ContextNodeData extends BaseNodeData {
  contextKey: ContextKey;
  enabled: boolean;
}

export interface ToolsNodeData extends BaseNodeData {
  enabledTools: ToolKey[];
  engines: { kie: boolean; hyperframes: boolean; remotion: boolean };
}

export interface VersionNodeData extends BaseNodeData {
  versionId: string;
  number: number;
  latest: boolean;
}

export interface ResultNodeData extends BaseNodeData {
  /** "vacio" antes de generar, "proceso" con un trabajo activo, "pendiente" = versión nueva en proceso. */
  mode: "vacio" | "proceso" | "pendiente";
  /** Número de la versión que se está creando (para "pendiente"). */
  nextNumber: number;
}

export interface StackNodeData extends BaseNodeData {
  count: number;
  fromNumber: number;
  toNumber: number;
}

export type AnyNodeData = BaseNodeData | ContextNodeData | ToolsNodeData | VersionNodeData | ResultNodeData | StackNodeData;

export interface GraphNode<D extends AnyNodeData = AnyNodeData> {
  id: string;
  type: FlowNodeType;
  /** Tamaño estimado (antes de medir el DOM). */
  width: number;
  height: number;
  data: D;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** Texto sobre la flecha (corrección que originó la versión). */
  label?: string;
  /** Flecha de la etapa en proceso (animada). */
  animated: boolean;
  /** Rama inactiva (interruptor apagado): se dibuja tenue y punteada. */
  muted: boolean;
}

export interface GraphInput extends StageInput {
  showAllVersions: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Cuántas versiones se muestran desplegadas; el resto se apila. */
export const VISIBLE_VERSIONS = 3;

export const ESTIMATED_SIZES: Record<FlowNodeType | "context-chip", { width: number; height: number }> = {
  material: { width: 312, height: 420 },
  "context-chip": { width: 168, height: 44 },
  context: { width: 296, height: 330 },
  transcripcion: { width: 296, height: 360 },
  herramientas: { width: 324, height: 520 },
  instruccion: { width: 328, height: 520 },
  plan: { width: 280, height: 340 },
  resultado: { width: 260, height: 500 },
  version: { width: 264, height: 560 },
  stack: { width: 176, height: 210 },
};

const isActive = (job: Job | null): job is Job => !!job && (job.status === "corriendo" || job.status === "en-cola" || job.status === "esperando");

/** Nodo que se ilumina según la etapa del trabajo en curso. */
function processingNodeFor(stage: PipelineStage | null, hasPlan: boolean, resultId: string): string | null {
  switch (stage) {
    case "analizando":
      return "material";
    case "transcribiendo":
      return "transcripcion";
    case "planeando":
      return hasPlan ? "plan" : resultId;
    case "esperando-aprobacion":
      return hasPlan ? "plan" : null;
    case "generando-ia":
    case "motion-graphics":
      return "herramientas";
    case "render":
    case "revision-calidad":
      return resultId;
    default:
      return null;
  }
}

export function buildGraph(input: GraphInput): Graph {
  const { settings, versions, activeJob, showAllVersions } = input;
  const states = stageStates(input);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const job = isActive(activeJob) ? activeJob : null;
  const hasPlan = settings.instruction.reviewPlan;
  const sorted = [...versions].sort((a, b) => a.number - b.number);
  // Con versiones existentes, cualquier trabajo que crea una versión (generar de nuevo, corregir,
  // re-render) se muestra como una tarjeta "Vn · en proceso".
  const correcting = !!job && sorted.length > 0 && (job.type === "generar" || job.type === "corregir" || job.type === "re-render");
  const resultId = sorted.length === 0 ? "resultado" : correcting ? "version-pendiente" : `version-${sorted[sorted.length - 1]!.id}`;
  const processingId = job ? (processingNodeFor(job.stage, hasPlan, resultId) ?? (job.type === "generar" ? resultId : null)) : null;

  const base = (stage: StageId, id: string): BaseNodeData => ({
    stage,
    status: processingId === id ? "procesando" : states[stage].status,
    hint: states[stage].hint,
    processing: processingId === id,
  });
  const edge = (source: string, target: string, extra: Partial<GraphEdge> = {}): GraphEdge => ({
    id: `${source}->${target}`,
    source,
    target,
    animated: processingId === target,
    muted: false,
    ...extra,
  });

  // 1) MATERIAL
  nodes.push({ id: "material", type: "material", ...ESTIMATED_SIZES.material, data: base("material", "material") });

  // 2) CONTEXTO: un chip por interruptor apagado o un nodo desplegado si está prendido
  for (const key of CONTEXT_KEYS) {
    const enabled = settings.context[key].enabled;
    const id = `ctx-${key}`;
    const size = enabled ? ESTIMATED_SIZES.context : ESTIMATED_SIZES["context-chip"];
    const data: ContextNodeData = { ...base("contexto", id), contextKey: key, enabled };
    if (!enabled) data.status = "opcional";
    nodes.push({ id, type: "context", ...size, data });
    edges.push(edge("material", id, { muted: !enabled }));
    edges.push(edge(id, "transcripcion", { muted: !enabled }));
  }

  // 3) TRANSCRIPCIÓN
  nodes.push({ id: "transcripcion", type: "transcripcion", ...ESTIMATED_SIZES.transcripcion, data: base("transcripcion", "transcripcion") });

  // 4) HERRAMIENTAS (las prendidas viven dentro de la etapa, con el recuadro de motores)
  const enabledTools = (Object.keys(settings.tools) as ToolKey[]).filter((k) => settings.tools[k].enabled);
  const toolsData: ToolsNodeData = { ...base("herramientas", "herramientas"), enabledTools, engines: deriveEngines(settings) };
  nodes.push({ id: "herramientas", type: "herramientas", ...ESTIMATED_SIZES.herramientas, data: toolsData });
  edges.push(edge("transcripcion", "herramientas"));

  // 5) INSTRUCCIÓN
  nodes.push({ id: "instruccion", type: "instruccion", ...ESTIMATED_SIZES.instruccion, data: base("instruccion", "instruccion") });
  edges.push(edge("herramientas", "instruccion"));

  // 6) PLAN (solo con "Revisar plan antes de renderizar")
  let tail = "instruccion";
  if (hasPlan) {
    nodes.push({ id: "plan", type: "plan", ...ESTIMATED_SIZES.plan, data: base("plan", "plan") });
    edges.push(edge("instruccion", "plan"));
    tail = "plan";
  }

  // 7) RESULTADO y VERSIONES
  if (sorted.length === 0) {
    const data: ResultNodeData = { ...base("resultado", "resultado"), mode: job ? "proceso" : "vacio", nextNumber: 1 };
    nodes.push({ id: "resultado", type: "resultado", ...ESTIMATED_SIZES.resultado, data });
    edges.push(edge(tail, "resultado"));
    return { nodes, edges };
  }

  const visible = showAllVersions ? sorted : sorted.slice(-VISIBLE_VERSIONS);
  const hidden = sorted.slice(0, sorted.length - visible.length);
  const nodeIdOf = new Map<string, string>();
  let prev = tail;

  if (hidden.length > 0) {
    const data: StackNodeData = {
      ...base("versiones", "versions-stack"),
      status: "listo",
      count: hidden.length,
      fromNumber: hidden[0]!.number,
      toNumber: hidden[hidden.length - 1]!.number,
    };
    nodes.push({ id: "versions-stack", type: "stack", ...ESTIMATED_SIZES.stack, data });
    edges.push(edge(tail, "versions-stack"));
    for (const v of hidden) nodeIdOf.set(v.id, "versions-stack");
    prev = "versions-stack";
  }

  const latestId = sorted[sorted.length - 1]!.id;
  visible.forEach((v, i) => {
    const id = `version-${v.id}`;
    const stage: StageId = v.number === 1 ? "resultado" : "versiones";
    const data: VersionNodeData = {
      ...base(stage, id),
      status: processingId === id ? "procesando" : v.status === "error" ? "error" : v.status === "renderizando" ? "procesando" : "listo",
      hint: v.status === "error" ? "El render falló." : v.status === "renderizando" ? "Renderizando…" : v.changeSummary || "Lista para ver y exportar.",
      versionId: v.id,
      number: v.number,
      latest: v.id === latestId && !correcting,
    };
    nodes.push({ id, type: "version", ...ESTIMATED_SIZES.version, data });
    // Se conecta desde su versión madre (si está visible o apilada). Una versión sin madre es una
    // generación nueva: sale de INSTRUCCIÓN (o del PLAN).
    const parentNode = v.parentId ? nodeIdOf.get(v.parentId) : undefined;
    const source = parentNode ?? (!v.parentId && v.number > 1 ? tail : i === 0 ? prev : `version-${visible[i - 1]!.id}`);
    edges.push(edge(source, id, v.correction ? { label: v.correction } : {}));
    nodeIdOf.set(v.id, id);
  });

  if (correcting && job && job.type === "generar") {
    const data: ResultNodeData = {
      ...base("resultado", "version-pendiente"),
      status: job.status === "esperando" ? "esperando" : "procesando",
      hint: job.message || "Generando una versión nueva…",
      mode: "pendiente",
      nextNumber: sorted[sorted.length - 1]!.number + 1,
    };
    nodes.push({ id: "version-pendiente", type: "resultado", ...ESTIMATED_SIZES.resultado, data });
    edges.push(edge(tail, "version-pendiente", { animated: true }));
  } else if (correcting && job) {
    const fromVersion = typeof job.input.versionId === "string" ? job.input.versionId : latestId;
    const correction = typeof job.input.text === "string" ? job.input.text : typeof job.input.correction === "string" ? job.input.correction : undefined;
    const data: ResultNodeData = {
      ...base("versiones", "version-pendiente"),
      status: job.status === "esperando" ? "esperando" : "procesando",
      hint: job.message || "Aplicando tu corrección…",
      mode: "pendiente",
      nextNumber: sorted[sorted.length - 1]!.number + 1,
    };
    nodes.push({ id: "version-pendiente", type: "resultado", ...ESTIMATED_SIZES.resultado, data });
    edges.push(edge(nodeIdOf.get(fromVersion) ?? `version-${latestId}`, "version-pendiente", { label: correction, animated: true }));
  }

  return { nodes, edges };
}

/** Etapa de cada nodo (para el stepper y la vista enfocada). */
export function stageOfNode(node: Pick<GraphNode, "data">): StageId {
  return node.data.stage;
}
