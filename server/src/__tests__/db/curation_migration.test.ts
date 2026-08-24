import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

// Migration <next>_model_curation (feature 002-model-curation-layer):
// kind='catalog' sources + curated lists (static criteria, live membership)
// + per-model overrides.
describe('model curation migration', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  const tableColumns = (table: string): { name: string }[] =>
    getDb().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];

  it('widens model_sources.kind to accept catalog', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO model_sources (name, kind, location, enabled)
      VALUES ('models.dev', 'catalog', 'https://models.dev/api.json', 1)
    `).run();
    const row = db.prepare(
      "SELECT kind FROM model_sources WHERE name = 'models.dev'"
    ).get() as { kind: string };
    expect(row.kind).toBe('catalog');
  });

  it('still rejects unknown kinds', () => {
    expect(() =>
      getDb().prepare(`
        INSERT INTO model_sources (name, kind, location) VALUES ('x', 'ftp', '')
      `).run(),
    ).toThrow();
  });

  it('adds active_list_id to model_sources', () => {
    expect(tableColumns('model_sources').map(c => c.name)).toContain('active_list_id');
  });

  it('creates curation_lists with the five builtin seeds exactly once', () => {
    const rows = getDb().prepare(
      'SELECT name FROM curation_lists WHERE is_builtin = 1 ORDER BY name'
    ).all() as { name: string }[];
    expect(rows.map(r => r.name)).toEqual([
      'Big-context reasoning ≥200k',
      'Budget <$0.50 input',
      'Free & Tool-capable',
      'Open weights only',
      'Vision chat',
    ]);
  });

  it('creates curation_overrides with unique (list_id, platform, model_id)', () => {
    const cols = tableColumns('curation_overrides').map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(['id', 'list_id', 'platform', 'model_id', 'decision']));
    const db = getDb();
    const listId = (db.prepare("SELECT id FROM curation_lists WHERE is_builtin=1 LIMIT 1").get() as { id: number }).id;
    db.prepare(
      "INSERT INTO curation_overrides (list_id, platform, model_id, decision) VALUES (?, 'p', 'm', 'exclude')"
    ).run(listId);
    expect(() =>
      db.prepare(
        "INSERT INTO curation_overrides (list_id, platform, model_id, decision) VALUES (?, 'p', 'm', 'include')"
      ).run(listId),
    ).toThrow();
  });

  it('cascades: deleting a list removes its overrides; source keeps working without one', () => {
    const db = getDb();
    const info = db.prepare(
      "INSERT INTO curation_lists (name, criteria) VALUES ('tmp-list', '{}')"
    ).run();
    const id = Number(info.lastInsertRowid);
    db.prepare(
      "INSERT INTO curation_overrides (list_id, platform, model_id, decision) VALUES (?, 'p2', 'm2', 'include')"
    ).run(id);
    db.prepare('DELETE FROM curation_lists WHERE id = ?').run(id);
    const left = db.prepare('SELECT COUNT(*) AS n FROM curation_overrides WHERE list_id = ?').get(id) as { n: number };
    expect(left.n).toBe(0);
  });
});
