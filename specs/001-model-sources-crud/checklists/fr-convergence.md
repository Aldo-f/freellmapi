# FR-by-FR Convergence Check: 001-model-sources-crud

**Verified against**: live container `freellmapi:local-001` at `http://192.168.0.5:3001`, 2026-08-23.

| FR | Requirement | Evidence | Status |
|---|---|---|---|
| FR-1 | Display sources w/ name, location, enabled, last-sync time + outcome | `GET /api/sources` returns all fields; dashboard /sources renders them (live curl) | ✅ |
| FR-2 | Non-deletable builtin source (disable allowed) | DELETE builtin → 403 "cannot be deleted"; seeded exactly once (migration test) | ✅ |
| FR-3 | Add custom source (name + URL) | POST → 201 with status "never" (live) | ✅ |
| FR-4 | Validate source URL, surface failures on entry | bad name/URL → 400; dead URL sync → 502 + source marked error w/ message (live) | ✅ |
| FR-5 | Edit name/URL; toggle enabled/disabled | PATCH rename/relocate 200; disable hides + re-enable restores models in /v1/models (live) | ✅ |
| FR-6 | Delete custom sources; exclusive models removed, shared retained | DELETE 200 removes exclusive rows; shared-model re-own covered by unit test + FK-safe cleanup | ✅ |
| FR-7 | Manual sync per source (auto-schedule deferred per spec MAY) | POST /api/sources/:id/sync imports/tombstones (live); scheduler intentionally deferred to step-two project | ✅ |
| FR-8 | Merged listing = union of enabled sources − disabled/deleted | disable hides only that source's models from /v1/models (live); unify-mode groups also filtered | ✅ |
| FR-9 | All management ops require admin auth | route mounted under requireAuth; unauthenticated GET /api/sources → 401 (live) | ✅ |

## Bonus (US4 refinement)
- **Pinned protection**: PATCH `{pinned}` toggles all of a source's imported models; pinned rows survive empty-doc syncs (live + unit tested). Dashboard pin/unpin button with count badge.
