/**
 * Capas flotantes: FocusOverlay/Modal (Esc para cerrar, trampa de foco, devuelve el foco al salir),
 * Popover anclado y Toasts.
 */
import clsx from "clsx";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Portal } from "./portal.js";

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Atrapa el foco dentro de `ref` mientras está montado; Esc llama a onClose. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, onClose: () => void, active = true) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    const previous = document.activeElement as HTMLElement | null;
    const first = el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el).focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("keydown", onKey);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [ref, active]);
}

// ---------------------------------------------------------------------------- FocusOverlay

export function FocusOverlay({ open, onClose, title, children, actions, label }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; actions?: ReactNode; label: string }) {
  const reduce = useReducedMotion();
  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <motion.div
            className="ae-focus"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.18 }}
          >
            <FocusPanel onClose={onClose} title={title} actions={actions} label={label} reduce={!!reduce}>
              {children}
            </FocusPanel>
          </motion.div>
        )}
      </AnimatePresence>
    </Portal>
  );
}

function FocusPanel({ onClose, title, actions, children, label, reduce }: { onClose: () => void; title: ReactNode; actions?: ReactNode; children: ReactNode; label: string; reduce: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose);
  return (
    <motion.div
      ref={ref}
      className="ae-focus__panel"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      initial={{ opacity: 0, y: reduce ? 0 : 16, scale: reduce ? 1 : 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: reduce ? 0 : 8, scale: reduce ? 1 : 0.99 }}
      transition={{ duration: reduce ? 0 : 0.22, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <header className="ae-focus__head">
        <div className="ae-focus__title">{title}</div>
        <div className="ae-focus__actions">
          {actions}
          <button type="button" className="ae-focus__close" onClick={onClose} aria-label="Cerrar y volver al diagrama (Esc)">
            <span className="ae-focus__esc">Esc</span>
            <X size={18} aria-hidden />
          </button>
        </div>
      </header>
      <div className="ae-focus__body">{children}</div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------- Modal (diálogo pequeño)

export function Modal({ open, onClose, title, children, footer, width = 460 }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; width?: number }) {
  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <motion.div className="ae-modal" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <ModalPanel onClose={onClose} title={title} footer={footer} width={width}>
              {children}
            </ModalPanel>
          </motion.div>
        )}
      </AnimatePresence>
    </Portal>
  );
}

function ModalPanel({ onClose, title, children, footer, width }: { onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose);
  return (
    <motion.div
      ref={ref}
      className="ae-modal__panel"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{ maxWidth: width }}
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.18 }}
    >
      <header className="ae-modal__head">
        <h2>{title}</h2>
        <button type="button" className="ae-modal__close" onClick={onClose} aria-label="Cerrar">
          <X size={18} aria-hidden />
        </button>
      </header>
      <div className="ae-modal__body">{children}</div>
      {footer && <footer className="ae-modal__foot">{footer}</footer>}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------- Popover

/** Panel anclado bajo su disparador; se cierra con Esc o clic afuera. */
export function Popover({ open, onClose, anchor, children, align = "end", className, label }: { open: boolean; onClose: () => void; anchor: RefObject<HTMLElement | null>; children: ReactNode; align?: "start" | "end" | "center"; className?: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        anchor.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchor]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={ref}
          role="dialog"
          aria-label={label}
          className={clsx("ae-popover", `ae-popover--${align}`, className)}
          initial={{ opacity: 0, y: -4, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4, scale: 0.98 }}
          transition={{ duration: 0.14 }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------- Toasts

export interface ToastView {
  id: string;
  kind: "info" | "exito" | "error";
  text: string;
  action?: { label: string; run: () => void };
}

export function Toasts({ toasts, onDismiss }: { toasts: ToastView[]; onDismiss: (id: string) => void }) {
  return (
    <div className="ae-toasts" role="region" aria-live="polite" aria-label="Notificaciones">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: ToastView; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const ms = toast.kind === "error" ? 7000 : 4000;
    const timer = setTimeout(() => onDismiss(toast.id), ms);
    return () => clearTimeout(timer);
  }, [toast.id, toast.kind, onDismiss]);
  const Icon = toast.kind === "exito" ? CircleCheck : toast.kind === "error" ? CircleAlert : Info;
  return (
    <motion.div
      layout
      className={clsx("ae-toast", `ae-toast--${toast.kind}`)}
      role={toast.kind === "error" ? "alert" : "status"}
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98 }}
      transition={{ duration: 0.18 }}
    >
      <Icon size={16} aria-hidden />
      <span className="ae-toast__text">{toast.text}</span>
      {toast.action && (
        <button
          type="button"
          className="ae-toast__action"
          onClick={() => {
            toast.action?.run();
            onDismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" className="ae-toast__close" onClick={() => onDismiss(toast.id)} aria-label="Cerrar notificación">
        <X size={14} aria-hidden />
      </button>
    </motion.div>
  );
}
