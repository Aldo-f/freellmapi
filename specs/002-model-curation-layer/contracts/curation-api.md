# Contracts: Curation API (002)

All routes under existing `/api/sources` admin-auth middleware (same as 001).
Additive only — no existing route changes shape except documented additions.

## Modified: POST /api/sources

Request gains optional `kind`:

```json
{ "name": "models.dev", "location": "https://models.dev/api.json", "kind": "catalog" }
```

- `kind` absent ⇒ `'url'` (back-compat). `kind: 'catalog'` accepted.
- 201 body: source view incl. `active_list_id: null`.

## Modified: PATCH /api/sources/:id

Gains optional `active_list_id` (number | null) — apply/clear the curated list
driving this catalog source. 400 if the list doesn't exist. Takes effect on
the merged listing immediately (no re-sync needed).

## Curated lists

### GET /api/curated-lists
List all: builtin + custom, each with `{id, name, description, is_builtin,
criteria, match_count}` (`match_count` = live count against current catalog).

### POST /api/curated-lists
Create custom list: `{name, description?, criteria}` → 201. Validation:
name 1–100 unique; criteria keys limited to
`free_only|max_cost_input|min_context|tool_call|input_image|open_weights`
(unknown key → 400).

### PATCH /api/curated-lists/:id
Edit custom list (name/description/criteria). Builtin → 403.

### DELETE /api/curated-lists/:id
Delete custom list (cascades overrides; sources referencing it get
`active_list_id` cleared). Builtin → 403.

### PUT /api/curated-lists/:id/models
Set/clear a per-model override on ANY list (builtin included):

```json
{ "platform": "anthropic", "model_id": "claude-opus-5", "decision": "exclude" }
```

`decision: null` clears the override. Returns effective state for that model.

### GET /api/curated-lists/:id/models?search=&included=in|out|all&sort=context|-context|price|-price|name&page=&per_page=
Paged model browser for a list: each row
`{ platform, model_id, display_name, curated_in,
override: 'include'|'exclude'|null, metadata }`. `curated_in` = override wins
over static criteria. Sort keys as listed; default `-context`.

### Preview
`POST /api/curated-lists/preview` with unsaved `{criteria}` →
`{ match_count, sample: [up to 20 rows] }` for the live builder preview.

## Unchanged behavior contracts

- `POST /api/sources/:id/sync` on catalog source: same envelope/failure
  semantics; imports metadata; membership of active list re-evaluated live —
  newly matching models join automatically.
- Merged listings (`/v1/models` all variants, dashboard `/api/models`) reflect
  curation via membership only — zero wire-format changes.
