# Tasks: Model Curation Layer (002)

**Input**: Design documents from `specs/002-model-curation-layer/`
**Prerequisites**: spec.md, plan.md, data-model.md, contracts/curation-api.md, quickstart.md
**Tests**: INCLUDED — constitution Principle I mandates test-first (RED→GREEN).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no deps)
- **[Story]**: US1 catalog sync · US2 metadata · US3 filter builder · US4 curated /v1/models

---

## Phase 1: Setup

- [ ] T001 Create fixture `specs/002-model-curation-layer/fixtures/modelsdev-small.json` — a miniature models.dev api.json (3 providers × 2–3 models) covering: free model with zero cost, paid model, unknown-cost model, image-input modalities, open_weights true/false, tool_call true/false, missing limit/cost fields. Used by all tests (never hit the live doc in unit tests).

## Phase 2: Foundational (blocks all stories)

- [ ] T002 Migration `server/src/db/migrations/20260823_000005_model_curation.ts` (next free number — verify against defaults.ts at write time): widen `model_sources.kind` CHECK to include 'catalog'; add `model_sources.filter_criteria TEXT`; create `model_metadata` + `curation_overrides` per data-model.md (idempotent + reversible in existing style). Register in `defaults.ts` and every migration-list test.
- [ ] T003 [P] Failing migration test `server/src/__tests__/db/curation_migration.test.ts`: kind CHECK accepts 'catalog' & rejects garbage; tables/columns exist; FK cascade deletes metadata+overrides with their rows. Capture RED → GREEN.

**Checkpoint**: schema ready.

## Phase 3: US1+US2 — Catalog source sync imports models + metadata (P1) 🎯 MVP

- [ ] T004 [US1/US2] Contract tests in new `server/src/__tests__/routes/curation.test.ts` (RED first), using the 001 fetch-mock passthrough pattern (`127.0.0.1` → real fetch):
  - POST /api/sources with kind='catalog' → 201, view includes kind + filter_criteria:null; kind absent → 'url'.
  - POST /api/sources/:id/sync on catalog source against fixture server: ok counts; imported models carry metadata rows matching fixture values (spot-check cost/limits/tool_call/modalities/open_weights); unknown fields stored NULL not fabricated.
  - Sync failure (fixture 500): source marked error, prior imports intact.
  - Repeat sync after fixture edit: new model appears, removed model tombstoned unless pinned, curation overrides for surviving models preserved.
  - GET /api/sources/:id/models on a non-catalog source → 400.
- [ ] T005 [US1/US2] Extend `server/src/services/source-fetch.ts`: catalog document parser (`{slug:{models:{...}}}` shape) producing entries + raw metadata; export separate caps CATALOG_MAX_BODY_BYTES=20MB / CATALOG_MAX_MODELS=25000; url path unchanged (existing tests keep passing).
- [ ] T006 [US1/US2] Extend `server/src/services/model-sources.ts`: accept kind='catalog' in createSource/updateSource; branch syncSource to the catalog parser and upsert `model_metadata` in the same transaction; preserve override rows across re-syncs; deleteSource cascades (FK).
- [ ] T007 [US1/US2] Wire route changes in `server/src/routes/sources.ts`: kind on POST; GET /api/sources/:id/models (paging + search + included=in|out|all, returns effective curated_in + override + metadata).
- [ ] T008 [US1] Dashboard `/sources` page: "Add catalog source" affordance (kind selector) + metadata count shown for catalog sources.

**Checkpoint**: add models.dev → sync → models + metadata queryable via API.

## Phase 4: US4 — Curated selection drives merged listing (P2)

- [ ] T009 [US4] Tests first (RED): extend listing tests — catalog model failing an empty-but-set filter is ABSENT from buildModelListing(); passing one present; explicit exclude hides a filter-passing model; explicit include resurrects a filter-failing one; disabling the catalog source hides everything regardless of curation (001 rule intact); url-source models unaffected.
- [ ] T010 [US4] Implement curation predicate in `server/src/services/model-listing.ts`: extend `sourceVisibleExpr` with the catalog clause (override EXISTS wins over filter evaluation against model_metadata); keep unify + dedupe paths consistent (both read the same visibility expression).
- [ ] T011 [P] [US4] PUT /api/sources/:id/curate route + service (set/clear override, validation per contract, returns effective state); contract tests in curation.test.ts.

**Checkpoint**: exclude a model → next /v1/models request omits it; re-include restores.

## Phase 5: US3 — Filter builder UI (P2)

- [ ] T006b [US3] PATCH /api/sources/:id gains filter_criteria validation/storage (known keys only, else 400) — contract test RED→GREEN alongside T010/T011 wiring.
- [ ] T012 [US3] Dashboard page `client/src/pages/CuratePage.tsx` at `/curate`: source picker → filter builder (free-only toggle, min-context number input, tool_call/image/open_weights toggles) saving via PATCH → paged model table (search box, included=in/out/all tabs) with per-row include/exclude buttons hitting PUT curate; effective state badge per row.
- [ ] T013 [US3] Register `/curate` route + nav entry; link from SourcesPage to CuratePage for catalog sources.

**Checkpoint**: filter + toggles persist across page reload (and server restart via DB).

## Phase 6: Convergence & release

- [ ] T014 Full `npm test` green on ARM (only the 2 known compression timing flakes tolerated); capture summary output as evidence.
- [ ] T015 Real-runtime convergence per quickstart.md: `docker build -t freellmapi:local-002 .`, `docker compose up -d --force-recreate`, live curls against http://192.168.0.5:3001 (catalog create → live models.dev sync → metadata count → filter shrink → exclude → /v1/models membership checks → disable-source check), record HTTP codes + counts.
- [ ] T016 FR-by-FR cross-check vs spec.md (checklist file like 001's fr-convergence.md); commit checklist.
- [ ] T017 Commit early/often throughout; final push of `002-model-curation-layer` when green.
