/**
 * Transcriptor de modo demo (sin modelo de voz).
 *
 * Si el archivo trae en sus metadatos (etiqueta `comment` del contenedor, la que escribe
 * `scripts/generar-material-prueba.mjs`) un JSON con `words: [{text,start,end,probability}]`,
 * devuelve EXACTAMENTE esas palabras y tiempos, agrupadas en frases. Si no, devuelve una
 * transcripción vacía e informa "Modo demo: sin modelo de voz instalado".
 */
import type { Availability, Log, RawTranscript, RawTranscriptWord, RunOptions, Transcriber } from "../services/types.js";
import { ffprobeJson, type FfprobeOutput } from "../media/probe.js";
import { buildTranscript } from "./segments.js";

export const DEMO_EMPTY_DETAIL = "Modo demo: sin modelo de voz instalado";

export interface DemoTranscriberDeps {
  ffprobePath: string;
  log?: Log;
  /** Motivo por el que se usa el demo (se muestra en el detalle de disponibilidad). */
  reason?: string;
}

interface EmbeddedTranscript {
  language?: unknown;
  words?: unknown;
}

const isWord = (w: unknown): w is RawTranscriptWord =>
  !!w && typeof w === "object" && typeof (w as RawTranscriptWord).text === "string" && Number.isFinite(Number((w as RawTranscriptWord).start)) && Number.isFinite(Number((w as RawTranscriptWord).end));

/** Busca un JSON con palabras en las etiquetas del contenedor o de las pistas. */
export function embeddedTranscript(out: FfprobeOutput): { language: string; words: RawTranscriptWord[] } | null {
  const candidates: string[] = [];
  const pick = (tags?: Record<string, string>) => {
    if (!tags) return;
    for (const [k, v] of Object.entries(tags)) {
      if (/^(comment|description|transcript)$/i.test(k) && typeof v === "string" && v.includes("words")) candidates.push(v);
    }
  };
  pick(out.format?.tags);
  for (const s of out.streams ?? []) pick(s.tags);
  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw) as EmbeddedTranscript;
      if (!Array.isArray(parsed.words)) continue;
      const words = parsed.words.filter(isWord).map((w) => ({
        text: String(w.text),
        start: Number(w.start),
        end: Number(w.end),
        probability: Number.isFinite(Number(w.probability)) ? Number(w.probability) : 1,
        ...(w.speaker ? { speaker: String(w.speaker) } : {}),
      }));
      return { language: typeof parsed.language === "string" ? parsed.language : "", words };
    } catch {
      // no era JSON: se prueba el siguiente
    }
  }
  return null;
}

export function createDemoTranscriber(deps: DemoTranscriberDeps): Transcriber {
  return {
    provider: "demo",
    model: "demo",
    async available(): Promise<Availability> {
      return {
        ready: true,
        detail: deps.reason
          ? `Modo demo (${deps.reason}): solo se leen transcripciones incluidas en los archivos de prueba.`
          : "Modo demo: solo se leen transcripciones incluidas en los archivos de prueba.",
      };
    },
    async transcribe(filePath: string, opts: RunOptions & { language?: string }): Promise<RawTranscript> {
      opts.onProgress?.(0.05, "Leyendo el archivo (modo demo)");
      const out = await ffprobeJson(deps.ffprobePath, filePath, opts.signal);
      const found = embeddedTranscript(out);
      const lang = opts.language && opts.language !== "auto" ? opts.language : "";
      if (!found || found.words.length === 0) {
        deps.log?.info({ file: filePath.split(/[\\/]/).pop() }, DEMO_EMPTY_DETAIL);
        opts.onProgress?.(1, DEMO_EMPTY_DETAIL);
        return { language: lang || "es", words: [], segments: [] };
      }
      const transcript = buildTranscript(found.language || lang || "es", found.words);
      opts.onProgress?.(1, `Transcripción de demostración: ${transcript.words.length} palabras`);
      return transcript;
    },
  };
}
