/**
 * Subidas con progreso REAL, cancelar y reintentar (sin tocar el controlador compartido).
 *
 * - Cada subida queda en `store.uploads` (la ven el lienzo y la vista enfocada).
 * - El archivo y su AbortController se guardan aparte (por instancia del editor) para poder
 *   cancelar o reintentar sin volver a elegirlo.
 * - Si un archivo cae en una zona que no le corresponde (un video en "Fotos"), se acomoda solo
 *   en la categoría correcta y se avisa.
 */
import type { Asset, AssetCategory } from "@autoeditor/shared";
import { nanoid } from "nanoid";
import { useEffect, useMemo, useRef } from "react";
import { ApiRequestError, messageOf } from "../api/errors.js";
import type { ApiClient } from "../api/types.js";
import { categoryForFile } from "../store/controller.js";
import { useEditorContext } from "../store/context.js";
import type { EditorStore } from "../store/editorStore.js";

export type FileKind = "video" | "imagen" | "audio" | "fuente" | "documento" | "otro";

/** Tipo de archivo por MIME o extensión. */
export function fileKind(file: Pick<File, "name" | "type">): FileKind {
  const type = file.type || "";
  const name = file.name.toLowerCase();
  if (type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv|avi|mts|3gp)$/.test(name)) return "video";
  if (type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif|gif|svg|avif)$/.test(name)) return "imagen";
  if (type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|opus|flac)$/.test(name)) return "audio";
  if (/^font\//.test(type) || /\.(ttf|otf|woff2?)$/.test(name)) return "fuente";
  if (/\.(pdf|docx?|txt|md|rtf)$/.test(name) || type === "application/pdf" || type.startsWith("text/")) return "documento";
  return "otro";
}

/** Qué tipos acepta cada categoría (las de material/elementos se pueden reacomodar solas). */
const CATEGORY_KINDS: Partial<Record<AssetCategory, FileKind[]>> = {
  "clip-base": ["video"],
  "crudo-video": ["video"],
  "crudo-foto": ["imagen"],
  "crudo-voz": ["audio"],
  musica: ["audio"],
  sfx: ["audio"],
  grafico: ["imagen", "video"],
  logo: ["imagen"],
  fuente: ["fuente"],
  guion: ["documento"],
  referencia: ["imagen", "video"],
  "marca-intro": ["video", "imagen"],
  "marca-outro": ["video", "imagen"],
  "marca-transicion": ["video", "imagen"],
};

export const CATEGORY_LABELS: Partial<Record<AssetCategory, string>> = {
  "clip-base": "Clip base",
  "crudo-video": "Videos",
  "crudo-foto": "Fotos",
  "crudo-voz": "Notas de voz",
  musica: "Música",
  sfx: "Efectos de sonido",
  grafico: "Imágenes y gráficos",
  logo: "Logos",
  fuente: "Tipografías",
  guion: "Guion",
  referencia: "Referencias",
  "marca-intro": "Intro",
  "marca-outro": "Outro",
  "marca-transicion": "Transiciones",
};

/**
 * Decide la categoría final de un archivo: la de la zona si le corresponde; si no, la que le toca
 * según su tipo (y `moved` = true para avisar). `null` si no se puede usar.
 */
export function resolveCategory(file: Pick<File, "name" | "type">, wanted: AssetCategory | undefined, zone: "crudo" | "elementos"): { category: AssetCategory; moved: boolean } | null {
  const kind = fileKind(file);
  if (wanted) {
    const kinds = CATEGORY_KINDS[wanted];
    if (!kinds || kinds.includes(kind)) return { category: wanted, moved: false };
    // Solo las categorías del material se reacomodan; las demás (guion, fuente…) rechazan.
    const reroutable = ["clip-base", "crudo-video", "crudo-foto", "crudo-voz", "musica", "sfx", "grafico", "logo"].includes(wanted);
    if (!reroutable) return null;
  }
  const auto = categoryForFile(file as File, zone);
  if (auto === "otro") return null;
  return { category: auto, moved: !!wanted && auto !== wanted };
}

interface Pending {
  file: File;
  category: AssetCategory;
  priority?: Asset["priority"];
  note?: string;
  abort: AbortController;
  onDone?: (asset: Asset) => void;
}

const registries = new WeakMap<EditorStore, Map<string, Pending>>();
const registryOf = (store: EditorStore) => {
  let r = registries.get(store);
  if (!r) {
    r = new Map();
    registries.set(store, r);
  }
  return r;
};

export interface UploadRequest {
  zone?: "crudo" | "elementos";
  /** Categoría pedida (zona específica). */
  category?: AssetCategory;
  priority?: Asset["priority"];
  note?: string;
  /** Se llama con cada archivo que terminó de subir (p. ej. para enlazarlo en la marca). */
  onDone?: (asset: Asset) => void;
}

export function createUploader(store: EditorStore, getApi: () => ApiClient) {
  const s = () => store.getState();
  const reg = registryOf(store);

  async function run(id: string): Promise<Asset | null> {
    const p = reg.get(id);
    const project = s().project;
    if (!p || !project) return null;
    p.abort = new AbortController();
    s().upsertUpload({ id, category: p.category, name: p.file.name, size: p.file.size, progress: 0, status: "subiendo" });
    try {
      let asset = await getApi().uploadAsset(project.id, p.file, p.category, {
        signal: p.abort.signal,
        onProgress: (progress) => {
          const cur = s().uploads.find((u) => u.id === id);
          if (cur && cur.status === "subiendo" && (progress - cur.progress >= 0.01 || progress === 1)) s().upsertUpload({ ...cur, progress });
        },
      });
      const patch: { priority?: Asset["priority"]; note?: string } = {};
      if (p.priority && asset.priority !== p.priority) patch.priority = p.priority;
      if (p.note && asset.note !== p.note) patch.note = p.note;
      if (Object.keys(patch).length) asset = await getApi().updateAsset(asset.id, patch).catch(() => ({ ...asset, ...patch }));
      reg.delete(id);
      s().removeUpload(id);
      s().upsertAsset(asset);
      p.onDone?.(asset);
      return asset;
    } catch (err) {
      if (err instanceof ApiRequestError && err.isAbort) {
        reg.delete(id);
        s().removeUpload(id);
        return null;
      }
      const cur = s().uploads.find((u) => u.id === id);
      if (cur) s().upsertUpload({ ...cur, status: "error", error: messageOf(err) });
      return null;
    }
  }

  return {
    /** Sube varios archivos en paralelo. Devuelve los que terminaron bien. */
    async upload(files: File[], req: UploadRequest = {}): Promise<Asset[]> {
      if (!s().project || !files.length) return [];
      const max = s().config?.limits.maxUploadBytes ?? Infinity;
      const ids: string[] = [];
      const moved: string[] = [];
      for (const file of files) {
        if (file.size > max) {
          s().toast({ kind: "error", text: `“${file.name}” pesa más del máximo permitido.` });
          continue;
        }
        if (file.size === 0) {
          s().toast({ kind: "error", text: `“${file.name}” está vacío.` });
          continue;
        }
        const resolved = resolveCategory(file, req.category, req.zone ?? "crudo");
        if (!resolved) {
          s().toast({ kind: "error", text: `“${file.name}” no es un tipo de archivo que se pueda usar aquí.` });
          continue;
        }
        if (resolved.moved) moved.push(`“${file.name}” → ${CATEGORY_LABELS[resolved.category] ?? resolved.category}`);
        const id = nanoid(8);
        reg.set(id, { file, category: resolved.category, priority: resolved.category === "crudo-video" ? req.priority : undefined, note: req.note, abort: new AbortController(), onDone: req.onDone });
        ids.push(id);
      }
      if (moved.length) s().toast({ kind: "info", text: moved.length === 1 ? `Lo acomodé en su lugar: ${moved[0]}.` : `Acomodé ${moved.length} archivos en su categoría.` });
      const results = await Promise.all(ids.map((id) => run(id)));
      return results.filter((a): a is Asset => !!a);
    },
    cancel(id: string) {
      reg.get(id)?.abort.abort();
      if (!reg.has(id)) s().removeUpload(id);
    },
    retry(id: string) {
      if (reg.has(id)) return run(id);
      s().removeUpload(id);
      return Promise.resolve(null);
    },
    dismiss(id: string) {
      reg.get(id)?.abort.abort();
      reg.delete(id);
      s().removeUpload(id);
    },
    canRetry: (id: string) => reg.has(id),
  };
}

export type Uploader = ReturnType<typeof createUploader>;

export function useUploader(): Uploader {
  const { store, getApi } = useEditorContext();
  return useMemo(() => createUploader(store, getApi), [store, getApi]);
}

const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

/** Archivos del portapapeles (capturas de pantalla, archivos copiados). */
export function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file") {
      const f = item.getAsFile();
      if (f) out.push(f.name && f.name !== "image.png" ? f : new File([f], `pegado-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type: f.type }));
    }
  }
  if (!out.length && data.files?.length) out.push(...Array.from(data.files));
  return out;
}

/** Pegar archivos (Ctrl+V) mientras `enabled`; ignora el pegado dentro de campos de texto. */
export function usePasteFiles(enabled: boolean, onFiles: (files: File[]) => void) {
  const cb = useRef(onFiles);
  cb.current = onFiles;
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const files = filesFromClipboard(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      cb.current(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [enabled]);
}
