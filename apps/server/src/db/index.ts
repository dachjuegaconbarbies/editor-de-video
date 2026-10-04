/**
 * Implementación SQLite de `Db` (ver la interfaz y la guía para Postgres en `db/types.ts`).
 * Archivo: `<dataDir>/autoeditor.db` (WAL + llaves foráneas + migraciones versionadas).
 */
import path from "node:path";
import {
  Asset,
  Brand,
  GlossaryEntry,
  Job,
  Keyword,
  MemoryRule,
  Plan,
  Project,
  PublishCopy,
  Style,
  StyleVersion,
  Transcript,
  Version,
  updateCalibration,
  type Calibration,
  type EstimateStage,
} from "@autoeditor/shared";
import { z } from "zod";
import { MIGRATIONS } from "./migrations.js";
import { inTransaction, openSqlite, runMigrations, type SqliteDatabase } from "./sqlite.js";
import { SqliteTable } from "./table.js";
import {
  Feedback,
  type CalibrationRepo,
  type Db,
  type GlossaryRepo,
  type JobRepo,
  type KeywordsRecord,
  type KeywordsRepo,
  type KvRepo,
  type MemoryRuleRepo,
  type StyleVersionRepo,
  type TranscriptRepo,
  type VersionRepo,
} from "./types.js";
import { nowIso } from "./util.js";

export type * from "./types.js";
export { Feedback, FeedbackKind } from "./types.js";
export { newId, nowIso } from "./util.js";

/** Dueño reservado para la calibración común del servidor (no es un id de dueño válido). */
const SERVER_CALIBRATION_OWNER = "*";

// ---------------------------------------------------------------------------
// Tablas
// ---------------------------------------------------------------------------

class ProjectsTable extends SqliteTable<Project> {
  constructor(db: SqliteDatabase) {
    super(db, "projects", Project, {
      id: "text",
      name: "text",
      settings: "json",
      status: "text",
      currentVersionId: "text",
      thumbnailAssetId: "text",
      createdAt: "text",
      updatedAt: "text",
    });
  }
}

class AssetsTable extends SqliteTable<Asset> {
  constructor(db: SqliteDatabase) {
    super(db, "assets", Asset, {
      id: "text",
      projectId: "text",
      category: "text",
      kind: "text",
      originalName: "text",
      mimeType: "text",
      sizeBytes: "int",
      storageKey: "text",
      probe: "json",
      analysis: "json",
      thumbnailKey: "text",
      priority: "text",
      note: "text",
      order: ["real", "sort_order"],
      sha256: "text",
      createdAt: "text",
    });
  }
}

class TranscriptsTable extends SqliteTable<Transcript> implements TranscriptRepo {
  constructor(db: SqliteDatabase) {
    super(db, "transcripts", Transcript, {
      id: "text",
      projectId: "text",
      assetId: "text",
      language: "text",
      provider: "text",
      model: "text",
      status: "text",
      error: "text",
      words: "json",
      segments: "json",
      createdAt: "text",
      updatedAt: "text",
    });
  }
  async getByAsset(ownerId: string, assetId: string): Promise<Transcript | null> {
    return this.selectSync(ownerId, " AND asset_id = ? ORDER BY updated_at DESC LIMIT 1", [assetId])[0] ?? null;
  }
}

const ACTIVE_JOB_STATUSES = ["en-cola", "corriendo", "esperando"] as const;

class JobsTable extends SqliteTable<Job> implements JobRepo {
  constructor(db: SqliteDatabase) {
    super(db, "jobs", Job, {
      id: "text",
      projectId: "text",
      type: "text",
      status: "text",
      stage: "text",
      progress: "real",
      message: "text",
      input: "json",
      result: "json",
      error: "text",
      attempts: "int",
      estimatedSeconds: "real",
      stageTimings: "json",
      costUsd: "real",
      createdAt: "text",
      startedAt: "text",
      finishedAt: "text",
    });
  }

  async activeForProject(ownerId: string, projectId: string): Promise<Job | null> {
    const marks = ACTIVE_JOB_STATUSES.map(() => "?").join(", ");
    return (
      this.selectSync(ownerId, ` AND project_id = ? AND status IN (${marks}) AND type IN ('generar', 'corregir', 'exportar', 're-render', 'estilo-ficha') ORDER BY created_at DESC LIMIT 1`, [
        projectId,
        ...ACTIVE_JOB_STATUSES,
      ])[0] ??
      this.selectSync(ownerId, ` AND project_id = ? AND status IN (${marks}) ORDER BY created_at DESC LIMIT 1`, [projectId, ...ACTIVE_JOB_STATUSES])[0] ??
      null
    );
  }

  private systemRow(id: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToEntity(row) : null;
  }

  async systemClaimNext(types: readonly string[]): Promise<Job | null> {
    if (types.length === 0) return null;
    return inTransaction(this.db, () => {
      const row = this.db
        .prepare(`SELECT * FROM jobs WHERE status = 'en-cola' AND type IN (${types.map(() => "?").join(", ")}) ORDER BY created_at ASC, id ASC LIMIT 1`)
        .get(...types) as Record<string, unknown> | undefined;
      if (!row) return null;
      const job = this.rowToEntity(row);
      const claimed: Job = {
        ...job,
        status: "corriendo",
        attempts: job.attempts + 1,
        startedAt: nowIso(),
        finishedAt: null,
        error: null,
      };
      this.writeSync(job.ownerId, claimed);
      return claimed;
    });
  }

  async systemGet(id: string): Promise<Job | null> {
    return this.systemRow(id);
  }

  async systemUpdate(id: string, patch: Partial<Job> | ((current: Job) => Job)): Promise<Job | null> {
    const current = this.systemRow(id);
    if (!current) return null;
    return this.updateSync(current.ownerId, id, patch);
  }

  async systemMarkInterrupted(statuses: Job["status"][], message: string): Promise<Job[]> {
    if (statuses.length === 0) return [];
    const rows = this.db.prepare(`SELECT * FROM jobs WHERE status IN (${statuses.map(() => "?").join(", ")})`).all(...statuses) as Record<string, unknown>[];
    const out: Job[] = [];
    for (const row of rows) {
      const job = this.rowToEntity(row);
      const updated = this.updateSync(job.ownerId, job.id, { status: "error", error: message, message, finishedAt: nowIso() });
      if (updated) out.push(updated);
    }
    return out;
  }
}

class PlansTable extends SqliteTable<Plan> {
  constructor(db: SqliteDatabase) {
    super(db, "plans", Plan, {
      id: "text",
      projectId: "text",
      jobId: "text",
      status: "text",
      summary: "text",
      scenes: "json",
      recipe: "json",
      estimatedCostUsd: "real",
      feedback: "json",
      createdAt: "text",
      updatedAt: "text",
    });
  }
}

class VersionsTable extends SqliteTable<Version> implements VersionRepo {
  constructor(db: SqliteDatabase) {
    super(db, "versions", Version, {
      id: "text",
      projectId: "text",
      number: "int",
      parentId: "text",
      recipe: "json",
      correction: "text",
      correctionAt: "real",
      changes: "json",
      changeSummary: "text",
      status: "text",
      videoKey: "text",
      posterKey: "text",
      captionsSrtKey: "text",
      captionsVttKey: "text",
      publishCopy: "json",
      rating: "text",
      exported: "bool",
      qa: "json",
      renderSeconds: "real",
      costUsd: "real",
      createdAt: "text",
    });
  }

  async createNext(ownerId: string, entity: Omit<Version, "number">): Promise<Version> {
    return inTransaction(this.db, () => {
      const row = this.db.prepare("SELECT COALESCE(MAX(number), 0) AS n FROM versions WHERE project_id = ? AND owner_id = ?").get(entity.projectId, ownerId) as {
        n: number | bigint;
      };
      return this.insertSync(ownerId, { ...entity, number: Number(row.n) + 1 } as Version);
    });
  }

  async latest(ownerId: string, projectId: string): Promise<Version | null> {
    return this.selectSync(ownerId, " AND project_id = ? ORDER BY number DESC LIMIT 1", [projectId])[0] ?? null;
  }

  async statsByProject(ownerId: string): Promise<Record<string, { versions: number; corrections: number }>> {
    const rows = this.db
      .prepare(
        "SELECT project_id, COUNT(*) AS versions, SUM(CASE WHEN correction IS NOT NULL THEN 1 ELSE 0 END) AS corrections FROM versions WHERE owner_id = ? GROUP BY project_id",
      )
      .all(ownerId) as { project_id: string; versions: number | bigint; corrections: number | bigint | null }[];
    const out: Record<string, { versions: number; corrections: number }> = {};
    for (const r of rows) out[r.project_id] = { versions: Number(r.versions), corrections: Number(r.corrections ?? 0) };
    return out;
  }
}

class StylesTable extends SqliteTable<Style> {
  constructor(db: SqliteDatabase) {
    super(db, "styles", Style, {
      id: "text",
      name: "text",
      slug: "text",
      description: "text",
      currentVersion: "int",
      thumbnailAssetId: "text",
      timesUsed: "int",
      createdAt: "text",
      updatedAt: "text",
    });
  }
}

class StyleVersionsTable extends SqliteTable<StyleVersion> implements StyleVersionRepo {
  constructor(db: SqliteDatabase) {
    super(
      db,
      "style_versions",
      StyleVersion,
      {
        id: "text",
        styleId: "text",
        number: "int",
        preset: "json",
        rulesMarkdown: "text",
        rules: "json",
        sourceProjectId: "text",
        sourceVersionId: "text",
        createdAt: "text",
      },
      { ownerField: false },
    );
  }

  async createNext(ownerId: string, entity: Omit<StyleVersion, "number">): Promise<StyleVersion> {
    return inTransaction(this.db, () => {
      const row = this.db.prepare("SELECT COALESCE(MAX(number), 0) AS n FROM style_versions WHERE style_id = ? AND owner_id = ?").get(entity.styleId, ownerId) as {
        n: number | bigint;
      };
      return this.insertSync(ownerId, { ...entity, number: Number(row.n) + 1 } as StyleVersion);
    });
  }

  async getByNumber(ownerId: string, styleId: string, number: number): Promise<StyleVersion | null> {
    return this.selectSync(ownerId, " AND style_id = ? AND number = ?", [styleId, number])[0] ?? null;
  }
}

class BrandsTable extends SqliteTable<Brand> {
  constructor(db: SqliteDatabase) {
    super(db, "brands", Brand, {
      id: "text",
      name: "text",
      logoAssetIds: "json",
      fontAssetIds: "json",
      googleFonts: "json",
      colors: "json",
      introAssetId: "text",
      outroAssetId: "text",
      transitionAssetIds: "json",
      lowerThirdTemplateIds: "json",
      notes: "text",
      createdAt: "text",
      updatedAt: "text",
    });
  }
}

class RulesTable extends SqliteTable<MemoryRule> implements MemoryRuleRepo {
  constructor(db: SqliteDatabase) {
    super(db, "memory_rules", MemoryRule, {
      id: "text",
      scope: "text",
      scopeId: "text",
      text: "text",
      check: ["json", "rule_check"],
      source: "json",
      enabled: "bool",
      timesApplied: "int",
      strength: "int",
      createdAt: "text",
      updatedAt: "text",
    });
  }
  async incrementApplied(ownerId: string, ids: readonly string[]): Promise<void> {
    const stmt = this.db.prepare("UPDATE memory_rules SET times_applied = times_applied + 1 WHERE id = ? AND owner_id = ?");
    for (const id of ids) stmt.run(id, ownerId);
  }
}

class GlossaryTable extends SqliteTable<GlossaryEntry> implements GlossaryRepo {
  constructor(db: SqliteDatabase) {
    super(db, "glossary", GlossaryEntry, {
      id: "text",
      term: "text",
      variants: "json",
      scope: "text",
      scopeId: "text",
      timesApplied: "int",
      createdAt: "text",
    });
  }
  async incrementApplied(ownerId: string, counts: Record<string, number>): Promise<void> {
    const stmt = this.db.prepare("UPDATE glossary SET times_applied = times_applied + ? WHERE id = ? AND owner_id = ?");
    for (const [id, n] of Object.entries(counts)) if (n > 0) stmt.run(n, id, ownerId);
  }
}

class FeedbackTable extends SqliteTable<Feedback> {
  constructor(db: SqliteDatabase) {
    super(db, "feedback", Feedback, {
      id: "text",
      projectId: "text",
      versionId: "text",
      kind: "text",
      rating: "text",
      text: "text",
      data: "json",
      createdAt: "text",
    });
  }
}

// ---------------------------------------------------------------------------
// Repositorios sin id propio
// ---------------------------------------------------------------------------

const KeywordList = z.array(Keyword);

class SqliteKeywords implements KeywordsRepo {
  constructor(private readonly db: SqliteDatabase) {}

  private read(ownerId: string, projectId: string): KeywordsRecord | null {
    const row = this.db.prepare("SELECT * FROM keywords WHERE project_id = ? AND owner_id = ?").get(projectId, ownerId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      ownerId,
      projectId,
      keywords: KeywordList.parse(JSON.parse(String(row.keywords))),
      publishCopy: row.publish_copy == null ? null : PublishCopy.parse(JSON.parse(String(row.publish_copy))),
      updatedAt: String(row.updated_at),
    };
  }

  async get(ownerId: string, projectId: string): Promise<KeywordsRecord | null> {
    return this.read(ownerId, projectId);
  }

  async put(ownerId: string, projectId: string, keywords: Keyword[], publishCopy?: PublishCopy | null): Promise<KeywordsRecord> {
    const valid = KeywordList.parse(keywords);
    const current = this.read(ownerId, projectId);
    // Verifica que el proyecto sea del dueño antes de escribir (no se puede "adoptar" uno ajeno).
    const owns = this.db.prepare("SELECT 1 FROM projects WHERE id = ? AND owner_id = ?").get(projectId, ownerId);
    if (!owns) throw new Error("Proyecto no encontrado para este dueño");
    const copy = publishCopy === undefined ? (current?.publishCopy ?? null) : publishCopy === null ? null : PublishCopy.parse(publishCopy);
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO keywords (project_id, owner_id, keywords, publish_copy, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET keywords = excluded.keywords, publish_copy = excluded.publish_copy, updated_at = excluded.updated_at
         WHERE keywords.owner_id = excluded.owner_id`,
      )
      .run(projectId, ownerId, JSON.stringify(valid), copy ? JSON.stringify(copy) : null, now);
    return { ownerId, projectId, keywords: valid, publishCopy: copy, updatedAt: now };
  }
}

class SqliteCalibration implements CalibrationRepo {
  constructor(private readonly db: SqliteDatabase) {}

  private rows(ownerId: string): Calibration {
    const rows = this.db.prepare("SELECT stage, factor, samples FROM calibration WHERE owner_id = ?").all(ownerId) as { stage: string; factor: number; samples: number }[];
    const out: Calibration = {};
    for (const r of rows) out[r.stage as EstimateStage] = { factor: Number(r.factor), samples: Number(r.samples) };
    return out;
  }

  async get(ownerId: string): Promise<Calibration> {
    const server = this.rows(SERVER_CALIBRATION_OWNER);
    const own = this.rows(ownerId);
    const merged: Calibration = { ...server };
    for (const [stage, value] of Object.entries(own)) if (value && value.samples > 0) merged[stage as EstimateStage] = value;
    return merged;
  }

  private upsert(ownerId: string, stage: EstimateStage, estimatedSeconds: number, actualSeconds: number): { factor: number; samples: number } {
    const prev = this.rows(ownerId)[stage];
    const next = updateCalibration(prev, estimatedSeconds, actualSeconds);
    this.db
      .prepare(
        `INSERT INTO calibration (owner_id, stage, factor, samples, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(owner_id, stage) DO UPDATE SET factor = excluded.factor, samples = excluded.samples, updated_at = excluded.updated_at`,
      )
      .run(ownerId, stage, next.factor, next.samples, nowIso());
    return next;
  }

  async record(ownerId: string, stage: EstimateStage, estimatedSeconds: number, actualSeconds: number): Promise<{ factor: number; samples: number }> {
    return inTransaction(this.db, () => {
      this.upsert(SERVER_CALIBRATION_OWNER, stage, estimatedSeconds, actualSeconds);
      return this.upsert(ownerId, stage, estimatedSeconds, actualSeconds);
    });
  }
}

class SqliteKv implements KvRepo {
  constructor(private readonly db: SqliteDatabase) {}
  async get<T = unknown>(ownerId: string, key: string): Promise<T | null> {
    const row = this.db.prepare("SELECT value FROM kv WHERE owner_id = ? AND key = ?").get(ownerId, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }
  async set(ownerId: string, key: string, value: unknown): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO kv (owner_id, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(ownerId, key, JSON.stringify(value ?? null), nowIso());
  }
  async delete(ownerId: string, key: string): Promise<void> {
    this.db.prepare("DELETE FROM kv WHERE owner_id = ? AND key = ?").run(ownerId, key);
  }
}

// ---------------------------------------------------------------------------
// Fábrica
// ---------------------------------------------------------------------------

export interface SqliteDb extends Db {
  readonly kind: "sqlite";
  /** Acceso crudo (solo pruebas y diagnósticos). */
  readonly raw: SqliteDatabase;
  /** Tablas genéricas (para verificar columnas contra la migración en pruebas). */
  readonly tables: SqliteTable<{ id: string }>[];
}

/** Abre la base en `<dataDir>/autoeditor.db` (o `:memory:`) y aplica migraciones. */
export function createSqliteDb(opts: { dataDir: string } | { file: string }): SqliteDb {
  const file = "file" in opts ? opts.file : path.join(opts.dataDir, "autoeditor.db");
  const raw = openSqlite(file);
  runMigrations(raw, MIGRATIONS);
  const projects = new ProjectsTable(raw);
  const assets = new AssetsTable(raw);
  const transcripts = new TranscriptsTable(raw);
  const jobs = new JobsTable(raw);
  const plans = new PlansTable(raw);
  const versions = new VersionsTable(raw);
  const styles = new StylesTable(raw);
  const styleVersions = new StyleVersionsTable(raw);
  const brands = new BrandsTable(raw);
  const rules = new RulesTable(raw);
  const glossary = new GlossaryTable(raw);
  const feedback = new FeedbackTable(raw);
  let closed = false;
  return {
    kind: "sqlite",
    raw,
    tables: [projects, assets, transcripts, jobs, plans, versions, styles, styleVersions, brands, rules, glossary, feedback] as unknown as SqliteTable<{ id: string }>[],
    projects,
    assets,
    transcripts,
    keywords: new SqliteKeywords(raw),
    jobs,
    plans,
    versions,
    styles,
    styleVersions,
    brands,
    rules,
    glossary,
    feedback,
    calibration: new SqliteCalibration(raw),
    kv: new SqliteKv(raw),
    async close() {
      if (closed) return;
      closed = true;
      try {
        raw.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {
        // si falla el checkpoint, igual cerramos
      }
      raw.close();
    },
  };
}
