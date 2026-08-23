// Migration: model_sources table + models.source_ref_id / models.pinned
// Created: 2026-08-23 (feature 001-model-sources-crud)
//
// DOWN: reversible
//
// model_sources records every place the system pulls models from:
//   kind='builtin' — the existing signed upstream catalog (catalog-sync.ts);
//                    exactly one row, seeded here, never deletable.
//   kind='url'     — an operator-provided URL serving a JSON model list
//                    (custom format {"models":[...]} or OpenAI-style
//                    {"data":[{"id":...}]}), synced on demand.
//
// models.source_ref_id attributes a catalog-owned row to its source (NULL =
// legacy/baseline rows, treated as builtin). models.pinned protects a row from
// sync-tombstone removal when its source no longer lists it (#926 semantics,
// per-source).

import type { Db } from '../types.js';

function tableExists(db: Db, name: string): boolean {
  return !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(c => c.name === column);
}

export function up(db: Db): void {
  if (!tableExists(db, 'model_sources')) {
    db.exec(`
      CREATE TABLE model_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('builtin','url')),
        location TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_synced_at TEXT,
        last_sync_status TEXT NOT NULL DEFAULT 'never',
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  // Exactly one builtin row; INSERT OR IGNORE keeps re-runs idempotent. The
  // fixed created_at keeps down/up round trips byte-identical (a fresh
  // datetime('now') would differ by a second and break state comparisons).
  db.prepare(`
    INSERT OR IGNORE INTO model_sources (name, kind, location, enabled, created_at)
    VALUES ('Built-in catalog', 'builtin', '', 1, '2026-08-23 00:00:00')
  `).run();

  if (!hasColumn(db, 'models', 'source_ref_id')) {
    db.prepare('ALTER TABLE models ADD COLUMN source_ref_id INTEGER REFERENCES model_sources(id)').run();
  }
  if (!hasColumn(db, 'models', 'pinned')) {
    db.prepare('ALTER TABLE models ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0').run();
  }

  // What each source's LATEST document listed (regardless of whether the row
  // insert was skipped as a duplicate). Lets deleteSource re-own shared models
  // to the next enabled provider instead of dropping them.
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_model_index (
      source_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      PRIMARY KEY (source_id, platform, model_id)
    );
  `);
}

export function down(db: Db): void {
  // SQLite supports DROP COLUMN since 3.35; guarded for older runtimes.
  if (hasColumn(db, 'models', 'pinned')) {
    try { db.prepare('ALTER TABLE models DROP COLUMN pinned').run(); } catch { /* pre-3.35 */ }
  }
  if (hasColumn(db, 'models', 'source_ref_id')) {
    try { db.prepare('ALTER TABLE models DROP COLUMN source_ref_id').run(); } catch { /* pre-3.35 */ }
  }
  if (tableExists(db, 'model_sources')) {
    db.exec('DROP TABLE model_sources;');
  }
}
