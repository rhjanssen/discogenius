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
