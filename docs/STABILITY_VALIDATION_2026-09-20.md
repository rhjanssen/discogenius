# Discogenius 2.16.11 stability validation

## Live findings

The running 2.16.10 server had SQLite writer-admission failures in artist statistics, curation, provider identity updates, video catalog updates, and metadata sidecar indexing. Its diagnostics recorded a video-refresh writer hold of almost ten minutes. Synchronous dashboard totals also blocked HTTP handling.

A failed YouTube album acquisition had 24 staged files, none matching its 12 selected track IDs. The provider browse URL had produced a different playlist from the selected edition. Downloads now use explicit plan track IDs when available; canonical import matching remains strict.

The Apple wrapper's metadata port accepted connections, but its decryption port timed out with a full listen backlog. Four Apple downloader processes remained from the previous day. Worker termination did not terminate native downloaders. The release registers their process groups with the main thread and kills them on worker exit before recovery.

History retry used the same numeric namespace as live queue rows. The UI and API now explicitly distinguish the two. A regression test creates a collision and verifies that only the requested history item is requeued.

## Local validation

All local containers use isolated copies and volumes, without production library mounts.

- A fresh 10.1 GiB live database snapshot passed SQLite quick_check at schema 46. It contained 7,746,515 catalog tracks and 28,785 library files.
- The old synchronous statistics calculation took 1.89 seconds on the earlier 3.8-million-track copy. The worker calculation took 2.60 seconds on that copy while a 10 ms event-loop timer ran 255 times, with maximum additional delay below 1 ms.
- On the fresh 7.7-million-track snapshot, a cold worker calculation took 8.32 seconds while the timer ran 820 times, again with maximum additional delay below 1 ms. Moving this work off-thread preserves HTTP responsiveness; it does not make the underlying full-catalog count instant.
- The fresh-copy Bastille video repair pass completed in 12.60 seconds. Regression tests instrument the real better-sqlite3 prototype and verify that candidate reads are cached per pass and refreshed on the next pass.
- Browser-triggered Refresh & Scan completed for Bastille and Bakermat. A concurrent Bastille retag completed for 27 files with zero errors; the next preview reported no files needing retagging. Rename preview reported no changes.
- The Remove unmanaged tags switch saved and remained checked after a full browser reload.
- The release container downloaded and imported Bakermat's I Love Life through the album page and dashboard. Track Info showed one 31.6 MB, 24-bit, 44.1 kHz stereo FLAC in the expected canonical edition folder. Its subsequent tag preview was clean.
- Chrome played that imported file past 42 seconds without a media error. The Codex in-app browser buffered the audio but did not advance, so playback validation used Chrome.
- Native downloader termination was tested with a real child process on Windows and in the Linux release container. Linux tests distinguish an exited zombie awaiting reap from an executing process.
- The actual failed Peter Gabriel D.I.Y. FLAC was copied locally with its database row. A retag updated the canonical edition fields successfully, with no verification errors and a clean subsequent preview. The original transient verification failure was not reproduced; this is not evidence that every historical tagging failure is fixed.
- The failed YouTube i/o acquisition was replayed against the fresh database copy. All 12 selected provider tracks downloaded and imported into the intended canonical edition with verified tags. One track required a provider retry. This exposed two reporting issues now covered by the patch: duplicate staging formats inflated the processed count, and cached provider album membership supplied an unrelated expected total of 22.

## Release checks

Full yarn ci covers lint, backend/frontend type checking, API tests, frontend tests, and production builds. The baseline had no failing assertions. Known Node test-runner structured-clone failures were rerun in isolation, preserving the main TAP result when comparing failure names.

No schema change is included. Deployment must retain the current library/config volumes, verify the published version, check new logs and queue progress, and remove the temporary NAS SSH key after validation. The temporary NAS API key was already revoked after SSH access was established.

## Live deployment follow-up

Version 2.16.11 exposed a separate maintenance fault during its live validation. The overdue weekly backup wrote about 317 GB without completing a 6.7 GB destination because command-heartbeat writes came from another SQLite connection and repeatedly restarted the online backup. The task was cancelled, its incomplete file was removed, and 2.16.12 changes the backup to one SQLite snapshot step. Completed backups are renamed from a temporary path, so an interrupted run is never retained as a valid backup.

The fixed backup completed against the isolated 10.1 GiB live database copy in 252 seconds while a second SQLite connection committed 5,032 writes. The resulting 10,884,165,632-byte database passed `PRAGMA quick_check` and the temporary test backup was removed.

## September 26 live audit

After five days on 2.16.11, the container remained healthy but command-queue diagnostics were unhealthy. Monitoring refreshes for Andrew Bird, Alison Moyet, Avicii, and many other artists repeatedly reached the 30-minute no-progress watchdog while their workers still sent heartbeats. Every affected command's last description was `backfilling metadata files`; the monitored library saves lyrics, and those sidecar passes did not report per-item progress. Version 2.16.12 now reports album, lyric, and video sidecar work through the command's existing progress callback. This lets the watchdog distinguish a long backfill from a stuck operation, and exposes the current item in the UI.

The audit also found several `sqlite busy: database is locked` failures during file scans and one catalog statement timeout. Those are distinct faults and are not claimed as fixed by the backfill progress change.

The 2.16.12 candidate passed full `yarn ci`: 1,851 API tests, 181 app tests, lint, type checking, and both production builds. The local Docker image built and ran healthy against isolated library volumes. In the browser, Bakermat's imported `I Love Life` file still showed its 24-bit/44.1 kHz FLAC details, the tag preview found no required changes, and a fresh Bakermat Refresh & Scan completed without error. The focused backfill tests verified progress callbacks for album, lyric, and video work.

## September 26 follow-up

The 2.16.12 live deployment completed a queued backup while refresh and download workers were active. The 11,257,159,680-byte backup passed `PRAGMA quick_check`, and no partial backup remained. Avicii's recovered refresh entered album and lyric backfill with visible item counts, confirming that backfill progress reached the production command queue. The download queue had remained paused since the earlier backup investigation; it was resumed and a TIDAL album download advanced.

Progress also exposed the cost of two older queries. Avicii's lyric pass advanced only a few tracks per minute because each missing sidecar searched provider tracks before filtering by the matched artist. The live database has over 825,000 provider track rows across the lyric-capable providers. Scoping to accepted provider-to-canonical matches reduced Avicii's candidate set to 903 rows; the scoped ID lookup took 9 ms in a read-only live query. The filter retains both MBID and numeric artist links because 1,385 live recording rows have differing values for those two artist references.

Aretha Franklin's file scan advanced roughly one file every few minutes. `ProviderItems.provider_id` is already TEXT and indexed, but `CAST(provider_id AS TEXT)` in the scan's exact-ID lookups forced SQLite to scan `ProviderItems` and evaluate the artist-scope subqueries for each row. The 2.16.13 patch uses direct TEXT comparisons; `EXPLAIN QUERY PLAN` then selects `idx_provider_items_provider_id`. The local 2.16.13 container completed a browser-triggered Bakermat Refresh & Scan with no command error. The live impact of 2.16.13 must be checked after deployment; the 2.16.12 timings above are the baseline, not a claimed post-deploy improvement.

The local browser exposed an artist-page activity bug: after the completed Bakermat command, the button still showed `Scanning...` until reload, while `GET /api/v1/artist/:id/activity` already reported `scanning: false`. The page now refreshes activity while any artist job is active, refreshes after a scan is queued, and checks again when the window regains focus. This keeps the control state tied to the server rather than a missed SSE event.

Resuming the production download queue exposed TIDAL HTTP 400 failures at its token endpoint. The app's stored token still expired at 14:13 UTC, but tiddl began trying to refresh it at about 14:04 UTC. Discogenius checked credentials every 30 minutes and refreshed only when less than 25 minutes remained, leaving a window in which tiddl could attempt refresh first. A Discogenius-side refresh at 14:09 UTC succeeded (HTTP 200), synchronized a four-hour token to tiddl, and the next live TIDAL album transferred three tracks without the auth error. The queue was resumed. Version 2.16.13 checks every five minutes so this renewal runs ahead of tiddl; the next natural refresh cycle still needs live observation.
