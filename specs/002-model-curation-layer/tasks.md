# Tasks: Model Curation Layer (002)

**Input**: Design documents from `specs/002-model-curation-layer/`
**Prerequisites**: spec.md, plan.md, data-model.md, contracts/curation-api.md, quickstart.md
**Tests**: INCLUDED — constitution Principle I mandates test-first (RED→GREEN).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no deps)
- **[Story]**: US1 catalog sync · US2 metadata · US3 curated lists · US4 curated /v1/models

---

## Phase 1: Setup

- [ ] T001 Fixture `specs/002-model-curation-layer/fixtures/modelsdev-small.json`: miniature models.dev api.json (3 providers × 2–4 models) covering: zero-cost model, paid model, unknown-cost model, image input, open_weights true/false, tool_call true/false, reasoning true/false, missing limit/cost fields. All tests use this — never the live doc.

## Phase 2: Foundational (blocks all stories)

- [ ] T002 Migration `server/src/db/migrations/<next>_model_curation.ts` (verify next free number vs defaults.ts): widen `model_sources.kind` CHECK to 'builtin'|'url'|'catalog'; add `model_sources.active_list_id`; create `curation_lists` (+ seed 5 builtin lists) and `curation_overrides` per data-model.md. Register in `defaults.ts` + every migration-list test.
- [ ] T003 [P] Failing migration test `server/src/__tests__/db/curation_migration.test.ts`: kind CHECK accepts 'catalog'; tables/columns exist; 5 builtin lists seeded exactly once across re-runs; FK cascades (list delete → overrides gone; model delete → metadata gone). RED → GREEN.

**Checkpoint**: schema ready.

## Phase 3: US1+US2 — Catalog sync imports models + metadata (P1) 🎯 MVP

- [ ] T004 [US1/US2] Contract tests in new `server/src/__tests__/routes/curation.test.ts` (RED first; use 001's fetch-mock passthrough pattern):
  - POST /api/sources kind='catalog' → 201 with active_list_id:null; kind absent → 'url'.
  - Sync catalog source vs fixture server: ok counts; imported models carry metadata matching fixture values; unknown fields stored NULL not fabricated.
  - Sync failure (fixture 500): source marked error, prior imports intact.
  - Re-sync after fixture edit: new model appears, removed tombstoned unless pinned, metadata updated.
  - GET /api/sources/:id/models on non-catalog source → 400.
- [ ] T005 [US1/US2] Extend `source-fetch.ts`: catalog parser for `{slug:{models:{...}}}` shape producing entries + raw metadata; export CATALOG_MAX_BODY_BYTES=20MB / CATALOG_MAX_MODELS=25000; url path unchanged.
- [ ] T006 [US1/US2] Extend `model-sources.ts`: accept kind='catalog' in create/update; syncSource branches to catalog parser + upserts model_metadata in same transaction.
- [ ] T007 [US1/US2] Route changes in `routes/sources.ts`: kind on POST; GET /api/sources/:id/models (paging+search+included filter, effective curated_in + metadata).
- [ ] T008 [US1] Dashboard `/sources`: add-catalog-source affordance (kind selector); link to /curate for catalog sources.

**Checkpoint**: add models.dev → live sync → models + metadata queryable.

## Phase 4: US3 — Curated lists service + API (P2)

- [ ] T009 [US3] Service `server/src/services/curation-lists.ts` + contract tests (RED first): CRUD custom lists (validation per contract), builtin immutable (403 on PATCH/DELETE), list match_count evaluation against model_metadata criteria, override set/clear incl. on builtin lists, preview endpoint (unsaved criteria → count + ≤20 sample rows), sort keys price/context/name in list-models query.
- [ ] T010 [P] [US3] Routes `server/src/routes/curated-lists.ts`: GET/POST/PATCH/DELETE /api/curated-lists, PUT .../:id/models, POST /api/curated-lists/preview, GET .../:id/models (sort/search/paging). Admin auth.
- [ ] T011 [US4] Listing integration tests first (RED): source with active list → only matching models in buildModelListing(); override include resurrects non-matching; override exclude hides matching; no active list ⇒ all included; disabling source hides everything (001 rule); url sources unaffected; NEW sync adds a matching model → appears without touching the list (live membership).
- [ ] T012 [US4] Implement curation predicate inside `model-listing.ts` visibility expression (override EXISTS wins over static-criteria evaluation against model_metadata); consistent across unify/dedupe paths.

**Checkpoint**: apply builtin "Free & Tool-capable" → merged listing shrinks to matches; exclude one → reflected next request.

## Phase 5: US3 — Curate UI (P2)

- [ ] T013 [US3] Dashboard `client/src/pages/CuratePage.tsx` at `/curate`: list catalog (built-in + mine, with match counts), apply-to-source picker, list builder form (criteria inputs + LIVE match-count preview via /preview before save), paged model browser (search box, included tabs, sort by price/context/name, include/exclude buttons showing effective badge).
- [ ] T014 [US3] Register `/curate` route + nav entry; PATCH /api/sources/:id active_list_id wiring from CuratePage.

**Checkpoint**: apply/edit/toggle flows persist across reload AND server restart.

## Phase 6: Convergence & release

- [ ] T015 Full `npm test` green on ARM (only the 2 known compression flakes tolerated); capture evidence. Track progress on kanban via `hermes kanban` CLI throughout implementation.
- [ ] T016 Real-runtime convergence per quickstart.md: `docker build -t freellmapi:local-002 .`, `docker compose up -d --force-recreate`; live curls at http://192.168.0.5:3001: create catalog source → sync LIVE models.dev → metadata count → apply builtin list → /v1/models shrink → exclude → membership check → disable source check. Record HTTP codes + counts.
- [ ] T017 FR-by-FR cross-check checklist vs spec.md; commit; push branch when green.
