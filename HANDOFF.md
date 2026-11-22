# Session Handoff

- **Branch**: `claude/sweet-hypatia-nywmuu`, from `main` 2.26.11. No PR opened. It covers the audit, the Primula live reports (21 Nov) and the PO's approval of all recommendations.
- **Done** (each has a test that fails without the change, unless noted):
  - **Retry of failed downloads** (live 404): the History panel retries by command id (`source=history`). An unqueueable job answers 422 with its reason, real errors come back as 503/500 with their message, and the API client shows a body's `error` field.
  - **Readable failures**: `presentFailure` (`api/src/services/commands/failure-presentation.ts`) gives queue, history and activity items a `failure` with category, summary, hint, optional action and the raw `detail`. `FailureNotice` shows the summary and hint, with the raw text behind Details. A failed fallback names the provider that actually failed.
  - **Curation write gate** (57 s live hold): `processAll` computes each edition's plan under its own gate and holds the gate only for the decision and its persistence (`planning: "caller"`).
  - **RefreshArtist stalls at 85%**: each provider reports its silent phases (`provider_phase`). When one finishes, the description names the providers still running and their phase.
  - **HTTP-thread writes outside the gate**, which failed with "database is locked" during curation:
    - file deletes (track, album, artist, video, track file, unmapped); these unlinked the file before the failing row delete;
    - artist monitor, unmonitor and policy changes, and artist delete;
    - video monitoring;
    - artist path;
    - provider reorder and disconnect (plans were never marked stale);
    - manual artist match and ignore;
    - task cancel;
    - the CheckUpgrades queued by a quality change.
  - **#167**: CheckUpgrades skips while ApplyCuration, DownloadMissing or DownloadMissingForce is live.
  - **#159**: Deezer "no data" output (error 800, "Error getting downloadable data", "no media URL") becomes `ProviderUnavailableError`, so the offer is marked unavailable and replanned.
    - Streamrip runs with `COLUMNS=400`, because rich wrapped its log lines.
    - The classifier skips traceback source lines and matches only the whole word `dns`.
    - A failed run leads with its Python exception line.
  - **yt-dlp**: a bare `ERROR:` keeps the surrounding stderr; "This video is not available" marks that video unavailable.
  - **Upgrade renames** release the replaced track's own lyrics and metadata (#42288's stray `.lrc`), keeping anything at the new file's stem.
  - **UI** (`docs/UX_AUDIT.md`):
    - nav labels and a System link;
    - paused-downloads MessageBar;
    - the provider warning as a MessageBar;
    - full action labels on desktop;
    - an empty queue as one line;
    - Status shows problems first;
    - an empty library offers "Add an artist", which focuses search;
    - Settings toasts give the reason.
- **Not done / proposals** (details in `docs/UX_AUDIT.md`):
  - a Wanted view (why each monitored album isn't downloading);
  - a log viewer;
  - splitting the Dashboard into Activity / Wanted / Library import / System;
  - `title=` to Fluent `Tooltip` (117 places);
  - "Retry all failed";
  - a health dot in the nav, which needs a cheap endpoint.
- **Not done / open questions**:
  - #42288's track 12 file went missing between 18:06:31 and about 18:09 UTC. The organizer moves the file before writing the row, so something removed it afterwards. Next data to collect:
    - `find /library -iname "*Save a Prayer*"`
    - the JSONL log lines for command 42288 between 18:05 and 18:10 UTC
  - Apple "Failed to get album response" (exit 0) repeats for albums 1121490551 and 674064561. They are not marked unavailable: one failure is too little evidence.
  - API auth is disabled while port 3737 is open on all interfaces. That is a product decision.
  - Deploys kill imports that are already moving files; they fail closed by design. Pause downloads and let running imports finish before deploying.
  - Open PRs `rhjanssen/discogenius#164` (#156) and `rhjanssen/discogenius#160` (#152) belong to Gemini. #160 overlaps the refresh-progress change in `refresh-artist-service.ts` and will need a rebase.
- **Verification** (final tree): `yarn lint`, `yarn typecheck` and `yarn build` exit 0. `yarn test:app`: 52 files, 204 tests passed. `yarn test:api`: 2800 tests, 2790 pass, 6 skipped (the same skips as `main`), 4 fail. No failure is new against the `main` baseline (names compared). The 4 are tests that fail in this sandbox on `main` as well:
  - "local search answers on an empty catalog" and "artist album upsert stores allowed provider supplements…" need DNS for `api.lidarr.audio`;
  - "a read-only album directory reports the permission cause" cannot fail as root;
  - whole files that hit "Unable to deserialize cloned data" pass when rerun in isolation (`metadata-files.test.ts` here: 11/11 on two clean runs).
- **Live-verified**: nothing; no LAN access. The UI was checked in Chromium against a scratch database seeded with the live failure texts.
- **Live checks after deploy** (Bastille / Bakermat):
  1. Retry a failed album from History: it queues; an unqueueable job shows its reason.
  2. During a curation pass, `sqliteWriteLock.longestHoldMs` stays at a few seconds, not ~57 s. Deleting files and unmonitoring an artist succeed.
  3. A refresh killed by the watchdog names the provider and phase it was waiting on.
  4. A delisted Deezer album fails once and is then not requeued. `KLW0TLSmdr4` is marked unavailable.
  5. Failed items read as a cause and a next step, with the raw text behind Details.
