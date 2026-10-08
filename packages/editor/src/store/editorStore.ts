/**
 * Store del editor (zustand, una instancia por cada <AutoEditor/> montado).
 *
 * - `settings` es el estado del diagrama (interruptores, herramientas, instrucción). Es lo ÚNICO que
 *   entra al historial de deshacer/rehacer (zundo, con `partialize`).
 * - Los cambios que hace la persona en ráfaga (escribir) se agrupan en un solo paso de deshacer.
 * - Las acciones aquí son síncronas; las que hablan con la API viven en `controller.ts`.
 */
import {
  deriveEngines,
  type Asset,
  type AssetCategory,
  type Job,
  type Keyword,
  type MemoryRule,
  type Plan,
  type Project,
  type ProjectDetail,
  type ProjectSettings,
  type PublicConfig,
  type PublishCopy,
  type ServerEvent,
  type Style,
  type Transcript,
  type Version,
} from "@autoeditor/shared";
import { temporal, type TemporalState } from "zundo";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { StreamStatus } from "../api/types.js";
import { stageStates, suggestedStage } from "./derive.js";
import type { StageId } from "../lib/stages.js";
import { freshSettings } from "../lib/settings.js";

export type Route = { name: "inicio" } | { name: "editor"; projectId: string };
export type ConnectionState = "conectando" | "conectado" | "sin-conexion";
export type SaveStatus = "inactivo" | "pendiente" | "guardando" | "guardado" | "sin-conexion" | "error";

export interface UploadItem {
  id: string;
  category: AssetCategory;
  name: string;
  size: number;
  /** 0..1 */
  progress: number;
  status: "subiendo" | "error";
  error?: string;
}

export interface Toast {
  id: string;
  kind: "info" | "exito" | "error";
  text: string;
  action?: { label: string; run: () => void };
}

export interface RuleSuggestion {
  text: string;
  versionId: string;
  correction: string;
}

/** Pregunta aclaratoria del editor antes de aplicar una corrección ambigua (no se renderiza nada aún). */
export interface ClarifyState {
  versionId: string;
  question: string;
  correction: string;
  at: number | null;
}

/** Qué se muestra en la vista enfocada (pantalla completa). */
export interface FocusState {
  stage: StageId;
  /** Detalle opcional: id de nodo de contexto, id de versión o herramienta. */
  target?: string;
}

export interface EditorData {
  config: PublicConfig | null;
  connection: ConnectionState;
  /** Modo demostración de la interfaz (datos de ejemplo, sin servidor). */
  demo: boolean;
  route: Route;

  projects: Project[];
  projectsLoaded: boolean;
  styles: Style[];

  project: Project | null;
  settings: ProjectSettings;
  assets: Asset[];
  uploads: UploadItem[];
  transcripts: Transcript[];
  keywords: Keyword[];
  publishCopy: PublishCopy | null;
  versions: Version[];
  jobs: Record<string, Job>;
  activeJobId: string | null;
  pendingPlan: Plan | null;
  rules: MemoryRule[];
  stream: StreamStatus;
  save: { status: SaveStatus; at: number | null; error: string | null };

  // UI
  focus: FocusState | null;
  activeStage: StageId;
  panel: "aprendido" | "estimado" | null;
  showAllVersions: boolean;
  toasts: Toast[];
  ruleSuggestion: RuleSuggestion | null;
  /** Herramienta resaltada en la vista de HERRAMIENTAS. */
  selectedTool: string | null;
  /** Pedido al lienzo para encuadrar una etapa (o "todo"); `n` cambia en cada pedido. */
  viewRequest: { target: StageId | "todo"; n: number } | null;
  /** Comparar dos versiones lado a lado (ids de versión). */
  compare: { a: string; b: string } | null;
  /** Pregunta aclaratoria pendiente de una corrección. */
  clarify: ClarifyState | null;
  /** Con un estilo, el diagrama arranca corto; true = mostrar todas las etapas. */
  fullDiagram: boolean;
  /** Último trabajo de generación/corrección que falló (para mostrar el error y "Reintentar"). */
  failedJobId: string | null;
  /** Pantalla del editor: el estudio (principal) o la vista avanzada (diagrama de nodos). */
  view: "estudio" | "avanzada";
}

export interface EditorActions {
  set: (patch: Partial<EditorData>) => void;
  /** Modifica la configuración con una función que muta una copia (se agrega al historial). */
  updateSettings: (mutate: (draft: ProjectSettings) => void) => void;
  setProjectName: (name: string) => void;
  loadProject: (detail: ProjectDetail) => void;
  clearProject: () => void;
  applyEvent: (event: ServerEvent) => void;
  upsertAsset: (asset: Asset) => void;
  removeAsset: (assetId: string) => void;
  upsertUpload: (item: UploadItem) => void;
  removeUpload: (id: string) => void;
  upsertJob: (job: Job) => void;
  upsertVersion: (version: Version) => void;
  setTranscripts: (transcripts: Transcript[]) => void;
  setKeywords: (keywords: Keyword[], publishCopy?: PublishCopy | null) => void;
  toast: (toast: Omit<Toast, "id"> & { id?: string }) => string;
  dismissToast: (id: string) => void;
  openFocus: (stage: StageId, target?: string) => void;
  closeFocus: () => void;
  /** Encuadra una etapa en el lienzo (stepper, atajos) y la marca como actual. */
  requestView: (target: StageId | "todo") => void;
}

export type EditorState = EditorData & EditorActions;
export type EditorStore = StoreApi<EditorState> & { temporal: StoreApi<TemporalState<{ settings: ProjectSettings }>> };

let toastSeq = 0;

export function initialData(overrides: Partial<EditorData> = {}): EditorData {
  return {
    config: null,
    connection: "conectando",
    demo: false,
    route: { name: "inicio" },
    projects: [],
    projectsLoaded: false,
    styles: [],
    project: null,
    settings: freshSettings(),
    assets: [],
    uploads: [],
    transcripts: [],
    keywords: [],
    publishCopy: null,
    versions: [],
    jobs: {},
    activeJobId: null,
    pendingPlan: null,
    rules: [],
    stream: "cerrado",
    save: { status: "inactivo", at: null, error: null },
    focus: null,
    activeStage: "material",
    panel: null,
    showAllVersions: false,
    toasts: [],
    ruleSuggestion: null,
    selectedTool: null,
    viewRequest: null,
    compare: null,
    clarify: null,
    fullDiagram: false,
    failedJobId: null,
    view: "estudio",
    ...overrides,
  };
}

const isActiveJob = (job: Job) => job.status === "en-cola" || job.status === "corriendo" || job.status === "esperando";
const sortVersions = (vs: Version[]) => [...vs].sort((a, b) => a.number - b.number);

/** Agrupa cambios seguidos (p. ej. al escribir) en un solo paso de deshacer. */
const BURST_MS = 700;

export function createEditorStore(overrides: Partial<EditorData> = {}): EditorStore {
  const store = createStore<EditorState>()(
    temporal(
      (set, get) => ({
        ...initialData(overrides),

        set: (patch) => set(patch),

        updateSettings: (mutate) => {
          const draft = structuredClone(get().settings);
          mutate(draft);
          // Los motores se derivan de las herramientas (p. ej. IA imágenes prende Kie AI).
          draft.engines = deriveEngines(draft);
          set({ settings: draft });
        },

        setProjectName: (name) => {
          const project = get().project;
          if (!project) return;
          set({ project: { ...project, name } });
        },

        loadProject: (detail) => {
          const t = (store as unknown as EditorStore).temporal.getState();
          t.pause();
          const jobs: Record<string, Job> = {};
          if (detail.activeJob) jobs[detail.activeJob.id] = detail.activeJob;
          const activeJob = detail.activeJob && isActiveJob(detail.activeJob) ? detail.activeJob : null;
          const states = stageStates({ settings: detail.project.settings, assets: detail.assets, uploads: [], transcripts: [], versions: detail.versions, activeJob, pendingPlan: detail.pendingPlan });
          set({
            activeStage: suggestedStage(states, detail.project.settings),
            project: detail.project,
            settings: detail.project.settings,
            assets: detail.assets,
            versions: sortVersions(detail.versions),
            jobs,
            activeJobId: detail.activeJob && isActiveJob(detail.activeJob) ? detail.activeJob.id : null,
            pendingPlan: detail.pendingPlan,
            uploads: [],
            focus: null,
            showAllVersions: false,
            save: { status: "guardado", at: Date.parse(detail.project.updatedAt) || Date.now(), error: null },
          });
          t.resume();
          t.clear();
        },

        clearProject: () => {
          const t = (store as unknown as EditorStore).temporal.getState();
          t.pause();
          set({
            project: null,
            settings: freshSettings(),
            assets: [],
            uploads: [],
            transcripts: [],
            keywords: [],
            publishCopy: null,
            versions: [],
            jobs: {},
            activeJobId: null,
            pendingPlan: null,
            focus: null,
            stream: "cerrado",
            save: { status: "inactivo", at: null, error: null },
          });
          t.resume();
          t.clear();
        },

        applyEvent: (event) => {
          const s = get();
          switch (event.type) {
            case "job.updated":
              s.upsertJob(event.job);
              break;
            case "job.stage": {
              const job = s.jobs[event.jobId];
              if (job) s.upsertJob({ ...job, stage: event.stage, message: event.message, progress: event.progress, status: job.status === "en-cola" ? "corriendo" : job.status });
              break;
            }
            case "asset.updated":
              if (!s.project || event.asset.projectId === s.project.id) s.upsertAsset(event.asset);
              break;
            case "transcript.updated": {
              const others = s.transcripts.filter((t) => t.id !== event.transcript.id);
              set({ transcripts: [...others, event.transcript] });
              break;
            }
            case "keywords.updated":
              set({ keywords: event.keywords });
              break;
            case "plan.ready":
              set({ pendingPlan: event.plan });
              break;
            case "version.created":
            case "version.updated":
              s.upsertVersion(event.version);
              break;
            case "project.updated": {
              if (!s.project || event.project.id !== s.project.id) break;
              // Si hay cambios locales sin guardar, no pisamos la configuración.
              const dirty = s.save.status === "pendiente" || s.save.status === "guardando";
              const t = (store as unknown as EditorStore).temporal.getState();
              t.pause();
              set(dirty ? { project: { ...event.project, name: s.project.name, settings: s.settings } } : { project: event.project, settings: event.project.settings });
              t.resume();
              break;
            }
            case "rule.suggested":
              set({ ruleSuggestion: event.suggestion });
              break;
            case "ping":
              break;
          }
        },

        upsertAsset: (asset) => {
          const assets = get().assets;
          const i = assets.findIndex((a) => a.id === asset.id);
          set({ assets: i === -1 ? [...assets, asset] : assets.map((a) => (a.id === asset.id ? asset : a)) });
        },
        removeAsset: (assetId) => set({ assets: get().assets.filter((a) => a.id !== assetId) }),

        upsertUpload: (item) => {
          const uploads = get().uploads;
          const i = uploads.findIndex((u) => u.id === item.id);
          set({ uploads: i === -1 ? [...uploads, item] : uploads.map((u) => (u.id === item.id ? item : u)) });
        },
        removeUpload: (id) => set({ uploads: get().uploads.filter((u) => u.id !== id) }),

        upsertJob: (job) => {
          const s = get();
          const jobs = { ...s.jobs, [job.id]: job };
          let activeJobId = s.activeJobId;
          if (isActiveJob(job) && (job.type === "generar" || job.type === "corregir" || job.type === "re-render")) activeJobId = job.id;
          else if (activeJobId === job.id && !isActiveJob(job)) activeJobId = null;
          set({ jobs, activeJobId });
        },

        upsertVersion: (version) => {
          const versions = get().versions;
          const i = versions.findIndex((v) => v.id === version.id);
          set({ versions: sortVersions(i === -1 ? [...versions, version] : versions.map((v) => (v.id === version.id ? version : v))) });
        },

        setTranscripts: (transcripts) => set({ transcripts }),
        setKeywords: (keywords, publishCopy) => set(publishCopy === undefined ? { keywords } : { keywords, publishCopy }),

        toast: (toast) => {
          const id = toast.id ?? `t${++toastSeq}`;
          set({ toasts: [...get().toasts.filter((t) => t.id !== id), { ...toast, id }] });
          return id;
        },
        dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

        openFocus: (stage, target) => set({ focus: { stage, target }, activeStage: stage }),
        closeFocus: () => set({ focus: null }),
        requestView: (target) => {
          const n = (get().viewRequest?.n ?? 0) + 1;
          set(target === "todo" ? { viewRequest: { target, n } } : { viewRequest: { target, n }, activeStage: target });
        },
      }),
      {
        partialize: (state) => ({ settings: state.settings }),
        equality: (a, b) => a.settings === b.settings,
        limit: 100,
        handleSet: (handleSet) => {
          let last = 0;
          return (pastState, replace, currentState, deltaState) => {
            const now = Date.now();
            if (now - last > BURST_MS) {
              (handleSet as (...args: unknown[]) => void)(pastState, replace, currentState, deltaState);
            }
            last = now;
          };
        },
      },
    ),
  );
  return store as EditorStore;
}
