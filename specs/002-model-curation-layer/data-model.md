# Data Model: Model Curation Layer (002)

## Change: model_sources

- `kind` CHECK widened: `'builtin' | 'url' | 'catalog'`. Exactly one 'builtin'
  row (existing rule); many 'catalog' rows allowed; 'catalog' behaves like
  'url' for lifecycle (create/edit/delete/sync/status) but its sync uses the
  models.dev document parser and imports metadata.
- New column `active_list_id INTEGER REFERENCES curation_lists(id)` (nullable)
  — the curated list driving this source. NULL ⇒ no list applied. The old
  per-source filter_criteria idea is superseded by lists.
  ```jsonc
  {
    "free_only": false,        // cost.input==0 && cost.output==0 (unknown ⇒ NOT free)
    "min_context": 100000,     // limit.context >= N (null context fails this filter)
    "tool_call": true,         // capability flag must be true
    "input_image": false,      // modalities.input contains "image"
    "open_weights": true       // open_weights === true
  }
  ```
  Absent keys are not filtered on. Semantics: **include-if** — a model is
  curated-in iff it satisfies every set key, unless an override says otherwise.

## New table: model_metadata

| Column | Type | Notes |
|---|---|---|
| model_db_id | INTEGER PK REFERENCES models(id) ON DELETE CASCADE | one row max per model |
| cost_input | REAL | USD per Mtok; NULL = unknown |
| cost_output | REAL | USD per Mtok; NULL = unknown |
| context_limit | INTEGER | limit.context; NULL = unknown |
| output_limit | INTEGER | limit.output; NULL = unknown |
| tool_call | INTEGER | 0/1; NULL stored as NULL when absent upstream |
| structured_output | INTEGER | 0/1 or NULL |
| reasoning | INTEGER | 0/1 or NULL |
| modalities_input | TEXT NOT NULL DEFAULT '["text"]' | JSON array |
| modalities_output | TEXT NOT NULL DEFAULT '["text"]' | JSON array |
| open_weights | INTEGER | 0/1 or NULL |
| updated_at | TEXT NOT NULL | last catalog sync that touched it |

Written ONLY by catalog-source syncs. Rows cascade away with their model
(tombstone/delete). Non-catalog models simply have no row.

## New table: curation_lists

| Column | Type | Constraints |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| name | TEXT NOT NULL UNIQUE | 1–100 chars |
| description | TEXT NOT NULL DEFAULT '' | shown in the list catalog |
| criteria | TEXT NOT NULL DEFAULT '{}' | static filter JSON, shape below |
| is_builtin | INTEGER NOT NULL DEFAULT 0 | builtin rows are immutable, seeded by migration |
| created_at | TEXT NOT NULL DEFAULT (datetime('now')) | |

Criteria shape (same keys as before; absent keys not filtered on):
```jsonc
{
  "free_only": false,        // cost.input==0 && cost.output==0 (unknown ⇒ NOT free)
  "max_cost_input": 0.5,     // cost.input <= N (unknown cost fails)
  "min_context": 100000,     // limit.context >= N (null context fails)
  "tool_call": true,
  "input_image": false,      // modalities.input contains "image"
  "open_weights": true
}
```

Builtin seeds (criteria static forever; membership live):
`Free & Tool-capable` {free_only,tool_call} · `Vision chat` {input_image} ·
`Big-context reasoning ≥200k` {min_context:200000,reasoning:true} ·
`Open weights only` {open_weights} · `Budget <$0.50 in` {max_cost_input:0.5}.

## New table: curation_overrides

| Column | Type | Constraints |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| list_id | INTEGER NOT NULL REFERENCES curation_lists(id) ON DELETE CASCADE | per list |
| platform | TEXT NOT NULL | |
| model_id | TEXT NOT NULL | |
| decision | TEXT NOT NULL CHECK(decision IN ('include','exclude')) | wins over list criteria |

UNIQUE(list_id, platform, model_id). Deleting a list cascades its overrides.
Overrides on a builtin list are ALLOWED (stored separately from the immutable
definition) — admins can fine-tune a built-in without forking.

## Effective visibility (merged listing)

A model row participates in `buildModelListing()` iff ALL of:

1. existing rules: enabled + key availability + source enabled (001);
2. NEW: if its owner source is kind='catalog' with an active list, it is
   curated-in:
   - explicit override decision on that list, else
   - passes the list's static criteria evaluated against model_metadata
     (no active list ⇒ everything included).

Implemented as one extra EXISTS/NOT-EXISTS clause in `model-listing.ts`
(`sourceVisibleExpr`) so `/v1/models`, Anthropic `/v1/models`, Gemini, MCP,
Ollama listings and dashboard `/api/models` all inherit it.

## Catalog document → import mapping

```
doc[providerSlug].models[modelId] →
  platform   = providerSlug          (imported verbatim as a new platform;
                                      no forced mapping to the ~27 builtins)
  model_id   = "<provider>/<modelId>"? NO — plain <modelId>, scoped by platform
               (models.dev ids inside a provider block are already unique)
  display_name = .name
  context_window = .limit.context ?? NULL
  supports_vision  = modalities.input includes 'image'
  metadata row   = cost/limits/flags/modalities/open_weights verbatim
```

Dedupe/tombstone/pin semantics inherited from 001 unchanged
(first-enabled-source-wins on UNIQUE(platform, model_id)).

## Fetch guard changes (catalog kind only)

- Body cap: 20 MB (current doc ~4 MB; headroom ×5). URL sources keep 5 MB.
- Model cap: 25,000 (current doc ≈ thousands). URL sources keep 5,000.
- Timeout stays 15 s. Constants exported from `source-fetch.ts`.
