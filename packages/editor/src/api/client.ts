/**
 * Cliente HTTP tipado de la API del autoeditor (prefijo configurable, normalmente /api/v1).
 *
 * - Una función por ruta de `ROUTES` (@autoeditor/shared/api).
 * - Errores con el mensaje en español del servidor (`ApiRequestError`).
 * - Subida de archivos con progreso real (XMLHttpRequest → `upload.onprogress`).
 * - Eventos en vivo por SSE con reconexión automática.
 *
 * Las respuestas se aceptan tanto "desnudas" (`Project`) como envueltas (`{ project }`), para
 * tolerar pequeñas diferencias de forma entre versiones del servidor.
 */
import type {
  Asset,
  AssetCategory,
  Brand,
  CompareResponse,
  CorrectionBody,
  CreateProjectBody,
  CreateStyleBody,
  EstimateResponse,
  GlossaryEntry,
  Job,
  Keyword,
  KeywordsResponse,
  LearningMetrics,
  MemoryRule,
  Plan,
  Project,
  ProjectDetail,
  PublicConfig,
  Style,
  Transcript,
  UpdateAssetBody,
  UpdateProjectBody,
  UpdateTranscriptWordsBody,
  Version,
} from "@autoeditor/shared";
import { abortError, errorFromResponse, networkError } from "./errors.js";
import { connectSse } from "./sse.js";
import type {
  ApiClient,
  ApiClientOptions,
  BrandInput,
  DownloadType,
  ExportInput,
  GlossaryInput,
  RatingInput,
  RuleInput,
  StyleDetail,
  UpdateStyleInput,
  UploadOptions,
} from "./types.js";

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** Si la respuesta viene envuelta en `{ [key]: valor }`, devuelve el valor; si no, la respuesta tal cual. */
export function unwrap<T>(res: unknown, key: string): T {
  if (res && typeof res === "object" && !Array.isArray(res) && key in (res as Record<string, unknown>)) {
    return (res as Record<string, unknown>)[key] as T;
  }
  return res as T;
}

const id = (v: { id: string } | string) => (typeof v === "string" ? v : v.id);
const enc = encodeURIComponent;

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch: typeof fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));

  const headers = (): Record<string, string> => {
    const extra = typeof options.headers === "function" ? options.headers() : (options.headers ?? {});
    const h: Record<string, string> = { ...extra };
    if (options.ownerId) h["X-Owner-Id"] = options.ownerId;
    return h;
  };

  const url = (path: string) => `${baseUrl}${path}`;

  async function request<T>(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(url(path), {
        method,
        headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers() },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") throw abortError();
      throw networkError(err);
    }
    const text = await res.text().catch(() => "");
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) throw errorFromResponse(res.status, data);
    return data as T;
  }

  /** Subida multipart con progreso. El campo `category` va ANTES del archivo (multipart en streaming). */
  function upload<T>(path: string, fields: Record<string, string>, file: File, opts: UploadOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url(path));
      for (const [k, v] of Object.entries(headers())) xhr.setRequestHeader(k, v);
      xhr.setRequestHeader("Accept", "application/json");
      xhr.upload.onprogress = (e) => {
        const total = e.lengthComputable ? e.total : file.size;
        opts.onProgress?.(total ? Math.min(1, e.loaded / total) : 0, e.loaded, total);
      };
      xhr.onload = () => {
        let data: unknown = null;
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          data = xhr.responseText;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          opts.onProgress?.(1, file.size, file.size);
          resolve(data as T);
        } else reject(errorFromResponse(xhr.status, data));
      };
      xhr.onerror = () => reject(networkError());
      xhr.onabort = () => reject(abortError());
      if (opts.signal) {
        if (opts.signal.aborted) {
          reject(abortError());
          return;
        }
        opts.signal.addEventListener("abort", () => xhr.abort(), { once: true });
      }
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      form.append("file", file, file.name);
      xhr.send(form);
    });
  }

  const client: ApiClient = {
    baseUrl,
    isDemo: false,

    // ---------------------------------------------------------------- Sistema
    health: () => request<{ ok: boolean }>("GET", "/health"),
    getConfig: async () => unwrap<PublicConfig>(await request("GET", "/config"), "config"),

    // ---------------------------------------------------------------- Proyectos
    listProjects: async () => unwrap<Project[]>(await request("GET", "/projects"), "projects"),
    createProject: async (body: CreateProjectBody) => unwrap<Project>(await request("POST", "/projects", body), "project"),
    getProject: (projectId) => request<ProjectDetail>("GET", `/projects/${enc(projectId)}`),
    updateProject: async (projectId, body: UpdateProjectBody) => unwrap<Project>(await request("PATCH", `/projects/${enc(projectId)}`, body), "project"),
    deleteProject: async (projectId) => {
      await request("DELETE", `/projects/${enc(projectId)}`);
    },

    // ---------------------------------------------------------------- Archivos
    uploadAsset: async (projectId, file, category: AssetCategory, opts) =>
      unwrap<Asset>(await upload(`/projects/${enc(projectId)}/assets`, { category }, file, opts), "asset"),
    listAssets: async (projectId) => unwrap<Asset[]>(await request("GET", `/projects/${enc(projectId)}/assets`), "assets"),
    updateAsset: async (assetId, body: UpdateAssetBody) => unwrap<Asset>(await request("PATCH", `/assets/${enc(assetId)}`, body), "asset"),
    deleteAsset: async (assetId) => {
      await request("DELETE", `/assets/${enc(assetId)}`);
    },
    assetFileUrl: (asset) => url(`/assets/${enc(id(asset))}/file`),
    assetThumbnailUrl: (asset) => {
      if (typeof asset !== "string" && !asset.thumbnailKey && asset.kind !== "imagen") return null;
      return url(`/assets/${enc(id(asset))}/thumbnail`);
    },
    assetFrameUrl: (asset, t) => url(`/assets/${enc(id(asset))}/frame?t=${encodeURIComponent(t.toFixed(2))}`),

    // ---------------------------------------------------------------- Transcripción y palabras clave
    listTranscripts: async (projectId) => unwrap<Transcript[]>(await request("GET", `/projects/${enc(projectId)}/transcripts`), "transcripts"),
    updateTranscriptWords: async (transcriptId, body: UpdateTranscriptWordsBody) =>
      unwrap<Transcript>(await request("PATCH", `/transcripts/${enc(transcriptId)}/words`, body), "transcript"),
    getKeywords: async (projectId) => normalizeKeywords(await request("GET", `/projects/${enc(projectId)}/keywords`)),
    putKeywords: async (projectId, keywords: Keyword[]) =>
      normalizeKeywords(await request("PUT", `/projects/${enc(projectId)}/keywords`, { keywords })).keywords,
    detectKeywords: async (projectId) => normalizeKeywords(await request("POST", `/projects/${enc(projectId)}/keywords/detect`, {})),

    // ---------------------------------------------------------------- Generar, plan y trabajos
    estimate: async (projectId) => unwrap<EstimateResponse>(await request("POST", `/projects/${enc(projectId)}/estimate`, {}), "estimate"),
    generate: async (projectId) => unwrap<Job>(await request("POST", `/projects/${enc(projectId)}/generate`, {}), "job"),
    getPlan: async (planId) => unwrap<Plan>(await request("GET", `/plans/${enc(planId)}`), "plan"),
    approvePlan: async (planId) => unwrap<Job>(await request("POST", `/plans/${enc(planId)}/approve`, {}), "job"),
    revisePlan: async (planId, feedback) => unwrap<Job>(await request("POST", `/plans/${enc(planId)}/revise`, { feedback }), "job"),
    getJob: async (jobId) => unwrap<Job>(await request("GET", `/jobs/${enc(jobId)}`), "job"),
    cancelJob: async (jobId) => unwrap<Job>(await request("POST", `/jobs/${enc(jobId)}/cancel`, {}), "job"),
    retryJob: async (jobId) => unwrap<Job>(await request("POST", `/jobs/${enc(jobId)}/retry`, {}), "job"),
    subscribe: (projectId, opts) => connectSse({ ...opts, url: url(`/projects/${enc(projectId)}/events`), headers, fetch: doFetch }),

    // ---------------------------------------------------------------- Versiones
    listVersions: async (projectId) => unwrap<Version[]>(await request("GET", `/projects/${enc(projectId)}/versions`), "versions"),
    getVersion: async (versionId) => unwrap<Version>(await request("GET", `/versions/${enc(versionId)}`), "version"),
    versionVideoUrl: (version) => {
      if (typeof version !== "string" && (version.status !== "lista" || !version.videoKey)) return null;
      return url(`/versions/${enc(id(version))}/video`);
    },
    versionPosterUrl: () => null,
    correct: async (versionId, body: CorrectionBody) => unwrap<Job>(await request("POST", `/versions/${enc(versionId)}/corrections`, body), "job"),
    rate: async (versionId, body: RatingInput) => unwrap<Version>(await request("POST", `/versions/${enc(versionId)}/rating`, body), "version"),
    compare: (a, b) => request<CompareResponse>("GET", `/versions/compare?a=${enc(a)}&b=${enc(b)}`),
    exportVersion: async (versionId, body: ExportInput = {}) => unwrap<Job>(await request("POST", `/versions/${enc(versionId)}/export`, body), "job"),
    downloadUrl: (versionId, type: DownloadType, quality = "1080") => url(`/versions/${enc(versionId)}/download?type=${type}&quality=${quality}`),
    restoreVersion: async (versionId) => unwrap<Project>(await request("POST", `/versions/${enc(versionId)}/restore`, {}), "project"),

    // ---------------------------------------------------------------- Estilos
    listStyles: async () => unwrap<Style[]>(await request("GET", "/styles"), "styles"),
    createStyle: async (body: CreateStyleBody) => unwrap<Style>(await request("POST", "/styles", body), "style"),
    getStyle: async (styleId) => {
      const res = await request<unknown>("GET", `/styles/${enc(styleId)}`);
      if (res && typeof res === "object" && "style" in res) return { versions: [], ...(res as Partial<StyleDetail>) } as StyleDetail;
      return { style: res as Style, versions: [] };
    },
    updateStyle: async (styleId, body: UpdateStyleInput) => unwrap<Style>(await request("POST", `/styles/${enc(styleId)}/versions`, body), "style"),
    exportStyleUrl: (styleId) => url(`/styles/${enc(styleId)}/export`),
    importStyle: async (file, opts) => unwrap<Style>(await upload("/styles/import", {}, file, opts), "style"),
    deleteStyle: async (styleId) => {
      await request("DELETE", `/styles/${enc(styleId)}`);
    },

    // ---------------------------------------------------------------- Marcas
    listBrands: async () => unwrap<Brand[]>(await request("GET", "/brands"), "brands"),
    createBrand: async (body: BrandInput) => unwrap<Brand>(await request("POST", "/brands", body), "brand"),
    getBrand: async (brandId) => unwrap<Brand>(await request("GET", `/brands/${enc(brandId)}`), "brand"),
    updateBrand: async (brandId, body) => unwrap<Brand>(await request("PATCH", `/brands/${enc(brandId)}`, body), "brand"),
    deleteBrand: async (brandId) => {
      await request("DELETE", `/brands/${enc(brandId)}`);
    },

    // ---------------------------------------------------------------- Memoria
    listRules: async () => unwrap<MemoryRule[]>(await request("GET", "/memory/rules"), "rules"),
    createRule: async (body: RuleInput) => unwrap<MemoryRule>(await request("POST", "/memory/rules", body), "rule"),
    updateRule: async (ruleId, body) => unwrap<MemoryRule>(await request("PATCH", `/memory/rules/${enc(ruleId)}`, body), "rule"),
    deleteRule: async (ruleId) => {
      await request("DELETE", `/memory/rules/${enc(ruleId)}`);
    },
    listGlossary: async () => unwrap<GlossaryEntry[]>(await request("GET", "/memory/glossary"), "glossary"),
    createGlossaryEntry: async (body: GlossaryInput) => unwrap<GlossaryEntry>(await request("POST", "/memory/glossary", body), "entry"),
    deleteGlossaryEntry: async (entryId) => {
      await request("DELETE", `/memory/glossary/${enc(entryId)}`);
    },
    getMetrics: async () => unwrap<LearningMetrics>(await request("GET", "/memory/metrics"), "metrics"),
  };
  return client;
}

function normalizeKeywords(res: unknown): KeywordsResponse {
  if (Array.isArray(res)) return { keywords: res as Keyword[], publishCopy: null };
  const r = (res ?? {}) as Partial<KeywordsResponse>;
  return { keywords: r.keywords ?? [], publishCopy: r.publishCopy ?? null };
}
