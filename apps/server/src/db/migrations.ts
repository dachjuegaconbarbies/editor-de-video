/**
 * Migraciones versionadas del esquema. NUNCA edites una migración ya publicada: agrega una nueva.
 *
 * Convenciones:
 *  - Todas las tablas llevan `owner_id` (multiusuario / Zyra) con índice.
 *  - Columnas JSON como TEXT (en Postgres serían JSONB); al leer se validan con zod.
 *  - Booleanos como INTEGER 0/1; fechas ISO 8601 como TEXT.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "esquema-inicial",
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  settings TEXT NOT NULL,
  status TEXT NOT NULL,
  current_version_id TEXT,
  thumbnail_asset_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_projects_owner ON projects(owner_id, updated_at);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  kind TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  probe TEXT NOT NULL,
  analysis TEXT NOT NULL,
  thumbnail_key TEXT,
  priority TEXT NOT NULL,
  note TEXT NOT NULL,
  sort_order REAL NOT NULL,
  sha256 TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_assets_owner_project ON assets(owner_id, project_id);

CREATE TABLE transcripts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  words TEXT NOT NULL,
  segments TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_transcripts_owner_project ON transcripts(owner_id, project_id);
CREATE INDEX idx_transcripts_owner_asset ON transcripts(owner_id, asset_id);

CREATE TABLE keywords (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  keywords TEXT NOT NULL,
  publish_copy TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_keywords_owner ON keywords(owner_id);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT,
  progress REAL NOT NULL,
  message TEXT NOT NULL,
  input TEXT NOT NULL,
  result TEXT,
  error TEXT,
  attempts INTEGER NOT NULL,
  estimated_seconds REAL,
  stage_timings TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_jobs_owner_project ON jobs(owner_id, project_id, created_at);
CREATE INDEX idx_jobs_status ON jobs(status, created_at);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id TEXT,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  scenes TEXT NOT NULL,
  recipe TEXT NOT NULL,
  estimated_cost_usd REAL NOT NULL,
  feedback TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_plans_owner_project ON plans(owner_id, project_id, created_at);

CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  parent_id TEXT,
  recipe TEXT NOT NULL,
  correction TEXT,
  correction_at REAL,
  changes TEXT NOT NULL,
  change_summary TEXT NOT NULL,
  status TEXT NOT NULL,
  video_key TEXT,
  poster_key TEXT,
  captions_srt_key TEXT,
  captions_vtt_key TEXT,
  publish_copy TEXT NOT NULL,
  rating TEXT,
  exported INTEGER NOT NULL,
  qa TEXT NOT NULL,
  render_seconds REAL,
  cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, number)
);
CREATE INDEX idx_versions_owner_project ON versions(owner_id, project_id, number);

CREATE TABLE styles (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  thumbnail_asset_id TEXT,
  times_used INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_styles_owner ON styles(owner_id, updated_at);

CREATE TABLE style_versions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  style_id TEXT NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  preset TEXT NOT NULL,
  rules_markdown TEXT NOT NULL,
  rules TEXT NOT NULL,
  source_project_id TEXT,
  source_version_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (style_id, number)
);
CREATE INDEX idx_style_versions_owner_style ON style_versions(owner_id, style_id, number);

CREATE TABLE brands (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  logo_asset_ids TEXT NOT NULL,
  font_asset_ids TEXT NOT NULL,
  google_fonts TEXT NOT NULL,
  colors TEXT NOT NULL,
  intro_asset_id TEXT,
  outro_asset_id TEXT,
  transition_asset_ids TEXT NOT NULL,
  lower_third_template_ids TEXT NOT NULL,
  notes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_brands_owner ON brands(owner_id, updated_at);

CREATE TABLE memory_rules (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT,
  text TEXT NOT NULL,
  rule_check TEXT,
  source TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  times_applied INTEGER NOT NULL,
  strength INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_memory_rules_owner ON memory_rules(owner_id, scope, scope_id);

CREATE TABLE glossary (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  term TEXT NOT NULL,
  variants TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT,
  times_applied INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_glossary_owner ON glossary(owner_id, scope, scope_id);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  version_id TEXT,
  kind TEXT NOT NULL,
  rating TEXT,
  text TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_feedback_owner_project ON feedback(owner_id, project_id, created_at);

CREATE TABLE calibration (
  owner_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  factor REAL NOT NULL,
  samples INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, stage)
);

CREATE TABLE kv (
  owner_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, key)
);
`,
  },
];
