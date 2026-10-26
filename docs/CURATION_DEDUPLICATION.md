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
2. Refresh syncs release groups into `Albums`, releases into `AlbumEditions`, plus tracks, recordings, and relations. A MusicBrainz recording redirect re-keys video artwork onto the surviving recording in that edition write. An obsolete track detaches or re-points `LibraryVideos` instead of failing the artist. Owned audio `TrackFiles` and a live download/import snapshot still fail closed.
3. Providers supply edition offers. Typed matchers write edges.
4. Curation applies type/redundancy policy per library and writes `LibraryAlbums` / `LibraryEditions`.
5. Acquisition planning fits accepted sources onto each selected edition (`acquisition-plan-optimizer.ts`).
6. Download Missing queues incomplete plan assignments for that library.
7. Import writes `TrackFiles` and tags from canonical identity.

## Matching

Score provider albums against candidate MusicBrainz *releases* for the artist, not against a provider-invented release group. Evidence order: MB external links, UPC/ISRC, then title/version/date/type/shape. Online Servarr catalog often lacks ISRC/UPC; local-MB fills them. `provider-release-group-matcher.ts` still has a release-group-shaped entry point. Composite coverage belongs in acquisition plans, not in a generic match graph. A plan may combine several editions from one provider; cross-provider composites are unsupported.

Track matches store `matcher_version`. That stamp is a cache generation, not a veto: an automatic edge from an older matcher stays an acquisition candidate and a download fallback until a local replay rewrites it. A manual edge stays. Matcher version 5 accepts a provider item for none of the canonical tracks when the stored rows offer that item for more than one of them, including when every slot shares a title and a runtime inside the 10s grace. A duplicate listing of one track still matches. Two distinct provider items that share a title or an ISRC still match both slots. The planner (version 3) applies that rule to the candidate rows and still assigns one provider item to one track. A stored plan that names the same provider item for two tracks, or whose edition still accepts that item for another track, is blocked at download evaluation (`ambiguous_offer`) before any bytes are fetched. An older matcher version is not `offer_refresh_required`. After listen, a background pass replays stale automatic matches from stored provider rows, pending downloads first. Each release commits in its own write-gate transaction. A plan owned by a running download defers that release until the download releases it; the rest of the batch commits, and the deferred release is not dropped for the process lifetime. When the automatic assignments are unchanged, the replay stamps the new matcher version and the plan's policy hash and does not rebuild the plan. `matcher_version` stays in that hash. The priority join (editions that still owe a file) is read once per process. Artist refresh uses the same local replay and defers the same way, one release at a time. Neither calls the provider. A per-track fallback inside an album download stays on the command provider; a whole-album fallback switches the provider and remaps every offer.

## Automatic curation and user decisions

`enable_redundancy_filter` stays the config key. The settings label is Automatic curation. Default remains on, so existing installs do not change behaviour until someone turns it off.

Off is plain Lidarr. Adding an artist monitors one edition per release group inside the selected types and statuses. The app does not auto-unmonitor. Only a person, an artist unmonitor, or a type/status setting changes that. Selection, compilation gap-fill, empty-album pruning, and redundancy pruning all stay gated.

On, curation monitors the editions needed to cover the discography. Several editions of one release group are allowed. Only then does it auto-unmonitor a redundant edition.

A manual monitor, unmonitor, or edition pick sets `decision = 'user'` (`LibraryAlbums.locked = 1` for the album, `LibraryEditions.selection_mode = 'manual'` for that edition). Rows that were already locked migrate to `decision = 'user'`. User unmonitor deletes the monitored rows and writes `LibraryUserExclusions` (release group, or one edition). The next pass, in either mode, skips that exclusion, and compilation gap-fill does not treat those recordings as a hole to fill. Curation never overrides a user decision. Back to automatic clears the exclusion, sets `decision` back to `curation`, and recomputes. The album page shows who decided: "Unmonitored by curation: replaced by <edition>", "Waiting for replacement: N of M tracks covered", "Unmonitored by you", or "Chosen by you".

File ownership does not keep an edition. An edition that still has files stays monitored only when an accepted automatic track match is older than the current matcher, so a stale match cannot unmonitor it or delete its files. With Remove unmonitored files on, a user unmonitor deletes that album's files immediately. A curation unmonitor deletes a file only when the same recording (recording id or canonical recording MBID) already has a file on a monitored edition. Partial coverage deletes only the covered files. A different recording of the same song is not coverage. Unmapped files, and files not yet imported, are never deleted. After a successful import, the unmonitored editions that share those recordings are settled without a library-wide scan. The regular curation pass is the fallback. Every delete is logged per file with the reason, and the preview counts only files that would actually be deleted. The representative edition is the `LibraryEditions.representative` row (`selected_release_mbid`). Compilations are checked against the original discography first and keep only tracks no original release covers.

No `user_version` bump. `decision` on `LibraryAlbums` and `LibraryEditions`, plus `LibraryUserExclusions` and `LibraryCurationOutcomes`, are added in place (schema stays 46).

## Type policy

Filter on the release group: album, EP, single, compilation, live, remix. Apply filters before solving coverage. Provider availability does not put a group in scope. A wanted album with no offer stays wanted and unavailable.

There is no album-level "monitor new tracks." Lidarr Album.Monitored is a boolean; Discogenius already has that as `LibraryAlbums` rows. Editions and plans decide coverage.

## Dedup

Compare recording sets across release groups. Keep the smallest set that covers the filtered discography. Keys: recording MBID, then ISRC, then title/duration/position. Artist-wide coverage (pick which groups to keep) is still open; per-edition set cover has shipped. See `docs/MATCHING_SET_COVER_DESIGN.md` and `docs/TASKS.md`.

## Queue

`DownloadMissing` reads acquisition plans for the library it was asked to fill. Files go to that library's root. A provider video is actionable only through an accepted `ProviderVideoMatches` edge onto a canonical `Recordings` row.

Outstanding work is in `docs/TASKS.md`.
