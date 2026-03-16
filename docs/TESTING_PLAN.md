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

Expected:
- Embedded metadata follows setting state.
- Sidecars are created only when enabled.
- Disabled sidecars are pruned cleanly.
- No duplicate sidecar buildup or orphan DB file rows.

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
