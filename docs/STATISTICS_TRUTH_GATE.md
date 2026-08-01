# Statistics truth gate

This gate covers the user-visible dashboard/Library counters returned by
`GET /api/v1/stats` and the persisted `ArtistStatistics` rows read by the Artist
table. It boots the active production schema (`initDatabase()`, schema 42); it
does not use the aspirational `domain-v41` fixture.

## Authorities

| Statistic | Authority |
| --- | --- |
| Artist/Album/Track/Video totals | canonical `Artists`, `Albums`, `Tracks`, and `Recordings` |
| monitored Artists | `LibraryArtists.monitored = 1` in enabled Libraries |
| monitored Albums/Editions | `LibraryAlbums` / `LibraryEditions` row existence in enabled audio Libraries |
| monitored Videos | `LibraryVideos` row existence in enabled Libraries |
| audio completion | every exact `(library_id, track_id)` requirement has an audio `TrackFiles` row |
| video completion | every persisted placement's exact `(library_id, recording_id)` requirement has a video `TrackFiles` row |
| file count/size | `TrackFiles` row count and `SUM(file_size)` |
| Artist table counts | persisted `ArtistStatistics`, refreshed from the same selected-Library requirements |

Provider matches and Acquisition Plans are evidence and execution choices. They
do not change catalogue totals, monitoring, or completion until curation writes
Library rows or import writes a `TrackFiles` row.

## Invalidation

`library.updated` is emitted after direct Artist/Album/Edition/Video monitoring
and curation writes. It is bridged from command workers to the main thread,
clears the server's ten-second snapshot immediately, travels over global SSE,
and invalidates the shared Dashboard/Library query in the browser.

File add/delete/upgrade, metadata refresh, scan, config changes, and terminal
command events retain their existing server invalidation. Manual file deletion
also refreshes the bounded affected `ArtistStatistics` rows before its route
returns. Album/Edition mutations refresh primary and credited Artist projections
for the affected release group rather than rebuilding every Artist.

`ArtistStatistics` follows persisted enabled-Library selections. A legacy
`include_spatial` acquisition-policy switch does not erase an existing Spatial
completion requirement; withdrawing the `LibraryAlbums`/`LibraryEditions` rows
does.

## Deterministic evidence

`statistics-truth-gate.test.ts` compares four readers after every transition:

1. independent direct-SQL/JS truth;
2. `LibraryStatsQueryService`, including hot-cache identity;
3. the real Express statistics route plus runtime contract parser;
4. persisted `ArtistStatistics`.

The transitions are canonical metadata refresh, typed provider match, Artist
monitoring, Edition curation, partial and complete Stereo import, Spatial
selection and completion, Video selection and completion, manual file deletion,
per-Library Album unmonitor, Artist/Video unmonitor, and a fresh-process read of
the same SQLite database.

The pre-existing global-statistics suite separately covers collaboration
deduplication, duplicate/unselected video files, disabled Libraries, and strict
Stereo-plus-Spatial completion.

## Scale result

Run `statistics-truth-scale-seed2803` used the corrected deterministic load
fixture:

- schema 42;
- 2,500 Artists (500 monitored);
- 1,240 Albums, 1,792 Editions;
- 16,036 Track rows (16,023 audio Track occurrences);
- 14,138 Recordings;
- 1,550 LibraryAlbums, 1,588 LibraryEditions, 126 LibraryVideos;
- 245 TrackFiles;
- 104,519 command-history/queue rows.

On the Windows host, nine forced global recomputations measured 50.7 ms cold,
44.2 ms warm median, and 52.4 ms warm p95. A full refresh of all 2,500
`ArtistStatistics` rows took 129.5 ms. `PRAGMA quick_check` returned `ok` and
`foreign_key_check` returned zero rows.

The exact completion probes use the partial
`idx_track_files_audio_completion`/`idx_track_files_video_completion` indexes.
The global recomputation is still synchronous on the main event loop; roughly
40–52 ms at this fixture size is measured, not free.

## Remaining release edges

This gate does not prove:

- statistics after real rename, retag, move, upgrade replacement, unknown
  import/manual mapping, corrupt-media recovery, or provider-availability
  changes;
- quality distribution, Acquisition Plan coverage, missing/unavailable,
  upgrade-candidate, queue, or scheduled-task counters outside
  `LibraryStatsContract`;
- a 100,000-file inventory or a multi-hour mixed-write soak;
- rendered browser values across desktop/tablet/mobile, SSE reconnect storms,
  or accessibility announcements;
- live MusicBrainz, Servarr, TIDAL, or Apple Music lifecycle behavior.

Those capabilities remain separate release-readiness gates. This focused test
must not be used to claim the complete statistics matrix or long-soak result
passed.
