/**
 * Guardar ediciones de la transcripción (texto y marcas) con actualización optimista:
 * se ve al instante, se manda PATCH /transcripts/:id/words y, si falla, se revierte con un aviso.
 */
import type { Transcript } from "@autoeditor/shared";
import { useCallback } from "react";
import { messageOf } from "../../api/errors.js";
import { useApi, useEditorContext } from "../../store/context.js";
import { applyEdits, type WordEdit } from "./model.js";

export function useTranscriptSave() {
  const api = useApi();
  const { store } = useEditorContext();
  const replace = useCallback(
    (t: Transcript) => {
      const s = store.getState();
      s.setTranscripts(s.transcripts.map((x) => (x.id === t.id ? t : x)));
    },
    [store],
  );
  return useCallback(
    async (transcriptId: string, edits: WordEdit[], saveToGlossary: boolean): Promise<boolean> => {
      if (!edits.length) return true;
      const before = store.getState().transcripts.find((t) => t.id === transcriptId);
      if (!before) return false;
      replace(applyEdits(before, edits));
      try {
        const next = await api.updateTranscriptWords(transcriptId, { edits, saveToGlossary });
        // Si mientras tanto hubo otra edición local, gana la respuesta del servidor + lo pendiente no aplica.
        replace(next);
        return true;
      } catch (err) {
        replace(before);
        store.getState().toast({ kind: "error", text: `No se guardó el cambio: ${messageOf(err)}` });
        return false;
      }
    },
    [api, store, replace],
  );
}
