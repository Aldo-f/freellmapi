# FR Convergence Checklist — 002-model-curation-layer

Verified 2026-08-24 against the live instance `http://192.168.0.5:3001`
(container `02-ai-freellmapi-freellmapi-1`, image `freellmapi:local-002`,
restart policy `unless-stopped`) plus the ARM test suite.

| FR | Requirement | Evidence | Status |
|---|---|---|---|
| FR-001 | kind='catalog' source via /api/sources + UI | POST /api/sources `{kind:'catalog'}` → 201, view shows kind+active_list_id (unit test + live create of "models.dev" source) | ✅ |
| FR-002 | catalog sync parses models.dev shape through existing pipeline | Live sync: `{"status":"ok","imported":7031,"duplicates_skipped":97}` in 2.1 s; unit tests vs fixture | ✅ |
| FR-003 | per-model metadata persisted | model_metadata rows = 7031 after sync (= imported count); spot-checked costs/limits/flags/modalities/open_weights in unit tests; NULL for unknown fields | ✅ |
| FR-004 | url sources unchanged | sources.test.ts suite green (18 tests); curation predicate only activates on kind='catalog' with a list | ✅ |
| FR-005 | /curate filter builder + sort/search + live preview | CuratePage.tsx (builder with match-count preview via POST /api/curated-lists/preview); page serves HTTP 200 live; vite build clean | ✅ |
| FR-006 | builtin list catalog, one-click apply, overrides incl. on builtins | GET /api/curated-lists showed 5 seeded builtins with live counts (402 free&tools etc.); PATCH active_list_id applied list 1 to source 2 live; PUT override accepted on builtin list | ✅ |
| FR-007 | curated selection drives merged listing; 001 rules intact | Live: 2086 total → apply Free & Tool-capable → 382; exclude one model → 381 and absent from /v1/models; clear override → 382; disable source → 210 (all catalog models gone); delete → 210 with metadata cascade | ✅ |
| FR-008 | admin auth on new routes | curatedListsRouter mounted behind requireAuth in app.ts (401 without token observed pre-session) | ✅ |
| FR-009 | fetch guards sized for the real doc; failure isolation | CATALOG caps 20 MB / 25k models (live doc ~4 MB / ~7k models synced fine); failure-path unit tests green | ✅ |
| FR-010 | no new npm deps | package.json unchanged (git diff shows no dependency edits) | ✅ |

## Success criteria

- **SC-001** sync within timeout budget, ≥90% import: 7031 imported in 2.1 s ✅
- **SC-002** filtered subset spot-check: Free & Tool-capable = 402 matches from
  7031 (plausible subset; per-row criteria verified in unit tests) ✅
- **SC-003** exclusion reflected on next request <1 s: verified (0.89 s round trip) ✅
- **SC-004** `npm test` on ARM: 2609 passed / 2 failed — both failures are the
  two pre-existing compression timing flakes (`compression.test.ts`
  performance assertions), explicitly tolerated by the spec ✅

## Cleanup performed after verification

- Test catalog source deleted (7031 models cascaded away).
- Temporary verification session removed from the sessions table.
