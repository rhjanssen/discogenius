# Session Handoff

- **Branch**: `agent/issue-170`, rebased onto `main` (`9fd62075`, v2.27.3).
- **Done**:
  - **Rebased & deduplicated `path-utils.ts` (#170 / PR #175 review)**:
    - Rebased `agent/issue-170` onto `main` and dropped all `path-utils.ts` edits since `sameDirectoryEntry` (`fs.lstatSync(..., { bigint: true })`) already landed on `main` in #176.
    - Kept the 3 `upgrade-extra` retirement bug fixes (`OrganizerService` single-track & video upgrade extra release + `trackFileId` binding, `RetiredLibraryFile.libraryId` propagation, and case-insensitive + 64-bit `sameDirectoryEntry` checks in `extra-file-deletion.ts`, `release-track-replacement.ts`, `canonical-manual-import-service.ts`, `organizer.ts`, and `inventory-sidecars.ts`).
  - **Delete-first simplification of orphan sidecar cleanup (`orphan-sidecar-cleanup.ts`: 894 → 427 lines, −52.2%)**:
    - Removed `reconcileCandidatesAgainstDatabase` (full-table DB scans) and `isProtectedInDbNow` (leading-wildcard `LIKE '%/relDir/%'` 40M-row scans). Replaced with a single indexed-only `inspectDirectoryDbLinks` helper using B-tree exact/prefix lookups on `file_path`, `idx_track_files_normalized_path_folded`, and `idx_*_track_file` FK indexes (proven by `EXPLAIN QUERY PLAN` assertions with zero table `SCAN`s).
    - Eliminated all inline full-library disk walks on HTTP routes: `POST /api/v1/files/orphan-sidecars/preview` queues a `CleanupOrphanSidecars` dry-run command (`202`), `GET /api/v1/files/orphan-sidecars/preview` reads the persisted bounded preview (`MAX_PREVIEW_ENTRIES = 5000`, paginated `limit <= 500`) from `commands` in O(1), and `POST /api/v1/files/orphan-sidecars/apply` validates `confirm: true` + `confirmationToken` + optional `filePaths` against the stored preview in O(1) before queueing the apply worker.
    - Apply worker operates strictly over the confirmed preview entries (zero redundant full-library walk), re-verifying file witness (`dev:ino:size:mtimeNs`), root containment, directory media siblings (case-insensitive + `sameDirectoryEntry`), and indexed DB protection before unlinking and deleting verified stale (`track_file_id IS NULL`) extra-file rows.
- **Verification**:
  - Full `yarn ci` exited 0 (`yarn lint`, `yarn typecheck`, `yarn test:api`, `yarn test:app`, `yarn build`).
  - `yarn test:api`: main run 2,843 top-level entries (2,839 passed, 3 skipped, 1 Node clone flake on `src/services/mediafiles/metadata-files.test.ts` which passed 11/11 on automatic isolation retry; 0 failing tests).
  - `yarn test:app`: 56 files, 213 tests passed, 0 failed.
  - Focused tests: `orphan-sidecar-cleanup.test.ts` (6/6 passed, including 11 `EXPLAIN QUERY PLAN` zero-SCAN checks), `library-file-delete-service.test.ts`, `release-track-replacement.test.ts`, `canonical-manual-import-active-schema.test.ts`, `inventory-sidecars.test.ts` (70 passed, 1 root-permission skip, 0 failed).
- **Live-verified**: not live-verified (cloud runner has no LAN access to Primula).
- **Live operator steps on Primula after deploy**:
  1. Queue dry-run preview: `POST /api/v1/files/orphan-sidecars/preview` (optional `{"libraryRoot": "music"}` or `{"artistId": "<mbid>"}`) → returns `202 {"commandId": N, "dryRun": true}`.
  2. Read dry-run preview once completed: `GET /api/v1/files/orphan-sidecars/preview?commandId=N` → inspect `orphanCount`, `entries`, and `confirmationToken`.
  3. Confirm and remove: `POST /api/v1/files/orphan-sidecars/apply` with `{"confirm": true, "confirmationToken": "<token>", "previewCommandId": N}` (optional `"filePaths": [...]` or `"pruneEmptyFolders": true`) → queues `CleanupOrphanSidecars` (`202`).
