# Data Model: Model Sources CRUD

## Entity: model_sources (new table)

| Column | Type | Constraints |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| name | TEXT NOT NULL | unique, non-empty |
| kind | TEXT NOT NULL CHECK(kind IN ('builtin','url')) | exactly one 'builtin' row, seeded by migration |
| location | TEXT NOT NULL DEFAULT '' | URL for kind='url' |
| enabled | INTEGER NOT NULL DEFAULT 1 | 0/1 |
| last_synced_at | TEXT | ISO timestamp or NULL = never |
| last_sync_status | TEXT NOT NULL DEFAULT 'never' | 'ok' \| 'error' \| 'never' |
| last_error | TEXT | nullable |
| created_at | TEXT NOT NULL DEFAULT (datetime('now')) | |

Validation rules: name 1–100 chars; location must be http(s) URL when kind='url'; builtin row cannot be deleted (may be disabled).

## Change: models table

- Add column `source_ref_id INTEGER REFERENCES model_sources(id)` — NULL means built-in catalog / legacy rows.
- Add column `pinned INTEGER NOT NULL DEFAULT 0` — protects from tombstone removal.
- UNIQUE(platform, model_id) unchanged; on conflict between two enabled sources the first-by-priority source wins and the loser's contribution is recorded as duplicate (not inserted twice).

## State transitions (a source)

```
created(never) ──sync ok──► ok ──sync fail──► error ──sync ok──► ok
      │                        │
      └──sync fail──► error    └─disable→ disabled (models hidden) ─enable→ previous state
delete: allowed only if kind='url'; removes source + models where source_ref_id=source AND no other enabled source provides same model_id
```

## Sync semantics (per source)

1. Fetch `location` (timeout 15s, cap 5 MB), parse JSON.
2. Accept either `{"models":[...]}` or OpenAI-style `{"data":[{"id":...}]}`; map to `{model_id, display_name, context_window?, supports_vision?}`.
3. Upsert rows with `source_ref_id = source.id`; ids absent upstream → delete unless `pinned=1` (tombstone semantics per #926).
4. Update last_synced_at/status/error.
