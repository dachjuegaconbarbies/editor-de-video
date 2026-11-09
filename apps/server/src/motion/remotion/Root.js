/**
 * Composición única "Graphic": carga el HTML de una plantilla (HTML + GSAP con la timeline pausada en
 * window.__timelines["mg"]) dentro de un iframe y, en cada fotograma, coloca la timeline en el
 * tiempo exacto (frame / fps). Así las mismas plantillas de fábrica funcionan en Remotion, de forma
 * determinista y con fondo transparente. Tamaño, fps y duración llegan por props (calculateMetadata).
 */
import React, { useLayoutEffect, useRef, useState } from "react";
import { Composition, continueRender, delayRender, useCurrentFrame, useVideoConfig } from "remotion";

const Graphic = ({ html }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ref = useRef(null);
  const [handle] = useState(() => delayRender("Cargando la plantilla"));
  const [ready, setReady] = useState(false);

  const seek = () => {
    const win = ref.current?.contentWindow;
    const tl = win?.__timelines?.mg;
    if (!tl) return false;
    tl.pause();
    tl.time(frame / fps, false);
    return true;
  };

  useLayoutEffect(() => {
    if (ready) seek();
  }, [frame, fps, ready]);

  const onLoad = () => {
    const win = ref.current?.contentWindow;
    const fontsReady = win?.document?.fonts?.ready ?? Promise.resolve();
    fontsReady.then(() => {
      seek();
      setReady(true);
      continueRender(handle);
    });
  };

  return React.createElement("iframe", {
    ref,
    srcDoc: html,
    onLoad,
    style: { position: "absolute", inset: 0, width: "100%", height: "100%", border: 0, background: "transparent" },
  });
};

export const Root = () =>
  React.createElement(Composition, {
    id: "Graphic",
    component: Graphic,
    durationInFrames: 30,
    fps: 30,
    width: 1080,
    height: 1920,
    defaultProps: { html: "", durationSeconds: 1, fps: 30, width: 1080, height: 1920 },
    calculateMetadata: ({ props }) => ({
      durationInFrames: Math.max(1, Math.round(props.durationSeconds * props.fps)),
      fps: props.fps,
      width: props.width,
      height: props.height,
    }),
  });
