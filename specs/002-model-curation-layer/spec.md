# Feature Specification: Model Curation Layer with models.dev Catalog

**Feature Branch**: `002-model-curation-layer`

**Created**: 2026-08-24

**Status**: Draft

**Input**: User description: "A model-curation layer using https://models.dev as a metadata catalog. models.dev is treated as a special model_source (kind='catalog') whose sync imports rich per-model metadata (cost, context/output limits, tool_call, structured_output, reasoning, modalities, open_weights); an admin-facing filter builder curates which of those models are exposed; curated selection feeds the merged /v1/models listing under existing enabled-source visibility rules."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sync models.dev as a catalog source (Priority: P1)

As a FreeLLMAPI administrator, I can add https://models.dev as a special
catalog-kind model source and trigger a sync. The sync downloads the static
`https://models.dev/api.json` document (~4 MB, ~193 providers) and imports its
models into the system attributed to that source, reusing the existing
source-sync machinery from feature 001 (status tracking, dedupe, tombstones,
pin protection).

**Why this priority**: Without the import there is nothing to curate. It is the
enabling slice and delivers standalone value: thousands of catalogued models
become visible and attributable.

**Independent Test**: Add a source of kind `catalog` pointing at
models.dev, trigger sync, confirm imported models appear attributed to that
source and the source shows a successful last-sync timestamp.

**Acceptance Scenarios**:

1. **Given** a running instance, **When** the admin creates a source with kind
   `catalog` and URL `https://models.dev/api.json`, **Then** it appears in the
   source list like any other source.
2. **Given** a freshly added catalog source, **When** sync runs against the
   live models.dev document, **Then** models are imported (thousands, across
   many providers), each carrying its catalog metadata, and the source reports
   success with counts.
3. **Given** an unreachable or malformed catalog endpoint, **When** sync runs,
   **Then** the failure is reported on the source entry, previously imported
   data stays intact, and the rest of the system is unaffected (same failure
   contract as feature 001).
4. **Given** a repeat sync after upstream changes models, **When** sync
   completes, **Then** newly listed models appear, removed ones are tombstoned
   unless pinned, and unchanged ones keep their curation state.

### User Story 2 - Per-model metadata stored and visible (Priority: P1)

As an administrator, when catalog models are imported, each model's metadata —
input/output cost (USD per Mtok), context and output token limits,
tool_call / structured_output / reasoning flags, input/output modalities
(text/image/video/audio), and open_weights — is stored so it can be filtered on
and displayed. Models from non-catalog sources simply have no metadata rows.

**Why this priority**: Metadata is what makes curation meaningful rather than
name-guessing; filters in US3 depend on it.

**Independent Test**: After a catalog sync, query a single imported model and
verify its stored cost, limits, flags, modalities, and open_weights match the
models.dev document values.

**Acceptance Scenarios**:

1. **Given** a synced catalog containing a known model (e.g. an Anthropic or
   Google model with documented pricing), **When** the admin inspects that
   model, **Then** cost.input/cost.output, limit.context/limit.output,
   tool_call, reasoning, modalities, and open_weights match the catalog.
2. **Given** a catalog model with absent/unknown fields (e.g. no cost for a
   free model), **When** inspected, **Then** those fields are stored as
   unknown/free rather than crashing the import or being fabricated.
3. **Given** a model from a plain URL source (feature 001 style), **When**
   listed alongside catalog models, **Then** it has empty metadata and is not
   broken by the metadata layer.

### User Story 3 - Curation filter builder and include/exclude toggles (Priority: P2)

As an administrator, I can build a filter over the catalog-imported models —
free only (zero input+output cost), minimum context window, tool_call support,
image (or other modality) input, open weights — see the matching subset, and
toggle individual models in/out of the curated selection. The filter
definition is saved per catalog source and survives restarts; per-model manual
overrides win over the filter.

**Why this priority**: This is the actual "curation" value, but it depends on
US1+US2 data existing first.

**Independent Test**: Apply a "free AND tool_call AND min-context 100k"
filter, verify only matching models match, exclude two of them manually, save,
reload the page, and confirm filter + exclusions persist.

**Acceptance Scenarios**:

1. **Given** synced catalog data, **When** the admin sets free-only +
   min-context filters, **Then** only zero-cost models meeting the context
   threshold are shown as included.
2. **Given** a filtered set, **When** the admin excludes a model, **Then** it
   drops out of the curated selection even though it matches the filter.
3. **Given** an excluded model, **When** the admin explicitly includes it,
   **Then** it returns to the curated selection despite the filter.
4. **Given** saved filter criteria and overrides, **When** the server
   restarts, **Then** both persist and the effective selection is unchanged.

### User Story 4 - Curated selection drives /v1/models (Priority: P2)

As a client application (e.g. another local app fetching the model list), when
I call the merged models listing (`/v1/models` and dashboard `/api/models`),
the response reflects curation: catalog models excluded by the curator do not
appear; included catalog models do — subject to the same enabled-source
visibility rules established in feature 001 (disabled source ⇒ none of its
models, regardless of curation state).

**Why this priority**: Delivers the end-to-end value to consuming apps but is
a composition of prior slices.

**Independent Test**: Exclude a specific catalog model via the curator, then
call `/v1/models`: the model is absent; re-include it: it returns. Disable the
catalog source entirely: all its models vanish regardless of curation.

**Acceptance Scenarios**:

1. **Given** a curated-out catalog model, **When** a client lists models,
   **Then** that model id is absent from the merged listing.
2. **Given** a curated-in catalog model on an enabled source, **When** a
   client lists models, **Then** the model appears.
3. **Given** the catalog source disabled at source level, **When** a client
   lists models, **Then** no catalog-source models appear even if individually
   curated-in.
4. **Given** a client app that fetches the model list periodically, **When**
   curation changes, **Then** the next list request reflects the change
   without any restart.

### Edge Cases

- What happens when the models.dev document grows beyond current size (~4 MB)?
  Sync must enforce a generous size cap consistent with feature 001's fetch
  guard without failing on legitimate growth.
- What happens when two providers in the catalog expose the same underlying
  model id? Dedupe rules from feature 001 apply; metadata comes from the
  winning (first-enabled-source) row.
- What happens when cost/limit fields are missing or null for some providers?
  Store as unknown; the free-only filter treats UNKNOWN cost as NOT free
  (decided in clarify). A possible future refinement — probing whether a
  provider endpoint works without an API key to prove freeness — is explicitly
  OUT OF SCOPE for this feature.
- Newly imported catalog models default to CURATED-IN (all models exposed),
  matching models.dev's own presentation of everything it lists; curation only
  ever removes unless an explicit include override re-adds.
- What happens when a previously curated-in model disappears upstream? Normal
  tombstone semantics apply; pins still protect it.
- Provider slugs in models.dev don't map 1:1 to FreeLLMAPI platform names;
  unmatched slugs are imported as new platform entries rather than dropped.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support creating a model source with kind `catalog`
  via the existing `/api/sources` API and Sources UI, distinguished from
  builtin/url kinds.
- **FR-002**: Syncing a catalog source MUST fetch its configured URL expecting
  the models.dev api.json shape ({provider: {models: {...}}}) and import every
  provider/model entry through the existing source-sync pipeline (dedupe,
  attribution, status, tombstones).
- **FR-003**: Imported catalog models MUST persist per-model metadata: cost
  input/output (USD/Mtok), limit context/output, tool_call,
  structured_output, reasoning, input/output modalities, open_weights.
- **FR-004**: Non-catalog sources MUST continue to work unchanged; their
  models have no metadata and curation does not alter their visibility.
- **FR-005**: The dashboard MUST offer a curation view (on /sources or a
  dedicated page) with a filter builder over: free-only (price), minimum
  context window, tool_call, input modalities (at least image), open_weights.
- **FR-006**: The curation view MUST allow per-model include/exclude toggles
  that override the filter result, and MUST persist both filter criteria and
  overrides across restarts.
- **FR-007**: The merged models listing (`/v1/models`, dashboard
  `/api/models`) MUST exclude curated-out catalog models while continuing to
  honor feature 001's enabled-source visibility and pin semantics.
- **FR-008**: All new/changed endpoints MUST require auth consistent with
  existing `/api/sources` routes.
- **FR-009**: Catalog sync MUST respect the existing fetch guards (timeout /
  size cap sized generously above the current ~4 MB document / model-count
  cap raised accordingly) and report failures on the source without side
  effects on other sources.
- **FR-010**: No new npm dependencies may be added unless justified in the
  plan; implementation MUST use existing deps (undici/fetch, better-sqlite3,
  React dashboard stack).

### Key Entities *(include if feature involves data)*

- **ModelSource (extended)**: gains kind value `catalog`; stores saved filter
  criteria JSON for curation (per catalog source).
- **ModelMetadata (new or columns)**: per model — costs, limits, capability
  flags, modalities, open_weights, raw catalog provenance; linked to the model
  row owned by a catalog source.
- **CurationOverride**: per-model include/exclude decision attached to a
  catalog source, taking precedence over filter evaluation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A full catalog sync completes within the existing sync timeout
  budget on the Pi 5 host and imports ≥ 90% of models present in the fetched
  document.
- **SC-002**: Applying a "free + tool_call + ≥100k context" filter returns a
  correct subset verifiable by spot-checking against the live models.dev site.
- **SC-003**: A curated exclusion is reflected in `/v1/models` on the next
  request (< 1 s) without service restart.
- **SC-004**: Full `npm test` suite passes on ARM (only the 2 pre-existing
  compression timing flakes tolerated).

## Assumptions

- models.dev remains a static JSON document at `https://models.dev/api.json`;
  no auth, no rate limiting concerns at manual/scheduled sync frequency.
- Feature 001 artifacts (model_sources table, sync pipeline, /sources page,
  visibility rules) are stable groundwork and are extended, not rewritten.
- Curation applies only to catalog-kind sources in v1.
- The consuming "other application" reads the standard `/v1/models` listing;
  no new client-facing API shape is introduced.
