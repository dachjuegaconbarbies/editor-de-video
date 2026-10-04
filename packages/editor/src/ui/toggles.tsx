/**
 * Interruptores del lenguaje visual:
 * - TogglePill: píldora negra "TENGO GUION" (role=switch).
 * - OnOffFlag: banderín coral en forma de flecha con ON/OFF (role=switch, accesible por teclado).
 * - Switch: interruptor pequeño para opciones secundarias ("Revisar plan antes de renderizar").
 * - Segmented: selector rápido de opciones (radiogroup con flechas del teclado).
 */
import clsx from "clsx";
import { Check, Plus } from "lucide-react";
import { useRef, type KeyboardEvent, type ReactNode } from "react";

// ---------------------------------------------------------------------------- TogglePill

export function TogglePill({ label, checked, onChange, icon, size = "md", className }: { label: string; checked: boolean; onChange: (v: boolean) => void; icon?: ReactNode; size?: "sm" | "md"; className?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={clsx("ae-pill", `ae-pill--${size}`, checked && "is-on", className)}
      onClick={() => onChange(!checked)}
    >
      <span className="ae-pill__box" aria-hidden>
        {checked ? <Check size={12} strokeWidth={3} /> : <Plus size={12} strokeWidth={3} />}
      </span>
      {icon}
      <span className="ae-pill__label">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------- OnOffFlag

export function OnOffFlag({
  checked,
  onChange,
  label,
  disabled,
  size = "md",
  title,
  className,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  /** Qué prende/apaga (para lectores de pantalla), p. ej. "Subtítulos". */
  label: string;
  disabled?: boolean;
  size?: "sm" | "md";
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title ?? `${label}: ${checked ? "encendido" : "apagado"}`}
      disabled={disabled || !onChange}
      className={clsx("ae-flag", `ae-flag--${size}`, checked ? "is-on" : "is-off", (disabled || !onChange) && "is-readonly", className)}
      onClick={() => onChange?.(!checked)}
    >
      <span className="ae-flag__on" aria-hidden>
        ON
      </span>
      <span className="ae-flag__sep" aria-hidden>
        /
      </span>
      <span className="ae-flag__off" aria-hidden>
        OFF
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------- Switch

export function Switch({ checked, onChange, label, description, disabled, className }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean; className?: string }) {
  return (
    <label className={clsx("ae-switch", disabled && "is-disabled", className)}>
      <span className="ae-switch__text">
        <span className="ae-switch__label">{label}</span>
        {description && <span className="ae-switch__desc">{description}</span>}
      </span>
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} className={clsx("ae-switch__track", checked && "is-on")} onClick={() => onChange(!checked)}>
        <span className="ae-switch__thumb" />
      </button>
    </label>
  );
}

// ---------------------------------------------------------------------------- Segmented

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = "md",
  className,
  wrap,
}: {
  options: SegmentedOption<T>[];
  value: T | null;
  onChange: (v: T) => void;
  /** Etiqueta accesible del grupo. */
  label: string;
  size?: "sm" | "md";
  className?: string;
  wrap?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const idx = options.findIndex((o) => o.value === value);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = (i + dir + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={clsx("ae-seg", `ae-seg--${size}`, wrap && "ae-seg--wrap", className)}>
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (idx === -1 && i === 0) ? 0 : -1}
            title={o.title}
            className={clsx("ae-seg__opt", selected && "is-selected")}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
