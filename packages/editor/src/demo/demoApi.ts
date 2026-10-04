/**
 * Cliente de API de DEMOSTRACIÓN (en memoria). Implementa la misma interfaz que el cliente real
 * para recorrer la interfaz sin servidor: subir archivos (con progreso y análisis A-roll/B-roll
 * simulados), autoguardado, GENERAR (etapas en vivo), plan, correcciones (V2, V3…), estilos y reglas.
 * Nada sale del navegador.
 */
import {
  Asset,
  Job,
  Project,
  ProjectSettings,
  Style,
  Version,
  type AssetCategory,
  type Keyword,
  type PipelineStage,
  type Plan,
  type ProjectDetail,
  type ServerEvent,
  type Transcript,
} from "@autoeditor/shared";
import { nanoid } from "nanoid";
import { ApiRequestError } from "../api/errors.js";
import type { ApiClient, EventSubscription, SubscribeOptions } from "../api/types.js";
import {
  DEMO_OWNER,
  demoAssets,
  demoConfig,
  demoKeywords,
  demoPlan,
  demoPosters,
  demoProjects,
  demoPublishCopy,
  demoRules,
  demoStyles,
  demoThumbs,
  demoTranscripts,
  demoVersions,
} from "../fixtures/index.js";
import { posterThumb, sceneThumb } from "../fixtures/thumbs.js";
import { freshSettings } from "../lib/settings.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const clone = <T>(v: T): T => structuredClone(v);

const notFound = () => new ApiRequestError("No se encontró lo que buscabas.", 404, "no-encontrado");

/** Lee duración, tamaño y un fotograma de un video/imagen local (para que la demo se sienta real). */
async function readMedia(file: File): Promise<{ duration: number | null; width: number | null; height: number | null; thumb: string | null }> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return { duration: null, width: null, height: null, thumb: null };
  const url = URL.createObjectURL(file);
  if (file.type.startsWith("image/")) {
    const dims = await new Promise<{ w: number; h: number } | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = url;
    });
    return { duration: null, width: dims?.w ?? null, height: dims?.h ?? null, thumb: url };
  }
  if (!file.type.startsWith("video/") && !file.type.startsWith("audio/")) return { duration: null, width: null, height: null, thumb: null };
  return new Promise((resolve) => {
    const el = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
    const done = (thumb: string | null) => {
      const v = el as HTMLVideoElement;
      resolve({ duration: Number.isFinite(el.duration) ? el.duration : null, width: v.videoWidth || null, height: v.videoHeight || null, thumb });
    };
    const timer = setTimeout(() => done(null), 4000);
    el.preload = "metadata";
    el.muted = true;
    el.onloadedmetadata = () => {
      if (el instanceof HTMLVideoElement) el.currentTime = Math.min(1, (el.duration || 2) / 3);
      else {
        clearTimeout(timer);
        done(null);
      }
    };
    el.onseeked = () => {
      clearTimeout(timer);
      try {
        const v = el as HTMLVideoElement;
        const canvas = document.createElement("canvas");
        const scale = 320 / Math.max(v.videoWidth, v.videoHeight, 1);
        canvas.width = Math.round(v.videoWidth * scale);
        canvas.height = Math.round(v.videoHeight * scale);
        canvas.getContext("2d")?.drawImage(v, 0, 0, canvas.width, canvas.height);
        done(canvas.toDataURL("image/jpeg", 0.8));
      } catch {
        done(null);
      }
    };
    el.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
    el.src = url;
  });
}

function kindFor(category: AssetCategory, mime: string): Asset["kind"] {
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "imagen";
  if (mime.startsWith("audio/")) return "audio";
  if (category === "guion") return "documento";
  return "otro";
}

export function createDemoApi(): ApiClient {
  const projects = new Map<string, Project>(demoProjects.map((p) => [p.id, clone(p)]));
  const assets = new Map<string, Asset>(demoAssets.map((a) => [a.id, clone(a)]));
  const versions = new Map<string, Version>(demoVersions.map((v) => [v.id, clone(v)]));
  const transcripts = new Map<string, Transcript>(demoTranscripts.map((t) => [t.id, clone(t)]));
  const keywords = new Map<string, Keyword[]>([[demoProjects[0]!.id, clone(demoKeywords)]]);
  const jobs = new Map<string, Job>();
  const plans = new Map<string, Plan>();
  const styles = demoStyles.map(clone);
  let rules = demoRules.map(clone);
  const posters = new Map(demoPosters);
  const listeners = new Map<string, Set<(e: ServerEvent) => void>>();

  const emit = (projectId: string | null, event: ServerEvent) => {
    if (!projectId) return;
    listeners.get(projectId)?.forEach((fn) => fn(clone(event)));
  };

  const getProject = (id: string) => {
    const p = projects.get(id);
    if (!p) throw notFound();
    return p;
  };

  const touch = (projectId: string) => {
    const p = projects.get(projectId);
    if (p) projects.set(projectId, { ...p, updatedAt: nowIso() });
  };

  const updateJob = (job: Job, patch: Partial<Job>) => {
    const next = { ...job, ...patch };
    jobs.set(job.id, next);
    emit(job.projectId, { type: "job.updated", job: next });
    return next;
  };

  /** Simula el análisis en segundo plano (A-roll / B-roll según el nombre y si tiene voz). */
  const simulateAnalysis = async (asset: Asset) => {
    await wait(900);
    let a: Asset = { ...asset, analysis: { ...asset.analysis, status: "analizando" } };
    assets.set(a.id, a);
    emit(a.projectId, { type: "asset.updated", asset: a });
    await wait(1600);
    const name = a.originalName.toLowerCase();
    const talky = /(entrevista|habla|selfie|testimonio|vlog|podcast|cam)/.test(name);
    const isVideo = a.kind === "video";
    const role = !isVideo ? "desconocido" : talky ? "a-roll" : "b-roll";
    const d = a.probe.duration ?? 8;
    a = {
      ...a,
      analysis: {
        ...a.analysis,
        status: "listo",
        hasSpeech: a.kind === "audio" ? true : isVideo ? talky : false,
        role,
        brollSegments: role === "b-roll" ? [{ start: Math.min(0.5, d / 4), end: Math.max(1, d * 0.8), score: 0.8, description: "Toma estable aprovechable como B-roll", tags: [] }] : [],
        description: role === "b-roll" ? "Toma de apoyo sin voz." : role === "a-roll" ? "Persona hablando a cámara." : "",
      },
    };
    assets.set(a.id, a);
    emit(a.projectId, { type: "asset.updated", asset: a });
  };

  /** Simula un trabajo con etapas en vivo. */
  const runJob = async (job: Job, stages: PipelineStage[], onDone: () => void, pauseAtPlan = false) => {
    let j = updateJob(job, { status: "corriendo", startedAt: nowIso() });
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]!;
      const cur = jobs.get(j.id);
      if (!cur || cur.status === "cancelado") return;
      const progress = i / stages.length;
      j = updateJob(cur, { stage, progress, message: messageFor(stage) });
      emit(j.projectId, { type: "job.stage", jobId: j.id, stage, message: messageFor(stage), progress });
      await wait(stage === "render" ? 1800 : 1100);
      if (pauseAtPlan && stage === "planeando" && j.projectId) {
        const plan = demoPlan(j.projectId, j.id);
        plans.set(plan.id, plan);
        j = updateJob(jobs.get(j.id)!, { status: "esperando", stage: "esperando-aprobacion", message: "Esperando tu aprobación del plan", progress: (i + 1) / stages.length });
        emit(j.projectId, { type: "plan.ready", plan: clone(plan) });
        return;
      }
    }
    const fin = jobs.get(j.id);
    if (!fin || fin.status === "cancelado") return;
    onDone();
    updateJob(fin, { status: "listo", stage: "listo", progress: 1, finishedAt: nowIso(), message: "Listo" });
  };

  const createVersion = (projectId: string, parent: Version | null, correction: string | null) => {
    const list = [...versions.values()].filter((v) => v.projectId === projectId);
    const number = list.reduce((m, v) => Math.max(m, v.number), 0) + 1;
    const p = getProject(projectId);
    const base = parent?.recipe ?? demoVersions[0]!.recipe;
    const recipe = clone(base);
    recipe.format = { ...recipe.format, aspect: p.settings.instruction.format };
    const v = Version.parse({
      id: `v-${nanoid(6)}`,
      ownerId: DEMO_OWNER,
      projectId,
      number,
      parentId: parent?.id ?? null,
      recipe,
      correction,
      changes: correction ? [{ path: "/notes", op: "replace", label: `Ajuste: ${correction}`, area: "otro" }] : [],
      changeSummary: correction ? `Apliqué “${correction}”. Todo lo demás quedó idéntico.` : "",
      status: "lista",
      videoKey: `demo/${number}.mp4`,
      qa: [{ check: "Subtítulos dentro de la zona segura", ok: true }],
      createdAt: nowIso(),
    });
    versions.set(v.id, v);
    posters.set(v.id, posterThumb(number, p.settings.instruction.format !== "16:9"));
    projects.set(projectId, { ...p, currentVersionId: v.id, status: "listo", updatedAt: nowIso() });
    emit(projectId, { type: "version.created", version: clone(v) });
  };

  const newJob = (projectId: string, type: Job["type"], input: Record<string, unknown> = {}, estimatedSeconds = 12): Job =>
    Job.parse({ id: `job-${nanoid(6)}`, ownerId: DEMO_OWNER, projectId, type, status: "en-cola", input, estimatedSeconds, createdAt: nowIso() });

  const api: ApiClient = {
    baseUrl: "demo://",
    isDemo: true,

    health: async () => ({ ok: true }),
    getConfig: async () => {
      await wait(120);
      return clone(demoConfig);
    },

    listProjects: async () => [...projects.values()].map(clone),
    createProject: async (body) => {
      const id = `p-${nanoid(6)}`;
      const style = body.styleId ? styles.find((s) => s.id === body.styleId) : null;
      const settings = freshSettings();
      if (style) settings.style = { styleId: style.id, styleVersion: style.currentVersion };
      const p = Project.parse({ id, ownerId: DEMO_OWNER, name: body.name ?? "Proyecto sin título", settings: ProjectSettings.parse({ ...settings, ...(body.settings ?? {}) }), createdAt: nowIso(), updatedAt: nowIso() });
      projects.set(id, p);
      return clone(p);
    },
    getProject: async (projectId): Promise<ProjectDetail> => {
      await wait(80);
      const project = getProject(projectId);
      const active = [...jobs.values()].find((j) => j.projectId === projectId && (j.status === "corriendo" || j.status === "en-cola" || j.status === "esperando")) ?? null;
      const pending = [...plans.values()].find((pl) => pl.projectId === projectId && pl.status === "pendiente") ?? null;
      return clone({
        project,
        assets: [...assets.values()].filter((a) => a.projectId === projectId),
        versions: [...versions.values()].filter((v) => v.projectId === projectId),
        activeJob: active,
        pendingPlan: pending,
      });
    },
    updateProject: async (projectId, body) => {
      await wait(150);
      const p = getProject(projectId);
      const next = Project.parse({ ...p, ...(body.name ? { name: body.name } : {}), ...(body.settings ? { settings: body.settings } : {}), ...(body.currentVersionId !== undefined ? { currentVersionId: body.currentVersionId } : {}), updatedAt: nowIso() });
      projects.set(projectId, next);
      return clone(next);
    },
    deleteProject: async (projectId) => {
      projects.delete(projectId);
    },

    uploadAsset: async (projectId, file, category, opts) => {
      getProject(projectId);
      const id = `a-${nanoid(6)}`;
      const info = await readMedia(file);
      const steps = Math.max(6, Math.min(24, Math.round(file.size / 4_000_000)));
      for (let i = 1; i <= steps; i++) {
        if (opts?.signal?.aborted) throw new ApiRequestError("Se canceló la operación.", 0, "abortado");
        await wait(70);
        opts?.onProgress?.(i / steps, (file.size * i) / steps, file.size);
      }
      const kind = kindFor(category, file.type);
      const thumb = info.thumb ?? (kind === "video" ? sceneThumb("persona", (info.height ?? 0) > (info.width ?? 0)) : kind === "audio" ? sceneThumb(category === "musica" ? "ondas" : "voz") : null);
      if (thumb) demoThumbs.set(id, thumb);
      const asset = Asset.parse({
        id,
        ownerId: DEMO_OWNER,
        projectId,
        category,
        kind,
        originalName: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        storageKey: `demo/${id}`,
        probe: { duration: info.duration, width: info.width, height: info.height, hasVideo: kind === "video", hasAudio: kind === "video" || kind === "audio" },
        analysis: { status: kind === "video" || kind === "audio" ? "pendiente" : "listo" },
        thumbnailKey: thumb ? `demo/${id}` : null,
        createdAt: nowIso(),
      });
      assets.set(id, asset);
      touch(projectId);
      if (asset.analysis.status === "pendiente") void simulateAnalysis(asset);
      return clone(asset);
    },
    listAssets: async (projectId) => [...assets.values()].filter((a) => a.projectId === projectId).map(clone),
    updateAsset: async (assetId, body) => {
      const a = assets.get(assetId);
      if (!a) throw notFound();
      const { role, ...rest } = body;
      const next = { ...a, ...rest, analysis: role ? { ...a.analysis, role } : a.analysis } as Asset;
      assets.set(assetId, next);
      return clone(next);
    },
    deleteAsset: async (assetId) => {
      assets.delete(assetId);
    },
    assetFileUrl: (asset) => demoThumbs.get(typeof asset === "string" ? asset : asset.id) ?? "",
    assetThumbnailUrl: (asset) => demoThumbs.get(typeof asset === "string" ? asset : asset.id) ?? null,
    assetFrameUrl: (asset) => demoThumbs.get(typeof asset === "string" ? asset : asset.id) ?? "",

    listTranscripts: async (projectId) => [...transcripts.values()].filter((t) => t.projectId === projectId).map(clone),
    updateTranscriptWords: async (transcriptId, body) => {
      const t = transcripts.get(transcriptId);
      if (!t) throw notFound();
      const words = t.words.map((w) => {
        const e = body.edits.find((x) => x.i === w.i);
        if (!e) return w;
        return { ...w, text: e.text ?? w.text, mark: e.mark === undefined ? w.mark : e.mark, original: e.text && e.text !== w.text ? (w.original ?? w.text) : w.original };
      });
      const next = { ...t, words, updatedAt: nowIso() };
      transcripts.set(t.id, next);
      return clone(next);
    },
    getKeywords: async (projectId) => ({ keywords: clone(keywords.get(projectId) ?? []), publishCopy: keywords.has(projectId) ? clone(demoPublishCopy) : null }),
    putKeywords: async (projectId, list) => {
      keywords.set(projectId, clone(list));
      return clone(list);
    },
    detectKeywords: async (projectId) => ({ keywords: clone(keywords.get(projectId) ?? []), publishCopy: null }),

    estimate: async () => {
      throw new ApiRequestError("En la demo el estimado se calcula en el navegador.", 501, "no-disponible");
    },
    generate: async (projectId) => {
      const p = getProject(projectId);
      const reviewPlan = p.settings.instruction.reviewPlan;
      const stages: PipelineStage[] = ["analizando", "transcribiendo", "planeando"];
      if (p.settings.engines.kie) stages.push("generando-ia");
      if (p.settings.tools.motionGraphics.enabled) stages.push("motion-graphics");
      stages.push("render", "revision-calidad");
      const job = newJob(projectId, "generar", {}, stages.length * 1.2);
      jobs.set(job.id, job);
      const parent = [...versions.values()].filter((v) => v.projectId === projectId).sort((a, b) => b.number - a.number)[0] ?? null;
      void runJob(job, stages, () => createVersion(projectId, parent ? null : null, null), reviewPlan);
      return clone(job);
    },
    getPlan: async (planId) => {
      const pl = plans.get(planId);
      if (!pl) throw notFound();
      return clone(pl);
    },
    approvePlan: async (planId) => {
      const pl = plans.get(planId);
      if (!pl) throw notFound();
      plans.set(planId, { ...pl, status: "aprobado" });
      const job = pl.jobId ? jobs.get(pl.jobId) : undefined;
      if (!job || !job.projectId) throw notFound();
      const projectId = job.projectId;
      const rest: PipelineStage[] = ["render", "revision-calidad"];
      const resumed = updateJob(job, { status: "corriendo" });
      void runJob(resumed, rest, () => createVersion(projectId, null, null));
      return clone(resumed);
    },
    revisePlan: async (planId, feedback) => {
      const pl = plans.get(planId);
      if (!pl) throw notFound();
      const next = { ...pl, status: "ajustando" as const, feedback: [...pl.feedback, { text: feedback, at: nowIso() }] };
      plans.set(planId, next);
      const job = pl.jobId ? jobs.get(pl.jobId) : undefined;
      setTimeout(() => {
        const revised = { ...next, status: "pendiente" as const, summary: `${pl.summary} Ajuste: ${feedback}.`, updatedAt: nowIso() };
        plans.set(planId, revised);
        emit(pl.projectId, { type: "plan.ready", plan: clone(revised) });
      }, 1600);
      if (!job) throw notFound();
      return clone(job);
    },
    getJob: async (jobId) => {
      const j = jobs.get(jobId);
      if (!j) throw notFound();
      return clone(j);
    },
    cancelJob: async (jobId) => {
      const j = jobs.get(jobId);
      if (!j) throw notFound();
      return clone(updateJob(j, { status: "cancelado", finishedAt: nowIso(), message: "Cancelado" }));
    },
    retryJob: async (jobId) => {
      const j = jobs.get(jobId);
      if (!j || !j.projectId) throw notFound();
      return api.generate(j.projectId);
    },
    subscribe: (projectId, options: SubscribeOptions): EventSubscription => {
      const set = listeners.get(projectId) ?? new Set();
      set.add(options.onEvent);
      listeners.set(projectId, set);
      options.onStatus?.("conectado");
      return {
        close() {
          set.delete(options.onEvent);
          options.onStatus?.("cerrado");
        },
      };
    },

    listVersions: async (projectId) => [...versions.values()].filter((v) => v.projectId === projectId).map(clone),
    getVersion: async (versionId) => {
      const v = versions.get(versionId);
      if (!v) throw notFound();
      return clone(v);
    },
    versionVideoUrl: () => null,
    versionPosterUrl: (version) => posters.get(version.id) ?? null,
    correct: async (versionId, body) => {
      const parent = versions.get(versionId);
      if (!parent) throw notFound();
      const job = newJob(parent.projectId, "corregir", { versionId, text: body.text }, 5);
      jobs.set(job.id, job);
      void runJob(job, ["planeando", "render", "revision-calidad"], () => createVersion(parent.projectId, parent, body.text));
      return clone(job);
    },
    rate: async (versionId, body) => {
      const v = versions.get(versionId);
      if (!v) throw notFound();
      const next = { ...v, rating: body.rating ?? null };
      versions.set(versionId, next);
      return clone(next);
    },
    compare: async (a, b) => {
      const va = versions.get(a);
      const vb = versions.get(b);
      if (!va || !vb) throw notFound();
      return { a: clone(va), b: clone(vb), changes: clone(vb.changes), summary: vb.changeSummary };
    },
    exportVersion: async (versionId) => {
      const v = versions.get(versionId);
      if (!v) throw notFound();
      versions.set(versionId, { ...v, exported: true });
      const job = newJob(v.projectId, "exportar", { versionId }, 3);
      jobs.set(job.id, { ...job, status: "listo", progress: 1 });
      return clone(job);
    },
    downloadUrl: () => "#",
    restoreVersion: async (versionId) => {
      const v = versions.get(versionId);
      if (!v) throw notFound();
      const p = getProject(v.projectId);
      const next = { ...p, currentVersionId: versionId, updatedAt: nowIso() };
      projects.set(p.id, next);
      return clone(next);
    },

    listStyles: async () => styles.map(clone),
    createStyle: async (body) => {
      const s = Style.parse({ id: `s-${nanoid(6)}`, ownerId: DEMO_OWNER, name: body.name, slug: body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), description: body.description ?? "", currentVersion: 1, createdAt: nowIso(), updatedAt: nowIso() });
      styles.unshift(s);
      return clone(s);
    },
    getStyle: async (styleId) => {
      const s = styles.find((x) => x.id === styleId);
      if (!s) throw notFound();
      return { style: clone(s), versions: [] };
    },
    updateStyle: async (styleId) => {
      const s = styles.find((x) => x.id === styleId);
      if (!s) throw notFound();
      s.currentVersion += 1;
      return clone(s);
    },
    exportStyleUrl: () => "#",
    importStyle: async () => {
      throw new ApiRequestError("Importar estilos no está disponible en la demo.", 501, "no-disponible");
    },
    deleteStyle: async (styleId) => {
      const i = styles.findIndex((x) => x.id === styleId);
      if (i >= 0) styles.splice(i, 1);
    },

    listBrands: async () => [],
    createBrand: async () => {
      throw new ApiRequestError("La biblioteca de marcas no está disponible en la demo.", 501, "no-disponible");
    },
    getBrand: async () => {
      throw notFound();
    },
    updateBrand: async () => {
      throw notFound();
    },
    deleteBrand: async () => undefined,

    listRules: async () => rules.map(clone),
    createRule: async (body) => {
      const r = { ...clone(rules[0]!), id: `r-${nanoid(6)}`, text: body.text, scope: body.scope ?? "global", enabled: body.enabled ?? true, source: { type: "manual" as const, refId: null, excerpt: "" }, createdAt: nowIso(), updatedAt: nowIso() };
      rules = [r, ...rules];
      return clone(r);
    },
    updateRule: async (ruleId, body) => {
      const r = rules.find((x) => x.id === ruleId);
      if (!r) throw notFound();
      Object.assign(r, body, { updatedAt: nowIso() });
      return clone(r);
    },
    deleteRule: async (ruleId) => {
      rules = rules.filter((r) => r.id !== ruleId);
    },
    listGlossary: async () => [],
    createGlossaryEntry: async (body) => ({ id: `g-${nanoid(6)}`, ownerId: DEMO_OWNER, term: body.term, variants: body.variants ?? [], scope: body.scope ?? "global", scopeId: body.scopeId ?? null, timesApplied: 0, createdAt: nowIso() }),
    deleteGlossaryEntry: async () => undefined,
    getMetrics: async () => ({
      projects: projects.size,
      versions: versions.size,
      correctionsPerVideo: [
        { projectId: "demo-skincare", name: "Rutina de skincare", corrections: 3, createdAt: nowIso() },
        { projectId: "demo-cafe", name: "Café de olla", corrections: 1, createdAt: nowIso() },
      ],
      averageCorrectionsRecent: 1,
      averageCorrectionsPrevious: 3,
      rules: rules.length,
      glossaryTerms: 4,
    }),
  };
  return api;
}

function messageFor(stage: PipelineStage): string {
  switch (stage) {
    case "analizando":
      return "Revisando escenas, voz y tomas de B-roll…";
    case "transcribiendo":
      return "Transcribiendo palabra por palabra…";
    case "planeando":
      return "Claude está armando la edición…";
    case "generando-ia":
      return "Generando imágenes y clips con Kie AI…";
    case "motion-graphics":
      return "Animando gráficos con HyperFrames…";
    case "render":
      return "Renderizando el video…";
    case "revision-calidad":
      return "Claude revisa fotogramas del render…";
    default:
      return "";
  }
}
