/**
 * Material simulado para las pruebas del editor (sin red ni llaves): assets y transcripción construidos
 * desde data/muestras (probe real con ffprobe y las palabras guardadas en los metadatos del a-roll).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  defaultProjectSettings,
  materializeCaptionWords,
  parseRecipe,
  ProjectSettings,
  type Asset,
  type AssetCategory,
  type Keyword,
  type MediaKind,
  type MediaProbe,
  type MotionTemplate,
  type Project,
  type ProjectSettingsInput,
  type Recipe,
  type Transcript,
} from "@autoeditor/shared";
import { REPO_ROOT } from "../src/env.js";
import type { EditInput, EditorToolbox } from "../src/services/types.js";
import { highlightTerms, sourceWords } from "../src/ai/shared/transcript.js";

export const SAMPLES = path.join(REPO_ROOT, "data/muestras");
export const OWNER = "local";
export const PROJECT_ID = "proj-prueba";

export function samplesAvailable(): boolean {
  return ["a-roll.mp4", "b-roll-1.mp4", "b-roll-2.mp4", "musica.m4a"].every((f) => existsSync(path.join(SAMPLES, f)));
}

function run(cmd: string, args: string[], timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], signal: AbortSignal.timeout(timeoutMs) });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} salió con ${code}: ${err.slice(0, 300)}`))));
  });
}

interface FfprobeJson {
  format?: { duration?: string; tags?: Record<string, string> };
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string }[];
}

export async function ffprobe(file: string): Promise<{ probe: MediaProbe; tags: Record<string, string> }> {
  const json = JSON.parse(await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file])) as FfprobeJson;
  const v = json.streams?.find((s) => s.codec_type === "video");
  const a = json.streams?.find((s) => s.codec_type === "audio");
  const [num, den] = (v?.r_frame_rate ?? "0/1").split("/").map(Number);
  const isImage = /\.(png|jpe?g)$/i.test(file);
  return {
    probe: {
      duration: isImage ? null : Number(json.format?.duration ?? 0) || null,
      width: v?.width ?? null,
      height: v?.height ?? null,
      fps: v && den ? Math.round(((num ?? 0) / den) * 100) / 100 : null,
      rotation: 0,
      videoCodec: v?.codec_name ?? null,
      audioCodec: a?.codec_name ?? null,
      hasAudio: !!a,
      hasVideo: !!v && !isImage,
      variableFrameRate: false,
    },
    tags: json.format?.tags ?? {},
  };
}

const NOW = "2026-10-04T10:00:00.000Z";

function asset(id: string, file: string, category: AssetCategory, kind: MediaKind, probe: MediaProbe, extra: Partial<Asset> = {}, order = 0): Asset {
  return {
    id,
    ownerId: OWNER,
    projectId: PROJECT_ID,
    category,
    kind,
    originalName: file,
    mimeType: kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : "image/png",
    sizeBytes: 1000,
    storageKey: `proyectos/${PROJECT_ID}/${file}`,
    probe,
    analysis: {
      status: "listo",
      error: null,
      scenes: [],
      silences: [],
      loudness: null,
      keyframes: [],
      faces: [],
      description: "",
      hasSpeech: null,
      role: "desconocido",
      brollSegments: [],
      ...(extra.analysis ?? {}),
    },
    thumbnailKey: null,
    priority: "opcional",
    note: "",
    order,
    sha256: null,
    createdAt: NOW,
    ...extra,
    ...(extra.analysis ? { analysis: { ...asset0Analysis(), ...extra.analysis } } : {}),
  } as Asset;
}

function asset0Analysis(): Asset["analysis"] {
  return { status: "listo", error: null, scenes: [], silences: [], loudness: null, keyframes: [], faces: [], description: "", hasSpeech: null, role: "desconocido", brollSegments: [] };
}

export interface SampleMaterial {
  assets: Asset[];
  transcripts: Transcript[];
  arollId: string;
  words: { text: string; start: number; end: number }[];
}

let cached: SampleMaterial | null = null;

/** Assets y transcripción de data/muestras (se calcula una vez por proceso). */
export async function loadSampleMaterial(): Promise<SampleMaterial> {
  if (cached) return structuredClone(cached);
  const aroll = await ffprobe(path.join(SAMPLES, "a-roll.mp4"));
  const meta = JSON.parse(aroll.tags.comment ?? aroll.tags.COMMENT ?? "{}") as { language?: string; words?: { text: string; start: number; end: number; probability: number }[] };
  const words = meta.words ?? [];
  // Silencios simulados a partir de los huecos entre palabras (como los daría silencedetect).
  const silences: [number, number][] = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i]!.start - words[i - 1]!.end;
    if (gap >= 0.5) silences.push([words[i - 1]!.end, words[i]!.start]);
  }
  const b1 = await ffprobe(path.join(SAMPLES, "b-roll-1.mp4"));
  const b2 = await ffprobe(path.join(SAMPLES, "b-roll-2.mp4"));
  const foto = await ffprobe(path.join(SAMPLES, "foto.jpg"));
  const musica = await ffprobe(path.join(SAMPLES, "musica.m4a"));
  const whoosh = await ffprobe(path.join(SAMPLES, "whoosh.wav"));
  const golpe = await ffprobe(path.join(SAMPLES, "golpe.wav"));
  const logo = await ffprobe(path.join(SAMPLES, "logo.png"));
  const assets: Asset[] = [
    asset("a-roll", "a-roll.mp4", "crudo-video", "video", aroll.probe, { analysis: { ...asset0Analysis(), silences, hasSpeech: true, role: "a-roll", loudness: -18 } }, 0),
    asset(
      "b-roll-1",
      "b-roll-1.mp4",
      "crudo-video",
      "video",
      b1.probe,
      { analysis: { ...asset0Analysis(), hasSpeech: false, role: "b-roll", description: "Toma de apoyo con movimiento suave", brollSegments: [{ start: 0.5, end: 7.5, score: 0.8, description: "Movimiento suave de cámara", tags: ["ambiente", "edicion"] }] } },
      1,
    ),
    asset(
      "b-roll-2",
      "b-roll-2.mp4",
      "crudo-video",
      "video",
      b2.probe,
      { analysis: { ...asset0Analysis(), hasSpeech: false, role: "b-roll", description: "Detalle de producto", brollSegments: [{ start: 0, end: 6, score: 0.7, description: "Detalle", tags: ["subtitulos", "pantalla"] }] } },
      2,
    ),
    asset("foto", "foto.jpg", "crudo-foto", "imagen", foto.probe, {}, 3),
    asset("musica", "musica.m4a", "musica", "audio", musica.probe, {}, 4),
    asset("whoosh", "whoosh.wav", "sfx", "audio", whoosh.probe, {}, 5),
    asset("golpe", "golpe.wav", "sfx", "audio", golpe.probe, {}, 6),
    asset("logo", "logo.png", "logo", "imagen", logo.probe, {}, 7),
  ];
  const transcript: Transcript = {
    id: "tr-aroll",
    ownerId: OWNER,
    projectId: PROJECT_ID,
    assetId: "a-roll",
    language: meta.language ?? "es",
    provider: "metadatos",
    model: "espeak-ng",
    status: "listo",
    error: null,
    words: words.map((w, i) => ({ i, text: w.text, start: w.start, end: w.end, probability: w.probability ?? 1, speaker: null, mark: null, original: null, filler: false })),
    segments: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  cached = { assets, transcripts: [transcript], arollId: "a-roll", words };
  return structuredClone(cached);
}

export const TEMPLATES: MotionTemplate[] = [
  { id: "palabra-clave-pop", name: "Palabra clave pop", engine: "hyperframes", source: "<div>{{text}}</div>", propsSchema: { text: { type: "string", label: "Texto" }, color: { type: "color", label: "Color" } }, defaultDuration: 1.5, description: "Palabra que aparece con rebote" },
  { id: "cta-final", name: "CTA final", engine: "hyperframes", source: "<div>{{text}}</div>", propsSchema: { text: { type: "string", label: "Texto" }, accent: { type: "color", label: "Acento" } }, defaultDuration: 3, description: "Llamado a la acción al cierre" },
];

/** JPG mínimo válido (1×1) para simular fotogramas. */
export const TINY_JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

/** Toolbox de prueba: valida y materializa con las funciones de @autoeditor/shared. */
export function makeToolbox(transcripts: Transcript[], keywords: Keyword[] = []): EditorToolbox & { calls: string[] } {
  const calls: string[] = [];
  const words = sourceWords(transcripts);
  return {
    calls,
    async sourceFrame(assetId, t) {
      calls.push(`sourceFrame:${assetId}:${t}`);
      return { base64: TINY_JPEG, mediaType: "image/jpeg" };
    },
    async previewFrame(_recipe, t) {
      calls.push(`previewFrame:${t}`);
      return { base64: TINY_JPEG, mediaType: "image/jpeg" };
    },
    validateRecipe(data) {
      try {
        return { ok: true, recipe: parseRecipe(data) };
      } catch (err) {
        const issues = (err as { issues?: { path: (string | number)[]; message: string }[] }).issues;
        return { ok: false, errors: issues ? issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`) : [String(err)] };
      }
    },
    materializeCaptions(recipe: Recipe) {
      const kw = highlightTerms(keywords);
      return { ...recipe, tracks: { ...recipe.tracks, captions: { ...recipe.tracks.captions, words: materializeCaptionWords(recipe, words, kw, recipe.tracks.captions.overrides) } } };
    },
    motionTemplates: () => TEMPLATES,
    hyperframesGuide: async () => "Guía de HyperFrames (prueba): usa data-composition-id y una línea de tiempo GSAP pausada.",
  };
}

export function makeSettings(over: ProjectSettingsInput = {}): ProjectSettings {
  const base = defaultProjectSettings();
  return ProjectSettings.parse({ ...base, ...over, tools: { ...base.tools, ...(over.tools ?? {}) }, instruction: { ...base.instruction, ...(over.instruction ?? {}) } });
}

export function makeEditInput(material: SampleMaterial, settings: ProjectSettings, extra: Partial<EditInput> = {}): EditInput {
  const project: Project = { id: PROJECT_ID, ownerId: OWNER, name: "Prueba", settings, status: "borrador", currentVersionId: null, thumbnailAssetId: null, createdAt: NOW, updatedAt: NOW };
  const keywords = extra.keywords ?? [];
  return {
    project,
    settings,
    assets: material.assets,
    transcripts: material.transcripts,
    keywords,
    rules: [],
    glossary: [],
    brand: null,
    style: null,
    baseRecipe: null,
    toolbox: makeToolbox(material.transcripts, keywords),
    aiModels: [],
    ...extra,
  };
}
