# Session Handoff

- **Branch**: `agent/issue-178`, from `main` (v2.27.0).
- **Done**:
  - **Deleted witness-replay read planning (`api/src/database/sqlite-read-plan.ts`)**: removed `prepareSqliteReadPlan`, `recordSqlitePlanRead`, `assertOutsideSqliteReadPlan`, `sqliteDataRevision`, and the `db.prepare` / `db.transaction` / `db.exec` / `db.pragma` read-plan hooks in `api/src/database.ts`. Read queries are no longer recorded via `AsyncLocalStorage` / `v8.serialize` or replayed inside `BEGIN IMMEDIATE` under `withSqliteWriteGate`.
  - **Replaced video relation and artist statistics read-plan replay with bounded idempotent writes**:
    - `RefreshVideoService.repairVideoRecordsInBatches` (`videos:relation-batch`) plans relation updates in batches of 10 outside `withSqliteWriteGate` (sharing the artist's audio candidate map across batches of the pass), skips acquiring the write gate when a batch has no relation changes, and uses conditional `WHERE EXISTS (SELECT 1 FROM Recordings ...)` with `ON CONFLICT(source_recording_id, target_recording_id, relation_type) DO UPDATE` inside the gate.
    - `ArtistStatisticsService.refreshAsync` (`statistics:projection-batch`) computes each 20-artist chunk outside `withSqliteWriteGate` and persists under the gate using conditional `WHERE EXISTS (SELECT 1 FROM ArtistMetadata WHERE id = ?)` with `ON CONFLICT(library_id, artist_metadata_id) DO UPDATE`.
  - **Gated `RefreshAlbumService` writes**: wrapped `storeCanonicalAlbumReview` (`refresh-album:review`), `markEmptyAlbumReviewAttempt` (`refresh-album:review-empty`), `ProviderArtistIdentityService.store` (`refresh-album:artist-identity`), `refreshOffer` supplements/timestamp (`refresh-album:offer-supplements`), `refreshDetails` track credits/timestamp (`refresh-album:track-credits`, `refresh-album:details-timestamp`), SoundCloud DRM-only release rejection (`refresh-album:soundcloud-undownloadable`), and `upsertArtistAlbum` (`refresh-album:upsert-offer:<provider>`) in `withSqliteWriteGate`, and removed dead helper functions from `refresh-album-service.ts`.
  - **Regression tests**:
    - `api/src/services/music/refresh-album-service.test.ts`: verifies `refreshCanonicalAlbumReview` waits on `withSqliteWriteGate` for both review persistence and empty-attempt watermarking instead of throwing `SQLITE_BUSY` when another writer holds the gate.
    - `api/src/services/music/refresh-video-service.test.ts`: verifies `videos:relation-batch` safely skips a recording deleted while waiting for `withSqliteWriteGate` via conditional `WHERE EXISTS`.
- **Half-done**: none.
- **Verification**:
  - `yarn ci` (`yarn lint && yarn typecheck && yarn test:api && yarn build`) exits 0.
  - `yarn test:api`: 2801 tests run in a single pass with no clone-flake retry needed — 2798 passed, 0 failed, 3 skipped.
  - Net diff removes 119 lines across the codebase (excluding `HANDOFF.md`).
- **Live-verified**: not live-verified (cloud runner has no LAN access to the live container).
- **Open questions for PO**: none.

## Merged earlier on `main`: #177 (PR #180)

- **Branch**: `agent/issue-177` (merged in #180, `c6ea4b8`), from `main` (v2.27.0).
- **Done**:
  - **#177 (`fix(acquisition): shared_item_conflict self-collision blocks 99% of missing monitored albums`)**:
    - Removed `shared_item_conflict` from `evaluateAcquisitionDownload()` in `api/src/services/music/acquisition-download-command.ts` (19 lines deleted).
    - Why removal is safe:
      1. Matcher v4 (`sourcesWithConflictingSharedItem`) and matcher v5 (`sharedItemSourcesToDrop`) plus 1-to-1 `assignRankedTrackMatches` in `api/src/services/providers/provider-release-ingestion-service.ts` already prevent two canonical tracks on the same `provider_edition_match_id` from accepting the same `provider_track_item_id`.
      2. Planner v3 (`dropSharedItemCandidates` in `api/src/services/music/acquisition-planning-service.ts` and `usedProviderItems` in `api/src/services/music/acquisition-plan-optimizer.ts`) already drops shared-item candidates and assigns each `provider_item_id` to at most one track per plan.
      3. `offeredProviderTracks` in `evaluateAcquisitionDownload()` (`api/src/services/music/acquisition-download-command.ts:264-271`) already blocks any stored plan that offers the same `provider:provider_track_id` for more than one missing track.
    - Added regression test `"a plan that reuses a sibling edition's track matches by recording_id is ready to download"` in `api/src/services/music/acquisition-planning-service.test.ts`, verifying that cross-edition `recording_id` reuse (`track_match.track_id !== plan_track.track_id`, single accepted match) evaluates to `status: "ready"`.
- **Verification**:
  - `yarn lint`: 0 errors.
  - `yarn typecheck`: `api` (`tsc`) and `app` (`tsc --noEmit`) exit 0.
  - `yarn test:api`: 2,807 top-level TAP test entries, 2,804 pass, 0 fail, 3 skipped (Windows path-casing and case-insensitive filesystem tests on Linux).
  - `yarn test:app`: 52 test files, 204 tests pass, 0 fail.
  - `yarn build`: `api` and `app` exit 0.
- **Live-verified**: not live-verified (cloud runner has no LAN access to the live container).
- **Open questions**: none.
