/**
 * Reproductor de un clip (video, audio o imagen) con reloj propio.
 *
 * - Con el servidor: reproduce GET /assets/:id/file (Range) y lee el tiempo con requestAnimationFrame
 *   para que el resaltado palabra por palabra sea fluido.
 * - En la demostración (sin archivo reproducible) simula la reproducción sobre la miniatura: el
 *   tiempo avanza igual, así la transcripción sincronizada se puede probar.
 * - Teclado: Espacio reproduce/pausa; ← / → mueven 2 s.
 */
import type { Asset } from "@autoeditor/shared";
import clsx from "clsx";
import { Pause, Play, RotateCcw } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { formatDuration } from "../../lib/format.js";
import { useApi } from "../../store/context.js";
import { kindIcon } from "../../stages/material/assets.js";

export interface ClipPlayerHandle {
  seek(t: number, play?: boolean): void;
  play(): void;
  pause(): void;
  toggle(): void;
}

export interface ClipPlayerProps {
  asset: Asset;
  /** Se llama en cada cuadro mientras reproduce y al saltar. */
  onTime?: (t: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  /** Duración si el archivo no la trae (p. ej. fin de la última palabra). */
  fallbackDuration?: number;
  /** Capa sobre la imagen (p. ej. subtítulos). */
  overlay?: ReactNode;
  /** Contenido bajo la barra (p. ej. tira de B-roll). */
  below?: (state: { time: number; duration: number; seek: (t: number, play?: boolean) => void }) => ReactNode;
  size?: "md" | "lg";
  className?: string;
  autoFocus?: boolean;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export const ClipPlayer = forwardRef<ClipPlayerHandle, ClipPlayerProps>(function ClipPlayer(
  { asset, onTime, onPlayingChange, fallbackDuration, overlay, below, size = "md", className, autoFocus },
  ref,
) {
  const api = useApi();
  const src = asset.kind === "video" || asset.kind === "audio" ? api.assetFileUrl(asset) : "";
  const poster = api.assetThumbnailUrl(asset);
  const playable = !!src && !src.startsWith("data:image") && !src.endsWith(".svg");
  const [failed, setFailed] = useState(false);
  const simulated = !playable || failed;
  const media = useRef<HTMLVideoElement | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  const duration = Math.max(0.5, mediaDuration ?? asset.probe.duration ?? fallbackDuration ?? 10);
  const sim = useRef({ t: 0, last: 0 });
  const raf = useRef(0);
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;
  const onPlayingRef = useRef(onPlayingChange);
  onPlayingRef.current = onPlayingChange;
  const lastShown = useRef(0);

  const publish = useCallback((t: number, force = false) => {
    onTimeRef.current?.(t);
    if (force || Math.abs(t - lastShown.current) > 0.06) {
      lastShown.current = t;
      setTime(t);
    }
  }, []);

  const setPlay = useCallback((v: boolean) => {
    setPlaying(v);
    onPlayingRef.current?.(v);
  }, []);

  // Reinicia al cambiar de clip.
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    sim.current = { t: 0, last: 0 };
    setFailed(false);
    setMediaDuration(null);
    setPlay(false);
    publish(0, true);
  }, [asset.id, publish, setPlay]);

  // Bucle de tiempo mientras reproduce.
  useEffect(() => {
    if (!playing) return;
    const tick = (now: number) => {
      if (simulated) {
        const s = sim.current;
        const dt = s.last ? (now - s.last) / 1000 : 0;
        s.last = now;
        s.t = Math.min(duration, s.t + dt);
        publish(s.t);
        if (s.t >= duration) {
          setPlay(false);
          return;
        }
      } else if (media.current) {
        publish(media.current.currentTime);
      }
      raf.current = requestAnimationFrame(tick);
    };
    sim.current.last = 0;
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, simulated, duration, publish, setPlay]);

  const seek = useCallback(
    (t: number, play?: boolean) => {
      const v = clamp(t, 0, duration);
      if (simulated) sim.current.t = v;
      else if (media.current) media.current.currentTime = v;
      publish(v, true);
      if (play) {
        if (simulated) setPlay(true);
        else void media.current?.play().catch(() => setFailed(true));
      }
    },
    [duration, simulated, publish, setPlay],
  );

  const play = useCallback(() => {
    if (simulated) {
      if (sim.current.t >= duration - 0.05) sim.current.t = 0;
      setPlay(true);
    } else void media.current?.play().catch(() => setFailed(true));
  }, [simulated, duration, setPlay]);

  const pause = useCallback(() => {
    if (simulated) setPlay(false);
    else media.current?.pause();
  }, [simulated, setPlay]);

  const toggle = useCallback(() => (playing ? pause() : play()), [playing, play, pause]);

  useImperativeHandle(ref, () => ({ seek, play, pause, toggle }), [seek, play, pause, toggle]);

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type !== "range") return;
    if (e.key === " " || e.key === "k") {
      e.preventDefault();
      toggle();
    } else if (e.key === "ArrowRight" && (e.target as HTMLElement).tagName !== "INPUT") {
      e.preventDefault();
      seek(time + 2);
    } else if (e.key === "ArrowLeft" && (e.target as HTMLElement).tagName !== "INPUT") {
      e.preventDefault();
      seek(time - 2);
    }
  };

  const vertical = (asset.probe.height ?? 0) > (asset.probe.width ?? 0);
  const isAudio = asset.kind === "audio";
  const pct = (time / duration) * 100;

  return (
    <div className={clsx("ae-in-player", `ae-in-player--${size}`, vertical && "is-vertical", isAudio && "is-audio", className)} onKeyDown={onKey}>
      <div className="ae-in-player__screen" onClick={toggle} role="presentation">
        {!simulated && asset.kind === "video" ? (
          <video
            ref={media}
            src={src}
            poster={poster ?? undefined}
            preload="metadata"
            playsInline
            onLoadedMetadata={(e) => setMediaDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : null)}
            onPlay={() => setPlay(true)}
            onPause={() => setPlay(false)}
            onEnded={() => setPlay(false)}
            onSeeked={(e) => publish(e.currentTarget.currentTime, true)}
            onError={() => setFailed(true)}
          />
        ) : poster ? (
          <img src={poster} alt="" draggable={false} />
        ) : (
          <span className="ae-in-player__icon">{kindIcon(asset, 28)}</span>
        )}
        {!simulated && isAudio && (
          <audio
            ref={media as unknown as Ref<HTMLAudioElement>}
            src={src}
            preload="metadata"
            onLoadedMetadata={(e) => setMediaDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : null)}
            onPlay={() => setPlay(true)}
            onPause={() => setPlay(false)}
            onEnded={() => setPlay(false)}
            onError={() => setFailed(true)}
          />
        )}
        {isAudio && <Waveform progress={time / duration} seed={asset.id} />}
        {overlay}
        {!playing && (
          <span className="ae-in-player__bigplay" aria-hidden>
            <Play size={size === "lg" ? 26 : 20} fill="currentColor" />
          </span>
        )}
      </div>
      <div className="ae-in-player__bar">
        <button type="button" className="ae-in-player__btn" onClick={toggle} aria-label={playing ? "Pausar (Espacio)" : "Reproducir (Espacio)"} title={playing ? "Pausar (Espacio)" : "Reproducir (Espacio)"} autoFocus={autoFocus}>
          {playing ? <Pause size={16} fill="currentColor" /> : time >= duration - 0.05 ? <RotateCcw size={16} /> : <Play size={16} fill="currentColor" />}
        </button>
        <span className="ae-in-player__time">
          {formatTime(time)} <span>/ {formatDuration(duration)}</span>
        </span>
        <input
          type="range"
          className="ae-in-player__scrub"
          min={0}
          max={duration}
          step={0.05}
          value={time}
          aria-label="Posición del clip"
          aria-valuetext={`${formatTime(time)} de ${formatDuration(duration)}`}
          style={{ ["--ae-pct" as string]: `${pct}%` }}
          onChange={(e) => seek(Number(e.target.value))}
        />
        {simulated && api.isDemo && <span className="ae-in-player__sim" title="En la demostración no hay archivo real: el tiempo avanza simulado.">demo</span>}
      </div>
      {below?.({ time, duration, seek })}
    </div>
  );
});

/** 12.3 → "0:12.3" (con décimas para ubicar palabras). */
export function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

/** Forma de onda decorativa (determinista por id) para audios. */
function Waveform({ progress, seed }: { progress: number; seed: string }) {
  const bars = 48;
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const heights = Array.from({ length: bars }, (_, i) => {
    h = (h * 1103515245 + 12345) >>> 0;
    return 0.25 + ((h >>> 8) % 1000) / 1400 + 0.15 * Math.sin(i / 3);
  });
  return (
    <span className="ae-in-wave" aria-hidden>
      {heights.map((v, i) => (
        <span key={i} className={clsx(i / bars <= progress && "is-played")} style={{ height: `${Math.min(100, v * 100)}%` }} />
      ))}
    </span>
  );
}
