# Discogenius Backend Reference

## Authentication (Dual, Independent)
- Tidal OAuth device flow handled by api/src/services/tidal.ts.
  - Device flow: getTidalAuth() starts device flow, user enters code, checkDeviceAuth() polls for completion.
  - Tokens stored in tidal-dl-ng format (/config/tidal-dl-ng/token.json).
  - Tokens are synced to tidal-dl-ng format via syncTokenToTidalDlNg() after every save.
  - Tokens are also synced into Orpheus session storage via syncTokenToOrpheusSession() for music downloads.
  - Refresh via tidal-dl-ng auth check when expires_at is near or expired.
- App password (optional) uses ADMIN_PASSWORD env var and JWT in api/src/middleware/auth.ts.
  - If ADMIN_PASSWORD is unset, authMiddleware allows all requests.
  - All routes except /app-auth use the middleware.

## tidal-dl-ng CLI Integration
- Never implement download logic in Node.
- Spawn the CLI directly (api/src/services/tidal-dl-ng.ts):
  - Example: spawn(getTidalDlNgPath(), ["dl", url], { env: buildTidalDlNgEnv() })
- Config stored at /config/tidal-dl-ng in Docker (XDG_CONFIG_HOME=/config).
- Config files:
  - /config/tidal-dl-ng/settings.json
  - /config/tidal-dl-ng/token.json
- Quality mapping: HI_RES_LOSSLESS (max), LOSSLESS (high), HIGH (normal), LOW (low)
- Video quality: 1080 (fhd), 720 (hd), 480 (sd)

## Orpheus Integration
- Use Orpheus for music downloads: albums, tracks, and playlists.
- Runtime/bootstrap and session handling live in api/src/services/orpheus.ts.
- Orpheus session state lives under /config/orpheusdl/config/loginstorage.bin and must be written atomically; a zero-byte file will crash Orpheus with EOFError.
- Before starting an Orpheus download, sync the stored TIDAL token into Orpheus session storage.

## Database (better-sqlite3, synchronous)
- Use synchronous APIs only: .run(), .get(), .all().
- DB location in Docker: /config/discogenius.db.

## TypeScript backend guidance
- Discogenius uses TypeScript for backend runtime code; do not add new JavaScript files under `api/src`.
- The architecture target is Lidarr-style workflow rigor, not a C# clone. Preserve clear boundaries between routes, services, repositories, queue state, and import/organization flows.
- TypeScript does not protect runtime boundaries by itself. Validate API payloads, database row shapes, CLI responses, and filesystem-derived metadata before using them as trusted domain objects.
- Avoid broad `any` usage and ad hoc payload passing between services. Queue jobs, scan results, manual import matches, and organizer inputs should use stable named types.
- The main TypeScript backend risks here are weak runtime validation, route-heavy business logic, and hidden state transitions in long-running jobs.

### Core tables
- `Artists` / `ArtistMetadata`: managed artist state plus canonical MusicBrainz artist metadata
- `Albums`, `AlbumReleases`, `AlbumReleaseMedia`, `Tracks`, `Recordings`: canonical MusicBrainz/Lidarr-style metadata graph
- `ProviderItems` / `ReleaseGroupSlots`: provider availability, offer matching, and selected release-group slots
- `ProviderAlbums` / `ProviderMedia`: provider-primary compatibility cache while remaining read paths are retired
- `job_queue`: unified persistent task queue for exact download jobs, monitoring/control jobs like DownloadMissing and RescanAllRoots, and maintenance jobs like MoveArtist/RenameFiles/RetagFiles
- `TrackFiles`: local playable file tracking for tracks and videos
- `MetadataFiles`, `LyricFiles`, `ExtraFiles`: sidecar inventories
- `UnmappedFiles`: pre-existing local files awaiting Manual Import mapping

### Key relationships
- `Artists.mbid` links managed artists to `ArtistMetadata.mbid`.
- `Albums.mbid` is a MusicBrainz Release Group MBID.
- `AlbumReleases.release_group_mbid` links releases to release groups.
- `Tracks.release_mbid` and `Tracks.recording_mbid` link release tracks to recordings.
- `TrackFiles` stores canonical MBIDs plus provider provenance (`provider`, `provider_entity_type`, `provider_id`).

### Junction tables
- `AlbumArtists` and `ArtistReleaseGroups`: canonical MusicBrainz artist credit and release-group scope
- `ProviderAlbumArtists` and `ProviderMediaArtists`: compatibility artist relationships while provider-primary tables remain

### TrackFiles columns and types
- `file_path` TEXT UNIQUE (absolute path)
- `relative_path` TEXT (relative to library root)
- `library_root` TEXT (music, spatial_music, music_videos)
- `file_type` TEXT (`track` or `video` for playable media)
- canonical MBID columns (`canonical_artist_mbid`, `canonical_release_group_mbid`, `canonical_release_mbid`, `canonical_track_mbid`, `canonical_recording_mbid`)
- provider provenance (`provider`, `provider_entity_type`, `provider_id`)
- `naming_template`, `expected_path`, `needs_rename`

### Manual import surfaces
- `api/src/routes/unmapped.ts`: unmapped file list, identify, ignore/delete/map actions, and bulk mapping
- `api/src/services/unmapped-files.ts`: shared service boundary for unmapped file flows
- `api/src/services/import-discovery.ts`: root/library folder traversal, grouping, and local metadata rollups
- `api/src/services/import-matcher-service.ts`: direct-ID, search, and fingerprint-backed candidate resolution + scoring
- `api/src/services/manual-import-service.ts`: strict manual map/apply flow with dedup-safe DB writes
- `api/src/services/import-finalize-service.ts`: sidecar/finalize helpers and post-import rename reconciliation
- `api/src/services/identification-service.ts`: release/track matching used by Manual Import and scan-time auto-import
- `api/src/services/import-service.ts`: orchestration layer for root-folder/manual flows delegating matcher/apply/finalize services
- `api/src/services/library-metadata-backfill.ts`: metadata sidecar backfill for artist/album/track/video assets

## Monitoring and locks
- monitor BOOLEAN controls auto-scan/download.
- monitor_lock BOOLEAN prevents automated changes.
- Locked albums and media count as intentionally kept items for downloaded dashboard totals.
- Artist downloaded/completed counts must still be gated by monitored artist state or explicitly locked descendants, not by any downloaded child row alone.

## Quality tags
- Tags come from mediaMetadata.tags: DOLBY_ATMOS, HIRES_LOSSLESS, LOSSLESS.
- If HIRES_LOSSLESS is present alongside LOSSLESS, store only the highest quality tag in the DB.
- DB column: quality.

## Docker paths
- /config: configuration, database, tidal-dl-ng auth/settings, Orpheus state
- /downloads: temporary download staging
- /library: final organized music library
