# Session Handoff

- **Branch**: `agent/issue-140`
- **What is done**:
  - **Issue #140**: Re-landed stray cleanup, stereo/Atmos placement, and two-way disk-DB reconciliation (#129/#130) with comprehensive safety guards and dry-run mechanism:
    - **Safe path resolution**: Existence checks and tracked-path sets use `resolveStoredLibraryPath` (stored `file_path`, `library_root`, `relative_path`), NFC-normalized comparison, and per-root `isCaseInsensitivePath`. Handles stale stored roots, case-differing linked files, and NFD disk names matching NFC DB paths.
    - **Marking before deletion**: Reconciliation never deletes a `TrackFiles` row in the same run as stray cleanup. Missing files are first recorded in `ReconciliationMissingFiles`, kept protected in the current pass's tracked set, and deleted only on subsequent runs if confirmed missing and destructive mode is enabled. Restored files clear the mark.
    - **Dry-run first & destructive mode setting**: Destructive mode defaults to OFF (`housekeeping.destructive_mode` / `enable_destructive_cleanup`). Dry-run mode previews all deletions and moves with reasons without mutating disk or DB. Exposed via `GET /api/v1/system/status/reconciliation/dry-run`, `GET /api/v1/library/files/housekeeping/dry-run`, `POST /api/v1/system/status/reconciliation/destructive`, and `Housekeeping (Dry Run)` manual system task.
    - **Edition placement protection**: Evaluated per album edition. Misplaced files are moved, never deleting the last copy for an edition. Moves check disk and DB destination occupancy first and abort if occupied (never overwrite existing files).
    - **Product rules**: Atmos files in stereo allowed only if literally the only copy; stereo tracks in Atmos allowed if album is Atmos; linked tracks are never deleted.
    - **Validation**: Full `yarn ci` passed (exit code 0; 2734 API tests pass, 201 App tests pass, clean build).
- **What is half-done**: Nothing. All acceptance criteria and tests for #140 are complete.
- **What was NOT verified on LAN**:
  - Live smoke test against the running container on NAS `192.168.1.50` with real Bastille/Bakermat library paths.
- **Open questions / design items for PO**:
  - None for #140. Ready for review and merge.
