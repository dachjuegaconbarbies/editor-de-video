import { ProjectSettings } from "@autoeditor/shared";
import { afterEach, describe, expect, it } from "vitest";
import { makeApp, type TestApp } from "./helpers.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const as = (owner: string) => ({ "x-owner-id": owner });

describe("proyectos", () => {
  it("CRUD completo", async () => {
    t = await makeApp();
    const created = await t.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Mi video" } });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect(project).toMatchObject({ name: "Mi video", ownerId: "local", status: "borrador" });
    expect(project.settings.tools.removeSilences.enabled).toBe(true);

    const list = (await t.app.inject({ method: "GET", url: "/api/v1/projects" })).json();
    expect(list.projects).toHaveLength(1);
    expect(list.projects[0]).toMatchObject({ id: project.id, assetCount: 0, versionCount: 0 });

    const detail = await t.app.inject({ method: "GET", url: `/api/v1/projects/${project.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ project: { id: project.id }, assets: [], versions: [], activeJob: null, pendingPlan: null });

    const renamed = await t.app.inject({ method: "PATCH", url: `/api/v1/projects/${project.id}`, payload: { name: "Nuevo nombre" } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("Nuevo nombre");

    const del = await t.app.inject({ method: "DELETE", url: `/api/v1/projects/${project.id}` });
    expect(del.statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: `/api/v1/projects/${project.id}` })).statusCode).toBe(404);
  });

  it("aislamiento por dueño: lo de A no lo ve B", async () => {
    t = await makeApp();
    const a = (await t.app.inject({ method: "POST", url: "/api/v1/projects", headers: as("ana"), payload: { name: "De Ana" } })).json();
    expect(a.ownerId).toBe("ana");
    const listB = (await t.app.inject({ method: "GET", url: "/api/v1/projects", headers: as("beto") })).json();
    expect(listB.projects).toHaveLength(0);
    expect((await t.app.inject({ method: "GET", url: `/api/v1/projects/${a.id}`, headers: as("beto") })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "PATCH", url: `/api/v1/projects/${a.id}`, headers: as("beto"), payload: { name: "hackeado" } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "DELETE", url: `/api/v1/projects/${a.id}`, headers: as("beto") })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "GET", url: `/api/v1/projects/${a.id}/events`, headers: as("beto") })).statusCode).toBe(404);
    // El dueño se sanea: caracteres raros fuera.
    const weird = (await t.app.inject({ method: "POST", url: "/api/v1/projects", headers: as("an a/../x"), payload: { name: "Raro" } })).json();
    expect(weird.ownerId).toBe("anax");
    // Ana sigue viendo el suyo intacto.
    const mine = (await t.app.inject({ method: "GET", url: `/api/v1/projects/${a.id}`, headers: as("ana") })).json();
    expect(mine.project.name).toBe("De Ana");
    // Sin header → "local", que tampoco lo ve.
    expect((await t.app.inject({ method: "GET", url: `/api/v1/projects/${a.id}` })).statusCode).toBe(404);
  });

  it("autoguardado de settings aplica deriveEngines del lado servidor", async () => {
    t = await makeApp();
    const p = (await t.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "IA" } })).json();
    expect(p.settings.engines.kie).toBe(false);
    const settings = ProjectSettings.parse(p.settings);
    settings.tools.aiImages.enabled = true;
    settings.instruction.targetDuration = 30;
    settings.instruction.durationMode = "exacta";
    const res = await t.app.inject({ method: "PATCH", url: `/api/v1/projects/${p.id}`, payload: { settings } });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.engines.kie).toBe(true);
    expect(res.json().settings.instruction).toMatchObject({ targetDuration: 30, durationMode: "exacta" });
    // Se guardó de verdad.
    const again = (await t.app.inject({ method: "GET", url: `/api/v1/projects/${p.id}` })).json();
    expect(again.project.settings.engines.kie).toBe(true);
    expect(again.project.settings.tools.aiImages.enabled).toBe(true);

    // Settings inválidos → 400 sin tocar lo guardado.
    const bad = await t.app.inject({ method: "PATCH", url: `/api/v1/projects/${p.id}`, payload: { settings: { ...settings, instruction: { ...settings.instruction, format: "3:2" } } } });
    expect(bad.statusCode).toBe(400);
  });

  it("crear con settings parciales solo cambia esas secciones", async () => {
    t = await makeApp();
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "Parcial", settings: { instruction: { text: "Un reel de mi café", format: "16:9" }, tools: { broll: { enabled: true, source: "ia" } } } },
    });
    expect(res.statusCode).toBe(201);
    const s = res.json().settings;
    expect(s.instruction).toMatchObject({ text: "Un reel de mi café", format: "16:9", durationMode: "auto" });
    expect(s.tools.broll).toMatchObject({ enabled: true, source: "ia" });
    // B-roll con IA prende Kie AI.
    expect(s.engines.kie).toBe(true);
  });
});
