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
import {
  SourceFetchError,
  fetchSourceModels,
  fetchCatalogDocument,
  type CatalogEntry,
} from './source-fetch.js';

export interface NormalizedModelEntry {
  model_id: string;
  display_name: string;
  context_window: number | null;
  supports_vision: boolean;
}

export interface SourceRow {
  id: number;
  name: string;
  kind: 'builtin' | 'url' | 'catalog';
  location: string;
  enabled: number;
  last_synced_at: string | null;
  last_sync_status: 'ok' | 'error' | 'never';
  last_error: string | null;
  active_list_id: number | null;
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

export function createSource(
  name: string,
  location: string,
  kind: 'url' | 'catalog' = 'url',
): SourceRow {
  if (kind !== 'url' && kind !== 'catalog') {
    throw new ValidationError(`unknown source kind: ${String(kind)}`);
  }
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
    VALUES (?, ?, ?, 1)
  `).run(trimmedName, kind, location.trim());
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

  // Feature 002: catalog sources use the models.dev parser and additionally
  // upsert per-model metadata in the same transaction.
  if (source.kind === 'catalog') {
    return syncCatalogSource(source, now);
  }

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

/** Catalog (models.dev) sync: same dedupe/tombstone semantics as url sources
 *  plus model_metadata upserts. List overrides are never touched here — list
 *  membership is evaluated live at listing time. */
async function syncCatalogSource(
  source: SourceRow,
  now: string,
): Promise<SyncResult> {
  const db = getDb();
  const id = source.id;
  let entries: CatalogEntry[];
  try {
    entries = await fetchCatalogDocument(source.location);
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
      SELECT platform || '/' || model_id AS key FROM models
      WHERE source_ref_id IS NOT NULL AND source_ref_id != ?
    `).all(id) as { key: string }[]).map(r => r.key),
  );
  const ownIds = new Set(
    (db.prepare("SELECT platform || '/' || model_id AS key FROM models WHERE source_ref_id = ?")
      .all(id) as { key: string }[]).map(r => r.key),
  );

  const findRow = db.prepare(
    'SELECT id FROM models WHERE platform = ? AND model_id = ?'
  );
  const indexInsert = db.prepare(
    'INSERT OR REPLACE INTO source_model_index (source_id, platform, model_id) VALUES (?, ?, ?)'
  );
  const insert = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
                        size_label, monthly_token_budget, enabled, supports_vision,
                        context_window, source_ref_id, source)
    VALUES (?, ?, ?, 999, 999, '', '', 1, ?, ?, ?, 'user')
  `);
  const update = db.prepare(`
    UPDATE models SET display_name = ?, context_window = ?, supports_vision = ?,
                      source_ref_id = ?
    WHERE id = ?
  `);

  const metaUpsert = db.prepare(`
    INSERT INTO model_metadata (model_db_id, cost_input, cost_output, context_limit,
      output_limit, tool_call, structured_output, reasoning,
      modalities_input, modalities_output, open_weights, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(model_db_id) DO UPDATE SET
      cost_input=excluded.cost_input, cost_output=excluded.cost_output,
      context_limit=excluded.context_limit, output_limit=excluded.output_limit,
      tool_call=excluded.tool_call, structured_output=excluded.structured_output,
      reasoning=excluded.reasoning, modalities_input=excluded.modalities_input,
      modalities_output=excluded.modalities_output, open_weights=excluded.open_weights,
      updated_at=excluded.updated_at
  `);

  const b = (v: boolean | null): number | null => (v === null ? null : v ? 1 : 0);

  let imported = 0;
  let duplicates = 0;
  const seen = new Set<string>();
  const txUpsert = db.transaction(() => {
    for (const e of entries) {
      indexInsert.run(id, e.platform, e.model_id);
      const key = e.platform + '/' + e.model_id;
      if (seen.has(key)) { duplicates += 1; continue; }
      seen.add(key);
      const own = ownIds.has(key);
      if (existingIds.has(key) && !own) {
        duplicates += 1; // first-enabled-source-wins: another source owns it
        continue;
      }
      const row = findRow.get(e.platform, e.model_id) as { id: number } | undefined;
      let rowId: number;
      if (row && own) {
        update.run(e.display_name, e.context_window, e.supports_vision ? 1 : 0, id, row.id);
        rowId = row.id;
      } else if (row) {
        duplicates += 1;
        continue;
      } else {
        const info = insert.run(e.platform, e.model_id, e.display_name,
          e.supports_vision ? 1 : 0, e.context_window, id);
        rowId = Number(info.lastInsertRowid);
      }
      metaUpsert.run(rowId, e.metadata.cost_input, e.metadata.cost_output,
        e.metadata.context_limit, e.metadata.output_limit,
        b(e.metadata.tool_call), b(e.metadata.structured_output), b(e.metadata.reasoning),
        JSON.stringify(e.metadata.modalities_input), JSON.stringify(e.metadata.modalities_output),
        b(e.metadata.open_weights), now);
      imported += 1;
    }
    // Tombstones: this source's rows absent from the latest doc, unless pinned.
    // fallback_config / profile_models reference models(id) with FK constraints,
    // so their rows go first; metadata cascades via FK ON DELETE CASCADE.
    const tombstone = db.prepare(
      'DELETE FROM models WHERE source_ref_id = ? AND pinned = 0 AND platform = ? AND model_id = ?'
    );
    const clearFallback = db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?');
    const clearProfile = db.prepare('DELETE FROM profile_models WHERE model_db_id = ?');
    for (const ownKey of ownIds) {
      if (!seen.has(ownKey)) {
        const slash = ownKey.indexOf('/');
        const plat = ownKey.slice(0, slash);
        const mid = ownKey.slice(slash + 1);
        const victim = findRow.get(plat, mid) as { id: number } | undefined;
        if (victim) {
          clearFallback.run(victim.id);
          clearProfile.run(victim.id);
          tombstone.run(id, plat, mid);
        }
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

// ── Feature 002: catalog model browser ──────────────────────────────────────

export interface CatalogModelRow {
  platform: string;
  model_id: string;
  display_name: string;
  context_window: number | null;
  curated_in: boolean;
  override: 'include' | 'exclude' | null;
  metadata: Record<string, unknown> | null;
}

/** List a catalog source's models with metadata and effective curation state
 *  (override wins over active-list criteria; no list ⇒ all included). */
export function listCatalogSourceModels(
  id: number,
  opts: { search?: string; included?: 'all' | 'in' | 'out'; sort?: string; page?: number; perPage?: number } = {},
): { total: number; page: number; per_page: number; models: CatalogModelRow[] } {
  const source = getSource(id);
  if (!source) throw new NotFoundError('source not found');
  if (source.kind !== 'catalog') {
    throw new ValidationError('model browsing is only available for catalog sources');
  }

  const db = getDb();
  const page = Math.max(1, opts.page ?? 1);
  const perPage = Math.min(200, Math.max(1, opts.perPage ?? 50));
  const search = (opts.search ?? '').trim().toLowerCase();

  const rows = db.prepare(`
    SELECT m.id AS db_id, m.platform, m.model_id, m.display_name,
           mm.cost_input, mm.cost_output, mm.context_limit, mm.output_limit,
           mm.tool_call, mm.structured_output, mm.reasoning,
           mm.modalities_input, mm.modalities_output, mm.open_weights,
           ov.decision AS override
    FROM models m
    LEFT JOIN model_metadata mm ON mm.model_db_id = m.id
    LEFT JOIN curation_overrides ov ON ov.list_id = ? AND ov.platform = m.platform AND ov.model_id = m.model_id
    WHERE m.source_ref_id = ?
    ORDER BY m.platform ASC, m.model_id ASC
  `).all(source.active_list_id ?? -1, id) as any[];

  let items = rows.map(r => {
    const metadata = r.db_id && r.modalities_input !== undefined ? {
      cost_input: r.cost_input, cost_output: r.cost_output,
      context_limit: r.context_limit, output_limit: r.output_limit,
      tool_call: r.tool_call === null ? null : r.tool_call === 1,
      structured_output: r.structured_output === null ? null : r.structured_output === 1,
      reasoning: r.reasoning === null ? null : r.reasoning === 1,
      modalities_input: JSON.parse(r.modalities_input ?? '["text"]'),
      modalities_output: JSON.parse(r.modalities_output ?? '["text"]'),
      open_weights: r.open_weights === null ? null : r.open_weights === 1,
    } : null;

    // Effective state: override wins over static criteria of the active list.
    let curatedIn = true;
    if (source.active_list_id !== null) {
      const list = db.prepare('SELECT criteria FROM curation_lists WHERE id = ?')
        .get(source.active_list_id) as { criteria: string } | undefined;
      if (list) {
        curatedIn = matchesCriteria(metadata, JSON.parse(list.criteria || '{}'));
      }
    }
    const override = (r.override as 'include' | 'exclude' | null) ?? null;
    if (override === 'include') curatedIn = true;
    if (override === 'exclude') curatedIn = false;

    return {
      platform: r.platform, model_id: r.model_id, display_name: r.display_name,
      context_window: r.context_limit, curated_in: curatedIn, override, metadata,
    };
  });

  if (search) {
    items = items.filter(m =>
      `${m.platform}/${m.model_id}`.toLowerCase().includes(search) ||
      m.display_name.toLowerCase().includes(search));
  }
  if (opts.included === 'in') items = items.filter(m => m.curated_in);
  if (opts.included === 'out') items = items.filter(m => !m.curated_in);

  const priceOf = (m: CatalogModelRow): number =>
    m.metadata && typeof m.metadata.cost_input === 'number' ? m.metadata.cost_input : Infinity;
  const ctxOf = (m: CatalogModelRow): number => m.context_window ?? -1;
  switch (opts.sort) {
    case 'price': items.sort((a, b2) => priceOf(a) - priceOf(b2)); break;
    case '-price': items.sort((a, b2) => priceOf(b2) - priceOf(a)); break;
    case 'context': items.sort((a, b2) => ctxOf(a) - ctxOf(b2)); break;
    case '-context': items.sort((a, b2) => ctxOf(b2) - ctxOf(a)); break;
    case 'name': items.sort((a, b2) => a.display_name.localeCompare(b2.display_name)); break;
    default: break; // default order = platform/model_id (SQL)
  }

  const total = items.length;
  const start = (page - 1) * perPage;
  return { total, page, per_page: perPage, models: items.slice(start, start + perPage) };
}

/** Evaluate a list's STATIC criteria against one model's metadata.
 *  Unknown values fail positive filters (clarified: unknown cost ≠ free). */
export function matchesCriteria(
  md: Record<string, unknown> | null,
  criteria: Record<string, unknown>,
): boolean {
  if (!criteria || Object.keys(criteria).length === 0) return true;
  if (!md) return false;
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  if (criteria.free_only === true) {
    if (num(md.cost_input) !== 0 || num(md.cost_output) !== 0) return false;
  }
  if (typeof criteria.max_cost_input === 'number') {
    const ci = num(md.cost_input);
    if (ci === null || ci > criteria.max_cost_input) return false;
  }
  if (typeof criteria.min_context === 'number') {
    const cl = num(md.context_limit);
    if (cl === null || cl < criteria.min_context) return false;
  }
  if (criteria.tool_call === true && md.tool_call !== true) return false;
  if (criteria.reasoning === true && md.reasoning !== true) return false;
  if (criteria.open_weights === true && md.open_weights !== true) return false;
  if (criteria.input_image === true) {
    const mi = Array.isArray(md.modalities_input) ? md.modalities_input : [];
    if (!mi.includes('image')) return false;
  }
  return true;
}

// ── Typed errors the route layer maps to HTTP statuses ──────────────────────
export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class ForbiddenError extends Error {}
export class SyncFailureError extends Error {}
