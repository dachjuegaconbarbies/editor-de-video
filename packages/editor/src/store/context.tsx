/**
 * Contexto de React para una instancia del editor: store + API + controlador.
 * Cada <AutoEditor/> tiene el suyo, así se pueden montar varios en la misma página.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { ApiClient } from "../api/types.js";
import { computeEstimate, preflightWarnings, stageStates } from "./derive.js";
import type { Controller } from "./controller.js";
import type { EditorState, EditorStore } from "./editorStore.js";

export interface EditorContextValue {
  store: EditorStore;
  controller: Controller;
  getApi: () => ApiClient;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function EditorProvider({ value, children }: { value: EditorContextValue; children: ReactNode }) {
  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditorContext(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("Los componentes del editor deben usarse dentro de <AutoEditor/>.");
  return ctx;
}

/** Lee del store con un selector (se vuelve a renderizar solo si cambia lo seleccionado). */
export function useEditor<T>(selector: (s: EditorState) => T): T {
  return useStore(useEditorContext().store, selector);
}

/** Igual que useEditor pero compara superficialmente (para objetos/arreglos armados en el selector). */
export function useEditorShallow<T>(selector: (s: EditorState) => T): T {
  return useStore(useEditorContext().store, useShallow(selector));
}

export function useController(): Controller {
  return useEditorContext().controller;
}

export function useApi(): ApiClient {
  return useEditorContext().getApi();
}

export function useActions() {
  return useEditorContext().store.getState();
}

/** Puede deshacer/rehacer (para habilitar botones). */
export function useHistory() {
  const store = useEditorContext().store;
  const past = useStore(store.temporal, (t) => t.pastStates.length);
  const future = useStore(store.temporal, (t) => t.futureStates.length);
  return { canUndo: past > 0, canRedo: future > 0 };
}

export function useActiveJob() {
  return useEditor((s) => (s.activeJobId ? (s.jobs[s.activeJobId] ?? null) : null));
}

export function useStageStates() {
  const { settings, assets, uploads, transcripts, versions, pendingPlan } = useEditorShallow((s) => ({
    settings: s.settings,
    assets: s.assets,
    uploads: s.uploads,
    transcripts: s.transcripts,
    versions: s.versions,
    pendingPlan: s.pendingPlan,
  }));
  const activeJob = useActiveJob();
  return useMemo(
    () => stageStates({ settings, assets, uploads, transcripts, versions, activeJob, pendingPlan }),
    [settings, assets, uploads, transcripts, versions, activeJob, pendingPlan],
  );
}

/** Estimado instantáneo (se recalcula al prender/apagar cualquier cosa). */
export function useEstimate() {
  const { config, settings, assets, transcripts } = useEditorShallow((s) => ({ config: s.config, settings: s.settings, assets: s.assets, transcripts: s.transcripts }));
  return useMemo(() => computeEstimate(config, settings, assets, transcripts), [config, settings, assets, transcripts]);
}

export function useWarnings() {
  const { settings, assets } = useEditorShallow((s) => ({ settings: s.settings, assets: s.assets }));
  return useMemo(() => preflightWarnings(settings, assets), [settings, assets]);
}
