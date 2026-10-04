import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GlossaryEntry, Project, Version, defaultProjectSettings, type Recipe } from "@autoeditor/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createScrubber } from "../src/auth/index.js";
import { createSqliteDb, type SqliteDb } from "../src/db/index.js";
import { applyGlossaryEntries } from "../src/memory/index.js";
import { safeFileName } from "../src/storage/keys.js";
import { LocalStorage, validateKey } from "../src/storage/local.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "autoeditor-unit-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const streamToBuffer = async (s: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const c of s as AsyncIterable<Buffer>) chunks.push(c);
  return Buffer.concat(chunks);
};

describe("almacenamiento local", () => {
  it("rechaza claves peligrosas", () => {
    for (const bad of ["../x", "a/../b", "/abs/x", "a\\b", "a\0b", "", "a//b", "C:/x", "./a"]) {
      expect(() => validateKey(bad), bad).toThrow();
    }
    expect(validateKey("local/prj_1/assets/a.mp4")).toBe("local/prj_1/assets/a.mp4");
    expect(safeFileName("../../Mi Vídeo (final).MOV")).toBe("Mi-Video-final.mov");
  });

  it("escribe de forma atómica, calcula sha256 y lee rangos", async () => {
    const storage = new LocalStorage({ dataDir: dir });
    await storage.init();
    const data = Buffer.from("0123456789abcdefghij");
    const stored = await storage.put("o/p/archivo.bin", data);
    expect(stored).toEqual({ key: "o/p/archivo.bin", sizeBytes: 20, sha256: createHash("sha256").update(data).digest("hex") });
    expect(await streamToBuffer(storage.createReadStream("o/p/archivo.bin", { start: 5, end: 9 }))).toEqual(Buffer.from("56789"));
    expect(await storage.stat("o/p/archivo.bin")).toMatchObject({ sizeBytes: 20 });
    expect((await storage.localPath("o/p/archivo.bin")).startsWith(path.join(dir, "storage"))).toBe(true);

    const src = path.join(dir, "fuente.txt");
    await writeFile(src, "hola");
    const moved = await storage.putFile("o/p/movido.txt", src, { move: true });
    expect(moved.sizeBytes).toBe(4);
    expect(await readFile(await storage.localPath("o/p/movido.txt"), "utf8")).toBe("hola");

    const tmp = await storage.tempDir("trabajo");
    expect(tmp.path.startsWith(path.join(dir, "tmp"))).toBe(true);
    await tmp.cleanup();

    await storage.deletePrefix("o/p");
    expect(await storage.exists("o/p/archivo.bin")).toBe(false);
    await expect(storage.deletePrefix("..")).rejects.toThrow();
  });
});

describe("base de datos", () => {
  let db: SqliteDb;
  beforeEach(() => {
    db = createSqliteDb({ dataDir: dir });
  });
  afterEach(async () => {
    await db.close();
  });

  it("las columnas de la migración cubren todos los campos de cada entidad", () => {
    for (const table of db.tables) {
      const cols = (db.raw.prepare(`PRAGMA table_info(${table.table})`).all() as { name: string }[]).map((c) => c.name);
      for (const c of table.columnNames()) expect(cols, `${table.table}.${c}`).toContain(c);
    }
    const migrations = db.raw.prepare("SELECT version FROM schema_migrations").all();
    expect(migrations.length).toBeGreaterThan(0);
    expect(String((db.raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toLowerCase()).toBe("wal");
    expect(Number((db.raw.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys)).toBe(1);
  });

  it("filtra SIEMPRE por dueño y valida al leer", async () => {
    const now = new Date().toISOString();
    const p = Project.parse({ id: "prj_a", ownerId: "ana", name: "A", settings: defaultProjectSettings(), createdAt: now, updatedAt: now });
    await db.projects.create("ana", p);
    expect(await db.projects.get("beto", "prj_a")).toBeNull();
    expect(await db.projects.list("beto")).toEqual([]);
    expect(await db.projects.update("beto", "prj_a", { name: "x" })).toBeNull();
    expect(await db.projects.delete("beto", "prj_a")).toBe(false);
    const got = await db.projects.get("ana", "prj_a");
    expect(got?.settings.tools.broll.enabled).toBe(true);
    // Un create con otro ownerId en la entidad queda con el dueño del parámetro.
    await db.projects.create("beto", { ...p, id: "prj_b", ownerId: "ana" });
    expect((await db.projects.get("beto", "prj_b"))?.ownerId).toBe("beto");
    expect(await db.projects.get("ana", "prj_b")).toBeNull();
  });

  it("numera versiones de forma atómica y cuenta correcciones", async () => {
    const now = new Date().toISOString();
    await db.projects.create("ana", Project.parse({ id: "prj_v", ownerId: "ana", name: "V", settings: defaultProjectSettings(), createdAt: now, updatedAt: now }));
    const recipe = { format: { aspect: "9:16", width: 1080, height: 1920 } } as unknown as Recipe;
    const base = (id: string, correction: string | null) =>
      Version.parse({ id, ownerId: "ana", projectId: "prj_v", number: 1, parentId: null, recipe, correction, status: "lista", createdAt: now });
    const { number: _n1, ...v1 } = base("ver_1", null);
    const { number: _n2, ...v2 } = base("ver_2", "más rápido");
    expect((await db.versions.createNext("ana", v1)).number).toBe(1);
    expect((await db.versions.createNext("ana", v2)).number).toBe(2);
    expect((await db.versions.latest("ana", "prj_v"))?.id).toBe("ver_2");
    expect(await db.versions.statsByProject("ana")).toEqual({ prj_v: { versions: 2, corrections: 1 } });
    // Borrar el proyecto borra sus versiones (llave foránea en cascada).
    await db.projects.delete("ana", "prj_v");
    expect(await db.versions.count("ana")).toBe(0);
  });

  it("kv y calibración", async () => {
    await db.kv.set("ana", "ui", { tab: 2 });
    expect(await db.kv.get("ana", "ui")).toEqual({ tab: 2 });
    expect(await db.kv.get("beto", "ui")).toBeNull();
    const c = await db.calibration.record("ana", "render", 10, 20);
    expect(c).toEqual({ factor: 2, samples: 1 });
    expect((await db.calibration.get("ana")).render).toEqual({ factor: 2, samples: 1 });
  });
});

describe("glosario y limpieza de textos", () => {
  it("aplica variantes conservando puntuación y guardando el original", () => {
    const now = new Date().toISOString();
    const entries = [
      GlossaryEntry.parse({ id: "g1", ownerId: "a", term: "Zyra", variants: ["Sira", "Zaira"], createdAt: now }),
      GlossaryEntry.parse({ id: "g2", ownerId: "a", term: "Claude Code", variants: ["clod cod"], createdAt: now }),
    ];
    const words = ["¿Conoces", "sira?", "Uso", "clod", "cod,", "y", "ZAIRA."].map((text) => ({ text, original: null as string | null }));
    const { words: out, counts } = applyGlossaryEntries(words, entries);
    expect(out.map((w) => w.text)).toEqual(["¿Conoces", "Zyra?", "Uso", "Claude", "Code,", "y", "Zyra."]);
    expect(out[1]!.original).toBe("sira?");
    expect(counts).toEqual({ g1: 2, g2: 1 });
    expect(words[1]!.text).toBe("sira?"); // no muta la entrada
  });

  it("el scrubber quita llaves y rutas absolutas", () => {
    const scrub = createScrubber({ anthropicApiKey: "sk-ant-secreta-123456", kieApiKey: "kie-secreta-999", transcriptionApiKey: "", dataDir: "/srv/datos" });
    const out = scrub("falló sk-ant-secreta-123456 con kie-secreta-999 en /srv/datos/storage/a.mp4 y /usr/bin/ffmpeg; Bearer abcdefghijklmnop");
    expect(out).not.toContain("secreta");
    expect(out).not.toContain("/srv/datos");
    expect(out).not.toContain("/usr/bin");
    expect(out).toContain("ffmpeg");
    expect(out).not.toContain("abcdefghijklmnop");
  });
});
