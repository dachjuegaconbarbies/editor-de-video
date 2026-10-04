/**
 * Conector del diagrama: gris, en ángulo recto (smoothstep) y con flecha.
 * - animated: la etapa que se está procesando (trazo morado en movimiento).
 * - muted: rama de un interruptor apagado (tenue y punteada).
 * - label: la corrección que originó la versión, escrita sobre la flecha (post-it coral).
 */
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps, type EdgeTypes } from "@xyflow/react";
import clsx from "clsx";
import { memo } from "react";

export interface FlowEdgeData extends Record<string, unknown> {
  label?: string;
  animated: boolean;
  muted: boolean;
}

/** Tamaño aproximado de la etiqueta (para reservar su espacio en el acomodo). */
export function labelSize(text: string): { width: number; height: number } {
  const charW = 6.6;
  const maxW = 176;
  const width = Math.min(maxW, Math.max(80, text.length * charW + 28));
  const lines = Math.min(3, Math.max(1, Math.ceil((text.length * charW) / (maxW - 28))));
  return { width, height: lines * 16 + 30 };
}

const FlowEdge = memo(function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps<Edge<FlowEdgeData>>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 14, offset: 24 });
  const label = data?.label;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={clsx("ae-edge", data?.animated && "is-animated", data?.muted && "is-muted")} />
      {label && (
        <EdgeLabelRenderer>
          <div className="ae-edge-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, maxWidth: labelSize(label).width }} title={label}>
            <span className="ae-edge-label__kicker">Corrección</span>
            <span className="ae-edge-label__text">{label}</span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const edgeTypes: EdgeTypes = { flow: FlowEdge } as EdgeTypes;
