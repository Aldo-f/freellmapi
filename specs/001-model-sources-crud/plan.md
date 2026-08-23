# Implementation Plan: Model Sources CRUD

**Branch**: `001-model-sources-crud` | **Spec**: [spec.md](spec.md) | **Created**: 2026-08-23

## Technical Context

- **Language/Stack**: TypeScript (Node 24), better-sqlite3-style sync SQLite via `server/src/db/`, Express-style routes in `server/src/routes/`, vitest (`npm test`, workspace `@freellmapi/server`). Client is a Vite SPA (served at `/sources` as a new dashboard page).
- **Deployment**: Docker on Pi 5 (ARM), compose on `traefik_net`; after code changes rebuild image (`docker compose build && up -d`) — playbook alone reuses stale image.
- **Existing building blocks (verified in repo)**:
  - `db/migrations/20260726_000003_model_source_provenance.ts` — `models.source` column ('catalog' | 'user') with delete-guard semantics.
  - `services/catalog-sync.ts` — signed upstream catalog sync with prune; the pattern to model multi-source sync on.
  - `services/custom-model-sync.ts` + `custom-model-register.ts` + `custom-model-tombstone.ts` — add-only endpoint model sync with tombstones.
  - Models table: `UNIQUE(platform, model_id)`.
- **Live instance**: `http://192.168.0.5:3001` (healthy), `/sources` currently serves SPA shell — will become the sources page.

## Constitution Check

| Principle | Status | Notes |
|---|---|---|
| I. Test-First | ✅ | Vitest RED→GREEN per task; tests exist before impl code |
| II. Real-Runtime Verification | ✅ | Converge = rebuild container, curl live `/api/sources*` + `/v1/models` |
| III. Upstream Compatibility | ✅ | Additive only: new table, new migration, new route file `routes/sources.ts`, no edits to catalog-sync internals beyond registration hooks |
| IV. Security & Secret Hygiene | ✅ | Source URLs fetched server-side with size cap + JSON schema validation; admin-auth middleware reused for CRUD |
| V. Simplicity / YAGNI | ✅ | v1: URL sources serving a JSON model list; manual sync-first (auto-schedule deferred); no new deps |

## Design Decisions (summary — details in research.md)

- **D1**: New `model_sources` table; models gain nullable `source_ref_id` FK. Built-in catalog remains source row kind='builtin' pointing at existing catalog-sync.
- **D2**: Source document format v1 = `{"models":[{"model_id","display_name",...}]}` OR a bare OpenAI-style `{"data":[{"id":...}]}` list — both accepted, schema-validated, ≤5 MB.
- **D3**: Sync per source is **replace-by-tombstone**: models exclusive to that source are removed when absent upstream unless pinned; shared model_ids resolve first-enabled-source-wins (existing UNIQUE constraint keeps one row).
- **D4**: New REST namespace `/api/sources` (+ `/api/sources/:id/sync`), dashboard page at `/sources`. Reuse admin auth middleware from existing settings routes.

## Phases

- **Phase 0** → research.md (done — all unknowns resolved above)
- **Phase 1** → data-model.md, contracts/sources-api.md, quickstart.md
- Implementation order: migration → service → route → tests (RED first) → dashboard page → converge against live instance.
