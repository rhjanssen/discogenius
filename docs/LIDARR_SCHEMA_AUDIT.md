# Lidarr Schema Alignment Audit (2026-06-16, schema v22)

Comparison of Discogenius's 34 tables against Lidarr's 40. **Conclusion: the
canonical metadata graph is aligned; every table we add that Lidarr lacks maps
to a distinguishing feature; the only genuine misalignment is the legacy
`Provider*` set, already scheduled for retirement (see
[LIDARR_DB_ALIGNMENT_PLAN.md](LIDARR_DB_ALIGNMENT_PLAN.md)).** One redundant
index introduced during perf work was removed (`idx_mb_tracks_recording`).

## A. Aligned with Lidarr (same role)
| Discogenius | Lidarr |
|---|---|
| Artists | Artists |
| ArtistMetadata | ArtistMetadata |
| Albums (release groups) | Albums |
| AlbumReleases | AlbumReleases |
| Tracks | Tracks |
| TrackFiles | TrackFiles |
| ExtraFiles / MetadataFiles / LyricFiles | ExtraFiles / MetadataFiles / LyricFiles |
| quality_profiles | QualityProfiles |
| config | Config |
| scheduled_tasks | ScheduledTasks |
| job_queue | Commands |
| history_events | History |

## B. Ours that Lidarr lacks — justified by our feature set
| Table | Reason (distinguishing feature) |
|---|---|
| `Recordings` | Recording-level identity for tracks **and music videos**; Lidarr has no video library and folds recordings into Tracks. |
| `RecordingRelations` | Recording relationships used by our matching/dedup. |
| `ReleaseGroupSlots` | **Stereo / spatial(Atmos) / video slot selection** per release group — the core multi-library feature. |
| `ProviderItems` | **Provider-as-availability** model: persisted provider offers keyed to MB ids. Replaces Lidarr's transient indexer results. |
| `ArtistReleaseGroups` | Artist↔RG junction for appears-on / multi-artist discography. |
| `ArtistReleaseGroupCuration` | **Discography dedup/curation** decisions (our headline feature on top of release-type filtering). |
| `AlbumArtists` | Multi-artist / various-artist album credits (Lidarr uses a single `ArtistMetadataId`). |
| `AlbumReleaseMedia` | Per-disc/media rows (Lidarr embeds media as JSON on AlbumReleases). Candidate to fold into `AlbumReleases.data` later — low priority. |
| `metadata_identity_status` | MusicBrainz match status per entity (our matching pipeline). |
| `monitoring_runtime_state` | Monitoring-cycle progress/state. |
| `MediaCoverProxyCache` | Provider artwork proxy cache (we proxy provider images; Lidarr serves local MediaCover). |
| `UnmappedFiles` | Files that couldn't be matched on import (manual-import workflow). |
| `upgrade_queue` | Quality-upgrade queue. **Overlap:** Lidarr drives upgrades through the normal command queue — candidate to fold into `job_queue` later (low priority). |
| `database_version_history` | Migration audit log (Lidarr uses FluentMigrator's VersionInfo). |

## C. Legacy / misaligned — RETIRE (planned)
`ProviderAlbums`, `ProviderMedia`, `ProviderAlbumArtists`, `ProviderMediaArtists`,
`ProviderSimilarAlbums`, `ProviderSimilarArtists` — pre-2.0 provider-shaped
tables duplicating the canonical graph. Tracked in LIDARR_DB_ALIGNMENT_PLAN.md.
(Minor smell: their indexes use an `idx_album_artists_*` / `idx_media_*` prefix
that reads like the canonical tables' — resolves on retirement.)

## D. Lidarr has, we don't — N/A or future
- **N/A by design (torrent/usenet model):** Indexers, IndexerStatus,
  DownloadClients, DownloadClientStatus, RemotePathMappings, PendingReleases,
  Blocklist(release), DownloadHistory. We download exclusively via `tiddl`/TIDAL.
- **Config-driven for now (could move to DB):** RootFolders, NamingConfig,
  QualityDefinitions (we use `config.toml` + `quality_profiles`).
- **Curation covers it:** MetadataProfiles, ReleaseProfiles, DelayProfiles,
  CustomFormats, CustomFilters (our curation + filtering config).
- **Future features:** Tags, Notifications/NotificationStatus, ImportLists/
  ImportListStatus/ImportListExclusions, Users (multi-user). See roadmap.
- **Different mechanism:** Logs (we log to files via app-logger, not a DB table).

## E. Index health
- Removed redundant `idx_mb_tracks_recording` (duplicate of
  `idx_mb_tracks_recording_mbid`).
- Minor overlaps left in place (low risk): `idx_track_files_canonical_recording`
  vs `..._canonical_recording_type`, and `..._canonical_track` vs `..._type` —
  the composite indexes also serve the single-column lookups; can be pruned
  during the Provider* migration cleanup.
- Hot paths added during perf work are covered: `idx_recordings_artist_mbid`,
  `idx_provider_items_provider_id`, release-group-scoped query rewrites.
