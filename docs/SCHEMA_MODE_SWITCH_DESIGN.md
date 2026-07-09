# Schema design for mode-switching (MB-local ↔ Servarr) — the lock-in target

Status: **finalized design**, ready to implement. No migration code (fresh DB per
the pre-1.0 workflow; wipe + regenerate).

## 1. Goal

Support switching catalog source at runtime:
- **MB-local mode:** flush the catalog tables, live-query the musicbrainz-docker
  Postgres. The Discogenius DB holds only app state + provider data.
- **Servarr mode:** populate the catalog tables locally from Servarr metadata.
- Switching MB→Servarr repopulates the catalog from MB, then layers Servarr on top.

**Invariant:** a catalog flush touches *only* the catalog layer. All app state —
monitoring, curation, provider offers/matches, files, and videos — survives,
keyed by **MBID value** (never a cascading FK into the catalog).

## 2. Two layers (Lidarr already does this for artists)

Lidarr splits `Artist` (app: `Monitored`, `Path`, `ProfileId`) from
`ArtistMetadata` (catalog). We extend the same split to the whole graph, because
we flush the catalog and Lidarr never does.

### Catalog layer — flushable, MB mirror (no app state, nothing app-side cascades to it)
`ArtistMetadata`, `Albums` (release groups), `AlbumReleases`, `Tracks`,
`Recordings` (audio only — see §6 for videos), `AlbumArtists`,
`ArtistReleaseGroups` (artist↔RG membership), `RecordingRelations`.

### App layer — persistent, MBID-keyed by value
`Artists` (monitored/path ✓), `Videos` (**new**, §6), `ProviderItems` (§4),
`ProviderItemMatches` (§4), `ReleaseGroupSlots` (§5), `ArtistReleaseGroupCuration`,
`TrackFiles`/`ExtraFiles`/`LyricFiles`/`MetadataFiles`/`UnmappedFiles`,
`ArtistStatistics`, `MediaCoverProxyCache`, infra (`commands`, `config`, …).

## 3. Provider API field reference (from live TIDAL responses + capability audit)

Real TIDAL shapes (from cached responses):
- **track:** id, title, duration, **replayGain, peak**, trackNumber, volumeNumber,
  version, popularity, **copyright**, bpm, key/keyScale, url, isrc, explicit,
  audioQuality, audioModes, artist(s), album.
- **album:** id, title, duration, numberOfTracks, numberOfVideos, numberOfVolumes,
  releaseDate, copyright, type, version, url, cover, vibrantColor, videoCover,
  explicit, upc, popularity, audioQuality, audioModes, artist(s).

Cross-provider (see `PROVIDER_CAPABILITY_AUDIT.md`): ISRC/UPC present on
TIDAL/Apple/Spotify/Deezer; absent on YouTube; Amazon gated. So every MB link and
identity field stays **optional**.

## 4. `ProviderItems` (facts) vs `ProviderItemMatches` (edges)

Complete the separation that already half-exists.

**`ProviderItems` = provider-native facts only** (mode-independent, never touched
by a flush). Drop the denormalized MB link + match columns
(`artist_mbid/release_group_mbid/release_mbid/track_mbid/recording_mbid`,
`match_status/confidence/method/evidence`, `album_id/track_id/recording_id`) —
those belong to the edge table. Keep/add the fact columns:
- common: `provider, entity_type, provider_id, title, version, quality,
  audio_quality, cover, asset_id, provider_url, availability, popularity,
  explicit, copyright, release_date, updated_at`
- album: `type, upc, volume_count` (have), + `track_count`
- track: `isrc, duration, track_number, volume_number` (have), + **`replay_gain`,
  `peak`** (the notable gap — provider is the *only* source; MB has no ReplayGain)
- optional/niche: `bpm, musical_key`
- artist: `provider_artist_name, picture(cover), popularity`

**`ProviderItemMatches` = the authoritative provider↔MB edge** (already exists,
MBID-keyed, supports one-to-many). This becomes the single source of the match,
which the recording-centric coverage model needs: a provider album covering
recordings across several MB releases is several edge rows, not one column.

Payoff: `ProviderItems` is 100% mode-independent; the edges are MBID-keyed and
survive a flush; the duplication (two sources of the match) that caused prior
drift is gone.

## 5. Monitoring model — artist + release-group only (Lidarr)

Lidarr's `Track` has **no** `Monitored`; monitoring is `Artist.Monitored`
(+`MonitorNewItems`) and `Album.Monitored` (+`AnyReleaseOk`). Adopt the same:

- **Keep:** artist-level (`Artists.monitored` + monitor-new-items) and
  release-group-level monitoring in the **app layer**. `ReleaseGroupSlots` already
  holds per-`(RG, slot)` `monitored` + `monitored_lock` (stereo/spatial/video) —
  that is our RG-level monitoring home; it just needs decoupling from the catalog
  cascade (§7).
- **Drop:** `monitored` on `Recordings`, `Tracks`, `AlbumReleases` — Lidarr has
  none of these and they sit on flushable tables anyway.
- **Videos:** monitored on the app-owned `Videos` table (§6), independent of
  albums.

## 6. Videos — provider-first, MusicBrainz-optional (the sparse-coverage answer)

Videos are the one media type where MB is the exception, not the spine: most are
provider-only (no MB recording), usually no album, sparse metadata. Today they
live in the catalog `Recordings` table (`is_video=1`), so **a flush deletes the
provider-only ones** (confirmed: 3 for Bakermat). Lidarr is no guide here (audio
only).

**Design:** a persistent app-owned **`Videos`** table:
```
Videos(
  id, artist_mbid,                     -- artist link (value)
  recording_mbid  NULL,                -- MB video recording when one exists (enrichment)
  release_group_mbid NULL,             -- rare album association
  title, provider, provider_id,        -- selected provider offer
  duration, cover, quality, release_date,
  monitored, monitored_lock, updated_at )
```
- No album ⇒ `release_group_mbid` null. No MB ⇒ `recording_mbid` null. Sparse
  metadata ⇒ nullable fact columns filled by whatever the provider gives.
- Raw offers stay in `ProviderItems(entity_type='video')`; `ProviderItemMatches`
  links a video offer → MB recording *iff* one exists. When MB has the video,
  the catalog `Recordings` row enriches it; when flushed, the `Videos` row (and
  its file via `TrackFiles`) persists.
- `TrackFiles` already keys video files by `canonical_recording_mbid` OR
  `provider_id` (for mbid-less videos) — so file↔video survives a flush.

This makes videos first-class and flush-safe, and the video↔audio and video↔MB
matching we already do becomes enrichment on top.

## 7. Decouple app state from the catalog cascade

Today `ReleaseGroupSlots` and `ArtistReleaseGroupCuration` have
`REFERENCES Albums(mbid) ON DELETE CASCADE` — a flush cascades straight through
them, destroying selection/curation/monitoring. Change those (and any other
app-layer FKs into the catalog) to **MBID value references with no FK**, mirroring
`TrackFiles` (which already uses `canonical_*_mbid` values + `ON DELETE SET NULL`
integer FKs). Keep integer FKs only *within* a layer.

## 8. Column gaps to add (this pass)

- `ProviderItems.replay_gain`, `ProviderItems.peak` (track) — needed for
  ReplayGain tagging in MB mode.
- `ProviderItems.track_count` (album) — currently derived.
- optional: `ProviderItems.bpm`, `ProviderItems.musical_key`.
- `Videos` table (§6).

## 9. Implementation order (no migration; wipe + regenerate + golden-verify)

1. Add the `Videos` app table; move provider-video creation there (out of
   `Recordings`); repoint the video read/download/monitor paths.
2. Add `ProviderItems.replay_gain/peak/track_count`; populate from the provider.
3. Make `ProviderItemMatches` authoritative; drop the denormalized MB link + match
   columns from `ProviderItems`; repoint readers to the edge table.
4. Move monitoring off catalog tables; drop `Recordings/Tracks/AlbumReleases`
   `monitored`.
5. Convert `ReleaseGroupSlots`/`ArtistReleaseGroupCuration` catalog FKs to MBID
   values.
6. Bump schema version; wipe; rescan the golden artist set; regenerate goldens;
   full suite.

Each step is verifiable against the golden-master matcher tests + a wipe/rescan.
Steps 1–2 are additive and low-risk; 3–5 are the structural decoupling and want
the golden net + a mode-switch smoke test (scan in Servarr, flush, confirm app
state intact).
