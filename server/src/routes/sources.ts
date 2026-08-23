// /api/sources — model sources CRUD + per-source sync (feature 001).
// Mounted with requireAuth in app.ts, like the other dashboard routes.

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  listSources,
  createSource,
  updateSource,
  deleteSource,
  syncSource,
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
    created_at: row.created_at,
    ...(row.model_count !== undefined ? { model_count: row.model_count } : {}),
  };
}

sourcesRouter.get('/', (_req: Request, res: Response) => {
  res.json({ sources: listSources().map(view) });
});

sourcesRouter.post('/', (req: Request, res: Response) => {
  try {
    const { name, location } = req.body ?? {};
    if (typeof name !== 'string' || typeof location !== 'string') {
      return res.status(400).json({ error: 'name and location are required strings' });
    }
    const row = createSource(name, location);
    return res.status(201).json({ source: { ...view(row), model_count: 0 } });
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
      patch.pinned !== undefined && typeof patch.pinned !== 'boolean'
    ) {
      return res.status(400).json({ error: 'invalid field types in patch' });
    }
    // `pinned` toggling is applied directly to this source's imported rows.
    const row = updateSource(id, patch);
    return res.json({ source: view(row) });
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
