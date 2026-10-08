/**
 * Material de prueba del render: assets falsos que apuntan a data/muestras (se genera con
 * `node scripts/generar-material-prueba.mjs`) y una receta realista a 9:16.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { Asset, materializeCaptionWords, parseRecipe, type MediaKind, type Recipe, type SourceWord } from "@autoeditor/shared";
import { REPO_ROOT } from "../src/env.js";
import type { Log, RenderContext } from "../src/services/types.js";

export const MUESTRAS = path.join(REPO_ROOT, "data/muestras");
export const hasSamples = () => ["a-roll.mp4", "b-roll-1.mp4", "b-roll-2.mp4", "foto.jpg", "musica.m4a", "whoosh.wav", "logo.png"].every((f) => existsSync(path.join(MUESTRAS, f)));

export const quietLog: Log = { info() {}, warn() {}, error() {}, debug() {} };

const FILES: Record<string, { file: string; kind: MediaKind; category: Asset["category"]; mime: string }> = {
  aroll: { file: "a-roll.mp4", kind: "video", category: "crudo-video", mime: "video/mp4" },
  broll1: { file: "b-roll-1.mp4", kind: "video", category: "crudo-video", mime: "video/mp4" },
  broll2: { file: "b-roll-2.mp4", kind: "video", category: "crudo-video", mime: "video/mp4" },
  foto: { file: "foto.jpg", kind: "imagen", category: "crudo-foto", mime: "image/jpeg" },
  musica: { file: "musica.m4a", kind: "audio", category: "musica", mime: "audio/mp4" },
  whoosh: { file: "whoosh.wav", kind: "audio", category: "sfx", mime: "audio/wav" },
  logo: { file: "logo.png", kind: "imagen", category: "logo", mime: "image/png" },
};

export function sampleAsset(id: string): Asset {
  const f = FILES[id];
  if (!f) throw new Error(`asset de prueba desconocido: ${id}`);
  return Asset.parse({
    id,
    ownerId: "local",
    projectId: "p1",
    category: f.category,
    kind: f.kind,
    originalName: f.file,
    mimeType: f.mime,
    sizeBytes: 1,
    storageKey: `muestras/${f.file}`,
    createdAt: "2026-10-04T00:00:00.000Z",
  });
}

export function sampleContext(workDir: string, extra: Record<string, { path: string; asset?: Asset }> = {}): RenderContext {
  return {
    async resolveAsset(id) {
      if (extra[id]) return { asset: extra[id]!.asset ?? { ...sampleAsset("broll1"), id }, path: extra[id]!.path };
      return { asset: sampleAsset(id), path: path.join(MUESTRAS, FILES[id]!.file) };
    },
    fontsDir: path.join(workDir, "fuentes-proyecto"),
    workDir,
    log: quietLog,
  };
}

/** Palabras con tiempos exactos guardadas en los metadatos del a-roll. */
export function arollWords(): SourceWord[] {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format_tags=comment", "-of", "default=nw=1:nk=1", path.join(MUESTRAS, "a-roll.mp4")], { encoding: "utf8" });
  const data = JSON.parse(r.stdout.trim()) as { words: { text: string; start: number; end: number }[] };
  return data.words.map((w, i) => ({ assetId: "aroll", i, text: w.text, start: w.start, end: w.end }));
}

/** a-roll (seguir) + b-roll-1 (fundido, zoom) + foto (Ken Burns), 9:16, título, karaoke, música con ducking, whoosh. */
export function sampleRecipe(): Recipe {
  const base = parseRecipe({
    format: { aspect: "9:16", width: 1080, height: 1920, fps: 30, platform: "tiktok" },
    tracks: {
      video: [
        {
          id: "c1",
          assetId: "aroll",
          sourceIn: 0.4,
          sourceOut: 8.9,
          reframe: { mode: "seguir", focusX: 0.5, focusY: 0.5, keyframes: [{ t: 0, x: 0.42, y: 0.5 }, { t: 4, x: 0.55, y: 0.5 }, { t: 8.5, x: 0.48, y: 0.5 }] },
          zoom: { from: 1, to: 1.12, start: 5.5, end: 8.5, ease: "suave" },
        },
        { id: "c2", assetId: "broll1", sourceIn: 1, sourceOut: 4, transitionIn: { type: "fundido", duration: 0.5 }, zoom: { from: 1, to: 1.15, start: 0, end: null, ease: "lineal" }, color: { look: "frio", brightness: 0, contrast: 1.05, saturation: 1.1 }, volume: 0.3 },
        { id: "c3", assetId: "foto", sourceIn: 0, sourceOut: 0, stillDuration: 3, reframe: { mode: "fondo-desenfocado", focusX: 0.5, focusY: 0.5, keyframes: [] }, color: { look: "calido", brightness: 0.02, contrast: 1, saturation: 1 } },
      ],
      overlays: [
        { id: "o1", kind: "broll", assetId: "broll2", start: 4.2, end: 6.4, sourceIn: 0.5, layout: "fondo-con-orador", transition: { type: "fundido", duration: 0.25 } },
        { id: "o2", kind: "logo", assetId: "logo", start: 11, end: 14, layout: "pip-arriba-der", kenBurns: false, transition: { type: "fundido", duration: 0.3 } },
      ],
      text: [{ id: "t1", kind: "titulo", text: "Tres trucos para editar", start: 0.2, end: 2.8, position: "arriba", animation: "pop" }],
      graphics: [{ id: "g1", templateId: "palabra-clave-pop", engine: "builtin", props: { text: "Rápido", color: "#FBE88A", textColor: "#111111", accent: "#EE6B6B" }, start: 9.5, end: 11 }],
      captions: { enabled: true, style: { mode: "palabra", highlightStyle: "caja", position: "abajo" } },
      audio: {
        music: [{ id: "m1", assetId: "musica", start: 0, gainDb: -14, duck: true }],
        sfx: [{ id: "s1", assetId: "whoosh", at: 8.05, gainDb: -4, kind: "whoosh" }],
      },
    },
  });
  base.tracks.captions.words = materializeCaptionWords(base, arollWords(), ["trucos", "rápido"]);
  return parseRecipe(base);
}
