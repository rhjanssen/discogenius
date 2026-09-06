# Release 2.16.4 validation

Validated on 6 September 2026 against a newly created Docker container with separate empty config, database, download and library volumes. Production storage was not mounted or modified. TIDAL credentials were copied into the test config after the empty-state checks.

- Full `yarn ci` passed: lint, typechecks, 1,792 API tests, 175 frontend tests and both production builds. Vite retains its existing large-chunk warning.
- Docker image built successfully. Fresh startup initialized schema 46 and the packaged command/download workers.
- Eight navigation/authentication browser tests and seven settings/dashboard tests passed.
- Added Bastille through the API. Catalog intake and provider matching completed. Removed surplus queued test acquisitions after intake; four album acquisition jobs completed, including a two-track Bad Blood request built from its selected plan in `trackOffers` mode.
- Probed all 25 imported files. All are stereo FLAC in library 1, have exact provider item links and canonical recording identity, and contain MusicBrainz recording/album tags. No missing or misplaced files were found.
- Rename preview reported zero unexpected changes, missing files or conflicts. Retagging an already-correct file completed with zero changes and zero errors.
- Restarted the container and repeated file, database and queue checks. All 25 files remained valid, SQLite quick-check passed, foreign-key check returned no violations, and the queue was empty.
- An early direct-provider track request, submitted before canonical matching completed, failed closed with `Album 131971385 has no unique canonical release group`. It produced no library file. Subsequent planned acquisitions completed.

The measured two-track request spent 11.97 and 12.79 seconds inside its TIDAL backend calls; processor preparation took 0 ms. Those times include downloader startup and transfer. This is not a before/after bandwidth benchmark. This patch removes duplicate preparation and adds timing visibility; it does not introduce concurrent track batching.

Regression coverage now includes mono-provider manifests, stale provider item IDs, explicit library/slot authority, ambiguous progress updates, bitrate units, terminal import cancellation and watchdog startup. The acquisition-planning and composite-plan suites now create the active schema.

The review's broader shared-dialog/form work, remaining production-fixture migrations and batching benchmarks remain follow-up improvements. Existing production files misplaced by earlier versions were not moved; repairing them still needs an exact-file destination/conflict check.
