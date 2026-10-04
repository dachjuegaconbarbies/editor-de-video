/**
 * Tabla genérica con dueño sobre SQLite: mapea campos de la entidad ↔ columnas, serializa JSON,
 * valida con zod al leer y al escribir, y SIEMPRE filtra por `owner_id`.
 *
 * Las operaciones son síncronas por dentro (node:sqlite) y se exponen como promesas para cumplir
 * el contrato asíncrono de `OwnedRepo` (que también sirve para Postgres).
 */
import type { z } from "zod";
import type { SqliteDatabase, SqlValue } from "./sqlite.js";
import type { ListOptions, OwnedRepo, Scalar, Where } from "./types.js";

export type ColKind = "text" | "int" | "real" | "bool" | "json";
/** Tipo de columna, opcionalmente con nombre propio (por defecto: snake_case del campo). */
export type ColSpec = ColKind | readonly [ColKind, string];
/** Todas las propiedades de la entidad (excepto ownerId, que siempre es `owner_id`) deben mapearse. */
export type ColumnMap<T> = { [K in Exclude<keyof T, "ownerId"> & string]-?: ColSpec };

interface ResolvedCol {
  field: string;
  column: string;
  kind: ColKind;
}

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export class DbValidationError extends Error {
  constructor(table: string, id: string, detail: string) {
    super(`Datos inválidos en ${table} (${id}): ${detail}`);
    this.name = "DbValidationError";
  }
}

export class SqliteTable<T extends { id: string }> implements OwnedRepo<T> {
  protected readonly cols: ResolvedCol[];
  protected readonly byField: Map<string, ResolvedCol>;
  protected readonly hasUpdatedAt: boolean;
  protected readonly hasCreatedAt: boolean;
  protected readonly hasOwnerField: boolean;

  constructor(
    protected readonly db: SqliteDatabase,
    readonly table: string,
    protected readonly schema: z.ZodType<T>,
    columns: ColumnMap<T>,
    opts: { ownerField?: boolean } = {},
  ) {
    this.cols = Object.entries(columns as Record<string, ColSpec>).map(([field, spec]) => {
      const [kind, column] = typeof spec === "string" ? [spec, snake(field)] : [spec[0], spec[1]];
      return { field, column, kind };
    });
    this.byField = new Map(this.cols.map((c) => [c.field, c]));
    this.hasUpdatedAt = this.byField.has("updatedAt");
    this.hasCreatedAt = this.byField.has("createdAt");
    this.hasOwnerField = opts.ownerField ?? true;
  }

  /** Columnas declaradas (para verificar que la migración las tiene). */
  columnNames(): string[] {
    return ["owner_id", ...this.cols.map((c) => c.column)];
  }

  // ------------------------------------------------------------------ conversión

  protected toSql(col: ResolvedCol, value: unknown): SqlValue {
    if (value === undefined || value === null) return null;
    switch (col.kind) {
      case "json":
        return JSON.stringify(value);
      case "bool":
        return value ? 1 : 0;
      case "int":
      case "real":
        return Number(value);
      default:
        return String(value);
    }
  }

  protected fromSql(col: ResolvedCol, value: unknown): unknown {
    if (value === null || value === undefined) return null;
    switch (col.kind) {
      case "json":
        return JSON.parse(String(value));
      case "bool":
        return Number(value) !== 0;
      case "int":
      case "real":
        return Number(value);
      default:
        return String(value);
    }
  }

  protected rowToEntity(row: Record<string, unknown>): T {
    const obj: Record<string, unknown> = {};
    for (const col of this.cols) obj[col.field] = this.fromSql(col, row[col.column]);
    if (this.hasOwnerField) obj.ownerId = row.owner_id;
    const parsed = this.schema.safeParse(obj);
    if (!parsed.success) throw new DbValidationError(this.table, String(row.id ?? "?"), parsed.error.message.slice(0, 500));
    return parsed.data;
  }

  protected validate(entity: unknown): T {
    const parsed = this.schema.safeParse(entity);
    if (!parsed.success) {
      const id = (entity as { id?: string } | null)?.id ?? "?";
      throw new DbValidationError(this.table, String(id), parsed.error.message.slice(0, 500));
    }
    return parsed.data;
  }

  // ------------------------------------------------------------------ SQL auxiliar

  protected whereSql(where: Where<T> | undefined, params: SqlValue[]): string {
    const parts: string[] = [];
    for (const [field, value] of Object.entries((where ?? {}) as Record<string, Scalar | readonly Scalar[] | undefined>)) {
      if (value === undefined) continue;
      const col = this.byField.get(field);
      if (!col || col.kind === "json") throw new Error(`No se puede filtrar ${this.table} por ${field}`);
      if (Array.isArray(value)) {
        if (value.length === 0) {
          parts.push("0 = 1");
          continue;
        }
        parts.push(`${col.column} IN (${value.map(() => "?").join(", ")})`);
        for (const v of value) params.push(this.toSql(col, v));
      } else if (value === null) {
        parts.push(`${col.column} IS NULL`);
      } else {
        parts.push(`${col.column} = ?`);
        params.push(this.toSql(col, value));
      }
    }
    return parts.length ? ` AND ${parts.join(" AND ")}` : "";
  }

  protected orderSql(opts: ListOptions<T> | undefined): string {
    const field = opts?.orderBy ?? (this.hasCreatedAt ? "createdAt" : "id");
    const col = this.byField.get(field);
    if (!col) throw new Error(`No se puede ordenar ${this.table} por ${field}`);
    let sql = ` ORDER BY ${col.column} ${opts?.desc ? "DESC" : "ASC"}, id ${opts?.desc ? "DESC" : "ASC"}`;
    if (opts?.limit != null) sql += ` LIMIT ${Math.max(0, Math.floor(opts.limit))}`;
    if (opts?.offset != null) sql += `${opts?.limit == null ? " LIMIT -1" : ""} OFFSET ${Math.max(0, Math.floor(opts.offset))}`;
    return sql;
  }

  /** Consulta con dueño + condición SQL adicional (para repositorios específicos). */
  protected selectSync(ownerId: string, extraSql = "", params: SqlValue[] = []): T[] {
    const rows = this.db.prepare(`SELECT * FROM ${this.table} WHERE owner_id = ?${extraSql}`).all(ownerId, ...params) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntity(r));
  }

  protected getSync(ownerId: string, id: string): T | null {
    const row = this.db.prepare(`SELECT * FROM ${this.table} WHERE id = ? AND owner_id = ?`).get(id, ownerId) as Record<string, unknown> | undefined;
    return row ? this.rowToEntity(row) : null;
  }

  protected insertSync(ownerId: string, entity: T): T {
    const data = this.hasOwnerField ? { ...entity, ownerId } : entity;
    const valid = this.validate(data);
    const columns = ["owner_id", ...this.cols.map((c) => c.column)];
    const values: SqlValue[] = [ownerId, ...this.cols.map((c) => this.toSql(c, (valid as Record<string, unknown>)[c.field]))];
    this.db.prepare(`INSERT INTO ${this.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
    return valid;
  }

  protected writeSync(ownerId: string, entity: T): void {
    const sets = this.cols.filter((c) => c.field !== "id").map((c) => `${c.column} = ?`);
    const values = this.cols.filter((c) => c.field !== "id").map((c) => this.toSql(c, (entity as Record<string, unknown>)[c.field]));
    this.db.prepare(`UPDATE ${this.table} SET ${sets.join(", ")} WHERE id = ? AND owner_id = ?`).run(...values, entity.id, ownerId);
  }

  protected updateSync(ownerId: string, id: string, patch: Partial<T> | ((current: T) => T)): T | null {
    const current = this.getSync(ownerId, id);
    if (!current) return null;
    const next = typeof patch === "function" ? patch(structuredClone(current)) : { ...current, ...patch };
    const merged: Record<string, unknown> = { ...next, id: current.id };
    if (this.hasOwnerField) merged.ownerId = ownerId;
    const patchSetsUpdatedAt = typeof patch !== "function" && "updatedAt" in (patch as object);
    if (this.hasUpdatedAt && !patchSetsUpdatedAt) merged.updatedAt = new Date().toISOString();
    const valid = this.validate(merged);
    this.writeSync(ownerId, valid);
    return valid;
  }

  // ------------------------------------------------------------------ OwnedRepo

  async create(ownerId: string, entity: T): Promise<T> {
    return this.insertSync(ownerId, entity);
  }

  async get(ownerId: string, id: string): Promise<T | null> {
    return this.getSync(ownerId, id);
  }

  async list(ownerId: string, where?: Where<T>, opts?: ListOptions<T>): Promise<T[]> {
    const params: SqlValue[] = [];
    const sql = this.whereSql(where, params) + this.orderSql(opts);
    return this.selectSync(ownerId, sql, params);
  }

  async count(ownerId: string, where?: Where<T>): Promise<number> {
    const params: SqlValue[] = [];
    const sql = this.whereSql(where, params);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${this.table} WHERE owner_id = ?${sql}`).get(ownerId, ...params) as { n: number | bigint };
    return Number(row.n);
  }

  async update(ownerId: string, id: string, patch: Partial<T> | ((current: T) => T)): Promise<T | null> {
    return this.updateSync(ownerId, id, patch);
  }

  async delete(ownerId: string, id: string): Promise<boolean> {
    const res = this.db.prepare(`DELETE FROM ${this.table} WHERE id = ? AND owner_id = ?`).run(id, ownerId);
    return Number(res.changes) > 0;
  }
}
