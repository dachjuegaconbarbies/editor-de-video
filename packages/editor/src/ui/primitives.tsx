/**
 * Piezas pequeñas del sistema visual: StatusBadge, Chip, PostIt, ProgressBar, EmptyState, Tooltip,
 * Kbd y Field. Todas con prefijo `ae-` en sus clases.
 */
import clsx from "clsx";
import { CircleAlert, CircleCheck, Hourglass, LoaderCircle, X } from "lucide-react";
import { useId, type HTMLAttributes, type ReactNode } from "react";
import { STATUS_LABELS, type NodeStatus } from "../lib/stages.js";

// ---------------------------------------------------------------------------- StatusBadge

export function StatusBadge({ status, label, className }: { status: NodeStatus; label?: string; className?: string }) {
  const icon =
    status === "procesando" ? (
      <LoaderCircle className="ae-spin" size={12} aria-hidden />
    ) : status === "listo" ? (
      <CircleCheck size={12} aria-hidden />
    ) : status === "error" ? (
      <CircleAlert size={12} aria-hidden />
    ) : status === "esperando" ? (
      <Hourglass size={12} aria-hidden />
    ) : (
      <span className="ae-badge__dot" aria-hidden />
    );
  return (
    <span className={clsx("ae-badge", `ae-badge--${status}`, className)}>
      {icon}
      <span>{label ?? STATUS_LABELS[status]}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------- Chip

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: "neutral" | "ink" | "purple" | "mint" | "coral" | "peach" | "yellow" | "outline";
  icon?: ReactNode;
  onRemove?: () => void;
  removeLabel?: string;
  size?: "sm" | "md";
}

export function Chip({ tone = "neutral", icon, onRemove, removeLabel = "Quitar", size = "md", className, children, ...rest }: ChipProps) {
  return (
    <span className={clsx("ae-chip", `ae-chip--${tone}`, `ae-chip--${size}`, className)} {...rest}>
      {icon}
      <span className="ae-chip__text">{children}</span>
      {onRemove && (
        <button type="button" className="ae-chip__remove" onClick={onRemove} aria-label={removeLabel} title={removeLabel}>
          <X size={12} aria-hidden />
        </button>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------- PostIt

export function PostIt({ children, className, tilt = 0, title }: { children: ReactNode; className?: string; tilt?: number; title?: string }) {
  return (
    <div className={clsx("ae-postit", className)} style={tilt ? { transform: `rotate(${tilt}deg)` } : undefined}>
      {title && <div className="ae-postit__title">{title}</div>}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------- ProgressBar

export function ProgressBar({ value, label, tone = "purple", size = "md", className }: { value: number | null; label?: string; tone?: "purple" | "mint" | "coral" | "ink"; size?: "sm" | "md"; className?: string }) {
  const pct = value == null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className={clsx("ae-progress", `ae-progress--${tone}`, `ae-progress--${size}`, pct == null && "is-indeterminate", className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
    >
      <div className="ae-progress__bar" style={pct == null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------- EmptyState

export function EmptyState({ icon, title, children, action, compact, className }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; compact?: boolean; className?: string }) {
  return (
    <div className={clsx("ae-empty", compact && "ae-empty--compact", className)}>
      {icon && <div className="ae-empty__icon">{icon}</div>}
      <div className="ae-empty__title">{title}</div>
      {children && <div className="ae-empty__text">{children}</div>}
      {action && <div className="ae-empty__action">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------- Tooltip

/**
 * Tooltip ligero (CSS): aparece al pasar el mouse o con foco de teclado.
 * Envuelve al elemento que lo dispara; el texto también queda como descripción accesible.
 */
export function Tooltip({ text, children, side = "top", className }: { text: ReactNode; children: ReactNode; side?: "top" | "bottom" | "right" | "left"; className?: string }) {
  const id = useId();
  return (
    <span className={clsx("ae-tip", `ae-tip--${side}`, className)} aria-describedby={id}>
      {children}
      <span role="tooltip" id={id} className="ae-tip__bubble">
        {text}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------- Kbd

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ae-kbd">{children}</kbd>;
}

// ---------------------------------------------------------------------------- Field

export function Field({ label, hint, children, className, htmlFor }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={clsx("ae-field", className)}>
      <label className="ae-field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <div className="ae-field__hint">{hint}</div>}
    </div>
  );
}

/** Título pequeño en mayúsculas para secciones dentro de una tarjeta. */
export function SectionLabel({ children, extra, className }: { children: ReactNode; extra?: ReactNode; className?: string }) {
  return (
    <div className={clsx("ae-section-label", className)}>
      <span>{children}</span>
      {extra}
    </div>
  );
}
