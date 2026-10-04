import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Recipe, Version, type Project } from "@autoeditor/shared";
import { afterEach, describe, expect, it } from "vitest";
import { makeApp, type TestApp } from "./helpers.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const recipeV1 = () =>
  Recipe.parse({
    format: { aspect: "9:16", width: 1080, height: 1920 },
    duration: 4,
    tracks: {
      video: [{ id: "c1", assetId: "a1", sourceIn: 0, sourceOut: 4 }],
      text: [{ id: "t1", kind: "titulo", text: "Hola", start: 0.5, end: 2 }],
      captions: {
        words: [
          { text: "Hola", start: 0, end: 0.4 },
          { text: "mundo.", start: 0.45, end: 0.9 },
        ],
      },
    },
  });

async function seedVersions(app: TestApp, project: Project) {
  const now = new Date().toISOString();
  const v1 = Version.parse({ id: "ver_1", ownerId: "local", projectId: project.id, number: 1, parentId: null, recipe: recipeV1(), status: "lista", createdAt: now });
  const r2 = recipeV1();
  r2.tracks.text[0]!.text = "Hola a todos";
  r2.style.titleFont.family = "Montserrat";
  const { number: _a, ...v1rest } = v1;
  await app.ctx.db.versions.createNext("local", v1rest);
  const v2 = Version.parse({ ...v1, id: "ver_2", number: 2, parentId: "ver_1", recipe: r2, correction: "cambia el título", publishCopy: { title: "Mi reel", hashtags: ["cafe", "#mx"] } });
  const { number: _b, ...v2rest } = v2;
  await app.ctx.db.versions.createNext("local", v2rest);
}

describe("versiones", () => {
  it("lista, compara (qué cambió), descarga subtítulos/texto, califica y restaura", async () => {
    t = await makeApp();
    const app = t.app;
    const project = (await app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Mi Café Rico" } })).json() as Project;
    await seedVersions(t, project);

    const list = (await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/versions` })).json();
    expect(list.versions.map((v: Version) => v.number)).toEqual([1, 2]);

    const cmp = await app.inject({ method: "GET", url: "/api/v1/versions/compare?a=ver_1&b=ver_2" });
    expect(cmp.statusCode).toBe(200);
    const areas = cmp.json().changes.map((c: { area: string }) => c.area);
    expect(areas).toContain("texto");
    expect(areas).toContain("estilo");
    expect(cmp.json().summary).toMatch(/Hola a todos|Montserrat/);

    const srt = await app.inject({ method: "GET", url: "/api/v1/versions/ver_1/download?type=srt" });
    expect(srt.statusCode).toBe(200);
    expect(srt.headers["content-disposition"]).toContain("mi-cafe-rico-v1.srt");
    expect(srt.body).toContain("00:00:00,000 -->");
    const vtt = await app.inject({ method: "GET", url: "/api/v1/versions/ver_1/download?type=vtt" });
    expect(vtt.body.startsWith("WEBVTT")).toBe(true);
    const txt = await app.inject({ method: "GET", url: "/api/v1/versions/ver_1/download?type=txt" });
    expect(txt.body).toContain("Hola mundo.");
    const copy = await app.inject({ method: "GET", url: "/api/v1/versions/ver_2/download?type=copy" });
    expect(copy.body).toContain("Mi reel");
    expect(copy.body).toContain("#cafe #mx");
    // Sin render todavía: mp4 → 404 claro.
    const mp4 = await app.inject({ method: "GET", url: "/api/v1/versions/ver_1/download?type=mp4" });
    expect(mp4.statusCode).toBe(404);
    expect(mp4.headers["content-type"]).toMatch(/json/);

    const rated = await app.inject({ method: "POST", url: "/api/v1/versions/ver_2/rating", payload: { rating: "arriba", comment: "me encantó" } });
    expect(rated.json().rating).toBe("arriba");
    const fb = await t.ctx.db.feedback.list("local", { kind: "calificacion" });
    expect(fb).toHaveLength(1);

    const restored = await app.inject({ method: "POST", url: "/api/v1/versions/ver_1/restore" });
    expect(restored.json().currentVersionId).toBe("ver_1");

    // Otro dueño no ve ni compara nada.
    expect((await app.inject({ method: "GET", url: "/api/v1/versions/ver_1", headers: { "x-owner-id": "otro" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/versions/compare?a=ver_1&b=ver_2", headers: { "x-owner-id": "otro" } })).statusCode).toBe(404);

    const metrics = (await app.inject({ method: "GET", url: "/api/v1/memory/metrics" })).json();
    expect(metrics).toMatchObject({ projects: 1, versions: 2 });
    expect(metrics.correctionsPerVideo[0]).toMatchObject({ projectId: project.id, corrections: 1 });
  });
});

describe("biblioteca: marcas, reglas y glosario", () => {
  it("CRUD de marcas con PATCH parcial (no pisa lo demás)", async () => {
    t = await makeApp();
    const created = await t.app.inject({ method: "POST", url: "/api/v1/brands", payload: { name: "Zyra", colors: ["#8B7CF0"], googleFonts: ["Montserrat"] } });
    expect(created.statusCode).toBe(201);
    const brand = created.json();
    const patched = await t.app.inject({ method: "PATCH", url: `/api/v1/brands/${brand.id}`, payload: { notes: "Siempre en mayúsculas" } });
    expect(patched.json()).toMatchObject({ name: "Zyra", colors: ["#8B7CF0"], googleFonts: ["Montserrat"], notes: "Siempre en mayúsculas" });
    expect((await t.app.inject({ method: "GET", url: "/api/v1/brands" })).json().brands).toHaveLength(1);
    expect((await t.app.inject({ method: "DELETE", url: `/api/v1/brands/${brand.id}` })).statusCode).toBe(200);
  });

  it("reglas: crear, reforzar, editar sin pisar el alcance y borrar", async () => {
    t = await makeApp();
    const r1 = await t.app.inject({ method: "POST", url: "/api/v1/memory/rules", payload: { text: "Subtítulos siempre en mayúsculas" } });
    expect(r1.statusCode).toBe(201);
    const again = await t.app.inject({ method: "POST", url: "/api/v1/memory/rules", payload: { text: "subtítulos siempre en MAYÚSCULAS" } });
    expect(again.statusCode).toBe(200);
    expect(again.json().strength).toBe(2);
    const scoped = (await t.app.inject({ method: "POST", url: "/api/v1/memory/rules", payload: { text: "Títulos en Montserrat", scope: "estilo", scopeId: "sty_1" } })).json();
    const off = await t.app.inject({ method: "PATCH", url: `/api/v1/memory/rules/${scoped.id}`, payload: { enabled: false } });
    expect(off.json()).toMatchObject({ enabled: false, scope: "estilo", scopeId: "sty_1", text: "Títulos en Montserrat" });
    const noScope = await t.app.inject({ method: "POST", url: "/api/v1/memory/rules", payload: { text: "x", scope: "marca" } });
    expect(noScope.statusCode).toBe(400);
    expect((await t.app.inject({ method: "GET", url: "/api/v1/memory/rules" })).json().rules).toHaveLength(2);
    expect((await t.app.inject({ method: "DELETE", url: `/api/v1/memory/rules/${scoped.id}` })).statusCode).toBe(200);
    // rulesFor respeta capas: la global aplica, la de otro estilo no.
    const rules = await t.ctx.memory.rulesFor("local", { styleId: "sty_2" });
    expect(rules.map((r) => r.text)).toEqual(["Subtítulos siempre en mayúsculas"]);
  });

  it("palabras clave: guardar, leer y registrar lo que agregaste", async () => {
    t = await makeApp();
    const p = (await t.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "KW" } })).json();
    const put = await t.app.inject({
      method: "PUT",
      url: `/api/v1/projects/${p.id}/keywords`,
      payload: { keywords: [{ id: "k1", text: "café de olla", category: "tema", source: "usuario" }] },
    });
    expect(put.statusCode).toBe(200);
    const got = (await t.app.inject({ method: "GET", url: `/api/v1/projects/${p.id}/keywords` })).json();
    expect(got.keywords[0]).toMatchObject({ text: "café de olla", enabled: true });
    expect(await t.ctx.db.feedback.count("local", { kind: "palabras-clave" })).toBe(1);
    // Sin transcripción no se puede detectar.
    const det = await t.app.inject({ method: "POST", url: `/api/v1/projects/${p.id}/keywords/detect` });
    expect(det.statusCode).toBe(409);
  });
});

describe("interfaz compilada", () => {
  it("sirve index.html con fallback SPA excepto /api", async () => {
    const web = await mkdtemp(path.join(os.tmpdir(), "autoeditor-web-"));
    await mkdir(path.join(web, "assets"));
    await writeFile(path.join(web, "index.html"), "<!doctype html><title>Autoeditor</title>");
    await writeFile(path.join(web, "assets", "app.js"), "console.log(1)");
    try {
      t = await makeApp({ env: { webDist: web }, serveWeb: true });
      const root = await t.app.inject({ method: "GET", url: "/" });
      expect(root.statusCode).toBe(200);
      expect(root.body).toContain("Autoeditor");
      const js = await t.app.inject({ method: "GET", url: "/assets/app.js" });
      expect(js.body).toContain("console.log");
      const deep = await t.app.inject({ method: "GET", url: "/proyecto/prj_123" });
      expect(deep.statusCode).toBe(200);
      expect(deep.body).toContain("Autoeditor");
      const api = await t.app.inject({ method: "GET", url: "/api/v1/nada" });
      expect(api.statusCode).toBe(404);
      expect(api.json().error).toBe("no-encontrado");
      expect((await t.app.inject({ method: "GET", url: "/api/v1/docs" })).statusCode).toBe(200);
    } finally {
      await rm(web, { recursive: true, force: true });
    }
  });
});
