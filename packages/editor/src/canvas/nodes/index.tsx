/**
 * Tipos de nodo del lienzo (React Flow). Cada uno envuelve el cuerpo "compacto" de su etapa con
 * un puerto de entrada (izquierda) y uno de salida (derecha). Los datos de cada nodo vienen de
 * `buildGraph`; el contenido fino se lee del store.
 */
import { Handle, Position, type Node, type NodeProps, type NodeTypes } from "@xyflow/react";
import clsx from "clsx";
import { memo, type ReactNode } from "react";
import { ContextNodeBody } from "../../stages/context/index.js";
import { InstructionStage } from "../../stages/instruction/index.js";
import { MaterialStage } from "../../stages/material/index.js";
import { PlanStage } from "../../stages/plan/index.js";
import { ResultPlaceholder, VersionCard, VersionStack } from "../../stages/result/index.js";
import { ToolsStage } from "../../stages/tools/index.js";
import { TranscriptionStage } from "../../stages/transcription/index.js";
import type { BaseNodeData, ContextNodeData, ResultNodeData, StackNodeData, ToolsNodeData, VersionNodeData } from "../buildGraph.js";

function Shell({ data, children, className }: { data: BaseNodeData; children: ReactNode; className?: string }) {
  return (
    <div className={clsx("ae-node", data.processing && "is-processing", className)}>
      <Handle type="target" position={Position.Left} isConnectable={false} className="ae-handle" />
      {children}
      <Handle type="source" position={Position.Right} isConnectable={false} className="ae-handle" />
    </div>
  );
}

type N<D extends BaseNodeData> = NodeProps<Node<D>>;

const MaterialNode = memo(function MaterialNode({ data }: N<BaseNodeData>) {
  return (
    <Shell data={data}>
      <MaterialStage variant="compact" />
    </Shell>
  );
});

const ContextNode = memo(function ContextNode({ data }: N<ContextNodeData>) {
  return (
    <Shell data={data} className={data.enabled ? "ae-node--ctx-on" : "ae-node--chip"}>
      <ContextNodeBody contextKey={data.contextKey} enabled={data.enabled} />
    </Shell>
  );
});

const TranscriptionNode = memo(function TranscriptionNode({ data }: N<BaseNodeData>) {
  return (
    <Shell data={data}>
      <TranscriptionStage variant="compact" />
    </Shell>
  );
});

const ToolsNode = memo(function ToolsNode({ data }: N<ToolsNodeData>) {
  return (
    <Shell data={data}>
      <ToolsStage variant="compact" />
    </Shell>
  );
});

const InstructionNode = memo(function InstructionNode({ data }: N<BaseNodeData>) {
  return (
    <Shell data={data}>
      <InstructionStage variant="compact" />
    </Shell>
  );
});

const PlanNode = memo(function PlanNode({ data }: N<BaseNodeData>) {
  return (
    <Shell data={data}>
      <PlanStage variant="compact" />
    </Shell>
  );
});

const ResultNode = memo(function ResultNode({ data }: N<ResultNodeData>) {
  return (
    <Shell data={data}>
      <ResultPlaceholder mode={data.mode} nextNumber={data.nextNumber} status={data.status} hint={data.hint} />
    </Shell>
  );
});

const VersionNode = memo(function VersionNode({ data }: N<VersionNodeData>) {
  return (
    <Shell data={data}>
      <VersionCard versionId={data.versionId} latest={data.latest} />
    </Shell>
  );
});

const StackNode = memo(function StackNode({ data }: N<StackNodeData>) {
  return (
    <Shell data={data}>
      <VersionStack count={data.count} fromNumber={data.fromNumber} toNumber={data.toNumber} />
    </Shell>
  );
});

export const nodeTypes: NodeTypes = {
  material: MaterialNode,
  context: ContextNode,
  transcripcion: TranscriptionNode,
  herramientas: ToolsNode,
  instruccion: InstructionNode,
  plan: PlanNode,
  resultado: ResultNode,
  version: VersionNode,
  stack: StackNode,
} as NodeTypes;
