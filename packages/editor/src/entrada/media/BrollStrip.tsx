/**
 * Tira de la línea de tiempo de un clip con los fragmentos detectados como B-roll
 * (analysis.brollSegments), los cambios de escena y los silencios. Clic en un fragmento = saltar.
 */
import type { Asset } from "@autoeditor/shared";
import clsx from "clsx";
import { formatDuration } from "../../lib/format.js";

export interface BrollStripProps {
  asset: Asset;
  duration?: number;
  time?: number;
  onSeek?: (t: number) => void;
  size?: "sm" | "md";
  /** Muestra la leyenda y la lista de fragmentos. */
  detailed?: boolean;
  className?: string;
}

export function hasTimeline(asset: Asset): boolean {
  return asset.kind === "video" && (asset.probe.duration ?? 0) > 0 && asset.analysis.status === "listo";
}

export function BrollStrip({ asset, duration: durationProp, time, onSeek, size = "sm", detailed, className }: BrollStripProps) {
  const d = Math.max(0.1, durationProp ?? asset.probe.duration ?? 1);
  const segs = asset.analysis.brollSegments;
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / d) * 100))}%`;
  const wpct = (a: number, b: number) => `${Math.max(0.6, Math.min(100, ((b - a) / d) * 100))}%`;
  const fullBroll = asset.analysis.role === "b-roll" && segs.length === 0;
  return (
    <div className={clsx("ae-in-strip", `ae-in-strip--${size}`, className)}>
      <div className="ae-in-strip__track" aria-label={segs.length ? `${segs.length} fragmentos de B-roll en este clip` : "Línea de tiempo del clip"} role="group">
        {asset.analysis.silences.map(([a, b], i) => (
          <span key={`s${i}`} className="ae-in-strip__silence" style={{ left: pct(a), width: wpct(a, b) }} title={`Silencio ${formatDuration(a)}–${formatDuration(b)}`} />
        ))}
        {fullBroll && <span className="ae-in-strip__seg is-full" style={{ left: 0, width: "100%" }} title="Toda la toma es B-roll" />}
        {segs.map((s, i) => (
          <button
            key={`b${i}`}
            type="button"
            className="ae-in-strip__seg"
            style={{ left: pct(s.start), width: wpct(s.start, s.end), opacity: 0.55 + s.score * 0.45 }}
            title={`B-roll ${formatDuration(s.start)}–${formatDuration(s.end)}${s.description ? ` · ${s.description}` : ""}`}
            aria-label={`Fragmento de B-roll de ${formatDuration(s.start)} a ${formatDuration(s.end)}${s.description ? `: ${s.description}` : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              onSeek?.(s.start);
            }}
            disabled={!onSeek}
          />
        ))}
        {asset.analysis.scenes
          .filter((t) => t > 0.05 && t < d - 0.05)
          .map((t, i) => (
            <span key={`c${i}`} className="ae-in-strip__cut" style={{ left: pct(t) }} aria-hidden />
          ))}
        {time != null && <span className="ae-in-strip__head" style={{ left: pct(time) }} aria-hidden />}
      </div>
      {detailed && (
        <>
          <div className="ae-in-strip__legend">
            <span>
              <i className="is-broll" /> B-roll aprovechable
            </span>
            <span>
              <i className="is-cut" /> Cambio de escena
            </span>
            {asset.analysis.silences.length > 0 && (
              <span>
                <i className="is-silence" /> Silencio
              </span>
            )}
          </div>
          {segs.length > 0 && (
            <ul className="ae-in-strip__list">
              {segs.map((s, i) => (
                <li key={i}>
                  <button type="button" onClick={() => onSeek?.(s.start)} disabled={!onSeek}>
                    <span className="ae-in-strip__range">
                      {formatDuration(s.start)}–{formatDuration(s.end)}
                    </span>
                    <span className="ae-in-strip__desc">{s.description || "Toma de apoyo"}</span>
                    <span className="ae-in-strip__score" title="Qué tan aprovechable es">
                      {Math.round(s.score * 100)}%
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
