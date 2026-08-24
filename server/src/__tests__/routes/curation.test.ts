import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// Feature 002-model-curation-layer: catalog-kind sources (models.dev shape)
// importing models + metadata; curated lists; listing integration.
let dashToken = '';
let app: Express;

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
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  await new Promise<void>(c => s.close(() => c()));
  return { status: res.status, body: data };
}

const FIXTURE = new URL('../../../../specs/002-model-curation-layer/fixtures/modelsdev-small.json', import.meta.url);

// Serve the fixture over real HTTP on an ephemeral port so the catalog parser
// exercises the full fetch path (127.0.0.1 passthrough keeps app calls live).
let fixtureServer: Server;
let fixturePort = 0;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  app = createApp();
  dashToken = mintDashboardToken();
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const baseDoc = JSON.parse(readFileSync(fileURLToPath(FIXTURE), 'utf8'));
  // /p/<prefix>/api.json serves the fixture with provider slugs renamed
  // <prefix>_<slug> so every test gets its own platform namespace (the
  // UNIQUE(platform, model_id) dedupe must not leak state across tests).
  fixtureServer = (await import('node:http')).createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const m = /\/p\/([A-Za-z0-9_]+)\//.exec(req.url ?? '');
    if (!m) { res.end(JSON.stringify(baseDoc)); return; }
    const prefix = m[1];
    const renamed: Record<string, any> = {};
    for (const [slug, prov] of Object.entries(baseDoc)) {
      renamed[`${prefix}_${slug}`] = JSON.parse(JSON.stringify(prov));
    }
    res.end(JSON.stringify(renamed));
  });
  await new Promise<void>(r => fixtureServer.listen(0, '127.0.0.1', () => r()));
  fixturePort = (fixtureServer.address() as any).port;
});

afterAll(async () => {
  fixtureServer?.close();
});

async function makeCatalogSource(name: string, prefix?: string): Promise<number> {
  const loc = prefix
    ? `http://127.0.0.1:${fixturePort}/p/${prefix}/api.json`
    : `http://127.0.0.1:${fixturePort}/api.json`;
  const r = await request('POST', '/api/sources', {
    name,
    location: loc,
    kind: 'catalog',
  });
  expect(r.status).toBe(201);
  return r.body.source.id as number;
}

describe('catalog source CRUD + sync (US1/US2)', () => {
  it('creates a catalog source and reports kind + active_list_id in the view', async () => {
    const { status, body } = await request('POST', '/api/sources', {
      name: 'models.dev',
      location: `http://127.0.0.1:${fixturePort}/api.json`,
      kind: 'catalog',
    });
    expect(status).toBe(201);
    expect(body.source.kind).toBe('catalog');
    expect(body.source.active_list_id).toBeNull();
  });

  it('kind absent defaults to url (back-compat)', async () => {
    const r = await request('POST', '/api/sources', {
      name: 'Plain url src', location: 'https://example.com/models.json',
    });
    expect(r.status).toBe(201);
    expect(r.body.source.kind).toBe('url');
  });

  it('sync imports models AND metadata matching the document', async () => {
    const id = await makeCatalogSource('MetaSync', 'ms');
    const synced = await request('POST', `/api/sources/${id}/sync`);
    expect(synced.status).toBe(200);
    expect(synced.body.status).toBe('ok');
    expect(synced.body.imported).toBe(6); // 2+2+2 fixture models

    // Spot-check metadata fidelity for anthropic/claude-haiku-cheapie.
    const row = getDb().prepare(`
      SELECT m.model_id, mm.* FROM models m
      JOIN model_metadata mm ON mm.model_db_id = m.id
      WHERE m.platform = 'ms_anthropic' AND m.model_id = 'claude-haiku-cheapie'
    `).get() as any;
    expect(row).toBeTruthy();
    expect(row.cost_input).toBeCloseTo(0.25);
    expect(row.cost_output).toBeCloseTo(1.25);
    expect(row.context_limit).toBe(200000);
    expect(row.output_limit).toBe(4096);
    expect(row.tool_call).toBe(0);
    expect(row.open_weights).toBe(0);
    expect(JSON.parse(row.modalities_input)).toEqual(['text']);

    // Unknown fields stored NULL, not fabricated (mysterylabs/ghost-free).
    const ghost = getDb().prepare(`
      SELECT mm.cost_input, mm.context_limit, mm.reasoning
      FROM models m JOIN model_metadata mm ON mm.model_db_id = m.id
      WHERE m.platform = 'ms_mysterylabs' AND m.model_id = 'ghost-free'
    `).get() as any;
    expect(ghost).toBeTruthy();
    expect(ghost.cost_input).toBeNull();
    expect(ghost.context_limit).toBeNull();

    // Vision flag mapped onto models.supports_vision.
    const vision = getDb().prepare(
      "SELECT supports_vision FROM models WHERE platform='ms_anthropic' AND model_id='claude-opus-5'"
    ).get() as any;
    expect(vision.supports_vision).toBe(1);

    // Context window copied for routing.
    const ctx = getDb().prepare(
      "SELECT context_window FROM models WHERE platform='ms_meta' AND model_id='muse-vision-open'"
    ).get() as any;
    expect(ctx.context_window).toBe(262144);
  });

  it('marks error on failure and keeps prior imports', async () => {
    const created = await request('POST', '/api/sources', {
      name: 'BrokenCat',
      location: 'http://127.0.0.1:1/api.json', // nothing listens here
      kind: 'catalog',
    });
    const id = created.body.source.id;
    const failed = await request('POST', `/api/sources/${id}/sync`);
    expect(failed.status).toBe(502);
    expect(failed.body.status).toBe('error');
    const rows = getDb().prepare(
      'SELECT COUNT(*) AS n FROM models WHERE source_ref_id = ?').get(id) as any;
    expect(rows.n).toBe(0);
  });

  it('re-sync updates metadata and tombstones removed models unless pinned', async () => {
    const id = await makeCatalogSource('ResyncCat');
    await request('POST', `/api/sources/${id}/sync`);
    // Pin one of this source's models, then serve a doc without it.
    const victim = getDb().prepare(
      "SELECT id FROM models WHERE platform='meta' AND model_id='muse-glimmer-30b'").get() as any;
    getDb().prepare('UPDATE models SET pinned = 1 WHERE id = ?').run(victim.id);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) =>
      String(input).includes('127.0.0.1') && !String(input).includes(String(fixturePort))
        ? origFetch(input, init)
        : new Response(JSON.stringify({
            rs_meta: { models: { muse_glimmer_30b: {
              name: 'Muse Glimmer 30B', tool_call: true,
              modalities: { input: ['text'], output: ['text'] },
              open_weights: true, limit: { context: 131072, output: 131072 },
              cost: { input: 0, output: 0 },
            } } }
          }), { status: 200 })) as typeof fetch;
    try {
      const synced = await request('POST', `/api/sources/${id}/sync`);
      expect(synced.status).toBe(200);
      expect(synced.body.removed).toBeGreaterThanOrEqual(4);
      const still = getDb().prepare(
        "SELECT COUNT(*) AS n FROM models WHERE id = ?").get(victim.id) as any;
      expect(still.n).toBe(1); // pinned survives
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('GET /api/sources/:id/models rejects non-catalog sources with 400', async () => {
    const created = await request('POST', '/api/sources', {
      name: 'UrlOnly', location: 'https://example.com/m.json',
    });
    const r = await request('GET', `/api/sources/${created.body.source.id}/models`);
    expect(r.status).toBe(400);
  });

  it('GET /api/sources/:id/models lists catalog models with metadata + effective state', async () => {
    const id = await makeCatalogSource('BrowseCat', 'br');
    await request('POST', `/api/sources/${id}/sync`);
    const r = await request('GET', `/api/sources/${id}/models?per_page=100`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(6);
    const opus = r.body.models.find((m: any) => m.model_id === 'claude-opus-5');
    expect(opus.metadata.cost_input).toBeCloseTo(0);
    expect(opus.curated_in).toBe(true); // no active list ⇒ everything included
    expect(opus.override).toBeNull();
  });
});

describe('curated lists (US3/US4)', () => {
  it('seeds five builtin lists with match counts', async () => {
    const r = await request('GET', '/api/curated-lists');
    expect(r.status).toBe(200);
    const builtins = r.body.lists.filter((l: any) => l.is_builtin);
    expect(builtins.length).toBe(5);
    expect(builtins[0].match_count).toBeTypeOf('number');
  });

  it('creates custom lists and rejects unknown criteria keys', async () => {
    const ok = await request('POST', '/api/curated-lists', {
      name: 'My cheap tools',
      criteria: { free_only: true, tool_call: true },
    });
    expect(ok.status).toBe(201);
    const bad = await request('POST', '/api/curated-lists', {
      name: 'Bad criteria',
      criteria: { hax: true },
    });
    expect(bad.status).toBe(400);
  });

  it('refuses to edit or delete builtin lists but allows overrides on them', async () => {
    const lists = (await request('GET', '/api/curated-lists')).body.lists;
    const builtin = lists.find((l: any) => l.is_builtin);
    expect((await request('PATCH', `/api/curated-lists/${builtin.id}`, { name: 'x' })).status).toBe(403);
    expect((await request('DELETE', `/api/curated-lists/${builtin.id}`)).status).toBe(403);
    // Overrides ARE allowed on builtins.
    const ov = await request('PUT', `/api/curated-lists/${builtin.id}/models`, {
      platform: 'br_anthropic', model_id: 'claude-opus-5', decision: 'exclude',
    });
    expect(ov.status).toBe(200);
  });

  it('applies a list to a catalog source via active_list_id and filters the browser', async () => {
    const srcId = await makeCatalogSource('ListedCat', 'lc');
    await request('POST', `/api/sources/${srcId}/sync`);
    const lists = (await request('GET', '/api/curated-lists')).body.lists;
    const freeTools = lists.find((l: any) => l.name === 'Free & Tool-capable');
    const patched = await request('PATCH', `/api/sources/${srcId}`, { active_list_id: freeTools.id });
    expect(patched.status).toBe(200);

    const browse = await request('GET', `/api/sources/${srcId}/models`);
    const ins = browse.body.models.filter((m: any) => m.curated_in);
    // Fixture ms/lc_anthropic+meta+mysterylabs: zero-cost AND tool_call models only.
    for (const m of ins) {
      expect(m.metadata.cost_input).toBe(0);
      expect(m.metadata.tool_call).toBe(true);
    }
    expect(ins.length).toBeGreaterThan(0);
    expect(ins.length).toBeLessThan(browse.body.total);
  });

  it('preview returns live count + sample for unsaved criteria', async () => {
    const r = await request('POST', '/api/curated-lists/preview', {
      criteria: { min_context: 100000 },
    });
    expect(r.status).toBe(200);
    expect(r.body.match_count).toBeTypeOf('number');
    expect(Array.isArray(r.body.sample)).toBe(true);
  });

  it('override wins over static criteria in effective state', async () => {
    const srcId = await makeCatalogSource('OvCat', 'ov');
    await request('POST', `/api/sources/${srcId}/sync`);
    const lists = (await request('GET', '/api/curated-lists')).body.lists;
    const vision = lists.find((l: any) => l.name === 'Vision chat');
    await request('PATCH', `/api/sources/${srcId}`, { active_list_id: vision.id });
    // Exclude an image-input model → drops out despite matching.
    const opusId = getDb().prepare(
      "SELECT model_id FROM models WHERE platform='ov_anthropic' AND model_id='claude-opus-5'"
    ).get() as any;
    expect(opusId).toBeTruthy();
    const ex = await request('PUT', `/api/curated-lists/${vision.id}/models`, {
      platform: 'ov_anthropic', model_id: 'claude-opus-5', decision: 'exclude',
    });
    expect(ex.status).toBe(200);
    let browse = await request('GET', `/api/sources/${srcId}/models?included=in`);
    expect(browse.body.models.some((m: any) => m.model_id === 'claude-opus-5')).toBe(false);
    // Include a non-vision model → resurrects despite failing the filter.
    const inc = await request('PUT', `/api/curated-lists/${vision.id}/models`, {
      platform: 'ov_mysterylabs', model_id: 'tiny-context', decision: 'include',
    });
    expect(inc.status).toBe(200);
    browse = await request('GET', `/api/sources/${srcId}/models?included=in`);
    expect(browse.body.models.some((m: any) => m.model_id === 'tiny-context')).toBe(true);
  });

  it('deleting a custom list clears referencing sources and cascades overrides', async () => {
    const created = await request('POST', '/api/curated-lists', {
      name: 'Doomed list', criteria: { open_weights: true },
    });
    const listId = created.body.list.id;
    const srcId = await makeCatalogSource('DoomedSrc', 'dm');
    await request('PATCH', `/api/sources/${srcId}`, { active_list_id: listId });
    const del = await request('DELETE', `/api/curated-lists/${listId}`);
    expect(del.status).toBe(200);
    const srcRow = (await request('GET', '/api/sources')).body.sources
      .find((s: any) => s.id === srcId);
    expect(srcRow.active_list_id).toBeNull();
  });

  it('sorts the model browser by price and context', async () => {
    const srcId = await makeCatalogSource('SortCat', 'so');
    await request('POST', `/api/sources/${srcId}/sync`);
    const asc = await request('GET', `/api/sources/${srcId}/models?sort=price&per_page=100`);
    const prices = asc.body.models.map((m: any) => m.metadata?.cost_input ?? Infinity);
    for (let i = 1; i < prices.length; i++) expect(prices[i - 1] <= prices[i]).toBe(true);
    const descCtx = await request('GET', `/api/sources/${srcId}/models?sort=-context&per_page=100`);
    const ctxs = descCtx.body.models.map((m: any) => m.context_window ?? -1);
    expect([...ctxs].sort((a: number, b: number) => b - a)).toEqual(ctxs);
  });
});
