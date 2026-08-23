# Feature Specification: Model Sources CRUD

**Feature Branch**: `001-model-sources-crud`

**Created**: 2026-08-23

**Status**: Draft

**Input**: User description: "Model sources CRUD: an editable, visible list of where FreeLLMAPI pulls its models from"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View model sources (Priority: P1)

As a FreeLLMAPI administrator, I can open the dashboard and see the complete list of sources the system currently pulls models from (the built-in upstream catalog plus any user-added sources), with each source's name, URL/endpoint, enabled state, and last-sync status. Today this information is invisible — models simply "appear" — and the user cannot tell where a model came from.

**Why this priority**: Visibility is the core value of the feature; everything else builds on it. It is pure read-only and delivers standalone value.

**Independent Test**: Open the dashboard's model-sources page; the built-in catalog source appears with its current sync status without any configuration.

**Acceptance Scenarios**:

1. **Given** a fresh install with no custom sources, **When** the admin opens the model-sources view, **Then** exactly one built-in catalog source is listed, marked enabled.
2. **Given** at least one sync has run, **When** the admin views the source list, **Then** each source shows its last successful sync time (or "never synced").
3. **Given** a source's endpoint becomes unreachable, **When** the list is viewed after a failed sync attempt, **Then** that source shows an error/failed state rather than silently appearing healthy.

### User Story 2 - Add a custom model source (Priority: P1)

As an administrator, I can register a new model source by providing a name and a source location (URL returning a model list). After adding, I can trigger a sync and see imported models attributed to that source.

**Why this priority**: This is the feature's enabling capability — without add, the list is decorative.

**Independent Test**: Add a source pointing at a small static model-list document, trigger sync, confirm the models appear in the system's model listing attributed to that source.

**Acceptance Scenarios**:

1. **Given** the admin is on the model-sources page, **When** they submit a valid new source (name + URL), **Then** the source appears in the list as enabled and unsynced.
2. **Given** a newly added source, **When** sync runs against a reachable, well-formed source document, **Then** models from that document are imported and visible in the models view, tagged with that source.
3. **Given** a source URL that returns malformed data or is unreachable, **When** sync runs, **Then** the failure is reported on the source entry, previously imported models remain intact, and the rest of the system is unaffected.

### User Story 3 - Edit and remove model sources (Priority: P2)

As an administrator, I can rename a source, change its URL, enable/disable it, and delete it entirely. Disabling stops the source from contributing models without deleting anything; deleting removes the source and its exclusive contributions.

**Why this priority**: Full lifecycle control matters but only once viewing and adding work.

**Independent Test**: Disable a synced source → its models disappear from the merged model listing while other sources' models remain; re-enable → they return.

**Acceptance Scenarios**:

1. **Given** two enabled sources each contributing distinct models, **When** one is disabled, **Then** only that source's models disappear from the merged listing.
2. **Given** a disabled source, **When** re-enabled and synced, **Then** its models reappear.
3. **Given** a custom source, **When** deleted, **Then** models contributed solely by it are removed; models also available from another active source are retained.
4. **Given** the built-in catalog source, **When** the admin attempts to delete it, **Then** deletion is refused (it may be disabled, not removed).

### User Story 4 - Sync behavior & tombstones (Priority: P3)

As an administrator, when a source is re-synced and a model has disappeared upstream, that model is removed locally unless the user explicitly pinned/favorited it. Syncs can be triggered manually per source and run automatically on a schedule.

**Why this priority**: Refines correctness over time; not needed for initial value.

**Independent Test**: Sync a source twice with the second fetch missing one model; verify the removed model is dropped (or kept if pinned).

**Acceptance Scenarios**:

1. **Given** a synced source, **When** a later sync no longer contains a previously imported model, **Then** that model is removed unless pinned by the user.
2. **Given** any source, **When** the admin presses "sync now", **Then** the sync completes and the source's last-sync timestamp updates.

## Edge Cases

- Source URL redirects or serves very large documents → enforce a size cap and reject oversized payloads with a clear error.
- Two sources provide the same model identifier → first-enabled-source wins for conflicting metadata; duplicates are not double-counted.
- Model identifiers containing unexpected characters → sanitized/validated before import.
- Concurrent syncs of the same source → serialized; a sync already running is not duplicated.
- Empty source document → valid but imports nothing; source shows success with zero models.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-1**: The system SHALL display all configured model sources with name, location, enabled state, last-sync time, and last-sync outcome.
- **FR-2**: The system SHALL always include one non-deletable built-in catalog source (disable allowed).
- **FR-3**: Administrators SHALL be able to add a custom source consisting of a name and a source URL.
- **FR-4**: The system SHALL validate added source URLs (reachable, well-formed response) before/at import time and surface failures on the source entry.
- **FR-5**: Administrators SHALL be able to edit a custom source's name and URL, and toggle any source enabled/disabled.
- **FR-6**: Administrators SHALL be able to delete custom sources; deleting a source removes models contributed exclusively by it.
- **FR-7**: Each source SHALL support manual sync-on-demand; automatic scheduled sync is desirable but MAY be deferred if it complicates the first version.
- **FR-8**: The merged model listing presented to API consumers SHALL reflect the union of enabled sources minus disabled/deleted contributions.
- **FR-9**: All source-management operations SHALL require administrator authentication consistent with existing dashboard auth.

### Assumptions

- "Source" in v1 means a URL serving a model list document (JSON); richer catalog formats (e.g., full metadata catalogs like models.dev) are explicitly the follow-up project, not this feature.
- Only administrators manage sources; regular API-key consumers see only the merged model listing.
- A reasonable payload size cap (a few MB) suffices.

### Dependencies

- Existing models table/model listing endpoints.
- Existing dashboard authentication.

### Out of Scope

- Metadata curation/filtering (cost/context/modality filters) — separate follow-up project.
- Non-HTTP source types (local files, git repos).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- An administrator can go from zero custom sources to a working custom source with imported models in under 5 minutes using only the dashboard.
- 100% of CRUD operations (list/add/edit/disable/delete/sync) verifiable via dashboard UI and corresponding API calls.
- Disabling or deleting a source changes the public merged model listing within one request, with no stale entries from that source.
- Failed syncs never corrupt or remove previously imported models.

## Key Entities

- **ModelSource**: id; name; kind (built-in | url); location (URL); enabled (bool); last_synced_at; last_sync_status (ok | error | never); last_error (text, nullable); created_at.
- **Model**: existing model entity, extended with a reference to the originating source and a "pinned" flag protecting it from sync-tombstone removal.
