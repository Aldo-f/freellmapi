## POST /api/keys/import — Batch Import API Keys

Import multiple API keys at once by uploading a `.env`, `.json`, `.txt`, `.jsonc`, or `.md` file.

**Endpoint**: `POST /api/keys/import`
**Content-Type**: `multipart/form-data`
**File parameter**: `file` (single file, max 5MB)

**Supported file formats**:
- `.env` / `.txt` — `KEY=VALUE` lines, one per line. Example: `GROQ_API_KEY=gsk_abc123`
- `.json` / `.jsonc` — JSON object mapping key names to values: `{"GROQ_API_KEY": "gsk_abc123", ...}`

**Supported prefixes** (env-var prefix → platform mapping):

| Prefix | Platform |
|---|---|
| `GOOGLE_` | google |
| `GROQ_` | groq |
| `CEREBRAS_` | cerebras |
| `SAMBANOVA_` | sambanova |
| `NVIDIA_` | nvidia |
| `MISTRAL_` | mistral |
| `OPENROUTER_` | openrouter |
| `GITHUB_` | github |
| `COHERE_` | cohere |
| `CLOUDFLARE_` | cloudflare |
| `ZHIPU_` | zhipu |
| `OLLAMA_` | ollama |
| `HF_` | huggingface |

Keys whose prefix does not match any entry in this table are returned in the `skipped` array.

**Response shape** (HTTP 200):
```json
{
  "imported": 2,
  "skipped": ["UNRECOGNISED_KEY"],
  "errors": [],
  "total": 3
}
```

- `imported` — number of keys successfully imported and encrypted
- `skipped` — array of key names that were skipped (unrecognised prefix or no-api-key platform)
- `errors` — array of `{ key, error }` objects for keys that failed during insertion
- `total` — total number of keys found in the file

**Error responses**:
- `400 Bad Request` — No file uploaded, empty file, unsupported file type, malformed JSON
- `413 Payload Too Large` — File exceeds 5MB

**curl example**:
```bash
curl -X POST http://localhost:3001/api/keys/import \
  -F "file=@keys.env;type=text/plain"
```

### POST /api/keys/preview — Preview parsed keys

Preview parsed keys from uploaded files without importing them. Accepts multiple files and returns detected keys with their platform mapping.

**Endpoint**: `POST /api/keys/preview`
**Content-Type**: `multipart/form-data`
**File parameter**: `files` (multiple files, max 5MB each)

**Response shape** (HTTP 200):
```json
{
  "keys": [
    {
      "keyName": "GROQ_API_KEY",
      "keyValue": "gsk_abc123",
      "detectedPlatform": "groq",
      "prefix": "GROQ_"
    }
  ],
  "total": 1,
  "skipped": ["UNRECOGNISED_KEY"]
}
```

- `keys` — array of previewed keys with their detected platform
- `total` — total number of keys found across all files
- `skipped` — array of key names that were skipped (unrecognised prefix)

**curl example**:
```bash
curl -X POST http://localhost:3001/api/keys/preview \
  -F "files=@keys.env;type=text/plain" \
  -F "files=@keys.json;type=application/json"
```

### POST /api/keys/import-selected — Import selected keys from preview

Import a subset of keys returned by the preview endpoint. Accepts an explicit list of keys with their platform mapping.

**Endpoint**: `POST /api/keys/import-selected`
**Content-Type**: `application/json`

**Request body**:
```json
{
  "keys": [
    {
      "keyName": "GROQ_API_KEY",
      "keyValue": "gsk_abc",
      "platform": "groq"
    }
  ]
}
```

**Response shape** (HTTP 200):
```json
{
  "imported": 1,
  "skipped": [],
  "errors": [],
  "total": 1
}
```

- `imported` — number of keys successfully imported and encrypted
- `skipped` — array of key names that were skipped
- `errors` — array of `{ key, error }` objects for keys that failed during insertion
- `total` — total number of keys in the request

**curl example**:
```bash
curl -X POST http://localhost:3001/api/keys/import-selected \
  -H "Content-Type: application/json" \
  -d '{"keys":[{"keyName":"GROQ_API_KEY","keyValue":"gsk_abc","platform":"groq"}]}'
```
