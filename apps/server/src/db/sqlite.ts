/**
 * Conexión SQLite con `node:sqlite` (incluido en Node 22, sin dependencias nativas).
 * Se carga con `createRequire` DESPUÉS de silenciar su ExperimentalWarning para no ensuciar la consola.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type * as SqliteModule from "node:sqlite";
import type { Migration } from "./migrations.js";

/** Silencia solo el aviso "SQLite is an experimental feature" (los demás avisos se muestran normal). */
function silenceSqliteWarning(): void {
  const flag = Symbol.for("autoeditor.sqliteWarningSilenced");
  const proc = process as unknown as Record<symbol, boolean>;
  if (proc[flag]) return;
  proc[flag] = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning?.message ?? "";
    if (/SQLite is an experimental feature/i.test(text)) return;
    return (original as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

silenceSqliteWarning();
const require = createRequire(import.meta.url);
const sqlite = require("node:sqlite") as typeof SqliteModule;

export type SqliteDatabase = SqliteModule.DatabaseSync;
export type SqlValue = null | number | bigint | string | Uint8Array;

/** Abre (o crea) la base con WAL y llaves foráneas. `file` = ":memory:" para pruebas. */
export function openSqlite(file: string): SqliteDatabase {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file, { enableForeignKeyConstraints: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

/** Ejecuta `fn` dentro de una transacción (síncrona). */
export function inTransaction<T>(db: SqliteDatabase, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Aplica en orden las migraciones que falten y las registra en `schema_migrations`. */
export function runMigrations(db: SqliteDatabase, migrations: Migration[]): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => Number(r.version)),
  );
  const done: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    inTransaction(db, () => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, new Date().toISOString());
    });
    done.push(m.version);
  }
  return done;
}
