# Contracts: Curation API (002)

All routes under existing `/api/sources` admin-auth middleware (same as 001).
Additive only — no existing route changes shape except documented additions.

## Modified: POST /api/sources

Request gains optional `kind`:

```json
{ "name": "models.dev", "location": "https://models.dev/api.json", "kind": "catalog" }
```

- `kind` absent ⇒ `'url'` (back-compat).
- `kind: 'catalog'` accepted; validation identical (http(s) URL, name rules).
- 201 body: source view incl. new `filter_criteria: null`.

## Modified: PATCH /api/sources/:id

Gains optional `filter_criteria` (object or null). Server validates the known
keys (`free_only`, `min_context`, `tool_call`, `input_image`, `open_weights`)
and stores JSON. Unknown keys → 400. Takes effect on the merged listing
immediately (no re-sync needed).

## New: GET /api/sources/:id/models

Paged catalog-model browser for the curation UI.

```
GET /api/sources/:id/models?search=gemini&included=all&page=1&per_page=50
```

- Only valid for kind='catalog' (else 400).
- Each row: `{ platform, model_id, display_name, curated_in,
  override: 'include'|'exclude'|null, metadata: {...}|null }`
- `curated_in` = effective decision (override wins over filter).
- `included` filter param: `all | in | out`.
- `metadata` mirrors `model_metadata` columns.
- 404 unknown source; auth required.

## New: PUT /api/sources/:id/curate

Set/clear a per-model override.

```json
{ "platform": "anthropic", "model_id": "claude-opus-5", "decision": "exclude" }
```

`decision: null` clears the override row (falls back to filter). Returns the
updated effective state for that model. 404 unknown source; 400 bad payload;
auth required.

## Unchanged behavior contracts

- `POST /api/sources/:id/sync` on a catalog source runs the models.dev parser
  and imports metadata; same SyncResult envelope + failure semantics as url
  sources.
- Merged listings (`/v1/models`, Anthropic/Gemini/MCP/Ollama variants,
  dashboard `/api/models`) reflect curation with zero wire-format changes —
  only membership changes.
