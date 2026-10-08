/**
 * <AutoEditor/>: el editor completo como componente montable.
 *
 * No asume que es dueño de la página: vive dentro de un contenedor raíz `.ae-root` (altura 100 %),
 * sus estilos llevan el prefijo `ae-` (importa "@autoeditor/editor/styles.css") y sus capas
 * flotantes se dibujan dentro de su propia raíz.
 *
 * Uso:
 *   <AutoEditor apiBaseUrl="/api/v1" ownerId="usuario-123" headers={() => ({ Authorization: token })} onEvent={console.log} />
 */
import clsx from "clsx";
import { MotionConfig } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createApiClient } from "./api/client.js";
import type { ApiClient, HeadersInput } from "./api/types.js";
import { createDemoApi } from "./demo/demoApi.js";
import { EditorScreen } from "./screens/Editor.js";
import { HomeScreen } from "./screens/Home.js";
import { createController, type AutoEditorEvent } from "./store/controller.js";
import { EditorProvider, useEditor, useEditorContext, useEditorShallow } from "./store/context.js";
import { createEditorStore } from "./store/editorStore.js";
import { PortalContext, Toasts } from "./ui/index.js";

export interface AutoEditorProps {
  /** Prefijo de la API (por defecto "/api/v1"). */
  apiBaseUrl?: string;
  /** Dueño de los datos (se manda como X-Owner-Id). */
  ownerId?: string;
  /** Encabezados extra para cada petición (p. ej. el token de la app anfitriona). */
  headers?: HeadersInput;
  /** Eventos para la app anfitriona (proyecto abierto, versión creada, errores…). */
  onEvent?: (event: AutoEditorEvent) => void;
  /** "hash" sincroniza la ruta con location.hash (#/proyecto/:id); "memory" no toca la URL. */
  routing?: "hash" | "memory";
  /** Abre directamente este proyecto. */
  projectId?: string;
  /** Fuerza el modo demo de la interfaz (también con ?demo-ui=1 en la URL). */
  demo?: boolean;
  /**
   * Solo demo: carpeta con videos de ejemplo (v1.mp4, v2.mp4, poster-v1.jpg…). Si no existen, cada
   * versión usa el clip que subió la persona.
   */
  demoMediaBaseUrl?: string;
  className?: string;
  style?: CSSProperties;
}

function urlWantsDemo(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("demo-ui") === "1";
}

/** Opciones de la API simulada: carpeta de medios y velocidad (?demo-rapido=1 acelera los procesos). */
function demoOptions(mediaBaseUrl: string | undefined) {
  const fast = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("demo-rapido") === "1";
  return { mediaBaseUrl, timeScale: fast ? 0.2 : 1 };
}

function parseHash(): { name: "inicio" } | { name: "editor"; projectId: string } | null {
  if (typeof window === "undefined") return null;
  const h = window.location.hash.replace(/^#\/?/, "");
  if (!h) return null;
  const m = /^proyecto\/([^/?#]+)/.exec(h);
  if (m) return { name: "editor", projectId: decodeURIComponent(m[1]!) };
  if (h.startsWith("inicio")) return { name: "inicio" };
  return null;
}

export function AutoEditor({ apiBaseUrl = "/api/v1", ownerId, headers, onEvent, routing = "memory", projectId, demo, demoMediaBaseUrl, className, style }: AutoEditorProps) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const instance = useMemo(() => {
    const wantDemo = demo ?? urlWantsDemo();
    const apiRef: { current: ApiClient } = { current: wantDemo ? createDemoApi(demoOptions(demoMediaBaseUrl)) : createApiClient({ baseUrl: apiBaseUrl, ownerId, headers }) };
    const store = createEditorStore({ demo: wantDemo });
    const controller = createController(store, () => apiRef.current, { onEvent: (e) => onEventRef.current?.(e) });
    return { store, controller, apiRef, getApi: () => apiRef.current };
    // Se crea una sola vez por montaje (las props de conexión se leen al montar).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  /** Mientras se resuelve la ruta inicial mostramos un cargador (evita ver el inicio un instante). */
  const [booted, setBooted] = useState(false);

  const ctx = useMemo(() => ({ store: instance.store, controller: instance.controller, getApi: instance.getApi }), [instance]);

  const enterDemo = useCallback(async () => {
    instance.apiRef.current = createDemoApi(demoOptions(demoMediaBaseUrl));
    instance.store.getState().set({ demo: true });
    await instance.controller.init();
  }, [instance, demoMediaBaseUrl]);

  // Arranque + ruta inicial.
  useEffect(() => {
    const { controller, store } = instance;
    let alive = true;
    void (async () => {
      await controller.init();
      if (!alive) return;
      const fromHash = routing === "hash" ? parseHash() : null;
      // Sin proyecto en la ruta se arranca en el inicio ("Nuevo video" + recientes), también en la demo.
      if (projectId) await controller.openProject(projectId);
      else if (fromHash?.name === "editor") await controller.openProject(fromHash.projectId);
      if (alive) setBooted(true);
    })();
    return () => {
      alive = false;
      controller.dispose();
    };
  }, [instance, routing, projectId]);

  // Ruta ↔ hash (solo si routing="hash").
  useEffect(() => {
    if (routing !== "hash" || typeof window === "undefined") return;
    const unsub = instance.store.subscribe((s, prev) => {
      if (s.route === prev.route) return;
      const target = s.route.name === "editor" ? `#/proyecto/${encodeURIComponent(s.route.projectId)}` : "#/inicio";
      if (window.location.hash !== target) window.history.pushState(null, "", `${window.location.pathname}${window.location.search}${target}`);
    });
    const onHash = () => {
      const r = parseHash();
      const cur = instance.store.getState().route;
      if (r?.name === "editor" && (cur.name !== "editor" || cur.projectId !== r.projectId)) void instance.controller.openProject(r.projectId);
      else if ((!r || r.name === "inicio") && cur.name === "editor") void instance.controller.closeProject();
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onHash);
    return () => {
      unsub();
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
    };
  }, [instance, routing]);

  return (
    <div className={clsx("ae-root", className)} style={style}>
      <MotionConfig reducedMotion="user">
        <PortalContext.Provider value={portal}>
          <EditorProvider value={ctx}>
            {booted ? <Screens onDemo={() => void enterDemo()} onRetry={() => void instance.controller.init()} /> : <BootScreen />}
            <ToastLayer />
          </EditorProvider>
        </PortalContext.Provider>
      </MotionConfig>
      <div className="ae-portal" ref={setPortal} />
    </div>
  );
}

function Screens({ onDemo, onRetry }: { onDemo: () => void; onRetry: () => void }) {
  const { route, hasProject } = useEditorShallow((s) => ({ route: s.route, hasProject: !!s.project }));
  if (route.name === "editor" && hasProject) return <EditorScreen />;
  return <HomeScreen onDemo={onDemo} onRetry={onRetry} />;
}

function BootScreen() {
  return (
    <div className="ae-boot" role="status" aria-live="polite">
      <span className="ae-logo__mark ae-boot__mark" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      <span className="ae-boot__text">Abriendo Autoeditor…</span>
    </div>
  );
}

function ToastLayer() {
  const toasts = useEditor((s) => s.toasts);
  const { store } = useEditorContext();
  const dismiss = useCallback((id: string) => store.getState().dismissToast(id), [store]);
  return <Toasts toasts={toasts} onDismiss={dismiss} />;
}
