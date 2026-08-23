# Tasks: Model Sources CRUD

**Input**: Design documents from `specs/001-model-sources-crud/`
**Prerequisites**: plan.md, spec.md, data-model.md, contracts/sources-api.md, quickstart.md
**Tests**: INCLUDED — constitution Principle I mandates test-first (RED→GREEN).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no deps)
- **[Story]**: US1 view sources · US2 add+sync · US3 edit/disable/delete · US4 tombstones

---

## Phase 1: Setup

- [ ] T001 Create feature branch `001-model-sources-crud` from main and fixture file `specs/001-model-sources-crud/fixtures/models.json` (custom-format doc with 2 models, incl. one OpenAI-style variant fixture `models-openai.json`)

## Phase 2: Foundational (blocks all stories)

- [ ] T002 Create migration `server/src/db/migrations/20260823_000004_model_sources.ts`: create `model_sources` table + seed builtin row; add `source_ref_id` and `pinned` columns to `models` (idempotent, reversible per existing migration style)
- [ ] T003 [P] Write failing migration test in `server/src/__tests__/db/model_sources_migration.test.ts` (table exists, builtin seeded exactly once, columns added) — capture RED before T002 lands, GREEN after

**Checkpoint**: schema ready.

## Phase 3: US1 — View model sources (P1) 🎯 MVP

**Goal**: list sources with status; builtin visible.
**Independent Test**: GET /api/sources returns the builtin source without any custom config.

- [ ] T004 [P] [US1] Contract test GET /api/sources in `server/src/__tests__/routes/sources.test.ts` (RED first)
- [ ] T005 [US1] Implement source listing service in `server/src/services/model-sources.ts` (`listSources()` with model_count)
- [ ] T006 [US1] Implement route `GET /api/sources` in new `server/src/routes/sources.ts`, registered in server app setup with admin-auth middleware (same as settings routes)
- [ ] T007 [US1] Dashboard page `/sources`: add sources view to client SPA (list name/kind/enabled/last-sync/status/model_count), route entry so it serves at `/sources`

**Checkpoint**: live container shows builtin source on /sources page and API.

## Phase 4: US2 — Add a custom source + sync now (P1)

**Goal**: register URL source, manual sync imports its models into merged catalog.
**Independent Test**: POST source → sync → models appear attributed to source.

- [ ] T008 [P] [US2] Contract tests POST /api/sources + POST /api/sources/:id/sync in `sources.test.ts` (RED first): valid create 201, invalid URL/name 400, duplicate name 409, sync ok counts, sync fetch-fail → 502 body + source marked error, previously imported models intact
- [ ] T009 [US2] Implement fetch/parse service in `server/src/services/source-fetch.ts`: 15s timeout, 5 MB cap, max 5000 models, accepts `{"models":[...]}` and OpenAI-style `{"data":[{"id":...}]}`, maps to normalized entries
- [ ] T010 [US2] Implement `createSource()`, `syncSource()` in `server/src/services/model-sources.ts`: upsert rows with `source_ref_id`, first-enabled-source-wins dedupe against UNIQUE(platform, model_id), update last_synced_at/status/error
- [ ] T011 [US2] Wire POST /api/sources and POST /api/sources/:id/sync handlers in `server/src/routes/sources.ts`
- [ ] T012 [US2] Dashboard: "Add source" form (name + URL) and per-source "Sync now" button on /sources page
- [ ] T013 [US2] Ensure merged listing: enabled-source models included in `/v1/models` output path (extend model query used by routes/models.ts via `source_ref_id` join, additive only)

**Checkpoint**: add→sync→visible end-to-end against live instance with fixtures.

## Phase 5: US3 — Edit, disable, delete (P2)

**Goal**: full lifecycle control.
**Independent Test**: disabling a synced source hides only its exclusive models from /v1/models.

- [ ] T014 [P] [US3] Contract tests PATCH/DELETE in `sources.test.ts` (RED first): rename/relocate 200, unknown id 404, disable hides exclusive models & re-enable restores, delete removes source + exclusively-owned models but retains shared ones, DELETE builtin → 403
- [ ] T015 [US3] Implement `updateSource()`, `deleteSource()` (with exclusive-model cleanup) in `server/src/services/model-sources.ts`
- [ ] T016 [US3] Wire PATCH/DELETE /api/sources/:id in `server/src/routes/sources.ts`
- [ ] T017 [US3] Dashboard: inline edit (name/URL), enable/disable toggle, delete-with-confirm on /sources page

**Checkpoint**: lifecycle verified live (disable → absent from /v1/models → re-enable → present).

## Phase 6: US4 — Sync tombstones (P3)

**Goal**: re-sync removes upstream-gone models unless pinned.
**Independent Test**: second sync missing one model drops it; pinned model survives.

- [ ] T018 [P] [US4] Contract tests in `sources.test.ts` (RED first): sync removing vanished model, pinned model retained, last_synced_at updated each sync
- [ ] T019 [US4] Implement tombstone logic in `syncSource()` (delete non-pinned rows owned by source absent from latest doc) + `pinned` toggle support (PATCH field or dedicated endpoint) in `server/src/services/model-sources.ts`
- [ ] T020 [US4] Dashboard: pin/unpin control per imported model on source detail

**Checkpoint**: full spec covered.

## Phase 7: Polish & Convergence

- [ ] T021 Run full suite `npm test`; fix any regressions except the known ARM compression timing flake
- [ ] T022 Rebuild container (`docker compose build && up -d`) and execute quickstart.md live verification end-to-end; capture curl outputs as convergence evidence
- [ ] T023 Cross-check every FR in spec.md against observed behavior (FR-by-FR table); commit feature + push branch

## Dependencies & Execution Order

T002→T003(GREEN) block everything. US1 → US2 (add builds on list) → US3 (lifecycle on existing rows) → US4 (tombstone refines sync). Within stories: tests RED → service → route → UI. T021–T023 last.

## Parallel Opportunities

T003/T004/T008/T014/T018 test-writing can be drafted while prior-phase impl proceeds; T009 is parallel to T005; dashboard tasks (T007/T012/T017/T020) parallel to their API counterparts once contracts are fixed.

## Implementation Strategy

MVP = Phases 1–4 (view + add + sync). Validate live after each checkpoint. Single-developer sequential order = task-ID order.

## Notes

- Known flake: compression wall-clock timing test on ARM — not a regression signal.
- After code changes rebuild the Docker image; playbook alone reuses stale image.
