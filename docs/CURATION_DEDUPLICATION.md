# Curation Workflow

Last updated: 2026-05-21

Discogenius curation is MusicBrainz release-group based. It no longer runs the old provider-album redundancy engine as a runtime fallback.

## Source Of Truth

- MusicBrainz/Lidarr metadata defines artists, release groups, releases, media, tracks, and recordings.
- Streaming providers define availability and actionable resources.
- `ReleaseGroupSlots` connects the two by selecting provider offers for each library slot.
- `ProviderItems` is the single provider-offer cache. Discogenius intentionally does not maintain a second provider-shaped catalog beside the MusicBrainz graph.
- Provider rows store normalized availability/action evidence, not full raw catalog responses.

## Slots

Each wanted release group can have independent slots:

- `stereo`: normal audio library target.
- `spatial`: surround/spatial audio library target. The core uses format-agnostic wording; providers expose native labels such as `DOLBY_ATMOS`.
- `video`: currently provider-discovered music videos, with MusicBrainz recording links added only when evidence is strong enough.

## Runtime Flow

1. Artist add/search resolves to a MusicBrainz artist MBID through the Lidarr metadata service.
2. Artist refresh syncs MusicBrainz release groups and release details into `ArtistMetadata`, `Albums`, `AlbumReleases`, `AlbumReleaseMedia`, `Tracks`, and `Recordings`.
3. The active streaming provider supplies release offers for the artist.
4. Provider offers are matched to MusicBrainz release groups, and to a specific MusicBrainz release when evidence supports it.
5. Curation applies MusicBrainz category and redundancy settings to `ReleaseGroupSlots.wanted`.
6. Download Missing queues selected provider resources for wanted, missing slots.
7. Download/import writes library files, metadata sidecars, and tags from canonical MusicBrainz identity plus provider evidence.

## Provider Matching

Provider album matching is release-group first:

- exact release evidence: UPC/barcode where available;
- strong release evidence: track count, medium count, title/version, release year, release type, and ISRC overlap when hydrated;
- unresolved exact release: keep the provider item matched to the release group only.

This is intentional. Standard, deluxe, clean, explicit, hi-res, and spatial provider albums may all belong to the same MusicBrainz release group. Discogenius should not invent exact MusicBrainz release IDs when the evidence is weak or missing.

## Category Policy

Curation uses MusicBrainz release-group fields:

- primary type: album, EP, single;
- secondary types: compilation, soundtrack, live, remix, DJ mix, demo;
- global setting for whether spatial and videos are wanted.

The category policy only marks slots wanted or unwanted. It does not replace MusicBrainz grouping with provider-derived version groups, and provider availability does not decide whether a MusicBrainz release group is wanted.

Provider matching only fills or clears slot availability fields such as `selected_provider`, `selected_provider_id`, `selected_release_mbid`, quality, compact offer snapshot, and match evidence. A wanted slot with no selected provider offer remains wanted but unavailable for download until a provider match appears.

## Queue Coupling

`queueMonitoredItems` queues selected provider resources from `ReleaseGroupSlots`.

- Stereo slots download into the music root.
- Spatial slots download into the spatial root.
- Videos download from provider video IDs until MusicBrainz video-recording coverage is strong enough to make videos fully canonical.

Download work stays in `download-processor.ts`; scheduled/non-download work stays in scheduler commands.

## Remaining Work

- Move manual import and unmapped matching terminology from `tidalId` to provider-neutral IDs.
- Replace provider-first video rows with canonical MusicBrainz recording links when evidence is strong.
- Add a central artwork resolver/cache for Lidarr images, Cover Art Archive, provider artwork, and local sidecars.
- Complete Lidarr-style rename/retag preview and apply flows for all library slots.
