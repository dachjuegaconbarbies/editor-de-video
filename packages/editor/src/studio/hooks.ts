/**
 * Hooks del estudio: subir archivos sin preguntar nada (la categoría sale del tipo de archivo)
 * y prender solas las opciones que el material pide (p. ej. subiste música → "Música" se prende).
 */
import type { Asset, AssetCategory } from "@autoeditor/shared";
import { createElement, useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { fileKind, useUploader } from "../entrada/uploads.js";
import { useEditorContext } from "../store/context.js";
import { BASE_CATEGORY, groupFilesByCategory } from "./logic.js";

export type DropZone = "base" | "extras";

export function useStudioUpload() {
  const uploader = useUploader();
  const { store } = useEditorContext();

  /** Ajustes que se prenden solos según lo que se subió abajo. */
  const afterExtras = useCallback(
    (category: AssetCategory, assets: Asset[]) => {
      if (!assets.length) return;
      const st = store.getState();
      const t = st.settings.tools;
      if (category === "musica" && !t.music.enabled) {
        st.updateSettings((d) => {
          d.tools.music.enabled = true;
          d.tools.music.source = "mia";
        });
        st.toast({ kind: "info", text: "Prendí “Música” para usar tu canción." });
      }
      if (category === "crudo-video" && !t.broll.enabled) {
        st.updateSettings((d) => {
          d.tools.broll.enabled = true;
          if (d.tools.broll.source === "ia") d.tools.broll.source = "ambos";
        });
        st.toast({ kind: "info", text: "Prendí “B-roll” para usar tus otros clips como tomas de apoyo." });
      }
      if (category === "sfx" && !t.sfx.enabled) {
        st.updateSettings((d) => {
          d.tools.sfx.enabled = true;
        });
      }
      if (category === "guion") {
        st.updateSettings((d) => {
          d.context.script.enabled = true;
          d.context.script.fileAssetId = assets[0]!.id;
        });
        st.toast({ kind: "info", text: "Usaré tu guion para ordenar y cortar el video." });
      }
      if (category === "logo") {
        st.updateSettings((d) => {
          d.context.brand.enabled = true;
          d.context.brand.inline.logoAssetIds = [...new Set([...d.context.brand.inline.logoAssetIds, ...assets.map((a) => a.id)])];
        });
      }
      if (category === "referencia") {
        st.updateSettings((d) => {
          d.context.references.enabled = true;
          d.context.references.imageAssetIds = [...new Set([...d.context.references.imageAssetIds, ...assets.map((a) => a.id)])];
        });
      }
    },
    [store],
  );

  return useCallback(
    async (files: File[], zone: DropZone, forced?: AssetCategory) => {
      if (!files.length) return;
      const st = store.getState();
      const tasks: Promise<unknown>[] = [];
      if (forced) {
        tasks.push(uploader.upload(files, { category: forced }).then((assets) => afterExtras(forced, assets)));
        await Promise.all(tasks);
        return;
      }
      const videos = zone === "base" ? files.filter((f) => fileKind(f) === "video") : [];
      const rest = zone === "base" ? files.filter((f) => fileKind(f) !== "video") : files;
      const { groups, rejected } = groupFilesByCategory(rest);
      for (const f of rejected) st.toast({ kind: "error", text: `“${f.name}” no es un video, foto, audio ni documento que se pueda usar.` });
      if (zone === "base" && groups.size > 0) st.toast({ kind: "info", text: "Lo que no es video (fotos, música…) lo puse abajo, con lo demás." });
      if (videos.length) tasks.push(uploader.upload(videos, { category: BASE_CATEGORY }));
      for (const [category, list] of groups) tasks.push(uploader.upload(list, { category }).then((assets) => afterExtras(category, assets)));
      await Promise.all(tasks);
    },
    [store, uploader, afterExtras],
  );
}

/** Reloj que avanza cada segundo mientras `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/**
 * Selector de archivos con un <input type="file"> oculto pero presente en el DOM (accesible y
 * fácil de automatizar). Devuelve el elemento a renderizar y `open()` para abrirlo.
 */
export function useFilePicker(opts: { accept: string; multiple?: boolean; label: string; onFiles: (files: File[]) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const cb = useRef(opts.onFiles);
  cb.current = opts.onFiles;
  const input = createElement("input", {
    ref,
    type: "file",
    accept: opts.accept,
    multiple: opts.multiple ?? true,
    "aria-label": opts.label,
    className: "ae-sr-only",
    tabIndex: -1,
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = "";
      if (files.length) cb.current(files);
    },
  });
  return { input, open: () => ref.current?.click() };
}
