/**
 * Zona de arrastre: suelta archivos o haz clic / Enter para elegirlos.
 */
import clsx from "clsx";
import { Upload } from "lucide-react";
import { useRef, useState, type DragEvent, type ReactNode } from "react";

export interface DropzoneProps {
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  label: string;
  hint?: string;
  icon?: ReactNode;
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}

export function Dropzone({ onFiles, accept, multiple = true, label, hint, icon, size = "md", disabled, className, children }: DropzoneProps) {
  const input = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const [over, setOver] = useState(false);

  const take = (list: FileList | null) => {
    if (!list || disabled) return;
    const files = Array.from(list);
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  };

  const onDragEnter = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    depth.current++;
    setOver(true);
  };
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    depth.current = 0;
    setOver(false);
    take(e.dataTransfer.files);
  };

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={hint ? `${label}. ${hint}` : label}
      className={clsx("ae-drop", `ae-drop--${size}`, over && "is-over", disabled && "is-disabled", "nodrag", className)}
      onClick={() => !disabled && input.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          input.current?.click();
        }
      }}
      onDragEnter={onDragEnter}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children ?? (
        <>
          <span className="ae-drop__icon" aria-hidden>
            {icon ?? <Upload size={18} />}
          </span>
          <span className="ae-drop__label">{label}</span>
          {hint && <span className="ae-drop__hint">{hint}</span>}
        </>
      )}
      <input
        ref={input}
        type="file"
        hidden
        accept={accept}
        multiple={multiple}
        onChange={(e) => {
          take(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** Hace que cualquier contenedor acepte archivos soltados (sin abrir selector al hacer clic). */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const depth = useRef(0);
  const [over, setOver] = useState(false);
  return {
    over,
    handlers: {
      onDragEnter: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        depth.current++;
        setOver(true);
      },
      onDragOver: (e: DragEvent) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        onFiles(Array.from(e.dataTransfer.files));
      },
    },
  };
}
