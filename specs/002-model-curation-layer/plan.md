# Implementation Plan: Model Curation Layer (002)

**Branch**: `002-model-curation-layer` | **Spec**: [spec.md](spec.md) | **Created**: 2026-08-24

## Technical Context

- **Language/Stack**: TypeScript (Node 24), better-sqlite3 sync SQLite
  (`server/src/db/`), Express-style routes (`server/src/routes/`), vitest
  workspaces. Client: Vite SPA, new page at `/curate`.
- **Deployment**: Docker on Pi 5 (ARM). Verify against the REAL running
  instance `http://192.168.0.5:3001`: `docker build -t freellmapi:local-002 .`
  + `docker compose up -d --force-recreate`; restart policy unless-stopped;
  `.env` preserved.
- **Groundwork (001, merged on this branch's history)**: `model_sources`
  table + CRUD routes `/api/sources`, `source-fetch.ts`, `syncSource()`
  (dedupe/tombstone/pin), `models.source_ref_id/pinned`,
  `buildModelListing()` source-visible clause in `server/src/services/model-listing.ts`
  (single choke point behind ALL listing endpoints), dashboard `/sources`.

## Constitution Check

| Principle | Status | Notes |
|---|---|---|
| I. Test-First | ✅ | RED→GREEN per task; contract tests spin real app on 127.0.0.1 |
| II. Real-Runtime Verification | ✅ | Converge = rebuild image, live curl of /api/sources*, /curate, /v1/models |
| III. Upstream Compatibility | ✅ | Additive: widen CHECK, two new tables, new columns, one extra visibility clause; no rewrites |
| IV. Security & Secret Hygiene | ✅ | Catalog fetched server-side; caps enforced; admin auth reused; no secrets involved |
| V. Simplicity / YAGNI | ✅ | No new npm deps (fetch + better-sqlite3 + React already present); keyless-freeness probing explicitly out of scope |

## Design Decisions

- **D1 — kind='catalog', reuse the sync path.** Widen `model_sources.kind`
  CHECK to include 'catalog'. `syncSource()` branches only on the document
  parser: catalog sources parse models.dev api.json shape and additionally
  write metadata rows. Dedupe/tombstone/pin/status logic untouched.
- **D2 — separate `model_metadata` table** (not columns on `models`). Keeps
  the hot catalog table narrow, cascades with tombstones via FK, and NULLable
  columns cleanly express "unknown". One row per model, PK = model_db_id.
- **D3 — filter stored as JSON on `model_sources.filter_criteria`**, evaluated
  in SQL as part of the listing query so curation costs one subquery per
  catalog-sourced row. Override rows in `curation_overrides` win over filter.
- **D4 — visibility enforced inside `buildModelListing()`'s
  `sourceVisibleExpr`.** Every consumer (/v1/models OpenAI+Anthropic, Gemini,
  MCP, Ollama, dashboard /api/models) inherits curation automatically —
  matches the "other app just fetches the model list" goal with zero new API
  surface for clients.
- **D5 — unknown cost ⇒ NOT free** (clarified). Keyless-endpoint probing to
  prove freeness: out of scope, noted as future refinement.
- **D6 — default curated-in**: newly imported models are exposed until filtered
  or excluded (mirrors models.dev showing everything).
- **D7 — platform = provider slug verbatim.** models.dev slugs that don't map
  to existing platforms become new platform entries; no forced mapping table
  in v1.
- **D8 — UI: dedicated `/curate` page** (`client/src/pages/CuratePage.tsx`),
  server-side paging/search via GET /api/sources/:id/models (thousands of rows
  never enter client state raw).

## Clarify decisions (2026-08-24)

1. Unknown/absent cost → treated as NOT free by free_only.
2. Default state of imported models → all included (like models.dev).
3. Curation UI → dedicated page in dashboard pages folder (`client/src/pages/`),
   route `/curate`.

## Risks / notes

- 4 MB document vs 5 MB url cap → catalog cap raised to 20 MB (D1 constants).
- ~10k+ inserts per sync → single transaction upsert (pattern already used);
  verify sync duration on Pi 5 during convergence.
- Listing SQL grows one correlated EXISTS over metadata/overrides — measure
  /v1/models latency before/after in convergence.

## Phases

- Phase 0 research: done (models.dev shape verified live; 001 code read).
- Phase 1 design: data-model.md, contracts/curation-api.md, quickstart.md (this dir).
- Implementation order: migration → parser+metadata writer → filter/override
  evaluation in listing → API routes → CuratePage → converge on live container.
