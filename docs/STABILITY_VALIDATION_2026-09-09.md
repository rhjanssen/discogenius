# Concurrent media maintenance audit, 9 September 2026

## Production findings

Production 2.16.6 continued to fail under concurrent catalogue refresh, download/import, rename and retag work. Rename command 9665 stopped with `database is locked`; retag command 9666 stopped after processing 1,750 of 9,037 files. Newly failed imports included 33 Resolutions Per Minute and Squad Goals. These were failures after the update, not historical failures from 2.16.3.

The shared writer diagnostics recorded holds exceeding twelve minutes. API reads generally remained responsive, but waiting media writers could still exhaust their synchronous admission timeout. The dashboard was visually inspected and search used for Bastille. It showed inconsistent percentage/file counts and recent lock failures. Downloaded track checkmarks appeared for some jobs; their complete absence was not universal.

## Changes and Lidarr comparison

The reference `RenameTrackFileService.RenameFiles` moves each file, updates its record and then publishes its event. `BasicRepository` scopes database transactions to record updates and retries SQLite Busy writes. `CommandExecutor` runs handlers on command threads. This supports short database commits and independent media work, rather than moving the entire catalogue into memory or replaying a partially executed import.

Discogenius now awaits its shared writer queue at rename commits, audio/video retag fact updates, organizer media commits, sidecar record writes and post-import reconciliation/statistics. Media rewriting and primary file moves remain outside the database transaction. Existing rollback tests still verify that a failed rename commit restores the original file and duplicate sidecar.

Import progress uses the organizer's count and phase percentage. Previously, persisted progress could derive its file position from already completed downloads. Import events also use accumulated buffered track states when the database snapshot is behind.

## Query measurements

The planning context query used a LEFT JOIN to SelectedAcquisitionPlans. SQLite materialized that view across LibraryEditions before resolving the requested edition. Joining AcquisitionPlans through the same library, edition and preferred plan key preserves selection semantics and uses its unique index.

On the supplied production snapshot, alternating the old and new read-only queries for edition 420 gave:

| Read | Previous | Updated |
| --- | ---: | ---: |
| First sample | 815.94 ms | 0.14 ms |
| Warm sample 1 | 24.71 ms | 0.15 ms |
| Warm sample 2 | 22.23 ms | 0.15 ms |

An individual Apple release rematch, 1250077673, dropped from 1,316 ms to 249 ms with the same accepted track count. These are local measurements, not production throughput. This identifies one source of excess writer occupancy; it does not prove that every production hold has the same cause. Slow transactions now log their call site without requiring another profiling deployment.

## Runtime checks

An isolated test container used the previously fresh 2.16.6 test library, with 30 actual Bastille audio files. A naming change caused 60 media/sidecar renames during a Bastille refresh. A deliberately incorrect embedded title caused one actual retag. Both jobs completed without errors, and the naming configuration was restored through the API.

Goosebumps then downloaded and imported all five tracks. All 35 resulting audio files existed, were readable by ffprobe and retained recording MusicBrainz IDs. These tests use test volumes; production files and jobs were not retried or modified.

Active-schema regressions cover waiting behind another writer during rename and actual audio tag/cover writing, rollback after failed commits, indexed selected-plan lookup, and distinct import/download progress counts. The initial full test run exposed sidecar tests that failed to await the newly asynchronous operation; those callers were corrected.

## Verification limits

The repaired build must still be observed on the live server after deployment with its full provider graph and storage. The local snapshot does not contain working Apple credentials, and the longest production transaction was not reproduced locally. Do not describe the whole production workload as proven stable from these results alone.

## Final container and browser checks

The final 2.16.7 image also booted with entirely empty test volumes. Both the empty database and the populated 35-file library returned `quick_check = ok` with no foreign-key violations.

Browser checks loaded the live Bad Blood page at 1440-pixel desktop and 390-pixel mobile widths without JavaScript errors. The mobile document stayed within its viewport. The local 2.16.7 Goosebumps page showed all five imported files with their MAX quality. Its edition card also displayed "No accepted provider match" beside a selected plan; this needs a separate check of edition-offer wording versus track-based plans and is not evidence that the imported files are missing.

The two existing settings accessibility scans retain their assertions and now allow 30 seconds each. Under local load the old five-second timeout interrupted one scan and caused the following scan to report that axe was already running. Both scans passed when run separately with sufficient time.


Final full yarn ci passed: lint, both TypeScript checks, all 1,825 API tests, all 181 frontend tests and both production builds. The Docker build also passed. No newly failing tests remain.
