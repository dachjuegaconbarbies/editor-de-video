/**
 * Recuadro rosa de motores (Kie AI, HyperFrames, Remotion), cada uno con su banderín ON/OFF.
 * Kie AI se prende solo cuando una herramienta usa IA generativa (deriveEngines).
 */
import clsx from "clsx";
import { OnOffFlag } from "./toggles.js";

export interface EngineView {
  key: "kie" | "hyperframes" | "remotion";
  name: string;
  on: boolean;
  /** Si no se puede cambiar a mano, por qué (se muestra como ayuda). */
  lockedReason?: string;
  note?: string;
  onChange?: (v: boolean) => void;
}

export function EnginesBox({ engines, size = "md", className }: { engines: EngineView[]; size?: "sm" | "md"; className?: string }) {
  return (
    <div className={clsx("ae-engines", `ae-engines--${size}`, className)} role="group" aria-label="Motores">
      <div className="ae-engines__title">Motores</div>
      <div className="ae-engines__row">
        {engines.map((e) => (
          <div key={e.key} className={clsx("ae-engine", e.on && "is-on")}>
            <div className="ae-engine__name" title={e.lockedReason ?? e.note}>
              {e.name}
            </div>
            <OnOffFlag size="sm" checked={e.on} label={e.name} onChange={e.lockedReason ? undefined : e.onChange} title={e.lockedReason ?? e.note} />
            {size === "md" && (e.lockedReason || e.note) && <div className="ae-engine__note">{e.lockedReason ?? e.note}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
