/**
 * Transcripción sin red ni llaves: segmentación, demo (lee las palabras incrustadas en el a-roll de
 * prueba), faster-whisper sin modelo (mensaje claro), caída automática al demo y la API compatible
 * con un fetch simulado.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isFiller } from "@autoeditor/shared";
import { REPO_ROOT, loadEnv } from "../src/env.js";
import { UserFacingError, type Log } from "../src/services/types.js";
import {
  createDemoTranscriber,
  createOpenAiTranscriber,
  createTranscriber,
  createTranscriberWithFallback,
  createWhisperTranscriber,
  DEMO_EMPTY_DETAIL,
  groupSegments,
  normalizeWords,
} from "../src/transcription/index.js";
import { normalizeLanguage, wordsFromVerbose } from "../src/transcription/openai.js";
import { runProcess } from "../src/media/process.js";

const SAMPLES = path.join(REPO_ROOT, "data/muestras");
const AROLL = path.join(SAMPLES, "a-roll.mp4");
const haveSamples = existsSync(AROLL);
const log: Log = { info() {}, warn() {}, error() {}, debug() {} };
const env = loadEnv({ anthropicApiKey: "", kieApiKey: "", transcriptionApiKey: "", demoMode: true });
const venvPython = path.join(REPO_ROOT, "workers/python/.venv/bin/python");
let haveWhisper = false;

let tmp: string;
const prevOffline = process.env.HF_HUB_OFFLINE;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "autoeditor-trn-test-"));
  // Nunca descargar modelos en las pruebas (aunque haya red).
  process.env.HF_HUB_OFFLINE = "1";
  if (existsSync(venvPython)) {
    const r = await runProcess(venvPython, ["-c", "import faster_whisper"], { timeoutMs: 30_000 }).catch(() => null);
    haveWhisper = r?.code === 0;
  }
});

afterAll(async () => {
  if (prevOffline === undefined) delete process.env.HF_HUB_OFFLINE;
  else process.env.HF_HUB_OFFLINE = prevOffline;
  await rm(tmp, { recursive: true, force: true });
});

const w = (text: string, start: number, end: number) => ({ text, start, end, probability: 0.9 });

describe("segmentación", () => {
  it("corta por puntuación y por pausas largas", () => {
    const words = normalizeWords([w("Hola,", 0, 0.3), w("soy", 0.35, 0.5), w("Ana.", 0.55, 0.8), w("Hoy", 0.9, 1.1), w("vemos", 1.15, 1.4), w("esto", 2.5, 2.8), w("y", 2.85, 2.9), w("aquello", 2.95, 3.4)]);
    const segs = groupSegments(words);
    expect(segs.map((s) => s.text)).toEqual(["Hola, soy Ana.", "Hoy vemos", "esto y aquello"]);
    expect(segs[0]).toMatchObject({ start: 0, end: 0.8, firstWord: 0, lastWord: 2 });
    expect(segs[2]).toMatchObject({ firstWord: 5, lastWord: 7 });
  });

  it("limpia palabras vacías, ordena y quita solapes", () => {
    const words = normalizeWords([w("b", 1, 1.6), w("  ", 0.2, 0.3), w("a", 0, 1.2), { text: "c", start: Number.NaN, end: 2, probability: 1 }]);
    expect(words.map((x) => x.text)).toEqual(["a", "b"]);
    expect(words[0]!.end).toBe(1);
  });

  it("parte frases demasiado largas", () => {
    const many = Array.from({ length: 70 }, (_, i) => w(`p${i}`, i * 0.3, i * 0.3 + 0.25));
    const segs = groupSegments(many);
    expect(segs.length).toBeGreaterThanOrEqual(3);
    expect(segs.every((s) => s.lastWord - s.firstWord + 1 <= 30)).toBe(true);
    expect(segs[segs.length - 1]!.lastWord).toBe(69);
  });
});

describe.skipIf(!haveSamples)("transcriptor demo", () => {
  it("lee las 44 palabras incrustadas en el a-roll de prueba", async () => {
    const t = createDemoTranscriber({ ffprobePath: env.ffprobePath, log });
    const messages: string[] = [];
    const raw = await t.transcribe(AROLL, { onProgress: (_p, m) => m && messages.push(m) });
    expect(raw.language).toBe("es");
    expect(raw.words).toHaveLength(44);
    expect(raw.words[0]).toMatchObject({ text: "Hola,", start: 0.6, end: 0.926 });
    // Segmentos contiguos que cubren todas las palabras.
    expect(raw.segments.length).toBeGreaterThan(2);
    expect(raw.segments[0]!.firstWord).toBe(0);
    expect(raw.segments[raw.segments.length - 1]!.lastWord).toBe(43);
    for (let i = 1; i < raw.segments.length; i++) expect(raw.segments[i]!.firstWord).toBe(raw.segments[i - 1]!.lastWord + 1);
    // El texto se devuelve tal cual; la muletilla se detecta con isFiller al guardar.
    expect(raw.words.some((x) => isFiller(x.text))).toBe(true);
    expect(messages.at(-1)).toMatch(/44 palabras/);
  });

  it("sin transcripción incrustada devuelve vacío con el aviso del modo demo", async () => {
    const t = createDemoTranscriber({ ffprobePath: env.ffprobePath, log });
    const messages: string[] = [];
    const raw = await t.transcribe(path.join(SAMPLES, "b-roll-1.mp4"), { onProgress: (_p, m) => m && messages.push(m) });
    expect(raw.words).toEqual([]);
    expect(raw.segments).toEqual([]);
    expect(messages).toContain(DEMO_EMPTY_DETAIL);
  });

  it("createTranscriber elige según la configuración", () => {
    const base = { model: "small", device: "auto" as const, computeType: "int8", apiBaseUrl: "", apiModel: "whisper-1" };
    expect(createTranscriber({ env, log, config: { ...base, provider: "demo" } }).provider).toBe("demo");
    expect(createTranscriber({ env, log, config: { ...base, provider: "faster-whisper" } }).provider).toBe("faster-whisper");
    expect(createTranscriber({ env, log, config: { ...base, provider: "openai-compatible" } }).provider).toBe("openai-compatible");
  });
});

describe("faster-whisper", () => {
  it("sin venv: no está listo y pide «pnpm instalar»", async () => {
    const t = createWhisperTranscriber({ pythonPath: path.join(tmp, "no-existe", "python"), ffprobePath: env.ffprobePath, model: "small", device: "auto", computeType: "int8", log, modelsDir: tmp });
    const a = await t.available();
    expect(a.ready).toBe(false);
    expect(a.detail).toMatch(/pnpm instalar/);
  });

  it.skipIf(!haveSamples)("sin modelo y sin conexión: error claro en español (o se salta si no hay venv)", async (ctx) => {
    if (!haveWhisper) {
      console.warn("[transcripción] se salta: el venv de Python con faster-whisper no existe (corre pnpm instalar)");
      ctx.skip();
      return;
    }
    const t = createWhisperTranscriber({ pythonPath: venvPython, ffprobePath: env.ffprobePath, model: "tiny", device: "auto", computeType: "int8", log, modelsDir: path.join(tmp, "models") });
    const a = await t.available();
    expect(a.ready).toBe(false);
    expect(a.detail).toMatch(/no está descargado/);
    const check = await t.check();
    expect(check).toMatchObject({ modelPresent: false, canDownload: false });
    expect(check.fasterWhisper).toMatch(/\d/);
    const err = await t.transcribe(AROLL, { language: "es", hotwords: ["Zyra", "HyperFrames"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as UserFacingError).code).toBe("modelo-no-disponible");
    expect((err as UserFacingError).userMessage).toMatch(/modelo de voz «tiny»/);
    expect((err as UserFacingError).userMessage).toMatch(/pnpm instalar/);
  }, 60_000);

  it.skipIf(!haveSamples)("cae al demo si faster-whisper no está listo e informa el motivo", async () => {
    const t = createTranscriberWithFallback({
      env: { ...env, pythonPath: haveWhisper ? venvPython : path.join(tmp, "no-existe", "python") },
      log,
      config: { provider: "faster-whisper", model: "tiny", device: "auto", computeType: "int8", apiBaseUrl: "", apiModel: "whisper-1" },
      modelsDir: path.join(tmp, "models"),
    });
    expect(t.configuredProvider).toBe("faster-whisper");
    const a = await t.available();
    expect(a.ready).toBe(false);
    expect(a.detail).toMatch(/modo demo/);
    expect(t.provider).toBe("demo");
    expect(t.fallbackReason).toBeTruthy();
    const raw = await t.transcribe(AROLL, { language: "auto" });
    expect(raw.words).toHaveLength(44);
  }, 60_000);
});

describe("API compatible con OpenAI (fetch simulado)", () => {
  it("normaliza idioma y palabras de verbose_json", () => {
    expect(normalizeLanguage("spanish")).toBe("es");
    expect(normalizeLanguage("en-US")).toBe("en");
    const words = wordsFromVerbose({ segments: [{ start: 0, end: 2, text: "uno dos" }] }, 10);
    expect(words).toHaveLength(2);
    expect(words[0]!.start).toBe(10);
    expect(words[1]!.end).toBeCloseTo(12);
  });

  it("sin llave no está listo", async () => {
    const t = createOpenAiTranscriber({ ffmpegPath: env.ffmpegPath, ffprobePath: env.ffprobePath, apiBaseUrl: "https://api.example.com/v1", apiModel: "whisper-1", apiKey: "", log });
    expect((await t.available()).ready).toBe(false);
  });

  it.skipIf(!haveSamples)("envía el audio extraído con los campos correctos y mapea la respuesta", async () => {
    const calls: { url: string; auth: string | null; fields: Record<string, unknown[]>; size: number }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const form = init!.body as FormData;
      const fields: Record<string, unknown[]> = {};
      let size = 0;
      for (const [k, v] of form.entries()) {
        (fields[k] ??= []).push(typeof v === "string" ? v : "blob");
        if (typeof v !== "string") size = v.size;
      }
      calls.push({ url: String(url), auth: new Headers(init!.headers).get("authorization"), fields, size });
      return new Response(
        JSON.stringify({ language: "spanish", duration: 24, words: [{ word: " Hola", start: 0.6, end: 0.9 }, { word: "soy", start: 1.1, end: 1.5 }, { word: "Ana.", start: 1.55, end: 1.9 }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const t = createOpenAiTranscriber({ ffmpegPath: env.ffmpegPath, ffprobePath: env.ffprobePath, apiBaseUrl: "https://api.example.com/v1/", apiModel: "whisper-1", apiKey: "sk-test-123456789", log, fetchImpl });
    const raw = await t.transcribe(AROLL, { language: "es", hotwords: ["Zyra"] });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe("https://api.example.com/v1/audio/transcriptions");
    expect(c.auth).toBe("Bearer sk-test-123456789");
    expect(c.fields).toMatchObject({ model: ["whisper-1"], response_format: ["verbose_json"], language: ["es"], prompt: ["Zyra"], file: ["blob"] });
    expect(c.fields["timestamp_granularities[]"]).toContain("word");
    expect(c.size).toBeGreaterThan(10_000);
    expect(c.size).toBeLessThan(2_000_000); // 24 s a 32 kbps ≈ 100 KB
    expect(raw.language).toBe("es");
    expect(raw.words.map((x) => x.text)).toEqual(["Hola", "soy", "Ana."]);
    expect(raw.segments).toHaveLength(1);
  }, 60_000);

  it.skipIf(!haveSamples)("traduce un 401 a un mensaje claro sin filtrar la llave", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: "Incorrect API key provided: sk-test-123456789" } }), { status: 401 })) as typeof fetch;
    const t = createOpenAiTranscriber({ ffmpegPath: env.ffmpegPath, ffprobePath: env.ffprobePath, apiBaseUrl: "https://api.example.com/v1", apiModel: "whisper-1", apiKey: "sk-test-123456789", log, fetchImpl });
    const err = (await t.transcribe(AROLL, { language: "auto" }).catch((e: unknown) => e)) as UserFacingError;
    expect(err).toBeInstanceOf(UserFacingError);
    expect(err.code).toBe("transcripcion-llave-invalida");
    expect(err.userMessage).not.toContain("sk-test");
  }, 60_000);
});
