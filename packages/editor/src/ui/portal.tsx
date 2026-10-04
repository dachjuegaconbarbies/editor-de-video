/**
 * Portal dentro de la raíz del editor (no en document.body) para que los estilos con prefijo
 * `.ae-` sigan aplicando y el editor no ensucie la página anfitriona.
 */
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const PortalContext = createContext<HTMLElement | null>(null);

export function Portal({ children }: { children: ReactNode }) {
  const target = useContext(PortalContext);
  if (!target) return null;
  return createPortal(children, target);
}
