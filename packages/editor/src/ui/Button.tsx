/**
 * Botones del lenguaje visual:
 * - morado = IA / motion graphics / acción principal (GENERAR)
 * - menta = versiones y EXPORTAR
 * - coral = GUARDAR ESTILO y CORRECCIÓN
 * - tinta = interruptores "TENGO …" y acciones neutras fuertes
 */
import clsx from "clsx";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export type ButtonTone = "purple" | "mint" | "coral" | "ink" | "ghost" | "plain";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  size?: ButtonSize;
  icon?: ReactNode;
  iconRight?: ReactNode;
  /** Botón seleccionado (paleta de herramientas). */
  active?: boolean;
  block?: boolean;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tone = "plain", size = "md", icon, iconRight, active, block, loading, className, children, type = "button", disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx("ae-btn", `ae-btn--${tone}`, `ae-btn--${size}`, active && "is-active", block && "ae-btn--block", loading && "is-loading", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="ae-spinner" aria-hidden /> : icon}
      {children != null && <span className="ae-btn__label">{children}</span>}
      {iconRight}
    </button>
  );
});

export const PurpleButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, "tone">>(function PurpleButton(props, ref) {
  return <Button ref={ref} tone="purple" {...props} />;
});
export const MintButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, "tone">>(function MintButton(props, ref) {
  return <Button ref={ref} tone="mint" {...props} />;
});
export const CoralButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, "tone">>(function CoralButton(props, ref) {
  return <Button ref={ref} tone="coral" {...props} />;
});

/** Botón cuadrado solo con icono (con etiqueta accesible obligatoria). */
export const IconButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, "children"> & { label: string }>(function IconButton(
  { label, className, tone = "ghost", size = "sm", ...rest },
  ref,
) {
  return <Button ref={ref} tone={tone} size={size} aria-label={label} title={label} className={clsx("ae-btn--icon", className)} {...rest} />;
});
