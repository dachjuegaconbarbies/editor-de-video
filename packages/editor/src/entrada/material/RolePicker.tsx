/**
 * Etiqueta A-ROLL / B-ROLL / MIXTO con opción de corregirla a mano (PATCH role).
 */
import type { Asset } from "@autoeditor/shared";
import clsx from "clsx";
import { Check, ChevronDown } from "lucide-react";
import { useRef, useState } from "react";
import { Popover } from "../../ui/index.js";

type Role = Asset["analysis"]["role"];

const OPTIONS: { value: Exclude<Role, "desconocido">; label: string; help: string }[] = [
  { value: "a-roll", label: "A-roll", help: "Alguien habla: es la toma principal." },
  { value: "b-roll", label: "B-roll", help: "Toma de apoyo: paisaje, producto, detalle. Va de fondo o como corte." },
  { value: "mixto", label: "Mixto", help: "Tiene partes de ambos." },
];

export const ROLE_NAMES: Record<Role, string> = { "a-roll": "A-ROLL", "b-roll": "B-ROLL", mixto: "MIXTO", desconocido: "SIN CLASIFICAR" };

export function RolePicker({ asset, onChange, size = "md" }: { asset: Asset; onChange: (role: Role) => void; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const role = asset.analysis.role;
  const segs = asset.analysis.brollSegments.length;
  return (
    <span className="ae-in-rolepick">
      <button
        ref={anchor}
        type="button"
        className={clsx("ae-in-roletag", `ae-in-roletag--${role}`, `ae-in-roletag--${size}`)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Tipo de toma: ${ROLE_NAMES[role]}. Cambiar`}
        title="¿Está mal? Corrígelo aquí"
        onClick={() => setOpen((v) => !v)}
      >
        {ROLE_NAMES[role]}
        {segs > 0 && role !== "b-roll" && <span className="ae-in-roletag__n">· {segs} B-roll</span>}
        {segs > 0 && role === "b-roll" && <span className="ae-in-roletag__n">· {segs} {segs === 1 ? "toma" : "tomas"}</span>}
        <ChevronDown size={12} aria-hidden />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="start" label="Corregir tipo de toma" className="ae-in-rolepop">
        <div className="ae-in-rolepop__title">¿Qué tipo de toma es?</div>
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            className={clsx("ae-in-rolepop__opt", role === o.value && "is-on")}
            onClick={() => {
              setOpen(false);
              if (o.value !== role) onChange(o.value);
            }}
          >
            <span className={clsx("ae-in-roletag", `ae-in-roletag--${o.value}`, "ae-in-roletag--sm")}>{o.label.toUpperCase()}</span>
            <span className="ae-in-rolepop__help">{o.help}</span>
            {role === o.value && <Check size={14} aria-hidden />}
          </button>
        ))}
      </Popover>
    </span>
  );
}
