# Lidarr Alignment Map

This document tracks the Discogenius backend surfaces that intentionally mirror Lidarr naming and workflow boundaries.

## Commands

| Lidarr command | Discogenius canonical command | Previous Discogenius name | Notes |
| --- | --- | --- | --- |
| `RefreshArtistCommand` | `RefreshArtist` | `RefreshArtist` | Already aligned. |
| `RefreshAlbumCommand` | `RefreshAlbum` | `ScanAlbum` | Discogenius album metadata refresh now uses Lidarr naming. |
| `RescanFoldersCommand` | `RescanFolders` | `RescanFolders` | Already aligned. Library-wide rescans still use `addNewArtists`. |
| `MoveArtistCommand` | `MoveArtist` | queued via `ApplyRenames` from artist path updates | Path updates now queue `MoveArtist`. |
| `RenameArtistCommand` | `RenameArtist` | `ApplyRenames` | Used for artist-wide rename plans. |
| `RenameFilesCommand` | `RenameFiles` | `ApplyRenames` | Used for selected/query-scoped rename plans. |
| `RetagArtistCommand` | `RetagArtist` | `ApplyRetags` | Used for artist-wide retag plans. |
| `RetagFilesCommand` | `RetagFiles` | `ApplyRetags` | Used for selected/query-scoped retag plans. |
| `BulkRefreshArtistCommand` | `BulkRefreshArtist` | `RefreshAllMonitored` | Queues a full monitored-artist metadata pass. |
| `CheckHealthCommand` | `CheckHealth` | `HealthCheck` | Manual health diagnostics command. |

## Services

| Lidarr service | Discogenius canonical service | Backing implementation | Status |
| --- | --- | --- | --- |
| `MoveArtistService` | `MoveArtistService` | `move-artist-service.ts` + rename queue | Aligned |
| `RenameTrackFileService` | `RenameTrackFileService` | `rename-track-file-service.ts` | Aligned, expected-path computation still shared with `LibraryFilesService` |
| `AudioTagService` | `AudioTagService` | `audio-tag-service.ts` | Aligned |
| `ManualImportService` | `ManualImportService` | `manual-import-service.ts` | Aligned |
| `DownloadedTracksImportService` | `DownloadedTracksImportService` | `downloaded-tracks-import-service.ts` | Aligned |
| `DiskScanService` | `DiskScanService` | `library-scan.ts` | Already aligned |
| `RefreshArtistService` | `RefreshArtistService` | `refresh-artist-service.ts` | Aligned |
| `RefreshAlbumService` | `RefreshAlbumService` | `refresh-album-service.ts` | Aligned |

## Partial Or Non-Analogues

| Lidarr surface | Discogenius analogue | Why not renamed directly |
| --- | --- | --- |
| `MediaFileService` | `LibraryFilesService` | Discogenius service owns rename previews, expected paths, tracked assets, and cleanup, not only file-row CRUD. |
| `FileNameBuilder` | `naming.ts` | Function-based builder today; needs a deeper extraction if we want a true class-level match. |
| `ArtistPathBuilder` | `artist-paths.ts` + `naming.ts` | Same reasoning as `FileNameBuilder`. |
| `DownloadedAlbumsCommandService` | `download-processor.ts` + `downloaded-tracks-import-service.ts` | Discogenius folds downloader orchestration and import dispatch differently. |
| no direct Lidarr analogue | `RefreshPlaylistService` | TIDAL playlist syncing is Discogenius-specific but now follows the same explicit refresh-service boundary. |
| no direct Lidarr analogue | `RefreshVideoService` | Lidarr has no music-video domain; Discogenius keeps it as a dedicated child refresh service. |
| no direct Lidarr analogue | `MediaSeedService` | Small single-item intake helper for track/video add flows; Lidarr spreads this across add/import services. |

## Migration Notes

- Existing `job_queue` rows are migrated at schema version `5` so legacy command types (`ScanAlbum`, `ApplyRenames`, `ApplyRetags`, `RefreshAllMonitored`, `HealthCheck`) are rewritten to their Lidarr-aligned names.
- History/activity rendering still understands the old names during the transition to keep older installations readable.
