# Session Handoff

- **Last updated by:** Google Antigravity / Gemini
- **Active branch:** `agent/issue-98`
- **Related issue / PR:** Issue #98 (`Some Apple albums still fail entirely on 'Failed to dl aac-lc: Unavailable' after #94`)

## Done
- Identified and fixed the remaining paths treating per-track Apple `Failed to dl aac-lc: Unavailable` as a fatal album failure:
  1. **`downloadAlbumTrackOffers` in `download-processor.ts`**: When an album ran in `acquisitionMode: "trackOffers"` (e.g. greatest hits / compilation / retrospective albums where some tracks were already in the library, or selected missing tracks, or `download_mode: "tracks"`), a single unavailable track threw `ProviderUnavailableError` ("Failed to dl aac-lc: Unavailable"). With no same-provider fallback offer, it threw `error` directly, aborting the whole album without downloading remaining tracks or setting `warningMessage`.
     - Handled in both preflight and download loops: when an offer fails with `ProviderUnavailableError` or `isAppleUnavailableTrackError` and no fallback offer exists, it records the track in `unavailableOffers`, marks the track status as `"error"`, emits track progress, and continues to the remaining offers.
     - If all requested offers are unavailable (`completedOffersCount === 0`), fails clearly with `ProviderUnavailableError("All tracks unavailable: ...")`.
     - If at least one track succeeds (`completedOffersCount > 0`), finishes with `outcome: "completedWithWarning"` and warning message `Completed with N unavailable track(s) [...]`, allowing the organizer/importer to import available tracks and record wanted gaps.
  2. **`resolveAppleAlbumTrackIds` in `apple-music-backend.ts`**: In SQLite `ProviderItems`, releases have `entity_type = 'release'`. The query checked `album_item.entity_type = 'album'`, which never matched any rows and always returned `[]`. When an album was queued without explicit `request.trackIds` (e.g. via HTTP API) and track 1 failed, `unattemptedTrackIds` was empty, preventing follow-up single-track downloads. Fixed filter to `entity_type IN ('release', 'album')`.
  3. **`executeProcess` in `apple-music-backend.ts`**: Stderr lines matching `isAppleUnavailableTrackError` now record the track in `unavailableTracks` rather than being discarded.
  4. **`classifyDownloadFailure` in `download-failure-policy.ts`**: Explicitly classifies `isAppleUnavailableTrackError` as `"permanent"` to skip useless same-offer retries.
- Verified:
  - Unit & replay tests:
    - `downloadAlbumTrackOffers` multi-track test with shorter `Failed to dl aac-lc: Unavailable` downloading available tracks, recording unavailable tracks in `ProviderItems`, and completing with `completedWithWarning`.
    - `downloadAlbumTrackOffers` all-tracks unavailable failing clearly with `All tracks unavailable`.
    - `resolveAppleAlbumTrackIds` resolving track IDs for `entity_type: 'release'`.
    - Replaying all 4 named albums (*Collected*, *Time Signatures: A Career Retrospective*, *Renovating->Diverse City*, *Music by Ry Cooder*) with first-track failures successfully downloading available tracks and completing with warnings.
    - Stderr parsing for the shorter form `Failed to dl aac-lc: Unavailable` without `exited with code` prefix.
  - Full `yarn ci` (`yarn lint`, `yarn typecheck`, `yarn test:api` (all 2,652 tests pass), `yarn build`) passed cleanly.

## Open Questions / Follow-ups for PO
- None. Ready for review and merge.
