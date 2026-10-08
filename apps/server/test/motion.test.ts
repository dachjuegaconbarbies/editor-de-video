/**
 * Motores de motion graphics: plantillas de fábrica, builtin (ffmpeg + libass con alfa), Remotion
 * apagado y HyperFrames real si en esta máquina hay Chrome headless (sin red: GSAP va vendorizado).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";
import { createMotionEngines } from "../src/motion/index.js";
import { fillTemplate, findChrome } from "../src/motion/hyperframes.js";
import { resolveProps, TEMPLATES } from "../src/motion/templates.js";
import type { Services } from "../src/services/types.js";
import { quietLog } from "./render-fixtures.js";

const REQUIRED = ["titulo-cinetico", "cintillo", "cifra-contador", "palabra-clave-pop", "cta-final", "logo-sting"];

function streamInfo(file: string): { pix_fmt: string; nb_frames: string; width: number; height: number } {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt,nb_frames,width,height", "-of", "json", file], { encoding: "utf8" });
  return (JSON.parse(r.stdout) as { streams: { pix_fmt: string; nb_frames: string; width: number; height: number }[] }).streams[0]!;
}

/** Histograma del canal alfa de un fotograma: [transparentes, opacos, total]. */
function alphaStats(file: string, t: number): [number, number, number] {
  const r = spawnSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "alphaextract", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 64 * 1024 * 1024 });
  const buf = r.stdout as Buffer;
  let zero = 0;
  let full = 0;
  for (const v of buf) {
    if (v === 0) zero++;
    else if (v === 255) full++;
  }
  return [zero, full, buf.length];
}

describe("plantillas de fábrica", () => {
  it("incluye las 6 plantillas con props tipadas y HTML válido para HyperFrames", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(expect.arrayContaining(REQUIRED));
    for (const t of TEMPLATES) {
      expect(Object.keys(t.propsSchema).length).toBeGreaterThan(2);
      for (const p of Object.values(t.propsSchema)) expect(["string", "number", "color", "boolean"]).toContain(p.type);
      expect(t.propsSchema.color?.type).toBe("color");
      expect(t.propsSchema.fontFamily?.type).toBe("string");
      expect(t.html).toContain('data-composition-id="mg"');
      expect(t.html).toContain('window.__timelines["mg"]');
      expect(t.html).toContain("vendor/gsap.min.js");
      expect(t.html).not.toMatch(/Math\.random|Date\.now|https?:\/\//);
    }
  });

  it("valida props: colores, números y valores por defecto", () => {
    const schema = TEMPLATES.find((t) => t.id === "cifra-contador")!.propsSchema;
    const p = resolveProps(schema, { value: "2,500", color: "rojo", accent: "#112233", extra: "x" });
    expect(p.value).toBe(2500);
    expect(p.color).toBe("#8B7CF0");
    expect(p.accent).toBe("#112233");
    expect(p.text).toBe("clientes felices");
    expect(p.extra).toBe("x");
  });

  it("fillTemplate escapa HTML, llena reservados y reescribe GSAP de CDN a local", () => {
    const html = '<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script><h1>{{text}}</h1><div data-d="{{duration}}">{{nada}}</div>';
    const out = fillTemplate(html, { text: '<b>"Hola" & adiós</b>' }, { duration: "2.5" });
    expect(out).toContain('<script src="vendor/gsap.min.js"></script>');
    expect(out).toContain("<h1>&lt;b&gt;&quot;Hola&quot; &amp; adiós&lt;/b&gt;</h1>");
    expect(out).toContain('data-d="2.5"></div>');
  });
});

describe("motores", () => {
  let tmp: string;
  let engines: Services["motion"];
  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "autoeditor-motion-"));
    engines = createMotionEngines({
      env: loadEnv({ dataDir: path.join(tmp, "data") }),
      config: { defaultEngine: "hyperframes", hyperframes: { enabled: true, command: "hyperframes", timeoutMs: 240_000 }, remotion: { enabled: false, licenseNote: "" } },
      log: quietLog,
    });
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("Remotion queda apagado y lo explica", async () => {
    const a = await engines.remotion!.available();
    expect(a.ready).toBe(false);
    expect(a.detail).toMatch(/licencia/i);
    expect(engines.remotion!.builtinTemplates()).toEqual([]);
  });

  it("builtin: clip con canal alfa, duración exacta y caché determinista", async () => {
    const eng = engines.builtin!;
    expect((await eng.available()).ready).toBe(true);
    const tpl = eng.builtinTemplates().find((t) => t.id === "palabra-clave-pop")!;
    expect(tpl.engine).toBe("builtin");
    const out = path.join(tmp, "kw.mov");
    const input = { template: tpl, props: { text: "Gratis" }, duration: 1.5, width: 1080, height: 1920, fps: 30, outPath: out };
    const r = await eng.renderGraphic(input);
    expect(r.hasAlpha).toBe(true);
    const s = streamInfo(out);
    expect(s.pix_fmt).toBe("argb");
    expect([s.width, s.height, Number(s.nb_frames)]).toEqual([1080, 1920, 45]);
    const [zero, full, total] = alphaStats(out, 0.8);
    expect(zero / total).toBeGreaterThan(0.8); // casi todo transparente…
    expect(full).toBeGreaterThan(1000); // …con la píldora opaca
    // Segunda vez: sale de la caché (data/motion-cache) sin volver a dibujar.
    const out2 = path.join(tmp, "kw2.mov");
    const r2 = await eng.renderGraphic({ ...input, outPath: out2 });
    expect(r2.seconds).toBeLessThan(r.seconds);
    expect((await stat(out2)).size).toBe((await stat(out)).size);
  }, 60_000);

  it("builtin: las 6 plantillas se dibujan sin errores", async () => {
    const eng = engines.builtin!;
    for (const id of REQUIRED) {
      const tpl = eng.builtinTemplates().find((t) => t.id === id)!;
      const out = path.join(tmp, `${id}.mov`);
      await eng.renderGraphic({ template: tpl, props: { text: "Prueba", subtitle: "Bajada", value: 99 }, duration: 1, width: 720, height: 1280, fps: 24, outPath: out });
      expect(streamInfo(out).pix_fmt).toBe("argb");
    }
  }, 120_000);

  const chrome = findChrome().path;
  it.skipIf(!chrome)("HyperFrames: render real de «palabra-clave-pop» con alfa", async () => {
    const eng = engines.hyperframes!;
    const a = await eng.available();
    expect(a.ready, a.detail).toBe(true);
    const tpl = eng.builtinTemplates().find((t) => t.id === "palabra-clave-pop")!;
    expect(tpl.engine).toBe("hyperframes");
    expect(tpl.source).toContain("{{text}}");
    const out = path.join(tmp, "hf.mov");
    const r = await eng.renderGraphic({ template: tpl, props: { text: "Rápido", color: "#FBE88A" }, duration: 1.2, width: 540, height: 960, fps: 24, outPath: out });
    expect(existsSync(out)).toBe(true);
    expect(r.hasAlpha).toBe(true);
    const s = streamInfo(out);
    expect([s.pix_fmt, s.width, s.height, Number(s.nb_frames)]).toEqual(["argb", 540, 960, Math.round(1.2 * 24)]);
    const [zero, full, total] = alphaStats(out, 0.7);
    expect(zero / total).toBeGreaterThan(0.6);
    expect(full).toBeGreaterThan(500);
    // eslint-disable-next-line no-console
    console.info(`[motion] HyperFrames palabra-clave-pop 540x960 1.2 s: ${r.seconds.toFixed(1)} s`);
  }, 240_000);
});
