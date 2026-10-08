/**
 * Kie AI sin red ni llave real: fetch simulado (crear → consultar → descargar, reintentos y errores) y
 * marcadores locales con ffmpeg en modo demo.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiRequest } from "@autoeditor/shared";
import { createKieProvider } from "../src/ai/kie/provider.js";
import { buildKieRequest, resolveKieModel } from "../src/ai/kie/params.js";
import { UserFacingError } from "../src/services/types.js";
import { testDeps } from "./ai-deps.js";

let outDir: string;
beforeAll(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), "kie-test-"));
});
afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Call {
  method: string;
  url: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

/** fetch simulado con una cola de respuestas por ruta. */
function fakeFetch(routes: Record<string, (() => Response)[]>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      url,
      auth: headers.get("authorization"),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const queue = key ? routes[key]! : [];
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (!next) throw new TypeError(`fetch failed: ${url}`);
    return next();
  }) as typeof fetch;
  return { impl, calls };
}

function provider(fetchImpl: typeof fetch) {
  const deps = testDeps({ kieApiKey: "kie-test-key", demoMode: false });
  return createKieProvider(deps, { fetchImpl, retryBaseMs: 1, sleep: async () => undefined, demo: false });
}

const imageRequest = AiRequest.parse({ id: "ai-1", kind: "imagen", model: "nano-banana-2", prompt: "Una oficina luminosa", seed: 7 });

describe("Kie AI (fetch simulado)", () => {
  it("crea la tarea, consulta hasta éxito y descarga el resultado", async () => {
    const { impl, calls } = fakeFetch({
      "/api/v1/jobs/createTask": [() => json({ code: 200, msg: "success", data: { taskId: "task-123" } })],
      "/api/v1/jobs/recordInfo": [
        () => json({ code: 200, data: { taskId: "task-123", state: "waiting" } }),
        () => json({ code: 200, data: { taskId: "task-123", state: "generating", progress: 50 } }),
        () =>
          json({
            code: 200,
            data: { taskId: "task-123", state: "success", resultJson: JSON.stringify({ resultUrls: ["https://cdn.example.com/r/abc.png"] }), creditsConsumed: 8 },
          }),
      ],
      "cdn.example.com": [() => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } })],
    });
    const p = provider(impl);
    expect(p.status()).toMatchObject({ configured: true, demo: false });
    const progress: number[] = [];
    const res = await p.generate(imageRequest, { outDir, aspect: "9:16", onProgress: (v) => progress.push(v) });

    expect(res.taskId).toBe("task-123");
    expect(res.mimeType).toBe("image/png");
    expect(res.model).toBe("nano-banana-2");
    expect(res.costUsd).toBeCloseTo(8 * 0.005, 6);
    expect(await readFile(res.filePath)).toEqual(PNG);

    const create = calls.find((c) => c.url.endsWith("/api/v1/jobs/createTask"))!;
    expect(create.method).toBe("POST");
    expect(create.auth).toBe("Bearer kie-test-key");
    expect(create.body).toMatchObject({ model: "nano-banana-2" });
    expect(JSON.stringify(create.body)).toContain("Una oficina luminosa");
    expect(calls.filter((c) => c.url.includes("recordInfo?taskId=task-123"))).toHaveLength(3);
    // La descarga del CDN NO lleva la llave.
    expect(calls.find((c) => c.url.includes("cdn.example.com"))!.auth).toBeNull();
    expect(progress.at(-1)).toBe(1);
  });

  it("reintenta con backoff cuando Kie responde 500 y luego sigue", async () => {
    const { impl, calls } = fakeFetch({
      "/api/v1/jobs/createTask": [() => json({ code: 500, msg: "Server error, please try again later" }, 500), () => json({ code: 200, data: { taskId: "t-2" } })],
      "/api/v1/jobs/recordInfo": [
        () => json({ code: 500, msg: "Server error" }, 500),
        () => json({ code: 200, data: { state: "success", resultJson: { resultUrls: ["https://cdn.example.com/r/x.png"] } } }),
      ],
      "cdn.example.com": [() => new Response("fallo", { status: 503 }), () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } })],
    });
    const res = await provider(impl).generate(imageRequest, { outDir, aspect: "1:1" });
    expect(res.taskId).toBe("t-2");
    expect(calls.filter((c) => c.url.endsWith("createTask"))).toHaveLength(2);
    expect(calls.filter((c) => c.url.includes("cdn.example.com"))).toHaveLength(2);
    // Sin creditsConsumed: costo estimado con la configuración (> 0).
    expect(res.costUsd).toBeGreaterThan(0);
  });

  it("sin créditos: error claro en español con código kie-sin-creditos (sin reintentar)", async () => {
    const { impl, calls } = fakeFetch({ "/api/v1/jobs/createTask": [() => json({ code: 402, msg: "Credits insufficient" })] });
    const err = await provider(impl)
      .generate(imageRequest, { outDir, aspect: "9:16" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as UserFacingError).code).toBe("kie-sin-creditos");
    expect((err as UserFacingError).userMessage).toMatch(/no tiene créditos suficientes/);
    expect(calls).toHaveLength(1);
  });

  it("llave inválida, contenido rechazado y tiempo agotado", async () => {
    const bad = fakeFetch({ "/api/v1/jobs/createTask": [() => json({ code: 401, msg: "Unauthorized" }, 401)] });
    await expect(provider(bad.impl).generate(imageRequest, { outDir, aspect: "9:16" })).rejects.toMatchObject({ code: "kie-llave-invalida" });

    const refused = fakeFetch({
      "/api/v1/jobs/createTask": [() => json({ code: 200, data: { taskId: "t-3" } })],
      "/api/v1/jobs/recordInfo": [() => json({ code: 200, data: { state: "fail", failCode: "400", failMsg: "content flagged by moderation (sensitive)" } })],
    });
    await expect(provider(refused.impl).generate(imageRequest, { outDir, aspect: "9:16" })).rejects.toMatchObject({ code: "kie-contenido-rechazado" });

    // Reloj simulado: cada consulta "tarda" 10 minutos → supera el timeout de la configuración.
    let t = 0;
    const slow = fakeFetch({
      "/api/v1/jobs/createTask": [() => json({ code: 200, data: { taskId: "t-4" } })],
      "/api/v1/jobs/recordInfo": [() => json({ code: 200, data: { state: "generating" } })],
    });
    const deps = testDeps({ kieApiKey: "k", demoMode: false });
    const p = createKieProvider(deps, { fetchImpl: slow.impl, sleep: async () => void (t += 600_000), now: () => t, demo: false });
    await expect(p.generate(imageRequest, { outDir, aspect: "9:16" })).rejects.toMatchObject({ code: "kie-tiempo-agotado" });
  });

  it("consulta el saldo de créditos", async () => {
    const { impl } = fakeFetch({ "/api/v1/chat/credit": [() => json({ code: 200, msg: "success", data: 1234 })] });
    expect(await provider(impl).credits()).toBe(1234);
  });

  it("traduce los parámetros genéricos a los campos de cada modelo", () => {
    const kie = testDeps().providers.kie;
    const veo = resolveKieModel(kie, "video", "veo3_fast")!;
    const built = buildKieRequest(veo, { prompt: "Atardecer en la playa", negativePrompt: "texto", params: { duration: 8 }, seed: 42 }, "9:16");
    expect(built.path).toBe("/api/v1/veo/generate");
    expect(JSON.stringify(built.body)).toContain("Atardecer en la playa");
    expect(JSON.stringify(built.body)).toContain("9:16");
    // El modelo por defecto de cada tipo existe y está prendido.
    for (const kind of ["imagen", "video", "musica", "voz", "sfx"] as const) expect(resolveKieModel(kie, kind)?.enabled).toBe(true);
  });
});

describe("Kie AI en modo demo (marcadores con ffmpeg)", () => {
  const deps = testDeps();
  const p = createKieProvider(deps);

  it("sin llave queda en modo demo y no consulta saldo", async () => {
    expect(p.status()).toMatchObject({ configured: false, demo: true });
    expect(await p.credits()).toBeNull();
  });

  it("genera imagen, video de 5 s y audio marcados como demo", async () => {
    const img = await p.generate(imageRequest, { outDir, aspect: "9:16" });
    expect(img.model).toMatch(/^demo:/);
    expect(img.costUsd).toBe(0);
    expect((await stat(img.filePath)).size).toBeGreaterThan(1000);

    const vid = await p.generate(AiRequest.parse({ id: "ai-2", kind: "video", model: "", prompt: "Ciudad de noche" }), { outDir, aspect: "9:16" });
    expect(vid.mimeType).toBe("video/mp4");
    expect((await stat(vid.filePath)).size).toBeGreaterThan(1000);

    const sfx = await p.generate(AiRequest.parse({ id: "ai-3", kind: "sfx", model: "", prompt: "whoosh" }), { outDir, aspect: "9:16" });
    expect(sfx.mimeType).toMatch(/^audio\//);
    expect((await stat(sfx.filePath)).size).toBeGreaterThan(500);
  }, 60_000);
});
