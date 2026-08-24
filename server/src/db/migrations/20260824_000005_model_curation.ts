// Migration: model curation layer (feature 002-model-curation-layer)
// Created: 2026-08-24
// DOWN: reversible
//
//  - model_sources.kind gains 'catalog' (models.dev-style metadata catalog
//    sources) and an active_list_id pointing at the curated list that drives
//    the source's contribution to the merged listing.
//  - curation_lists: named curated lists. criteria is a STATIC filter JSON;
//    membership is evaluated LIVE against current catalog data. Builtin rows
//    (seeded here) are immutable definitions; per-model overrides still apply.
//  - curation_overrides: per-list include/exclude decisions winning over the
//    list's static criteria.
//  - model_metadata: per-model metadata imported by catalog syncs.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(c => c.name === column);
}

function kindCheckAllowsCatalog(db: Db): boolean {
  // The CHECK lives in the table DDL; simplest robust probe: try inserting a
  // catalog row inside a savepoint and see if it sticks.
  db.prepare('SAVEPOINT kind_probe').run();
  try {
    db.prepare(`
      INSERT INTO model_sources (name, kind, location)
      VALUES ('__kind_probe__', 'catalog', '')
    `).run();
    return true;
  } catch {
    return false;
  } finally {
    db.prepare('ROLLBACK TO kind_probe').run();
    db.prepare('RELEASE kind_probe').run();
  }
}

function rebuildModelSourcesKind(db: Db): void {
  // SQLite cannot ALTER a CHECK constraint — rebuild the table preserving all
  // rows (endpoint-identity rebuild pattern from 001).
  const cols = (db.prepare('PRAGMA table_info(model_sources)').all() as { name: string }[])
    .map(c => c.name);
  const select = cols.join(', ');
  db.exec(`
    CREATE TABLE model_sources_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('builtin','url','catalog')),
      location TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_synced_at TEXT,
      last_sync_status TEXT NOT NULL DEFAULT 'never',
      last_error TEXT,
      active_list_id INTEGER REFERENCES curation_lists(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`INSERT INTO model_sources_new (${select}) SELECT ${select} FROM model_sources;`);
  db.exec('DROP TABLE model_sources;');
  db.exec('ALTER TABLE model_sources_new RENAME TO model_sources;');
}

export function up(db: Db): void {
  // curation_lists must exist before model_sources can gain its FK column.
  if (!tableExists(db, 'curation_lists')) {
    db.exec(`
      CREATE TABLE curation_lists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        criteria TEXT NOT NULL DEFAULT '{}',
        is_builtin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  if (!kindCheckAllowsCatalog(db)) {
    rebuildModelSourcesKind(db);
  } else if (!hasColumn(db, 'model_sources', 'active_list_id')) {
    db.prepare(
      'ALTER TABLE model_sources ADD COLUMN active_list_id INTEGER REFERENCES curation_lists(id)'
    ).run();
  }

  // Five builtin lists, seeded once with fixed keys for deterministic
  // down/up round trips. Criteria are static forever; membership is live.
  const seed = db.prepare(`
    INSERT OR IGNORE INTO curation_lists (name, description, criteria, is_builtin)
    VALUES (?, ?, ?, 1)
  `);
  seed.run('Free & Tool-capable', 'Zero-cost models that support tool calling',
           JSON.stringify({ free_only: true, tool_call: true }));
  seed.run('Vision chat', 'Models accepting image input',
           JSON.stringify({ input_image: true }));
  seed.run('Big-context reasoning ≥200k', 'Reasoning models with at least a 200k context window',
           JSON.stringify({ min_context: 200000, reasoning: true }));
  seed.run('Open weights only', 'Models with openly available weights',
           JSON.stringify({ open_weights: true }));
  seed.run('Budget <$0.50 input', 'Input price under $0.50 per Mtok (unknown cost excluded)',
           JSON.stringify({ max_cost_input: 0.5 }));

  db.exec(`
    CREATE TABLE IF NOT EXISTS curation_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL REFERENCES curation_lists(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('include','exclude')),
      UNIQUE(list_id, platform, model_id)
    );
  `);

  if (!tableExists(db, 'model_metadata')) {
    db.exec(`
      CREATE TABLE model_metadata (
        model_db_id INTEGER PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
        cost_input REAL,
        cost_output REAL,
        context_limit INTEGER,
        output_limit INTEGER,
        tool_call INTEGER,
        structured_output INTEGER,
        reasoning INTEGER,
        modalities_input TEXT NOT NULL DEFAULT '["text"]',
        modalities_output TEXT NOT NULL DEFAULT '["text"]',
        open_weights INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
}

function tableExists(db: Db, name: string): boolean {
  return !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
}

export function down(db: Db): void {
  if (tableExists(db, 'model_metadata')) db.exec('DROP TABLE model_metadata;');
  if (hasColumn(db, 'model_sources', 'active_list_id')) {
    // Rebuild without the FK column so the reference to curation_lists goes too.
    const cols = (db.prepare('PRAGMA table_info(model_sources)').all() as { name: string }[])
      .filter(c => c.name !== 'active_list_id').map(c => c.name);
    db.exec(`
      CREATE TABLE model_sources_down (
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
    db.exec(`INSERT INTO model_sources_down (${cols.join(', ')})
             SELECT ${cols.join(', ')} FROM model_sources;`);
    db.exec('DROP TABLE model_sources;');
    db.exec('ALTER TABLE model_sources_down RENAME TO model_sources;');
  }
  if (tableExists(db, 'curation_overrides')) db.exec('DROP TABLE curation_overrides;');
  if (tableExists(db, 'curation_lists')) db.exec('DROP TABLE curation_lists;');
}
