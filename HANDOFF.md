# Session Handoff

- **Branch**: `agent/issue-170`, from `main` (2.27.0).
- **Done**:
  - **Root-cause check for The Kinks orphan sidecars (#170)**:
    - Pre-2.27.0 upgrade renames left orphan `.lrc`/`.txt`/`.json` sidecars both when punctuation changed (`07 - Don't Hold Me Down.lrc` → `07 - Don’t Hold Me Down.m4a`) and when disc/track numbering changed between multi-disc `{medium:0}{track:00}` and single-disc `{track:00}` stems (`101 - Here Comes Yet Another Day.txt`, `102 - Maximum Consumption.lrc` … `106 - Motorway.lrc`). Retiring the old `TrackFiles` row (`TrackFileDeleted`) fired `ON DELETE SET NULL` on `LyricFiles.track_file_id` / `MetadataFiles.track_file_id` / `ExtraFiles.track_file_id` and left the old sidecars on disk.
    - Closed three remaining gaps in the 2.27.0 `releaseExtrasOfReplacedTrackFiles` path so new upgrades cannot leave orphans through a second path:
      1. Single-track upgrade imports (`OrganizerService.organizeDownload` `type === "track"`) and video upgrade imports (`type === "video"`) now capture linked extras before `forgetRetiredLibraryFileRows` and release them via `OrganizerService.releaseRetiredTrackExtras`, matching the album import loop. Video thumbnail and NFO upserts also bind `trackFileId`.
      2. `RetiredLibraryFile` now carries `TrackFiles.library_id` from `listPreviousReleaseTrackFiles` / `listPreviousVideoFiles` so `releaseRetiredTrackExtras` still releases linked extras when `raw.libraryId` is omitted on the organize request.
      3. `releaseExtrasOfReplacedTrackFiles` and `inspectInventorySidecar` now compare stems case-insensitively on case-insensitive mounts (`isCaseInsensitivePath`, live ZFS `casesensitivity=insensitive, normalization=none`) in addition to 64-bit `bigint` `dev`/`ino` (`isSameFile` in `path-utils.ts`), protecting case-only renamed sidecars (#42288) while releasing renumbered/retitled ones.
  - **Dry-run-first orphan sidecar cleanup (#170)**:
    - Added `previewOrphanSidecarCleanup` and `applyOrphanSidecarCleanup` (`api/src/services/mediafiles/orphan-sidecar-cleanup.ts`), `CleanupOrphanSidecars` command executor (`api/src/services/commands/executors/cleanup-orphan-sidecars-command.ts`), and endpoints `GET /api/v1/files/orphan-sidecars/preview` + `POST /api/v1/files/orphan-sidecars/apply` (`api/src/routes/library-files.ts`).
    - Preview is strictly read-only (`dryRun: true`): walks configured library roots (or a scoped `libraryRoot` / `artistId`), matches `.lrc`/`.txt`/`.json` sidecars against media siblings (including `<stem>.info.json`) using case-insensitive stems and `isSameFile` (`dev`/`ino`), checks `TrackFiles`, `UnmappedFiles`, and `LyricFiles`/`MetadataFiles`/`ExtraFiles` rows by `isSameFile` (protecting any sidecar whose row points at a live `TrackFiles` row on disk or folder-level `bio`/`review`/`nfo`), and returns the orphan list, stale DB rows, and a SHA-256 `confirmationToken` over the exact `(filePath, witness)` set.
    - Apply requires `confirm: true` and the exact `confirmationToken` from the dry-run preview (400 without `confirm: true`, 409 on token/witness drift), queues `CleanupOrphanSidecars`, re-verifies each file's `dev:ino:size:mtimeNs` witness, media siblings, and live DB links immediately before unlinking, and cleans any associated stale (`track_file_id IS NULL`) extra-file DB rows under the SQLite write gate.
- **Verification**:
  - `yarn lint`, `yarn typecheck`, and `yarn build` exit 0.
  - `yarn test:app`: 52 files, 204 tests passed, 0 failed.
  - `yarn test:api`: main run 2,791 top-level entries (2,788 passed, 2 skipped, 1 Node test-runner clone flake on `inventory-sidecars.test.ts` which passed 27/28 with 1 root-permission skip on automatic isolation retry = 2,815 passed, 3 skipped, 0 failed).
  - Focused tests: `node api/scripts/run-tests.mjs api/src/services/mediafiles/orphan-sidecar-cleanup.test.ts api/src/services/mediafiles/library-file-delete-service.test.ts api/src/services/mediafiles/release-track-replacement.test.ts` — 37/37 passed.
- **Live-verified**: not live-verified (cloud runner has no LAN access to Primula).
- **Live operator steps on Primula after deploy**:
  1. Dry-run preview: `GET /api/v1/files/orphan-sidecars/preview` (optionally `?libraryRoot=music` or `?artistId=<mbid>`) and inspect `orphanCount`, `entries`, and `confirmationToken`.
  2. Confirm and remove: `POST /api/v1/files/orphan-sidecars/apply` with `{"confirm": true, "confirmationToken": "<token from step 1>"}` (optionally `"filePaths": [...]` or `"pruneEmptyFolders": true`).
