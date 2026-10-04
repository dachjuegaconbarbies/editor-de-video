/**
 * StageCard: la "tarjeta-pantalla" de cada etapa.
 * Contenedor vertical redondeado con borde gris oscuro y su título en una etiqueta durazno encima.
 * - variant "compact": en el lienzo (ancho fijo, contenido resumido, botón para abrir en grande).
 * - variant "focus": en la vista enfocada a pantalla completa.
 */
import clsx from "clsx";
import { CircleAlert, Info, Maximize2 } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { NodeStatus } from "../lib/stages.js";
import { StatusBadge } from "./primitives.js";

export interface StageCardProps {
  title: string;
  variant: "compact" | "focus";
  status?: NodeStatus;
  statusLabel?: string;
  /** Qué le falta o qué está pasando (se muestra abajo si está vacío o con error). */
  hint?: string;
  processing?: boolean;
  /** Abre la vista enfocada (solo en compacto). */
  onOpen?: () => void;
  headerExtra?: ReactNode;
  /** Elemento flotante encima de la etiqueta (p. ej. la paleta morada de herramientas). */
  above?: ReactNode;
  footer?: ReactNode;
  width?: number;
  tone?: "default" | "mint" | "dashed";
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

export function StageCard({
  title,
  variant,
  status,
  statusLabel,
  hint,
  processing,
  onOpen,
  headerExtra,
  above,
  footer,
  width,
  tone = "default",
  className,
  bodyClassName,
  children,
}: StageCardProps) {
  const showHint = !!hint && variant === "compact" && (status === "vacio" || status === "error" || status === "esperando");
  const style: CSSProperties | undefined = width ? { width } : undefined;
  return (
    <section className={clsx("ae-stage", `ae-stage--${variant}`, `ae-stage--tone-${tone}`, processing && "is-processing", status && `is-${status}`, className)} style={style} aria-label={title}>
      {above && <div className="ae-stage__above">{above}</div>}
      <div className="ae-stage__tab">
        <span>{title}</span>
      </div>
      <div className="ae-stage__card">
        {(status || headerExtra || onOpen) && (
          <div className="ae-stage__head">
            {status && <StatusBadge status={processing ? "procesando" : status} label={statusLabel} />}
            <div className="ae-stage__head-extra">
              {headerExtra}
              {onOpen && variant === "compact" && (
                <button type="button" className="ae-stage__open nodrag" onClick={onOpen} aria-label={`Abrir ${title} en grande`} title="Abrir en grande (doble clic)">
                  <Maximize2 size={14} aria-hidden />
                </button>
              )}
            </div>
          </div>
        )}
        <div className={clsx("ae-stage__body", bodyClassName)}>{children}</div>
        {showHint && (
          <div className={clsx("ae-stage__hint", status === "error" && "is-error")}>
            {status === "error" ? <CircleAlert size={14} aria-hidden /> : <Info size={14} aria-hidden />}
            <span>{hint}</span>
          </div>
        )}
        {footer && <div className="ae-stage__foot">{footer}</div>}
      </div>
    </section>
  );
}
