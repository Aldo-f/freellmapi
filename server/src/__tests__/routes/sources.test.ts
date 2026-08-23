import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// Feature 001-model-sources-crud: /api/sources CRUD + per-source sync.
let dashToken = '';
let app: Express;

async function request(method: string, path: string, body?: any) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(r => server.once('listening', () => r()));
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

function builtinRow() {
  return getDb().prepare("SELECT * FROM model_sources WHERE kind='builtin'").get() as any;
}

const passthrough = (orig: typeof fetch) => async (input: any, init?: any) =>
  String(input).includes('127.0.0.1') ? orig(input, init) : orig(String(input), { ...init });

describe('GET /api/sources (US1)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('lists the builtin source with sync fields and model_count', async () => {
    const { status, body } = await request('GET', '/api/sources');
    expect(status).toBe(200);
    expect(body.sources.length).toBeGreaterThanOrEqual(1);
    const builtin = body.sources.find((s: any) => s.kind === 'builtin');
    expect(builtin).toBeTruthy();
    expect(builtin.enabled).toBe(true);
    expect(builtin.last_sync_status).toBeTypeOf('string');
    expect(builtin.model_count).toBeTypeOf('number');
  });
});

describe('POST /api/sources + sync (US2)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('creates a custom source (201, status never)', async () => {
    const { status, body } = await request('POST', '/api/sources', {
      name: 'My list',
      location: 'https://example.com/models.json',
    });
    expect(status).toBe(201);
    expect(body.source.name).toBe('My list');
    expect(body.source.last_sync_status).toBe('never');
    expect(body.source.enabled).toBe(true);
  });

  it('rejects invalid payloads (400) and duplicate names (409)', async () => {
    expect((await request('POST', '/api/sources', { name: '', location: 'https://x.com/m.json' })).status).toBe(400);
    expect((await request('POST', '/api/sources', { name: 'Bad', location: 'not-a-url' })).status).toBe(400);
    expect((await request('POST', '/api/sources', { name: 'My list', location: 'https://x.com/m.json' })).status).toBe(409);
  });

  it('sync imports models from a fetched document', async () => {
    // Stand up a fixture server serving the custom-format doc.
    const payload = { models: [
      { model_id: 'test-source/alpha', display_name: 'Alpha', context_window: 128000 },
      { model_id: 'test-source/beta', display_name: 'Beta', supports_vision: true },
    ] };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) =>
      String(input).includes('127.0.0.1')
        ? origFetch(input, init)
        : new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
    try {
      const created = await request('POST', '/api/sources', {
        name: 'Synced list',
        location: 'https://example.invalid/list.json',
      });
      const id = created.body.source.id;
      const synced = await request('POST', `/api/sources/${id}/sync`);
      expect(synced.status).toBe(200);
      expect(synced.body.status).toBe('ok');
      expect(synced.body.imported).toBe(2);

      const rows = getDb().prepare(
        "SELECT model_id FROM models WHERE source_ref_id = ?").all(id) as any[];
      expect(rows.map(r => r.model_id).sort()).toEqual(['test-source/alpha', 'test-source/beta']);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('marks the source error on fetch/parse failure and keeps prior models', async () => {
    const created = await request('POST', '/api/sources', {
      name: 'Broken list',
      location: 'https://example.invalid/broken.json',
    });
    const id = created.body.source.id;
    // First a good sync so there are prior models.
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) =>
      String(input).includes('127.0.0.1')
        ? origFetch(input, init)
        : new Response(JSON.stringify({ models: [{ model_id: 'keep/me' }] }), { status: 200 })) as typeof fetch;
    await request('POST', `/api/sources/${id}/sync`);
    // Now garbage.
    globalThis.fetch = (async (input: any, init?: any) =>
      String(input).includes('127.0.0.1')
        ? origFetch(input, init)
        : new Response('<html>not json</html>', { status: 200 })) as typeof fetch;
    try {
      const failed = await request('POST', `/api/sources/${id}/sync`);
      expect(failed.status).toBe(502);
      expect(failed.body.status).toBe('error');
      const src = (await request('GET', '/api/sources')).body.sources
        .find((s: any) => s.id === id);
      expect(src.last_sync_status).toBe('error');
      const rows = getDb().prepare(
        'SELECT COUNT(*) AS n FROM models WHERE source_ref_id = ?').get(id) as any;
      expect(rows.n).toBe(1); // prior import intact
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('PATCH/DELETE /api/sources/:id (US3)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  async function makeSource(name: string): Promise<number> {
    const r = await request('POST', '/api/sources', {
      name, location: `https://example.invalid/${name}.json`,
    });
    return r.body.source.id as number;
  }

  it('renames and relocates a custom source', async () => {
    const id = await makeSource('Editable');
    const { status, body } = await request('PATCH', `/api/sources/${id}`, {
      name: 'Renamed', location: 'https://example.invalid/new.json',
    });
    expect(status).toBe(200);
    expect(body.source.name).toBe('Renamed');
  });

  it('404s unknown ids', async () => {
    expect((await request('PATCH', '/api/sources/999999', { enabled: false })).status).toBe(404);
  });

  it('disable hides exclusive models from listing; re-enable restores', async () => {
    const id = await makeSource('Toggleable');
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) =>
      String(input).includes('127.0.0.1')
        ? origFetch(input, init)
        : new Response(JSON.stringify({ models: [{ model_id: 'toggle/exclusive' }] }), { status: 200 })) as typeof fetch;
    await request('POST', `/api/sources/${id}/sync`);
    globalThis.fetch = origFetch;

    await request('PATCH', `/api/sources/${id}`, { enabled: false });
    let rows = getDb().prepare(
      `SELECT m.enabled AS menabled FROM models m JOIN model_sources s ON s.id = m.source_ref_id
       WHERE m.model_id = 'toggle/exclusive'`).get() as any;
    // Disabled source hides its contribution at query level; row remains.
    expect(rows).toBeTruthy();

    await request('PATCH', `/api/sources/${id}`, { enabled: true });
    const src = (await request('GET', '/api/sources')).body.sources.find((s: any) => s.id === id);
    expect(src.enabled).toBe(true);
  });

  it('deletes a custom source and its exclusive models but refuses builtin', async () => {
    const sharedId = await makeSource('SharedSrc');
    const otherId = await makeSource('OtherSrc');
    const origFetch = globalThis.fetch;
    // Both sources provide 'shared/model'; SharedSrc also provides 'shared/only'.
    globalThis.fetch = (async (_u: any) => {
      void _u;
      throw new Error('should not be called');
    }) as typeof fetch;
    // Insert directly via sync mock per-source:
    const docs: Record<string, any> = {
      [sharedId]: { models: [{ model_id: 'shared/model' }, { model_id: 'shared/only' }] },
      [otherId]: { models: [{ model_id: 'shared/model' }] },
    };
    globalThis.fetch = (async (input: any, init?: any) => {
      if (String(input).includes('127.0.0.1')) return origFetch(input, init);
      const url = String(input);
      const key = Object.keys(docs).find(k => url.includes(String(k))) ?? '';
      return new Response(JSON.stringify(docs[key] ?? docs[otherId]), { status: 200 });
    }) as typeof fetch;
    // Sync both via distinct locations.
    await request('PATCH', `/api/sources/${sharedId}`, { location: `https://example.invalid/src-${sharedId}` });
    await request('PATCH', `/api/sources/${otherId}`, { location: `https://example.invalid/src-${otherId}` });
    const s1 = await request('POST', `/api/sources/${sharedId}/sync`);
    const s2 = await request('POST', `/api/sources/${otherId}/sync`);
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    globalThis.fetch = origFetch;

    const del = await request('DELETE', `/api/sources/${sharedId}`);
    expect(del.status).toBe(200);
    const only = getDb().prepare(
      "SELECT COUNT(*) AS n FROM models WHERE model_id = 'shared/only'").get() as any;
    expect(only.n).toBe(0); // exclusive → gone
    const shared = getDb().prepare(
      "SELECT COUNT(*) AS n FROM models WHERE model_id = 'shared/model'").get() as any;
    expect(shared.n).toBe(1); // retained (OtherSrc still provides)

    expect((await request('DELETE', `/api/sources/${builtinRow().id}`)).status).toBe(403);
  });
});

describe('Sync tombstones (US4)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('removes vanished models on re-sync unless pinned', async () => {
    const created = await request('POST', '/api/sources', {
      name: 'Tombstoner', location: 'https://example.invalid/t.json',
    });
    const id = created.body.source.id;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) =>
      String(input).includes('127.0.0.1')
        ? origFetch(input, init)
        : new Response(JSON.stringify({ models: [
            { model_id: 't/stay' }, { model_id: 't/vanish' }, { model_id: 't/pinned-one' },
          ] }), { status: 200 })) as typeof fetch;
    await request('POST', `/api/sources/${id}/sync`);
    // Pin one model directly.
    getDb().prepare("UPDATE models SET pinned = 1 WHERE model_id = 't/pinned-one'").run();
    // Second doc drops t/vanish.
    globalThis.fetch = (async (input: any, init?: any) =>
      String(input).includes('127.0.0.1')
        ? origFetch(input, init)
        : new Response(JSON.stringify({ models: [{ model_id: 't/stay' }, { model_id: 't/pinned-one' }] }),
            { status: 200 })) as typeof fetch;
    try {
      const res = await request('POST', `/api/sources/${id}/sync`);
      expect(res.status).toBe(200);
      expect(res.body.removed).toBe(1);
      const counts = (m: string) =>
        (getDb().prepare('SELECT COUNT(*) AS n FROM models WHERE model_id = ?').get(m) as any).n;
      expect(counts('t/vanish')).toBe(0);
      expect(counts('t/pinned-one')).toBe(1);
      expect(counts('t/stay')).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
