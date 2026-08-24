// /api/curated-lists — curated list CRUD + overrides + preview (feature 002).
// Mounted with requireAuth in app.ts, like the other dashboard routes.

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  listLists,
  createList,
  updateList,
  deleteList,
  setOverride,
  previewCriteria,
} from '../services/curation-lists.js';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
} from '../services/model-sources.js';

export const curatedListsRouter = Router();

function view(row: any) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    criteria: row.criteria_parsed ?? JSON.parse(row.criteria || '{}'),
    is_builtin: row.is_builtin === 1 || row.is_builtin === true,
    created_at: row.created_at,
    ...(row.match_count !== undefined ? { match_count: row.match_count } : {}),
  };
}

curatedListsRouter.get('/', (_req: Request, res: Response) => {
  res.json({ lists: listLists().map(view) });
});

curatedListsRouter.post('/preview', (req: Request, res: Response) => {
  try {
    const { criteria } = req.body ?? {};
    res.json(previewCriteria(criteria));
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    throw err;
  }
});


curatedListsRouter.post('/', (req: Request, res: Response) => {
  try {
    const { name, description, criteria } = req.body ?? {};
    if (typeof name !== 'string' || criteria === undefined) {
      return res.status(400).json({ error: 'name and criteria are required' });
    }
    const row = createList(name, typeof description === 'string' ? description : '', criteria);
    return res.status(201).json({ list: view({ ...row, criteria_parsed: undefined, match_count: undefined }) });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

curatedListsRouter.patch('/:id', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'curated list not found' });
    const row = updateList(id, req.body ?? {});
    return res.json({ list: view(row) });
  } catch (err) {
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof ForbiddenError) return res.status(403).json({ error: err.message });
    throw err;
  }
});

curatedListsRouter.delete('/:id', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'curated list not found' });
    deleteList(id);
    return res.json({ ok: true });
  } catch (err) {
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof ForbiddenError) return res.status(403).json({ error: err.message });
    throw err;
  }
});

curatedListsRouter.put('/:id/models', (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'curated list not found' });
    const { platform, model_id, decision } = req.body ?? {};
    if (typeof platform !== 'string' || typeof model_id !== 'string') {
      return res.status(400).json({ error: 'platform and model_id are required strings' });
    }
    if (decision !== null && decision !== 'include' && decision !== 'exclude') {
      return res.status(400).json({ error: "decision must be 'include', 'exclude' or null" });
    }
    const result = setOverride(id, platform, model_id, decision);
    res.json({ ok: true, override: result.override });
  } catch (err) {
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    throw err;
  }
});
