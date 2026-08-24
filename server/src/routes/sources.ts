// /api/sources — model sources CRUD + per-source sync (feature 001).
// Mounted with requireAuth in app.ts, like the other dashboard routes.

import { Router } from 'express';
import { getDb } from '../db/index.js';
import type { Request, Response } from 'express';
import {
  listSources,
  createSource,
  updateSource,
  deleteSource,
  syncSource,
  listCatalogSourceModels,
  ValidationError,
  ConflictError,
  NotFoundError,
  ForbiddenError,
  SyncFailureError,
} from '../services/model-sources.js';

export const sourcesRouter = Router();

function view(row: any) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    location: row.location,
    enabled: row.enabled === 1 || row.enabled === true,
    last_synced_at: row.last_synced_at,
    last_sync_status: row.last_sync_status,
    last_error: row.last_error,
    active_list_id: row.active_list_id ?? null,
    created_at: row.created_at,
    ...(row.model_count !== undefined ? { model_count: row.model_count } : {}),
    ...(row.pinned_count !== undefined ? { pinned_count: row.pinned_count } : {}),
  };
}

sourcesRouter.get('/', (_req: Request, res: Response) => {
  res.json({ sources: listSources().map(view) });
});

sourcesRouter.post('/', (req: Request, res: Response) => {
  try {
    const { name, location, kind } = req.body ?? {};
    if (typeof name !== 'string' || typeof location !== 'string') {
      return res.status(400).json({ error: 'name and location are required strings' });
    }
    if (kind !== undefined && kind !== 'url' && kind !== 'catalog') {
      return res.status(400).json({ error: `unknown source kind: ${String(kind)}` });
    }
    const row = createSource(name, location, kind === 'catalog' ? 'catalog' : 'url');
    return res.status(201).json({ source: view(listSources().find(s => s.id === row.id)) });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof ConflictError) return res.status(409).json({ error: err.message });
    throw err;
  }
});

sourcesRouter.patch('/:id', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(404).json({ error: 'source not found' });
    }
    const patch = req.body ?? {};
    if (
      patch.name !== undefined && typeof patch.name !== 'string' ||
      patch.location !== undefined && typeof patch.location !== 'string' ||
      patch.enabled !== undefined && typeof patch.enabled !== 'boolean' ||
      patch.pinned !== undefined && typeof patch.pinned !== 'boolean' ||
      patch.active_list_id !== undefined &&
        patch.active_list_id !== null && !Number.isInteger(patch.active_list_id)
    ) {
      return res.status(400).json({ error: 'invalid field types in patch' });
    }
    if (patch.active_list_id !== undefined) {
      if (patch.active_list_id !== null) {
        const list = getDb().prepare('SELECT id FROM curation_lists WHERE id = ?')
          .get(patch.active_list_id) as { id: number } | undefined;
        if (!list) return res.status(400).json({ error: 'unknown curated list' });
      }
      getDb().prepare('UPDATE model_sources SET active_list_id = ? WHERE id = ?')
        .run(patch.active_list_id, id);
    }
    // `pinned` toggles protection for ALL of this source's imported models.
    if (patch.pinned !== undefined) {
      getDb().prepare('UPDATE models SET pinned = ? WHERE source_ref_id = ?')
        .run(patch.pinned ? 1 : 0, id);
    }
    updateSource(id, patch);
    const updated = listSources().find(s => s.id === id);
    return res.json({ source: view(updated) });
  } catch (err) {
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof ConflictError) return res.status(409).json({ error: err.message });
    throw err;
  }
});

sourcesRouter.delete('/:id', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(404).json({ error: 'source not found' });
    }
    const result = deleteSource(id);
    return res.json({ ok: true, removed_models: result.removedModels });
  } catch (err) {
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof ForbiddenError) return res.status(403).json({ error: err.message });
    throw err;
  }
});

sourcesRouter.post('/:id/sync', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(404).json({ error: 'source not found' });
    }
    const result = await syncSource(id);
    return res.json(result);
  } catch (err) {
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof ForbiddenError) return res.status(403).json({ error: err.message });
    if (err instanceof SyncFailureError) {
      return res.status(502).json({ status: 'error', last_error: err.message });
    }
    throw err;
  }
});

// Feature 002: paged model browser for catalog sources (curation UI).
sourcesRouter.get('/:id/models', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'source not found' });
    const includedParam = req.query.included === 'in' || req.query.included === 'out'
      ? req.query.included as 'in' | 'out' : 'all';
    const result = listCatalogSourceModels(id, {
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      included: includedParam,
      sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
      page: Number(req.query.page) || 1,
      perPage: Number(req.query.per_page) || 50,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    throw err;
  }
});
