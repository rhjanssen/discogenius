# Session Handoff

- **Branch**: `main` (clean; all feature branches merged and deleted)
- **What is done**:
  - **PR #126 (`#77`)**: Queue API performance (keyset cursor pagination, persistent read-only `worker_threads` worker, O(1) `queuePosition`, 10s remote hydration timeout on album reads).
  - **PR #127 (`#79`)**: Servarr/MusicBrainz locale alias lookup, `{Artist Original Name}` / `{Artist Locale Name}` / `{Artist Alias}` naming tokens, `TitleTokenRegex` fix.
  - **PR #128 (`#116`)**: AcoustID rate-limited verification (`<= 3 req/s` + 429 retry) on manual & folder auto-imports, merged recording redirect lookup, `force` override on `POST /api/unmapped/canonical-import`.
  - **PR #129 (`#114`)**: Housekeeping stray-file cleanup (`.lrc/.srt/.vtt`, aged temp/part files, empty folders, unowned audio) and stereo/Atmos placement enforcement (`runHousekeepingStrayAndPlacement`).
  - **PR #130 (`#115`)**: Two-way disk vs DB reconciliation (`reconcileDiskAndDatabase`), case-insensitive root comparison, stereo/Atmos placement validation (`isTrackFilePlacementValid`), and `/api/health` / `/api/v1/system/status` `reconciliation` diagnostics.
  - **PR #131 (`#78`)**: Plex & Jellyfin integration (`media_servers` config with redacted secrets, targeted folder scans after import/rename/retag, `POST /api/v1/media-servers/reconcile` dry-run & apply with MBID merge/fix-match/refresh).
  - **PR #132**: Audit Round 2 cleanup (`command-queue-manager.ts` empty/whitespace provider string guard in rate-limit backoff check).
- **Open issues / PRs**: None (`0` open issues, `0` open PRs on `rhjanssen/discogenius`).
- **What was NOT verified on LAN**:
  - Cloud VM cannot reach the LAN (`192.168.1.50` / `192.168.1.100` / running container). Live-server smoke testing with real provider tokens, Plex/Jellyfin instances, and Bastille/Bakermat remains for the LAN session / user.
- **Open design items for PO**:
  - Edition selection UX improvement (Lidarr-style modal supporting multi-edition selection and source selection on album page).
  - Audit Round 2 follow-up notes: `artist-statistics-service.ts:448` (`Libraries ORDER BY id LIMIT 1` fallback when `LibraryArtists` has no row) and `album-query-service.ts:589` (`LIKE` search inside `listAlbumsFromMembership`).
