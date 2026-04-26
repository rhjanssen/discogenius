# Lidarr Monitoring Model And Discogenius Alignment

Last updated: 2026-04-26

## What Lidarr Actually Monitors

Lidarr's music model is not Sonarr's series/season/episode model copied over to tracks.

The relevant levels are:

- `Artist.Monitored`
- `Album.Monitored`
- `AlbumRelease.Monitored`
- `Track.TrackFileId` / file state

Tracks do not have their own `Monitored` flag in Lidarr. Tracks are children of an album release, and the selected monitored release determines which tracks are expected. Missing/wanted logic then checks file state for those tracks.

Reference points in the local Lidarr checkout:

- `.ref_lidarr/src/NzbDrone.Core/Music/Model/Artist.cs`
- `.ref_lidarr/src/NzbDrone.Core/Music/Model/Album.cs`
- `.ref_lidarr/src/NzbDrone.Core/Music/Model/Release.cs`
- `.ref_lidarr/src/NzbDrone.Core/Music/Model/Track.cs`
- `.ref_lidarr/src/NzbDrone.Core/Music/Repositories/TrackRepository.cs`
- `.ref_lidarr/src/NzbDrone.Core/IndexerSearch/AlbumSearchService.cs`

## Exact Release Selection

Lidarr stores multiple `AlbumRelease` rows under one `Album`.

During refresh, Lidarr makes sure only one release is monitored by default. Its selection prefers:

1. a release that was already monitored,
2. the release with the most existing files,
3. the release with the highest track count.

That is close to the behavior Discogenius needs, with Discogenius-specific additions:

- keep standard, deluxe, anniversary, clean/explicit, and spatial variants distinguishable,
- prefer provider-available candidates,
- use UPC and exact MusicBrainz release IDs when present,
- use ISRC/tracklist coverage when UPC is missing,
- apply simpler stereo/spatial/video quality preferences.

## Current Discogenius Mismatch

Today Discogenius mostly stores provider albums directly in `albums`.

That makes a single row act like several different Lidarr concepts:

- Lidarr `Album` album concept / release group,
- Lidarr `AlbumRelease` exact edition,
- provider availability candidate.

The `media.monitor` flag also exists today. It is useful for compatibility and manual one-off track downloads, but it should not be the core discography curation unit. Core music curation should select releases; tracks should be expected because their selected release is wanted.

Music videos are a Discogenius extension. They can keep their own monitored state because Lidarr has no equivalent music-video domain.

## Target Discogenius Monitoring Model

Discogenius should align to Lidarr like this:

| Product level | Lidarr concept | Discogenius target |
| --- | --- | --- |
| Artist | `Artist.Monitored` | `artists.monitor` |
| Album concept | `Album.Monitored` | canonical release group / album concept row |
| Exact edition | `AlbumRelease.Monitored` | selected exact MusicBrainz/provider release |
| Track | no monitor flag | derived expected track/file state from selected release |
| Music video | no Lidarr equivalent | Discogenius video monitor |

## Wanted Semantics

The normal wanted units should be:

- release/album targets for music,
- video targets for music videos.

Track targets should be treated as manual or legacy partial-track targets, not as the default discography model.

This matters because redundancy filtering is a release-selection problem, not a track-monitoring problem. A single should become unwatched because its recording is covered by a selected album release; individual tracks should not become first-class curation targets unless the user explicitly asked for a track-only item.

## Migration Direction

1. Keep existing `artists.monitor`, `albums.monitor`, and `media.monitor` working for compatibility.
2. Treat `media.monitor` as derived/manual in new backend contracts.
3. Introduce a canonical album-concept layer separate from exact provider releases.
4. Store selected exact release per album concept, equivalent to Lidarr's monitored `AlbumRelease`.
5. Make wanted/redundancy UI explain whether an item is wanted because of artist, album, exact release, manual track, or music-video state.
6. Once compatibility is stable, stop writing track monitor state from curation except as a derived cache or migration bridge.
