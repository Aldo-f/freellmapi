# API Contract: /api/sources

All endpoints require dashboard admin auth (same middleware as `/api/settings`).

## Endpoints

### GET /api/sources
List all sources.
```json
200 {"sources":[{"id":1,"name":"Built-in catalog","kind":"builtin","location":"","enabled":true,
      "last_synced_at":"2026-08-23T10:00:00Z","last_sync_status":"ok","last_error":null,
      "model_count":193}]}
```

### POST /api/sources
Add a custom source. Body: `{"name":"My list","location":"https://example.com/models.json"}`
- 201 → created source object (status "never")
- 400 invalid name/URL · 409 duplicate name

### PATCH /api/sources/:id
Edit name/location and/or toggle enabled: `{"enabled":false}` or `{"name":...,"location":...}`
- 200 updated · 404 unknown id

### DELETE /api/sources/:id
Delete a custom source (and its exclusively-owned models). Builtin → 403.

### POST /api/sources/:id/sync
Fetch + import now.
- 200 `{"status":"ok","imported":12,"removed":1,"duplicates_skipped":0,"last_synced_at":...}`
- 502 on fetch/parse failure with `{"status":"error","last_error":"..."}` (source row updated, HTTP still reports)

## Source document format (fetched from `location`)

Either:
```json
{"models":[{"model_id":"foo/bar","display_name":"Foo Bar","context_window":128000,"supports_vision":false}]}
```
or OpenAI-style:
```json
{"data":[{"id":"foo/bar"}]}
```
Caps: ≤5 MB, ≤15s timeout, max 5,000 models per document.

## Merged listing impact

`GET /v1/models` returns the union of: built-in catalog models ∪ every **enabled** source's models − disabled/deleted contributions. Disabled source ⇒ its exclusive models vanish from `/v1/models` until re-enabled.
