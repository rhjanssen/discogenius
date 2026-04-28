# Testing Plan

This plan is the release-candidate baseline. Run automated checks first, then manual browser and filesystem validation with a real TIDAL session. Playwright passing is required, but not sufficient by itself for release confidence.

## 1. Environment Baseline

1. Install JavaScript dependencies.
   ```bash
   yarn install
   ```

2. Prepare local downloader tooling (only needed for local dev; Docker can provide tooling instead).

   Linux/macOS:
   ```bash
   python -m venv .venv
   source .venv/bin/activate
   python -m pip install --upgrade pip tidal-dl-ng
   ```

   Windows PowerShell:
   ```powershell
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   python -m pip install --upgrade pip tidal-dl-ng
   ```

   Notes:
   - ffmpeg must be available on PATH.
   - If you do not use repo-local .venv, set TIDAL_DL_NG_BIN to the tidal-dl-ng executable path.

3. Verify core tools.

   Linux/macOS:
   ```bash
   python --version
   .venv/bin/tidal-dl-ng --version
   ffmpeg -version
   yarn --version
   ```

   Windows PowerShell:
   ```powershell
   python --version
   .\.venv\Scripts\tidal-dl-ng.exe --version
   ffmpeg -version
   yarn --version
   ```

4. Start the local stack.
   ```bash
   yarn dev
   ```

Expected:
- API (default PORT=3737): http://localhost:3737/health
- App (Vite): http://localhost:8080

If PORT is set in your environment, use that value instead of 3737 for API URLs.

Important:
- Do not run yarn dev and docker compose up simultaneously against the same checkout. Both access config/discogenius.db and can cause SQLite conflicts.
- For packaging/runtime parity checks, Docker validation is still required.

## 2. Automated Baseline

Run before manual QA:

```bash
yarn lint
yarn build
yarn test:e2e
```

If packaging/runtime paths/downloader availability changed, also run:

```bash
docker compose up --build -d
docker compose logs -f
```

## 3. Manual Browser and Filesystem Validation

### A. Authentication and Connected Session

1. Open http://localhost:8080/auth.
2. Confirm repo-local token state is detected when present.
3. If disconnected, complete the TIDAL device login flow.
4. Restart backend once and confirm session restoration.
5. Force a disconnected state and confirm protected routes redirect back to /auth until reconnected.

Expected:
- Auth state restores from config/providers/tidal and syncs to Orpheus/tidal-dl-ng session formats.
- Protected routes require an active TIDAL session and redirect disconnected users to the auth flow.

### B. Download Quality Lifecycle

Use at least one monitored album (multi-track), one downloadable video if available, and inspect disk after each transition.

1. Set audio quality to normal and download.
2. Move to high and trigger upgrade path.
3. Move to max and repeat.
4. Move back to normal or low and verify downgrade path.

Expected:
- Replacement flow is safe (new file lands before old variant removal).
- Staging cleanup runs after success/failure.
- library_files reflects final path/quality.
- Queue and album UI state update without hard refresh.

### C. Metadata Embedding and Sidecar Toggles

Validate toggle combinations for:

1. embed_cover
2. embed_lyrics
3. save_album_cover
4. save_lyrics
5. save_video_thumbnail
6. save_nfo

Expected:
- Embedded metadata follows setting state.
- Sidecars are created only when enabled, including Jellyfin/Kodi `artist.nfo`, `album.nfo`, and music-video `.nfo` files when `save_nfo` is enabled.
- Disabled sidecars are pruned cleanly.
- No duplicate sidecar buildup or orphan DB file rows.
- NFO files include available MusicBrainz artist, album/release, release-group, and track IDs.
- NFO generation falls back to local database metadata when TIDAL text/detail calls are unavailable.

### D. Core Product Flows

1. Import followed artists.
2. Scan artist metadata from artist page.
3. Run dashboard manual import flow.
4. Validate queue/history/retry/removal behavior.
5. Verify artist/album/track/video pages in mixed local/remote states.

Expected:
- Progress and completion states are accurate.
- Manual import candidates clear after successful apply.
- Queue counts/history remain consistent through lifecycle transitions.

### E. Visual and Interaction Review

Check Library, Artist, Album, Video, Dashboard, Monitoring, Search, and Settings on desktop and mobile.

Expected:
- Action states, spacing, icon sizing, and layout consistency are maintained.
- UltraBlur transitions remain smooth across page artwork changes.
- No clipped text, layout jumps, or console errors during normal navigation.

### F. Error Handling and Recovery

1. Trigger scans/downloads while disconnected from TIDAL.
2. Restart backend with active browser session.
3. Try nonexistent artist/album IDs.
4. Cancel/interrupt a download and inspect staging/final folders.

Expected:
- Errors are actionable and visible.
- App recovers from restart without auth/chunk-load regressions.
- Failed downloads do not leave stray files in final library paths.

### G. Control-Plane Endpoint and Dashboard Freshness Validation

1. Call `/api/tasks` with defaults and explicit filters (`status|statuses`, `category|categories`, `type|types`, `limit`, `offset`) and confirm it only returns task-surface rows (non-download command categories).
2. Call `/api/activity` with defaults and explicit filters and confirm the default response is history-oriented (`completed`, `failed`, `cancelled`) while still allowing explicit status/category/type overrides.
3. Call `/api/activity/events` and verify merged event-feed semantics: task + history sources, newest-first ordering, stable pagination (`limit`, `offset`, `hasMore`), and source-prefixed IDs (`task:<id>`, `history:<id>`).
4. Call `/api/status` and confirm response is summary-only (`activity`, `taskQueueStats`, `commandStats`, optional running/rate-limit fields), not a detailed task list.
5. Verify `/api/status/tasks` is no longer exposed.
6. Verify `/api/queue` remains the live queue source for active queue rows and reordering, and `GET /api/queue/history` returns completed/failed/cancelled download/import rows in `QueueItemContract` shape.
7. Verify Dashboard Queue History is populated from `/api/queue/history`, including `quality` badges where present, and does not depend on `/api/activity` row mapping.
8. Restart or interrupt the queue SSE connection during active download/import work and confirm the Queue tab reconciles correctly once SSE progress, full `/api/queue` refreshes, and global queue/job invalidation events arrive.
9. During a download-to-import transition, confirm the short grace window prevents an active row from disappearing before the authoritative queue refresh catches up.
10. In Dashboard Activity, trigger a background refresh while data is already visible and confirm stale data remains visible with a non-blocking "Updating activity"/"Showing cached activity" notice.
11. Validate Activity empty/error semantics: failed initial load with no cached rows -> "Activity unavailable"; successful load with no rows -> "No recent activity".

### H. Optimization Increment Perf Proxies and Targeted Checks

Use these as pragmatic perf/correctness proxies for this increment (not benchmark-grade profiling):

1. Filter parser consistency proxy:
   - Validate equivalent query inputs (`status` vs `statuses`, `category` vs `categories`, `type` vs `types`) on both `/api/tasks` and `/api/activity`.
   - Confirm invalid values return 400 with clear unsupported-filter messages.
2. Activity mapping efficiency proxy:
   - Seed activity pages with repeated artist/album/track/video references.
   - Confirm response latency remains stable as repeated references grow on the same page (batched lookup path), and descriptions remain populated.
3. Events merge pagination proxy:
   - Page `/api/activity/events` with offsets near start/middle/end while mixed task/history events are present.
   - Confirm deterministic ordering and consistent `total`/`hasMore` without endpoint timeouts or large response-time jumps between adjacent pages.
4. Pending queue-position scope proxy:
   - Query mixed status pages from `/api/activity` (for example pending+completed).
   - Confirm pending rows return absolute queue positions while non-pending rows omit queue position, and pagination does not require full pending-list enumeration.
5. Frontend active-tab gating and retry-suppression checks:
   - Keep Dashboard on Queue/Tasks tabs and verify Activity feed requests are not continuously refreshed until Activity is active.
   - In Activity tab, verify failed import retry button suppression when matching in-flight `/api/activity` rows exist.
   - Verify conservative suppression when in-flight feed reports `hasMore=true` even if first-page rows do not include a direct match.

Targeted automated checks to keep in CI/local loops for this increment:

- API/service and route checks in [api/src/services/activity.test.ts](api/src/services/activity.test.ts) and [api/src/routes/tasks-activity-split.test.ts](api/src/routes/tasks-activity-split.test.ts).
- Download queue route/contract checks in [api/src/routes/download-queue.test.ts](api/src/routes/download-queue.test.ts).
- Dashboard queue history/restoration and retry/gating checks in [e2e/queue-dialog.spec.ts](e2e/queue-dialog.spec.ts).

## 4. Optional Deep Inspection

Filesystem check:

Linux/macOS:
```bash
find ./library -type f -print
```

Windows PowerShell:
```powershell
Get-ChildItem .\library -Recurse | Select-Object FullName, Length
```

Database spot check:

```sql
SELECT media_id, file_type, file_path, quality, extension
FROM library_files
ORDER BY media_id, file_type;
```

Use this to confirm replacements, pruning, and sidecar toggles match disk state.

## 5. Release Checklist

- [ ] yarn lint passes
- [ ] yarn build passes
- [ ] yarn test:e2e passes
- [ ] Docker startup/build works
- [ ] Live TIDAL auth works with local or Docker runtime paths
- [ ] Quality transitions replace files safely
- [ ] Metadata toggle behavior matches disk and DB state
- [ ] No orphan media or sidecar files remain after prune/replacement flows
- [ ] Desktop and mobile UI feel consistent and production-ready
