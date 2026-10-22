// SQLite schema + seed. All ids are UUIDs.
import type { Database } from "bun:sqlite";
import { SEED_PLAYBOOK } from "./seed.ts";

export function initDb(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS playbooks (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    weeks_json TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, playbook_id TEXT NOT NULL, name TEXT NOT NULL,
    start_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, week INTEGER NOT NULL,
    role TEXT NOT NULL, title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0, done_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS kpis (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT '', targets_json TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS metric_entries (
    id TEXT PRIMARY KEY, kpi_id TEXT NOT NULL, date TEXT NOT NULL,
    value REAL NOT NULL, source TEXT NOT NULL DEFAULT 'manual', note TEXT NOT NULL DEFAULT ''
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS connector_cfg (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}'
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_kpis_run ON kpis(run_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_entries_kpi ON metric_entries(kpi_id, date)`);
}

/** Seed the template playbook on a fresh database. Idempotent. */
export function seedIfEmpty(db: Database) {
  const n = db.query("SELECT COUNT(*) AS c FROM playbooks").get() as { c: number };
  if (n.c > 0) return;
  db.run("INSERT INTO playbooks (id, name, description, weeks_json) VALUES (?, ?, ?, ?)", [
    crypto.randomUUID(),
    SEED_PLAYBOOK.name,
    SEED_PLAYBOOK.description,
    JSON.stringify({ weeks: SEED_PLAYBOOK.weeks, kpis: SEED_PLAYBOOK.kpis }),
  ]);
}
