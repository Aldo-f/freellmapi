import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// Feature 002 US4: the active curated list on a catalog source filters the
// MERGED listing (/v1/models + every consumer via buildModelListing).
// Overrides win over static criteria; live membership picks up new syncs.

let app: Express;
let dashToken = '';
let fixtureServer: Server;
let fixturePort = 0;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  app = createApp();
  dashToken = mintDashboardToken();
  const { createServer } = await import('node:http');
  const baseDoc: Record<string, any> = {
    acme: {
      models: {
        'zfree-ztools-zx': { name: 'Free Tools', cost: { input: 0, output: 0 }, tool_call: true,
          modalities: { input: ['text'], output: ['text'] }, limit: { context: 128000, output: 8192 },
          open_weights: true },
        'zpaid-zvision-zx': { name: 'Paid Vision', cost: { input: 1, output: 2 },
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 200000, output: 16384 } },
        'zfree-znontools-zx': { name: 'Free NonTools', cost: { input: 0, output: 0 }, tool_call: false,
          modalities: { input: ['text'], output: ['text'] }, limit: { context: 32000, output: 4096 } },
        'zexpensive-zbig-zx': { name: 'Expensive Big', cost: { input: 9, output: 27 },
          tool_call: true, limit: { context: 1000000, output: 64000 } },
      },
    },
  };
  await new Promise<void>(r => {
    fixtureServer = createServer((req, res) => {
      res.writeHead(200);
      const m = /\/p\/([A-Za-z0-9_]+)\//.exec(req.url ?? '');
      if (!m) { res.end(JSON.stringify(baseDoc)); return; }
      const renamed: Record<string, any> = {};
      for (const [slug, prov] of Object.entries(baseDoc)) {
        renamed[`${m[1]}_${slug}`] = JSON.parse(JSON.stringify(prov));
      }
      res.end(JSON.stringify(renamed));
    });
    fixtureServer.listen(0, '127.0.0.1', () => r());
  });
  fixturePort = (fixtureServer.address() as any).port;
});

afterAll(async () => {
  fixtureServer?.close();
});

async function listen(): Promise<{ s: any; url: string }> {
  return new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => {
      const a: any = s.address();
      resolve({ s, url: `http://127.0.0.1:${a.port}` });
    });
  });
}

async function request(method: string, path: string, body?: any) {
  const { s, url } = await listen();
  const res = await fetch(url + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${dashToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  await new Promise<void>(c => s.close(() => c()));
  return { status: res.status, body: data };
}

// The unify path lists CANONICAL group ids (slug-normalized), not raw
// catalog ids. Assert visibility by db row: a listing entry whose platforms
// include 'acme' and whose group contains our db row's id.

// Visibility of a db row as the listing computes it: run the row through the
// SAME sourceVisibilityExpr the services use (canonical group ids are
// slug-normalized, so raw id membership can't be asserted directly).
import { sourceVisibilityExpr } from '../../services/source-visibility.js';

function acmeVisible(platform: string): Set<string> {
  const rows = getDb().prepare(`
    SELECT m.model_id FROM models m
    LEFT JOIN model_metadata mm ON mm.model_db_id = m.id
    WHERE m.platform = ? AND ${sourceVisibilityExpr()}
  `).all(platform) as any[];
  return new Set(rows.map(r => r.model_id));
}

function catalogSource(name: string, prefix: string): number {
  const info = getDb().prepare(`
    INSERT INTO model_sources (name, kind, location, enabled)
    VALUES (?, 'catalog', ?, 1)
  `).run(name, `http://127.0.0.1:${fixturePort}/p/${prefix}/api.json`);
  return Number(info.lastInsertRowid);
}

describe('curated selection drives the merged listing (US4)', () => {
  it('no active list ⇒ all catalog models listed', async () => {
    const id = catalogSource('plain', 'pl');
    await request('POST', `/api/sources/${id}/sync`);
    for (const mid of ['zfree-ztools-zx', 'zpaid-zvision-zx', 'zfree-znontools-zx', 'zexpensive-zbig-zx']) {
      expect(acmeVisible('pl_acme').has(mid)).toBe(true);
    }
  });

  it('applying Free & Tool-capable leaves only matching models', async () => {
    const id = catalogSource('filtered', 'fl');
    await request('POST', `/api/sources/${id}/sync`);
    const freeTools = getDb().prepare(
      "SELECT id FROM curation_lists WHERE name = 'Free & Tool-capable'"
    ).get() as any;
    const patched = await request('PATCH', `/api/sources/${id}`, { active_list_id: freeTools.id });
    expect(patched.status).toBe(200);
    const ids = acmeVisible('fl_acme');
    expect(ids.has('zfree-ztools-zx')).toBe(true);   // free + tools ✓
    expect(ids.has('zpaid-zvision-zx')).toBe(false); // not free
    expect(ids.has('zfree-znontools-zx')).toBe(false); // no tools
    expect(ids.has('zexpensive-zbig-zx')).toBe(false); // not free
  });

  it('exclude override hides a matching model; include resurrects a failing one', async () => {
    const id = catalogSource('ovl', 'ov');
    await request('POST', `/api/sources/${id}/sync`);
    const freeTools = getDb().prepare(
      "SELECT id FROM curation_lists WHERE name = 'Free & Tool-capable'"
    ).get() as any;
    await request('PATCH', `/api/sources/${id}`, { active_list_id: freeTools.id });

    await request('PUT', `/api/curated-lists/${freeTools.id}/models`, {
      platform: 'ov_acme', model_id: 'zfree-ztools-zx', decision: 'exclude',
    });
    expect(acmeVisible('ov_acme').has('zfree-ztools-zx')).toBe(false);

    await request('PUT', `/api/curated-lists/${freeTools.id}/models`, {
      platform: 'ov_acme', model_id: 'zexpensive-zbig-zx', decision: 'include',
    });
    expect(acmeVisible('ov_acme').has('zexpensive-zbig-zx')).toBe(true);

    // Clearing overrides restores pure filter behavior.
    await request('PUT', `/api/curated-lists/${freeTools.id}/models`, {
      platform: 'ov_acme', model_id: 'zfree-ztools-zx', decision: null,
    });
    await request('PUT', `/api/curated-lists/${freeTools.id}/models`, {
      platform: 'ov_acme', model_id: 'zexpensive-zbig-zx', decision: null,
    });
    expect(acmeVisible('ov_acme').has('zfree-ztools-zx')).toBe(true);
    expect(acmeVisible('ov_acme').has('zexpensive-zbig-zx')).toBe(false);
  });

  it('LIVE membership: newly synced matching models appear without touching the list', async () => {
    const id = catalogSource('live', 'lv');
    const freeTools = getDb().prepare(
      "SELECT id FROM curation_lists WHERE name = 'Free & Tool-capable'"
    ).get() as any;
    getDb().prepare('UPDATE model_sources SET active_list_id = ? WHERE id = ?')
      .run(freeTools.id, id);
    await request('POST', `/api/sources/${id}/sync`);
    const before = acmeVisible('lv_acme');
    expect(before.has('zfree-ztools-zx')).toBe(true);
    expect(before.has('zexpensive-zbig-zx')).toBe(false);
    // List definition unchanged — membership is re-evaluated per request.
    const listRow = getDb().prepare(
      "SELECT criteria FROM curation_lists WHERE id = ?"
    ).get(freeTools.id) as any;
    expect(JSON.parse(listRow.criteria)).toEqual({ free_only: true, tool_call: true });
  });

  it('disabling the catalog source hides everything regardless of curation (001 intact)', async () => {
    const id = catalogSource('disabled-src', 'ds');
    await request('POST', `/api/sources/${id}/sync`);
    expect(acmeVisible('ds_acme').size).toBeGreaterThan(0);
    await request('PATCH', `/api/sources/${id}`, { enabled: false });
    // All acme rows from ALL test sources vanish (001 rule intact).
    expect(acmeVisible('ds_acme').size).toBe(0);
  });
});
