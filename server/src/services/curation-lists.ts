// curation-lists service (feature 002-model-curation-layer).
//
// Curated lists = STATIC filter criteria + per-model overrides; membership is
// evaluated LIVE against current catalog data at listing time. Builtin rows
// (seeded by migration) are immutable definitions but accept per-model
// overrides.

import { getDb } from '../db/index.js';
import { ValidationError, NotFoundError, ForbiddenError, matchesCriteria } from './model-sources.js';

export interface CurationListRow {
  id: number;
  name: string;
  description: string;
  criteria: string;
  is_builtin: number;
  created_at: string;
}

export interface CurationListView extends CurationListRow {
  is_builtin_bool: boolean;
  criteria_parsed: Record<string, unknown>;
  match_count: number;
}

const KNOWN_CRITERIA_KEYS = [
  'free_only', 'max_cost_input', 'min_context',
  'tool_call', 'input_image', 'open_weights',
];

function validateCriteria(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('criteria must be an object');
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!KNOWN_CRITERIA_KEYS.includes(k)) {
      throw new ValidationError(`unknown criteria key: ${k}`);
    }
    if (k === 'min_context' || k === 'max_cost_input') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new ValidationError(`${k} must be a non-negative number`);
      }
    } else if (typeof v !== 'boolean') {
      throw new ValidationError(`${k} must be a boolean`);
    }
    out[k] = v;
  }
  return out;
}

/** Live match count of a criteria object against all imported catalog models. */
export function countMatches(criteria: Record<string, unknown>): number {
  if (!criteria || Object.keys(criteria).length === 0) {
    return (getDb().prepare('SELECT COUNT(*) AS n FROM model_metadata').get() as { n: number }).n;
  }
  const rows = getDb().prepare(`
    SELECT cost_input, cost_output, context_limit, output_limit,
           tool_call, structured_output, reasoning, modalities_input,
           modalities_output, open_weights
    FROM model_metadata
  `).all() as any[];
  let n = 0;
  for (const r of rows) {
    const md = {
      cost_input: r.cost_input, cost_output: r.cost_output,
      context_limit: r.context_limit, output_limit: r.output_limit,
      tool_call: r.tool_call === null ? null : r.tool_call === 1,
      structured_output: r.structured_output === null ? null : r.structured_output === 1,
      reasoning: r.reasoning === null ? null : r.reasoning === 1,
      modalities_input: JSON.parse(r.modalities_input ?? '["text"]'),
      modalities_output: JSON.parse(r.modalities_output ?? '["text"]'),
      open_weights: r.open_weights === null ? null : r.open_weights === 1,
    };
    if (matchesCriteria(md, criteria)) n += 1;
  }
  return n;
}

function rowToView(row: CurationListRow): CurationListView {
  const criteria = JSON.parse(row.criteria || '{}') as Record<string, unknown>;
  return {
    ...row,
    is_builtin_bool: row.is_builtin === 1,
    criteria_parsed: criteria,
    match_count: countMatches(criteria),
  };
}

export function listLists(): CurationListView[] {
  const rows = getDb().prepare(
    'SELECT * FROM curation_lists ORDER BY is_builtin DESC, name ASC'
  ).all() as unknown as CurationListRow[];
  return rows.map(rowToView);
}

function getList(id: number): CurationListRow {
  const row = getDb().prepare('SELECT * FROM curation_lists WHERE id = ?').get(id) as CurationListRow | undefined;
  if (!row) throw new NotFoundError('curated list not found');
  return row;
}

export function createList(name: string, description: string, criteriaRaw: unknown): CurationListRow {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) {
    throw new ValidationError('name must be 1-100 characters');
  }
  const criteria = validateCriteria(criteriaRaw);
  const dup = getDb().prepare('SELECT id FROM curation_lists WHERE name = ?').get(trimmed);
  if (dup) throw new ValidationError(`a list named "${trimmed}" already exists`);
  const info = getDb().prepare(
    "INSERT INTO curation_lists (name, description, criteria, is_builtin) VALUES (?, ?, ?, 0)"
  ).run(trimmed, description.trim(), JSON.stringify(criteria));
  return getList(Number(info.lastInsertRowid));
}

export function updateList(id: number, patch: { name?: string; description?: string; criteria?: unknown }): CurationListRow {
  const existing = getList(id);
  if (existing.is_builtin === 1) {
    throw new ForbiddenError('built-in curated lists are immutable');
  }
  const name = patch.name !== undefined ? patch.name.trim() : existing.name;
  if (!name || name.length > 100) throw new ValidationError('name must be 1-100 characters');
  if (name !== existing.name) {
    const dup = getDb().prepare('SELECT id FROM curation_lists WHERE name = ? AND id != ?').get(name, id);
    if (dup) throw new ValidationError(`a list named "${name}" already exists`);
  }
  const description = patch.description !== undefined ? String(patch.description).trim() : existing.description;
  const criteria = patch.criteria !== undefined
    ? JSON.stringify(validateCriteria(patch.criteria))
    : existing.criteria;
  getDb().prepare('UPDATE curation_lists SET name = ?, description = ?, criteria = ? WHERE id = ?')
    .run(name, description, criteria, id);
  return getList(id);
}

export function deleteList(id: number): void {
  const existing = getList(id);
  if (existing.is_builtin === 1) {
    throw new ForbiddenError('built-in curated lists cannot be deleted');
  }
  // Sources referencing this list fall back to "everything included".
  getDb().prepare('UPDATE model_sources SET active_list_id = NULL WHERE active_list_id = ?').run(id);
  getDb().prepare('DELETE FROM curation_lists WHERE id = ?').run(id); // overrides cascade
}

/** Set/clear a per-model override on ANY list (builtin included).
 *  decision=null clears the override row. */
export function setOverride(
  listId: number,
  platform: string,
  modelId: string,
  decision: 'include' | 'exclude' | null,
): { override: 'include' | 'exclude' | null } {
  getList(listId);
  if (decision !== null && decision !== 'include' && decision !== 'exclude') {
    throw new ValidationError("decision must be 'include', 'exclude' or null");
  }
  const db = getDb();
  if (decision === null) {
    db.prepare('DELETE FROM curation_overrides WHERE list_id = ? AND platform = ? AND model_id = ?')
      .run(listId, platform, modelId);
    return { override: null };
  }
  db.prepare(`
    INSERT INTO curation_overrides (list_id, platform, model_id, decision)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(list_id, platform, model_id) DO UPDATE SET decision = excluded.decision
  `).run(listId, platform, modelId, decision);
  return { override: decision };
}

/** Live preview for unsaved criteria (builder UI): count + small sample. */
export function previewCriteria(criteriaRaw: unknown): { match_count: number; sample: unknown[] } {
  const criteria = validateCriteria(criteriaRaw);
  const matchCount = countMatches(criteria);
  if (!criteria || Object.keys(criteria).length === 0) {
    const rows = getDb().prepare(`
      SELECT m.platform, m.model_id, m.display_name FROM models m
      JOIN model_metadata mm ON mm.model_db_id = m.id LIMIT 20
    `).all() as any[];
    return { match_count: matchCount, sample: rows };
  }
  const rows = getDb().prepare(`
    SELECT m.platform, m.model_id, m.display_name,
           mm.cost_input, mm.cost_output, mm.context_limit, mm.output_limit,
           mm.tool_call, mm.structured_output, mm.reasoning,
           mm.modalities_input, mm.modalities_output, mm.open_weights
    FROM models m JOIN model_metadata mm ON mm.model_db_id = m.id
    LIMIT 20000
  `).all() as any[];
  const sample: unknown[] = [];
  for (const r of rows) {
    const md = {
      cost_input: r.cost_input, cost_output: r.cost_output,
      context_limit: r.context_limit, output_limit: r.output_limit,
      tool_call: r.tool_call === null ? null : r.tool_call === 1,
      structured_output: r.structured_output === null ? null : r.structured_output === 1,
      reasoning: r.reasoning === null ? null : r.reasoning === 1,
      modalities_input: JSON.parse(r.modalities_input ?? '["text"]'),
      modalities_output: JSON.parse(r.modalities_output ?? '["text"]'),
      open_weights: r.open_weights === null ? null : r.open_weights === 1,
    };
    if (!matchesCriteria(md, criteria)) continue;
    sample.push({ platform: r.platform, model_id: r.model_id, display_name: r.display_name });
    if (sample.length >= 20) break;
  }
  return { match_count: matchCount, sample };
}
