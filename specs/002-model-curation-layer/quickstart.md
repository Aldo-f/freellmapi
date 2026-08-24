# Quickstart: Verify Model Curation Layer (002)

Prereqs: repo on branch `002-model-curation-layer`, `npm install` done,
Docker running, live instance at `http://192.168.0.5:3001`.

## 1. Unit/contract tests (RED→GREEN evidence)

```bash
cd ~/dev/02-ai-freellmapi/server && npx vitest run src/__tests__/routes/curation.test.ts src/__tests__/db/curation_migration.test.ts
```

## 2. Real-runtime verification (live container)

```bash
cd ~/dev/02-ai-freellmapi
docker build -t freellmapi:local-002 .
docker compose up -d --force-recreate   # container restart policy: unless-stopped; .env untouched
BASE=http://192.168.0.5:3001

# 1) Create catalog source + sync against the LIVE models.dev document
curl -s -X POST $BASE/api/sources -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"models.dev","location":"https://models.dev/api.json","kind":"catalog"}'
curl -s -X POST $BASE/api/sources/<id>/sync -H "Authorization: Bearer $ADMIN_KEY"
# expect SyncResult ok with imported in the thousands, duplicates small

# 2) Metadata landed
sqlite3 server/data/freeapi.db 'SELECT COUNT(*) FROM model_metadata'   # > 0 (or docker exec)

# 3) Curated listing feeds /v1/models
curl -s $BASE/v1/models | jq '.data | length'

# 4) Save a free+tools+big-context filter → list shrinks
curl -s -X PATCH $BASE/api/sources/<id> -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"filter_criteria":{"free_only":true,"tool_call":true,"min_context":100000}}'
curl -s $BASE/v1/models | jq '.data | length'   # smaller than step 3

# 5) Per-model exclude wins over filter
curl -s -X PUT $BASE/api/sources/<id>/curate -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"platform":"<p>","model_id":"<m>","decision":"exclude"}'
curl -s "$BASE/api/sources/<id>/models?included=out" -H "Authorization: Bearer $ADMIN_KEY"

# 6) Disable source → ALL its models vanish from /v1/models (001 rule intact)
curl -s -X PATCH $BASE/api/sources/<id> -H "Authorization: Bearer $ADMIN_KEY" \
  -d '{"enabled":false}'
curl -s $BASE/v1/models | jq '[..data[].id] | length'   # back to pre-import count

# cleanup: delete the test source (cascades metadata + overrides)
```

Expected outcomes per spec success criteria:
- SC-001 sync completes within timeout budget, imports ≥90% of doc models.
- SC-002 spot-check a filtered-in model on models.dev website matches filters.
- SC-003 curated exclusion visible on next `/v1/models` request (<1 s), no restart.
- SC-004 `npm test` green on ARM (only the 2 known compression flakes).

## 3. Dashboard check

Open `http://192.168.0.5:3001/curate` — pick the models.dev source, build a
filter, toggle include/exclude on individual rows, reload page → state persists.
