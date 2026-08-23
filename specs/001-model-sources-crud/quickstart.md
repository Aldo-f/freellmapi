# Quickstart: Verify Model Sources CRUD

Prereqs: repo checked out, `npm install` done, Docker running.

## 1. Unit/contract tests (RED→GREEN evidence)

```bash
cd ~/dev/02-ai-freellmapi/server && npx vitest run src/__tests__/routes/sources.test.ts
```
Expect: tests exist and pass after implementation; RED output captured before implementation.

## 2. Real-runtime verification (live container)

```bash
cd ~/dev/02-ai-freellmapi && docker compose build && docker compose up -d
BASE=http://192.168.0.5:3001

curl -s $BASE/api/ping                                  # 200
curl -s $BASE/api/sources -H "Authorization: Bearer $ADMIN_TOKEN"   # builtin source listed
# Add a custom source pointing at a local fixture:
python3 -m http.server 8899 --directory specs/001-model-sources-crud/fixtures &
curl -s -X POST $BASE/api/sources -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"name":"test list","location":"http://192.168.0.5:8899/models.json"}'
curl -s -X POST $BASE/api/sources/<id>/sync -H "Authorization: Bearer $ADMIN_TOKEN"
curl -s $BASE/v1/models | grep <fixture-model-id>       # imported model visible in merged listing
curl -s -X PATCH $BASE/api/sources/<id> -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"enabled":false}'
curl -s $BASE/v1/models | grep <fixture-model-id>       # now ABSENT (disabled hides models)
curl -s -X DELETE $BASE/api/sources/<id> ...            # cleanup
```

Expected outcomes per spec success criteria:
- add→sync→visible in under 5 min via API/dashboard
- disable/delete immediately reflected in `/v1/models`
- failed sync (stop the fixture server) leaves previously imported models intact and marks the source `error`

## 3. Dashboard check

Open `http://192.168.0.5:3001/sources` — sources page renders list with statuses, add/edit/disable/sync controls work.
