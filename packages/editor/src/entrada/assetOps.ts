/**
 * Acciones sobre archivos ya subidos: borrar con DESHACER, reordenar, corregir A-roll/B-roll,
 * prioridad, nota y reintentar el análisis.
 *
 * Borrar con deshacer: el archivo desaparece al instante y el borrado real se manda unos segundos
 * después; "Deshacer" en el aviso lo cancela. Si la página se cierra antes, se manda de inmediato.
 */
import type { Asset } from "@autoeditor/shared";
import { useMemo } from "react";
import { messageOf } from "../api/errors.js";
import type { ApiClient } from "../api/types.js";
import type { Controller } from "../store/controller.js";
import { useEditorContext } from "../store/context.js";
import type { EditorStore } from "../store/editorStore.js";
import { moveItem, orderPatches } from "./order.js";

export const UNDO_DELETE_MS = 5000;

interface PendingDelete {
  asset: Asset;
  timer: ReturnType<typeof setTimeout>;
  toastId: string;
}

const pendingByStore = new WeakMap<EditorStore, Map<string, PendingDelete>>();
const pendingOf = (store: EditorStore) => {
  let m = pendingByStore.get(store);
  if (!m) {
    m = new Map();
    pendingByStore.set(store, m);
  }
  return m;
};

/** Quita referencias a un archivo borrado de la configuración (guion, marca, referencias). */
function dropReferences(store: EditorStore, assetId: string) {
  const ctx = store.getState().settings.context;
  const refs =
    ctx.script.fileAssetId === assetId ||
    ctx.brand.inline.logoAssetIds.includes(assetId) ||
    ctx.brand.inline.fontAssetIds.includes(assetId) ||
    ctx.brand.inline.transitionAssetIds.includes(assetId) ||
    ctx.brand.inline.introAssetId === assetId ||
    ctx.brand.inline.outroAssetId === assetId ||
    ctx.references.imageAssetIds.includes(assetId);
  if (!refs) return;
  store.getState().updateSettings((d) => {
    const c = d.context;
    if (c.script.fileAssetId === assetId) c.script.fileAssetId = null;
    const b = c.brand.inline;
    b.logoAssetIds = b.logoAssetIds.filter((x) => x !== assetId);
    b.fontAssetIds = b.fontAssetIds.filter((x) => x !== assetId);
    b.transitionAssetIds = b.transitionAssetIds.filter((x) => x !== assetId);
    if (b.introAssetId === assetId) b.introAssetId = null;
    if (b.outroAssetId === assetId) b.outroAssetId = null;
    c.references.imageAssetIds = c.references.imageAssetIds.filter((x) => x !== assetId);
  });
}

export function createAssetOps(store: EditorStore, getApi: () => ApiClient, controller: Controller) {
  const s = () => store.getState();
  const pending = pendingOf(store);

  async function commitDelete(assetId: string) {
    const p = pending.get(assetId);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(assetId);
    try {
      await getApi().deleteAsset(assetId);
      dropReferences(store, assetId);
    } catch (err) {
      s().upsertAsset(p.asset);
      s().toast({ kind: "error", text: `No se pudo quitar “${p.asset.originalName}”: ${messageOf(err)}` });
    }
  }

  function undoDelete(assetId: string) {
    const p = pending.get(assetId);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(assetId);
    s().upsertAsset(p.asset);
    s().dismissToast(p.toastId);
  }

  if (typeof window !== "undefined") {
    const flush = () => {
      for (const id of [...pending.keys()]) void commitDelete(id);
    };
    window.addEventListener("pagehide", flush, { once: true });
  }

  return {
    /** Quita el archivo con opción de deshacer. */
    remove(asset: Asset) {
      if (pending.has(asset.id)) return;
      s().removeAsset(asset.id);
      const toastId = `del-${asset.id}`;
      s().toast({ id: toastId, kind: "info", text: `Quitaste “${asset.originalName}”.`, action: { label: "Deshacer", run: () => undoDelete(asset.id) } });
      const timer = setTimeout(() => void commitDelete(asset.id), UNDO_DELETE_MS);
      pending.set(asset.id, { asset, timer, toastId });
    },
    /** Quita varios archivos a la vez ("Vaciar") con un solo aviso y un solo "Deshacer". */
    removeMany(list: Asset[], text: string) {
      const items = list.filter((a) => !pending.has(a.id));
      if (!items.length) return;
      const toastId = `del-${items[0]!.id}-${items.length}`;
      for (const a of items) s().removeAsset(a.id);
      s().toast({ id: toastId, kind: "info", text, action: { label: "Deshacer", run: () => items.forEach((a) => undoDelete(a.id)) } });
      for (const a of items) pending.set(a.id, { asset: a, timer: setTimeout(() => void commitDelete(a.id), UNDO_DELETE_MS), toastId });
    },
    undoDelete,
    isPendingDelete: (id: string) => pending.has(id),

    /** Mueve un archivo dentro de su lista (orden manual) y guarda los `order` que cambian. */
    async reorder(list: Asset[], from: number, to: number) {
      if (from === to || to < 0 || to >= list.length) return;
      const next = moveItem(list, from, to);
      const patches = orderPatches(next);
      const before = new Map(list.map((a) => [a.id, a]));
      for (const p of patches) {
        const a = before.get(p.id);
        if (a) s().upsertAsset({ ...a, order: p.order });
      }
      try {
        await Promise.all(patches.map((p) => getApi().updateAsset(p.id, { order: p.order })));
      } catch (err) {
        for (const a of list) s().upsertAsset(a);
        s().toast({ kind: "error", text: `No se pudo guardar el orden: ${messageOf(err)}` });
      }
    },

    setNote: (asset: Asset, note: string) => (note !== asset.note ? controller.updateAsset(asset.id, { note }) : Promise.resolve()),
    setPriority: (asset: Asset, priority: Asset["priority"]) => controller.updateAsset(asset.id, { priority }),
    setRole: async (asset: Asset, role: Asset["analysis"]["role"]) => {
      await controller.updateAsset(asset.id, { role });
      s().toast({ kind: "exito", text: role === "b-roll" ? "Listo: Claude la usará como toma de apoyo." : role === "a-roll" ? "Listo: Claude la usará como toma principal." : "Listo: tiene partes de ambos." });
    },

    /** Trabajo de análisis conocido para este archivo (si la página lo vio pasar). */
    analysisJobOf(asset: Asset) {
      const jobs = Object.values(s().jobs).filter((j) => j.type === "analizar" && (j.input as { assetId?: string }).assetId === asset.id);
      return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
    },

    /** Reintenta el análisis si se conoce su trabajo; si no, devuelve false (hay que volver a subirlo). */
    async retryAnalysis(asset: Asset): Promise<boolean> {
      const job = this.analysisJobOf(asset);
      if (!job) return false;
      s().upsertAsset({ ...asset, analysis: { ...asset.analysis, status: "pendiente", error: null } });
      try {
        s().upsertJob(await getApi().retryJob(job.id));
        return true;
      } catch (err) {
        s().upsertAsset(asset);
        s().toast({ kind: "error", text: `No se pudo reintentar: ${messageOf(err)}` });
        return true;
      }
    },
  };
}

export type AssetOps = ReturnType<typeof createAssetOps>;

const opsByStore = new WeakMap<EditorStore, AssetOps>();

export function useAssetOps(): AssetOps {
  const { store, getApi, controller } = useEditorContext();
  return useMemo(() => {
    let ops = opsByStore.get(store);
    if (!ops) {
      ops = createAssetOps(store, getApi, controller);
      opsByStore.set(store, ops);
    }
    return ops;
  }, [store, getApi, controller]);
}
