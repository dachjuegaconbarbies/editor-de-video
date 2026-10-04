import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/env.js";
import { makeApp, type TestApp } from "./helpers.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe("sistema", () => {
  it("health responde ok", async () => {
    t = await makeApp();
    const res = await t.app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, demoMode: true });
  });

  it("/config nunca incluye llaves ni rutas absolutas", async () => {
    const anthropic = "sk-ant-api03-PRUEBA-FALSA-1234567890abcdefXYZ";
    const kie = "kie-PRUEBA-FALSA-0987654321fedcba";
    t = await makeApp({ env: { anthropicApiKey: anthropic, kieApiKey: kie, transcriptionApiKey: "tr-FALSA-112233445566" } });
    const res = await t.app.inject({ method: "GET", url: "/api/v1/config" });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).not.toContain(anthropic);
    expect(body).not.toContain(kie);
    expect(body).not.toContain("tr-FALSA-112233445566");
    expect(body).not.toContain(t.dataDir);
    expect(body).not.toContain(REPO_ROOT);
    const cfg = res.json();
    expect(cfg).toHaveProperty("capabilities.claude");
    expect(typeof cfg.capabilities.kie).toBe("boolean");
    expect(cfg.models.editor).toBeTruthy();
    expect(cfg.estimator.coefficients).toHaveProperty("renderPerSecond");
    expect(cfg.pricing.editorModel).toHaveProperty("inputUsdPerMTok");
    expect(cfg.limits.maxUploadBytes).toBeGreaterThan(0);
  });

  it("documentación OpenAPI disponible", async () => {
    t = await makeApp();
    const spec = await t.app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(spec.statusCode).toBe(200);
    const json = spec.json();
    expect(json.openapi).toMatch(/^3\./);
    expect(Object.keys(json.paths)).toContain("/api/v1/projects/{projectId}/assets");
    const docs = await t.app.inject({ method: "GET", url: "/api/v1/docs" });
    expect(docs.statusCode).toBe(200);
  });

  it("errores uniformes en español", async () => {
    t = await makeApp();
    const nf = await t.app.inject({ method: "GET", url: "/api/v1/no-existe" });
    expect(nf.statusCode).toBe(404);
    expect(nf.json()).toMatchObject({ error: "no-encontrado" });

    const bad = await t.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "datos-invalidos", message: "Datos inválidos" });
    expect(Array.isArray(bad.json().details)).toBe(true);

    const badJson = await t.app.inject({ method: "POST", url: "/api/v1/projects", headers: { "content-type": "application/json" }, payload: "{nope" });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json().message).toMatch(/JSON/);

    const missing = await t.app.inject({ method: "GET", url: "/api/v1/projects/prj_inexistente" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().message).toMatch(/No encontré/);
    expect(missing.body).not.toMatch(/at .*\.ts:\d+/); // sin stack
  });

  it("funciones de la ola 2 responden 501 claro (sin romper)", async () => {
    t = await makeApp();
    const p = (await t.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "X" } })).json();
    const res = await t.app.inject({ method: "POST", url: `/api/v1/projects/${p.id}/generate` });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ error: "no-implementado" });
  });

  it("CORS para los orígenes configurados", async () => {
    t = await makeApp();
    const res = await t.app.inject({
      method: "OPTIONS",
      url: "/api/v1/projects",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "PATCH", "access-control-request-headers": "x-owner-id,content-type" },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(String(res.headers["access-control-allow-methods"])).toContain("PATCH");
  });
});
