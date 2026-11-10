# Session Handoff

- **Last updated by:** Antigravity
- **Date:** 2026-11-09
- **Active branch:** `agent/issue-73`
- **Related issue / PR:** Issue #73 / PR #89 (`Use MusicBrainz track credit for track artist tags`)

## Done in last session
- Fixed `MusicBrainzArtistCreditService.materializeIntegerCreditsForReleaseGroup` so it never copies multi-artist release-group credits onto `TrackArtistCredits` or `RecordingArtistCredits` (without deleting genuine duet/collab track credits), while single-artist release groups seed missing track/recording credits with the canonical `ArtistMetadata.name` instead of release-group `credited_name`.
- Removed `TrackArtistCreditNames` and reused existing credit tables (`TrackArtistCredits`, `RecordingArtistCredits`, `ReleaseArtistCredits`, `ReleaseGroupArtistCredits`, `ArtistMetadata`) across `TrackArtistCreditSync`, `AudioTagService`, `/ws/2` mapping (`musicbrainz-ws-mapping.ts`), and `ServarrMetadataService.reconcileReleaseGroupDetail`.
- Fixed `ensureMonitoredArtist` in `followed-artists-import.ts` to resolve artist folders from canonical MusicBrainz `ArtistMetadata.name` instead of provider spelling (`"Bangles"` / `"AFROJACK"`).
- Added unit/fixture coverage for `Afrojack feat. Eva Simons`, `Diana Ross & The Supremes`, `Tom Waits` / `Crystal Gayle` (`ARTISTSORT` and full-credit `ALBUMARTIST` join phrases), genuine duet/collab WS track credit preservation during `reconcileReleaseGroupDetail`, and provider spelling resolution (`"Bangles"` -> `"The Bangles"`).
- Updated stale comment in `api/src/database/schema/artist-locale-aliases.ts`.
- Verified full `yarn ci` passes (`yarn lint`, `yarn typecheck`, `yarn test:api`, `yarn test:app`, `yarn build`).

## Half-done / in progress
- None.

## Verified against running container
- Cloud runner (no LAN access); live verification against **Bastille** and **Bakermat** on the LAN container is ready for LAN agent / post-merge verification.

## Open questions for Product Owner (Homelab Bot / Robert)
- Ready for review and live container verification on **Bastille** and **Bakermat**.
