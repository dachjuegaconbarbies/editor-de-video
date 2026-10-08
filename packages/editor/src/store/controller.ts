/**
 * Controlador: acciones asíncronas que hablan con la API y mantienen el store al día.
 *
 * - Arranque: pide /config; si no responde, queda "sin conexión" y ofrece la demo de la interfaz.
 * - Autoguardado: cualquier cambio en la configuración o el nombre se guarda con PATCH tras ~600 ms
 *   sin cambios ("Guardando…" → "Guardado" / "Sin conexión"). Reintenta al volver la red.
 * - Eventos en vivo (SSE) del proyecto abierto → `applyEvent`; al reconectar, resincroniza.
 */
import {
  type Asset,
  type AssetCategory,
  type CreateProjectBody,
  type Job,
  type ProjectSettings,
  type ServerEvent,
} from "@autoeditor/shared";
import { nanoid } from "nanoid";
import { ApiRequestError, messageOf } from "../api/errors.js";
import type { ApiClient, EventSubscription } from "../api/types.js";
import type { EditorStore } from "./editorStore.js";

export interface AutoEditorEvent {
  type:
    | "proyecto.abierto"
    | "proyecto.creado"
    | "archivo.subido"
    | "generacion.iniciada"
    | "version.creada"
    | "correccion.enviada"
    | "plan.aprobado"
    | "estilo.guardado"
    | "error";
  projectId?: string;
  detail?: unknown;
}

export interface ControllerOptions {
  onEvent?: (event: AutoEditorEvent) => void;
  /** Debounce del autoguardado (ms). */
  autosaveMs?: number;
}

export type Controller = ReturnType<typeof createController>;

/** Categoría sugerida para un archivo según su tipo y la zona donde se soltó. */
export function categoryForFile(file: File, zone: "crudo" | "elementos"): AssetCategory {
  const type = file.type || "";
  const name = file.name.toLowerCase();
  const isVideo = type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv|avi|mts|3gp)$/.test(name);
  const isImage = type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif|gif|svg)$/.test(name);
  const isAudio = type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|opus|flac)$/.test(name);
  if (zone === "crudo") {
    if (isVideo) return "crudo-video";
    if (isImage) return "crudo-foto";
    if (isAudio) return "crudo-voz";
    return "otro";
  }
  if (isAudio) return "musica";
  if (isImage) return /logo/.test(name) ? "logo" : "grafico";
  if (isVideo) return "crudo-video";
  return "otro";
}

export function createController(store: EditorStore, getApi: () => ApiClient, options: ControllerOptions = {}) {
  const autosaveMs = options.autosaveMs ?? 600;
  const emit = (event: AutoEditorEvent) => options.onEvent?.(event);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let savedSettings: ProjectSettings | null = null;
  let savedName: string | null = null;
  let saving: Promise<void> | null = null;
  let subscription: EventSubscription | null = null;
  let disposed = false;
  const s = () => store.getState();
  const api = () => getApi();

  const fail = (err: unknown, prefix?: string) => {
    if (err instanceof ApiRequestError && err.isAbort) return;
    // 501 = el servidor aún no tiene lista esa parte del proceso: mensaje amable, sin tecnicismos.
    const text =
      err instanceof ApiRequestError && err.status === 501
        ? "Esta parte se está terminando de conectar en el servidor. Tu material y tus ajustes quedaron guardados; intenta de nuevo en un rato."
        : prefix
          ? `${prefix}: ${messageOf(err)}`
          : messageOf(err);
    s().toast({ kind: "error", text });
    emit({ type: "error", projectId: s().project?.id, detail: text });
  };

  // ------------------------------------------------------------------ Autoguardado
  const isDirty = () => {
    const st = s();
    return !!st.project && (st.settings !== savedSettings || st.project.name !== savedName);
  };

  async function flushSave(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (saving) await saving;
    const st = s();
    const project = st.project;
    if (!project || !isDirty()) return;
    const settings = st.settings;
    const name = project.name;
    st.set({ save: { ...st.save, status: "guardando", error: null } });
    saving = (async () => {
      try {
        const updated = await api().updateProject(project.id, { settings, name: name.trim() || "Proyecto sin título" });
        savedSettings = settings;
        savedName = name;
        const now = s();
        // Solo actualizamos metadatos (no pisamos lo que se haya escrito mientras guardaba).
        if (now.project?.id === project.id) {
          now.set({ project: { ...now.project, updatedAt: updated?.updatedAt ?? now.project.updatedAt, status: updated?.status ?? now.project.status } });
        }
        s().set({ save: { status: isDirty() ? "pendiente" : "guardado", at: Date.now(), error: null } });
        if (isDirty()) scheduleSave();
      } catch (err) {
        const offline = err instanceof ApiRequestError && err.isNetwork;
        s().set({ save: { status: offline ? "sin-conexion" : "error", at: s().save.at, error: messageOf(err) } });
      } finally {
        saving = null;
      }
    })();
    await saving;
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    const st = s();
    if (st.save.status !== "guardando") st.set({ save: { ...st.save, status: "pendiente" } });
    saveTimer = setTimeout(() => void flushSave(), autosaveMs);
  }

  const onStoreChange = (state: ReturnType<typeof s>, prev: ReturnType<typeof s>) => {
    if (!state.project) return;
    const projectChanged = state.project.id !== prev.project?.id;
    if (projectChanged) return;
    if (state.settings !== prev.settings || state.project.name !== prev.project?.name) {
      if (isDirty()) scheduleSave();
    }
  };

  const onOnline = () => {
    if (s().save.status === "sin-conexion") void flushSave();
  };
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (isDirty()) {
      void flushSave();
      e.preventDefault();
    }
  };

  /** Conecta suscripciones (idempotente: soporta montar/desmontar varias veces, p. ej. StrictMode). */
  let unsubscribeStore: (() => void) | null = null;
  function attach() {
    if (unsubscribeStore) return;
    disposed = false;
    unsubscribeStore = store.subscribe(onStoreChange);
    if (typeof window !== "undefined") {
      window.addEventListener("online", onOnline);
      window.addEventListener("beforeunload", onBeforeUnload);
    }
  }
  attach();

  // ------------------------------------------------------------------ Eventos en vivo
  function subscribe(projectId: string) {
    subscription?.close();
    subscription = api().subscribe(projectId, {
      onEvent: (event: ServerEvent) => {
        s().applyEvent(event);
        if (event.type === "version.created") {
          emit({ type: "version.creada", projectId, detail: event.version });
          s().toast({ kind: "exito", text: `V${event.version.number} está lista.` });
          if (!s().focus) s().requestView(event.version.number === 1 ? "resultado" : "versiones");
        }
        if (event.type === "plan.ready" && !s().focus) s().requestView("plan");
        if (event.type === "job.updated" && event.job.status === "error") s().toast({ kind: "error", text: event.job.error ?? "Falló un paso del proceso." });
      },
      onStatus: (stream) => s().set({ stream }),
      onReconnect: () => void refreshProject(),
    });
  }

  async function refreshProject() {
    const project = s().project;
    if (!project) return;
    try {
      const detail = await api().getProject(project.id);
      const st = s();
      // Resincroniza todo menos la configuración si hay cambios locales sin guardar.
      st.set({
        assets: detail.assets,
        versions: [...detail.versions].sort((a, b) => a.number - b.number),
        pendingPlan: detail.pendingPlan,
      });
      if (detail.activeJob) st.upsertJob(detail.activeJob);
      void loadSideData(project.id);
    } catch {
      // Silencioso: la siguiente reconexión lo intentará otra vez.
    }
  }

  async function loadSideData(projectId: string) {
    const a = api();
    const [transcripts, keywords] = await Promise.allSettled([a.listTranscripts(projectId), a.getKeywords(projectId)]);
    if (s().project?.id !== projectId) return;
    if (transcripts.status === "fulfilled") s().setTranscripts(transcripts.value);
    if (keywords.status === "fulfilled") s().setKeywords(keywords.value.keywords, keywords.value.publishCopy);
  }

  // ------------------------------------------------------------------ API pública
  return {
    /** Arranque: config pública + proyectos recientes + estilos. */
    async init() {
      attach();
      s().set({ connection: "conectando" });
      try {
        const config = await api().getConfig();
        if (disposed) return;
        s().set({ config, connection: "conectado" });
        void this.loadHome();
        void this.loadRules();
      } catch (err) {
        if (disposed) return;
        s().set({ connection: "sin-conexion", projectsLoaded: true });
        // Red caída o proxy sin servidor (5xx): basta con el aviso discreto del inicio.
        const quiet = err instanceof ApiRequestError && (err.isNetwork || err.status >= 500);
        if (!quiet) s().toast({ kind: "error", text: messageOf(err) });
      }
    },

    async loadHome() {
      try {
        const [projects, styles] = await Promise.all([api().listProjects(), api().listStyles().catch(() => [])]);
        projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        s().set({ projects, styles, projectsLoaded: true });
      } catch (err) {
        s().set({ projectsLoaded: true });
        fail(err, "No se pudieron cargar tus proyectos");
      }
    },

    async loadRules() {
      try {
        s().set({ rules: await api().listRules() });
      } catch {
        // El panel muestra su estado vacío.
      }
    },

    async openProject(projectId: string) {
      if (s().project?.id === projectId) {
        if (!subscription) subscribe(projectId);
        return;
      }
      await flushSave();
      subscription?.close();
      try {
        const detail = await api().getProject(projectId);
        savedSettings = detail.project.settings;
        savedName = detail.project.name;
        s().loadProject(detail);
        s().set({ route: { name: "editor", projectId } });
        subscribe(projectId);
        void loadSideData(projectId);
        emit({ type: "proyecto.abierto", projectId });
      } catch (err) {
        fail(err, "No se pudo abrir el proyecto");
        s().set({ route: { name: "inicio" } });
      }
    },

    async createProject(body: CreateProjectBody = {}) {
      try {
        const project = await api().createProject({ name: body.name ?? "Proyecto sin título", ...body });
        emit({ type: "proyecto.creado", projectId: project.id });
        s().set({ projects: [project, ...s().projects.filter((p) => p.id !== project.id)] });
        await this.openProject(project.id);
        return project;
      } catch (err) {
        fail(err, "No se pudo crear el proyecto");
        return null;
      }
    },

    async closeProject() {
      await flushSave();
      subscription?.close();
      subscription = null;
      s().clearProject();
      savedSettings = null;
      savedName = null;
      s().set({ route: { name: "inicio" } });
      void this.loadHome();
    },

    async deleteProject(projectId: string) {
      try {
        await api().deleteProject(projectId);
        s().set({ projects: s().projects.filter((p) => p.id !== projectId) });
      } catch (err) {
        fail(err, "No se pudo borrar");
      }
    },

    flushSave,

    /** Sube archivos con progreso; el análisis arranca solo en el servidor. */
    async uploadFiles(files: File[], zone: "crudo" | "elementos", forced?: AssetCategory, extra?: { priority?: Asset["priority"] }): Promise<Asset[]> {
      const project = s().project;
      if (!project) return [];
      const max = s().config?.limits.maxUploadBytes ?? Infinity;
      const uploaded: Asset[] = [];
      await Promise.all(
        files.map(async (file) => {
          const category = forced ?? categoryForFile(file, zone);
          const id = nanoid(8);
          if (file.size > max) {
            s().toast({ kind: "error", text: `“${file.name}” pesa más del máximo permitido.` });
            return;
          }
          if (category === "otro") {
            s().toast({ kind: "error", text: `“${file.name}” no es video, foto ni audio.` });
            return;
          }
          s().upsertUpload({ id, category, name: file.name, size: file.size, progress: 0, status: "subiendo" });
          try {
            let asset = await api().uploadAsset(project.id, file, category, {
              onProgress: (progress) => {
                const cur = s().uploads.find((u) => u.id === id);
                if (cur && progress - cur.progress >= 0.01) s().upsertUpload({ ...cur, progress });
              },
            });
            if (extra?.priority && asset.priority !== extra.priority) {
              asset = await api().updateAsset(asset.id, { priority: extra.priority }).catch(() => asset);
            }
            s().removeUpload(id);
            s().upsertAsset(asset);
            uploaded.push(asset);
            emit({ type: "archivo.subido", projectId: project.id, detail: asset });
          } catch (err) {
            const cur = s().uploads.find((u) => u.id === id);
            if (cur) s().upsertUpload({ ...cur, status: "error", error: messageOf(err) });
          }
        }),
      );
      return uploaded;
    },

    async updateAsset(assetId: string, body: { note?: string; priority?: Asset["priority"]; role?: Asset["analysis"]["role"] }) {
      const before = s().assets.find((a) => a.id === assetId);
      if (before) {
        const { role, ...rest } = body;
        s().upsertAsset({ ...before, ...rest, analysis: role ? { ...before.analysis, role } : before.analysis });
      }
      try {
        s().upsertAsset(await api().updateAsset(assetId, body));
      } catch (err) {
        if (before) s().upsertAsset(before);
        fail(err, "No se pudo guardar el cambio");
      }
    },

    async deleteAsset(assetId: string) {
      const before = s().assets.find((a) => a.id === assetId);
      s().removeAsset(assetId);
      try {
        await api().deleteAsset(assetId);
      } catch (err) {
        if (before) s().upsertAsset(before);
        fail(err, "No se pudo quitar el archivo");
      }
    },

    async generate() {
      const project = s().project;
      if (!project) return;
      const active = s().activeJobId ? s().jobs[s().activeJobId!] : null;
      if (active && (active.status === "corriendo" || active.status === "en-cola" || active.status === "esperando")) return;
      await flushSave();
      try {
        const job = await api().generate(project.id);
        s().upsertJob(job);
        s().requestView(s().settings.instruction.reviewPlan ? "plan" : "resultado");
        emit({ type: "generacion.iniciada", projectId: project.id, detail: job });
      } catch (err) {
        fail(err, "No se pudo generar");
      }
    },

    async cancelJob(jobId: string) {
      try {
        s().upsertJob(await api().cancelJob(jobId));
      } catch (err) {
        fail(err, "No se pudo cancelar");
      }
    },

    async retryJob(jobId: string) {
      try {
        s().upsertJob(await api().retryJob(jobId));
      } catch (err) {
        fail(err, "No se pudo reintentar");
      }
    },

    async approvePlan(planId: string) {
      try {
        const job: Job = await api().approvePlan(planId);
        s().upsertJob(job);
        const plan = s().pendingPlan;
        if (plan) s().set({ pendingPlan: { ...plan, status: "aprobado" }, activeStage: "resultado" });
        emit({ type: "plan.aprobado", projectId: s().project?.id, detail: planId });
      } catch (err) {
        fail(err, "No se pudo aprobar el plan");
      }
    },

    async revisePlan(planId: string, feedback: string) {
      try {
        const job = await api().revisePlan(planId, feedback);
        s().upsertJob(job);
        const plan = s().pendingPlan;
        if (plan) s().set({ pendingPlan: { ...plan, status: "ajustando" } });
      } catch (err) {
        fail(err, "No se pudo enviar el ajuste");
      }
    },

    async correct(versionId: string, text: string, at: number | null = null) {
      try {
        const job = await api().correct(versionId, { text, at });
        s().upsertJob({ ...job, input: { versionId, text, ...job.input } });
        s().requestView("versiones");
        emit({ type: "correccion.enviada", projectId: s().project?.id, detail: { versionId, text } });
        return true;
      } catch (err) {
        fail(err, "No se pudo enviar la corrección");
        return false;
      }
    },

    async rate(versionId: string, rating: "arriba" | "abajo" | null) {
      const v = s().versions.find((x) => x.id === versionId);
      if (v) s().upsertVersion({ ...v, rating });
      try {
        s().upsertVersion(await api().rate(versionId, { rating }));
      } catch (err) {
        if (v) s().upsertVersion(v);
        fail(err, "No se pudo guardar tu calificación");
      }
    },

    async exportVersion(versionId: string) {
      try {
        const job = await api().exportVersion(versionId, {});
        s().upsertJob(job);
        s().toast({ kind: "info", text: "Preparando la exportación…" });
      } catch (err) {
        fail(err, "No se pudo exportar");
      }
    },

    async saveStyle(versionId: string, name: string) {
      try {
        const style = await api().createStyle({ versionId, name });
        s().set({ styles: [style, ...s().styles] });
        s().toast({ kind: "exito", text: `Estilo “${style.name}” guardado.` });
        emit({ type: "estilo.guardado", projectId: s().project?.id, detail: style });
      } catch (err) {
        fail(err, "No se pudo guardar el estilo");
      }
    },

    async toggleRule(ruleId: string, enabled: boolean) {
      const before = s().rules;
      s().set({ rules: before.map((r) => (r.id === ruleId ? { ...r, enabled } : r)) });
      try {
        await api().updateRule(ruleId, { enabled });
      } catch (err) {
        s().set({ rules: before });
        fail(err, "No se pudo cambiar la regla");
      }
    },

    async deleteRule(ruleId: string) {
      const before = s().rules;
      s().set({ rules: before.filter((r) => r.id !== ruleId) });
      try {
        await api().deleteRule(ruleId);
      } catch (err) {
        s().set({ rules: before });
        fail(err, "No se pudo borrar la regla");
      }
    },

    undo() {
      store.temporal.getState().undo();
    },
    redo() {
      store.temporal.getState().redo();
    },

    dispose() {
      disposed = true;
      unsubscribeStore?.();
      unsubscribeStore = null;
      subscription?.close();
      subscription = null;
      if (saveTimer) clearTimeout(saveTimer);
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
        window.removeEventListener("beforeunload", onBeforeUnload);
      }
    },
  };
}
