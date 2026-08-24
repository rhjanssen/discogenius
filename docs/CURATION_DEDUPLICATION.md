# Curation and discography deduplication

MusicBrainz is identity. Providers are availability. Each library (stereo, spatial, video by default) has its own wanted set. There are no stereo/spatial/video *slots* on a release group.

## Authorities

- MusicBrainz defines artists, release groups, releases, media, tracks, and recordings.
- Providers define offers. `ProviderItems` is the offer cache. There is no second provider catalog.
- `ProviderArtistMatches`, `ProviderEditionMatches`, `ProviderTrackMatches`, and `ProviderVideoMatches` are the only provider-to-canonical edges. There is no `ProviderItemMatches`.
- `LibraryAlbums` / `LibraryEditions` / `LibraryVideos` are wanted-in-this-library. Row existence is the statement. Unmonitor deletes the row.
- `AcquisitionPlanSources` and `AcquisitionPlanTracks` persist how this library will acquire this edition. Plans do not invent identity.

## Libraries, not slots

Stereo, spatial, and video are library roots. Spatial never fills stereo. A video can be selected in Video and absent from an audio library. That cannot live on the catalog row.

Wanted work is `LibraryAlbums` (the release group). Coverage is `LibraryEditions` (the releases you actually hold). Curation picks a representative edition and adds a supplemental only when it contributes recordings the representative cannot deliver. Unmonitored catalog editions never become folders.

## Runtime

1. Add/search resolves a MusicBrainz artist. Catalog facts land on `ArtistMetadata`. Membership is `LibraryArtists` only after add (schema 46).
2. Refresh syncs release groups into `Albums`, releases into `AlbumEditions`, plus tracks, recordings, and relations.
3. Providers supply edition offers. Typed matchers write edges.
4. Curation applies type/redundancy policy per library and writes `LibraryAlbums` / `LibraryEditions`.
5. Acquisition planning fits accepted sources onto each selected edition (`acquisition-plan-optimizer.ts`).
6. Download Missing queues incomplete plan assignments for that library.
7. Import writes `TrackFiles` and tags from canonical identity.

## Matching

Score provider albums against candidate MusicBrainz *releases* for the artist, not against a provider-invented release group. Evidence order: MB external links, UPC/ISRC, then title/version/date/type/shape. Online Servarr catalog often lacks ISRC/UPC; local-MB fills them. `provider-release-group-matcher.ts` still has a release-group-shaped entry point. Composite coverage belongs in acquisition plans, not in a generic match graph. A plan may combine several editions from one provider; cross-provider composites are unsupported.

## Type policy

Filter on the release group: album, EP, single, compilation, live, remix. Apply filters before solving coverage. Provider availability does not put a group in scope. A wanted album with no offer stays wanted and unavailable.

There is no album-level "monitor new tracks." Lidarr Album.Monitored is a boolean; Discogenius already has that as `LibraryAlbums` rows. Editions and plans decide coverage.

## Dedup

Compare recording sets across release groups. Keep the smallest set that covers the filtered discography. Keys: recording MBID, then ISRC, then title/duration/position. Artist-wide coverage (pick which groups to keep) is still open; per-edition set cover has shipped. See `docs/MATCHING_SET_COVER_DESIGN.md` and `docs/TASKS.md`.

## Queue

`DownloadMissing` reads acquisition plans for the library it was asked to fill. Files go to that library's root. A provider video is actionable only through an accepted `ProviderVideoMatches` edge onto a canonical `Recordings` row.

Outstanding work is in `docs/TASKS.md`.
