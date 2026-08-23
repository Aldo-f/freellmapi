// model-sources service (feature 001-model-sources-crud).
//
// CRUD + sync for model_sources. The builtin row fronts the existing
// catalog-sync; kind='url' rows are synced on demand via source-fetch.ts.
//
// Sync semantics (spec):
//  - upsert rows owned by this source (models.source_ref_id = source id)
//  - first-enabled-source-wins: a model_id another enabled source already
//    provides is recorded once (UNIQUE(platform, model_id)) and the duplicate
//    is skipped, not double-counted
//  - tombstones: ids absent from the latest doc are removed unless pinned=1
//  - failures update last_sync_status/error and never delete prior imports

import { getDb } from '../db/index.js';
import { SourceFetchError, fetchSourceModels } from './source-fetch.js';

export interface NormalizedModelEntry {
  model_id: string;
  display_name: string;
  context_window: number | null;
  supports_vision: boolean;
}

export interface SourceRow {
  id: number;
  name: string;
  kind: 'builtin' | 'url';
  location: string;
  enabled: number;
  last_synced_at: string | null;
  last_sync_status: 'ok' | 'error' | 'never';
  last_error: string | null;
  created_at: string;
}

export interface SourceView extends SourceRow {
  enabled_bool: boolean;
  model_count: number;
  /** How many of this source's imported models are pinned (tombstone-protected). */
  pinned_count?: number;
}

const URL_RE = /^https?:\/\/[^\s]+$/i;

function rowToView(row: SourceRow): SourceView {
  const counts = getDb().prepare(
    'SELECT COUNT(*) AS n, COALESCE(SUM(pinned), 0) AS pinned FROM models WHERE source_ref_id = ?'
  ).get(row.id) as { n: number; pinned: number };
  return { ...row, enabled_bool: row.enabled === 1, model_count: counts.n,
           pinned_count: Number(counts.pinned) };
}

export function listSources(): SourceView[] {
  const rows = getDb().prepare(
    'SELECT * FROM model_sources ORDER BY kind = \'builtin\' DESC, id ASC'
  ).all() as unknown as SourceRow[];
  return rows.map(rowToView);
}

export function getSource(id: number): SourceRow | null {
  return (getDb().prepare('SELECT * FROM model_sources WHERE id = ?').get(id) ??
    null) as SourceRow | null;
}

export function createSource(name: string, location: string): SourceRow {
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName.length > 100) {
    throw new ValidationError('name must be 1-100 characters');
  }
  if (!URL_RE.test(location.trim())) {
    throw new ValidationError('location must be an http(s) URL');
  }
  const dup = getDb().prepare('SELECT id FROM model_sources WHERE name = ?').get(trimmedName);
  if (dup) throw new ConflictError(`a source named "${trimmedName}" already exists`);
  const info = getDb().prepare(`
    INSERT INTO model_sources (name, kind, location, enabled)
    VALUES (?, 'url', ?, 1)
  `).run(trimmedName, location.trim());
  return getSource(Number(info.lastInsertRowid))!;
}

export function updateSource(
  id: number,
  patch: { name?: string; location?: string; enabled?: boolean },
): SourceRow {
  const existing = getSource(id);
  if (!existing) throw new NotFoundError('source not found');

  const name = patch.name !== undefined ? patch.name.trim() : existing.name;
  if (!name || name.length > 100) {
    throw new ValidationError('name must be 1-100 characters');
  }
  if (name !== existing.name) {
    const dup = getDb().prepare('SELECT id FROM model_sources WHERE name = ? AND id != ?').get(name, id);
    if (dup) throw new ConflictError(`a source named "${name}" already exists`);
  }

  let location = existing.location;
  if (patch.location !== undefined) {
    if (existing.kind === 'builtin') {
      throw new ValidationError('the builtin source location cannot be changed');
    }
    location = patch.location.trim();
    if (!URL_RE.test(location)) {
      throw new ValidationError('location must be an http(s) URL');
    }
  }

  const enabled = patch.enabled === undefined ? existing.enabled : (patch.enabled ? 1 : 0);

  getDb().prepare(
    'UPDATE model_sources SET name = ?, location = ?, enabled = ? WHERE id = ?',
  ).run(name, location, enabled, id);
  return getSource(id)!;
}

export function deleteSource(id: number): { removedModels: number } {
  const existing = getSource(id);
  if (!existing) throw new NotFoundError('source not found');
  if (existing.kind === 'builtin') {
    throw new ForbiddenError('the builtin source cannot be deleted (disable it instead)');
  }

  const db = getDb();
  // Shared models (also listed by another ENABLED source) get re-owned to that
  // source's row — or, if no row exists yet, stay and are re-pointed to the
  // next sync. Exclusive models are deleted with the source.
  const shared = db.prepare(`
    SELECT m.id, m.platform, m.model_id,
           (SELECT s.source_id FROM source_model_index s
            JOIN model_sources ms ON ms.id = s.source_id
            WHERE s.platform = m.platform AND s.model_id = m.model_id
              AND s.source_id != ? AND ms.enabled = 1
            ORDER BY ms.id LIMIT 1) AS next_owner
    FROM models m WHERE m.source_ref_id = ?
  `).all(id, id) as { id: number; platform: string; model_id: string; next_owner: number | null }[];

  const remove = db.prepare('DELETE FROM models WHERE id = ?');
  const reown = db.prepare('UPDATE models SET source_ref_id = ? WHERE id = ?');
  const clearFallback = db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?');
  const clearProfile = db.prepare('DELETE FROM profile_models WHERE model_db_id = ?');
  const tx = db.transaction(() => {
    for (const row of shared) {
      if (row.next_owner !== null && row.next_owner !== undefined) {
        reown.run(row.next_owner, row.id);
      } else if (!row.next_owner) {
        // No other enabled provider: delete only if truly exclusive.
        const other = db.prepare(`
          SELECT 1 FROM source_model_index s
          JOIN model_sources ms ON ms.id = s.source_id
          WHERE s.platform = ? AND s.model_id = ? AND s.source_id != ? AND ms.enabled = 1
        `).get(row.platform, row.model_id, id);
        if (!other) {
          clearFallback.run(row.id);
          clearProfile.run(row.id);
          remove.run(row.id);
        }
      }
    }
    db.prepare('DELETE FROM source_model_index WHERE source_id = ?').run(id);
    db.prepare('DELETE FROM model_sources WHERE id = ?').run(id);
  });
  tx();
  return { removedModels: shared.filter(r => !r.next_owner).length };
}

export interface SyncResult {
  status: 'ok' | 'error';
  imported: number;
  removed: number;
  duplicates_skipped: number;
  last_synced_at: string | null;
  last_error?: string;
}

/** Sync one URL source: fetch, upsert, tombstone. Builtin rows are synced by
 *  the existing catalog-sync pipeline instead (403 at the route layer). */
export async function syncSource(id: number): Promise<SyncResult> {
  const source = getSource(id);
  if (!source) throw new NotFoundError('source not found');
  if (source.kind === 'builtin') {
    throw new ForbiddenError('the builtin catalog syncs via its own pipeline');
  }

  const now = new Date().toISOString();
  const db = getDb();
  let entries: NormalizedModelEntry[];
  try {
    entries = await fetchSourceModels(source.location);
  } catch (err) {
    const message = err instanceof SourceFetchError ? err.message : String(err);
    db.prepare(`
      UPDATE model_sources SET last_synced_at = ?, last_sync_status = 'error', last_error = ?
      WHERE id = ?
    `).run(now, message, id);
    throw new SyncFailureError(message);
  }

  const existingIds = new Set(
    (db.prepare(`
      SELECT model_id FROM models
      WHERE platform = 'custom'
        AND source_ref_id IS NOT NULL
        AND source_ref_id != ?
    `).all(id) as { model_id: string }[]).map(r => r.model_id),
  );
  // Also count rows owned by THIS source so upserts don't count as duplicates.
  const ownIds = new Set(
    (db.prepare('SELECT model_id FROM models WHERE source_ref_id = ?').all(id) as { model_id: string }[])
      .map(r => r.model_id),
  );

  const findRow = db.prepare(
    "SELECT id FROM models WHERE platform = 'custom' AND model_id = ?"
  );
  const indexInsert = db.prepare(
    'INSERT OR REPLACE INTO source_model_index (source_id, platform, model_id) VALUES (?, ?, ?)'
  );
  const insert = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
                        size_label, monthly_token_budget, enabled, supports_vision,
                        context_window, source_ref_id, source)
    VALUES ('custom', ?, ?, 999, 999, '', '', 1, ?, ?, ?, 'user')
  `);
  const update = db.prepare(`
    UPDATE models SET display_name = ?, context_window = ?, supports_vision = ?,
                      source_ref_id = ?
    WHERE id = ?
  `);

  let imported = 0;
  let duplicates = 0;
  const seen = new Set<string>();
  const txUpsert = db.transaction(() => {
    for (const e of entries) {
      indexInsert.run(id, 'custom', e.model_id);
      if (seen.has(e.model_id)) { duplicates += 1; continue; }
      seen.add(e.model_id);
      const own = ownIds.has(e.model_id);
      if (existingIds.has(e.model_id) && !own) {
        duplicates += 1; // first-enabled-source-wins: another source owns it
        continue;
      }
      const row = findRow.get(e.model_id) as { id: number } | undefined;
      if (row && own) {
        update.run(e.display_name, e.context_window, e.supports_vision ? 1 : 0, id, row.id);
      } else if (row) {
        duplicates += 1;
      } else {
        insert.run(e.model_id, e.display_name, e.supports_vision ? 1 : 0, e.context_window, id);
      }
      imported += 1;
    }
    // Tombstones: this source's rows absent from the latest doc, unless pinned.
    // fallback_config / profile_models reference models(id) with FK constraints,
    // so their rows go first or the delete fails (SqliteError FOREIGN KEY).
    const tombstone = db.prepare(
      'DELETE FROM models WHERE source_ref_id = ? AND pinned = 0 AND model_id = ?'
    );
    const clearFallback = db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?');
    const clearProfile = db.prepare('DELETE FROM profile_models WHERE model_db_id = ?');
    for (const own of ownIds) {
      if (!seen.has(own)) {
        const victim = findRow.get(own) as { id: number } | undefined;
        if (victim) {
          clearFallback.run(victim.id);
          clearProfile.run(victim.id);
        }
        tombstone.run(id, own);
      }
    }
  });
  txUpsert();

  db.prepare(`
    UPDATE model_sources SET last_synced_at = ?, last_sync_status = 'ok', last_error = NULL
    WHERE id = ?
  `).run(now, id);

  return {
    status: 'ok',
    imported,
    removed: Math.max(0, ownIds.size - seen.size),
    duplicates_skipped: duplicates,
    last_synced_at: now,
  };
}

// ── Typed errors the route layer maps to HTTP statuses ──────────────────────
export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class ForbiddenError extends Error {}
export class SyncFailureError extends Error {}
