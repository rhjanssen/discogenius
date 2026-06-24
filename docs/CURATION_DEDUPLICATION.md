# Curation Workflow

Last updated: 2026-06-23

Discogenius curation is MusicBrainz-canonical and provider-availability driven.
The current implementation is in transition from release-group-shaped matching
to release-level matching: provider offers are still processed through
release-group containers in parts of the code, but useful evidence is stored and
selected at the MusicBrainz release level wherever possible.

It no longer runs the old provider-album redundancy engine as a runtime
fallback.

## Source Of Truth

- MusicBrainz/Lidarr metadata defines artists, release groups, releases, media,
  tracks, and recordings.
- Streaming providers define availability and actionable resources.
- `ReleaseGroupSlots` stores the wanted state and the selected provider resource
  for each library slot.
- `ProviderItems` is the single provider-offer cache. Discogenius intentionally
  does not maintain a second provider-shaped catalog beside the MusicBrainz
  graph.
- `ProviderItemMatches` stores direct and composite edges from provider offers
  to MusicBrainz releases.
- Provider rows store normalized availability/action evidence, not full raw
  catalog responses.

## Slots

Each wanted release group can have independent slots:

- `stereo`: normal audio library target.
- `spatial`: surround/spatial audio library target. The core uses
  format-agnostic wording; providers expose native labels such as
  `DOLBY_ATMOS`.
- `video`: MusicBrainz video recordings where available, plus provider-only
  provisional video recordings when a connected provider exposes more videos
  than MusicBrainz currently knows.

## Runtime Flow

1. Artist add/search resolves to a MusicBrainz artist MBID through the selected
   catalog source.
2. Artist refresh syncs MusicBrainz release groups, release details,
   music-video recordings, and recording relationships into `ArtistMetadata`,
   `Albums`, `AlbumReleases`, `Tracks`, `Recordings`, and
   `RecordingRelations`.
3. The active streaming provider supplies release offers for the artist.
4. Provider offers are matched against the artist's MusicBrainz releases, with
   release groups currently used as the implementation container in the legacy
   matcher.
5. Direct and composite provider-to-release matches are persisted in
   `ProviderItemMatches` when there is enough evidence.
6. Curation applies MusicBrainz category and redundancy settings to
   `ReleaseGroupSlots.wanted`.
7. Slot selection chooses an available MusicBrainz release and provider resource
   for each wanted slot.
8. Download Missing queues selected provider resources for wanted, missing
   slots.
9. Download/import writes library files, metadata sidecars, and tags from
   canonical MusicBrainz identity plus provider evidence.

## Provider Matching

Target matching is artist-wide and release-centric: every provider album should
be scored against candidate MusicBrainz releases for the artist, not against a
provider-invented release group. Evidence priority is:

1. External streaming links from the MusicBrainz release to the provider
   resource. This requires local MusicBrainz mode because Servarr Metadata
   Server does not currently expose enough URL-relation detail for this tier.
2. UPC/barcode and ISRC/recording evidence. Provider UPC/barcode and ISRC values
   are matching evidence and remain provider evidence; they must not turn the
   provider into a parallel catalog source of truth.
3. Title, version/disambiguation, date, release type, medium count, track count,
   duration, and other tracklist shape evidence.

Current implementation notes:

- `provider-release-group-matcher` still has a release-group-shaped entry point,
  so this part is not fully at the target model yet.
- The matcher can record release-level evidence such as `releaseMbid` and
  `availableReleaseMbids`.
- Composite release coverage is persisted in `ProviderItemMatches`, so the
  availability graph can reason about provider-album sets that cover a
  MusicBrainz release.
- Servarr Metadata Server mode often lacks UPC/ISRC/external-link richness, so
  title and tracklist shape remain important fallbacks.

## Category Policy

Curation uses MusicBrainz release-group fields:

- primary type: album, EP, single;
- secondary types: compilation, soundtrack, live, remix, DJ mix, demo;
- global setting for whether spatial and videos are wanted.

The category policy marks slots wanted or unwanted. Provider availability does
not decide whether a MusicBrainz release group is in scope. A wanted slot with
no selected provider offer remains wanted but unavailable until a provider match
appears.

Artist-wide coverage optimization must apply these settings before solving for
coverage. Releases filtered out by primary type, secondary type, library type,
spatial/video policy, or explicit/clean preference are not candidates for the
coverage solver. They should not be selected first and removed afterward,
because that can produce a worse or impossible coverage set.

Provider matching fills or clears availability fields such as
`selected_provider`, `selected_provider_id`, `selected_release_mbid`, quality,
compact offer snapshot, and match evidence.

## Release Selection

Within a release group, slot selection should choose the best covered release for
the requested library slot. Current criteria include:

- full track coverage before partial coverage;
- more complete editions before smaller editions when they cover the same
  recording set cleanly;
- slot-specific quality and format, such as stereo, spatial, or video;
- explicit/clean preference where evidence is available;
- stronger matching evidence before weaker title/shape-only evidence.

The current code can promote a slot to the largest covered release in the
release group's availability graph after direct and composite matches are
persisted.

## Discography Deduplication

Across release groups, curation should compare recording sets and keep the
smallest useful set of releases that covers the filtered artist discography.
Preferred identity keys are:

1. MusicBrainz recording MBID.
2. ISRC, when recording MBID coverage is incomplete.
3. Title, duration, medium position, and track position fallback only when
   stronger identity is unavailable.

The goal is not simply "download the largest release in every release group".
The goal is full filtered-discography coverage with minimal redundant overlap and
the fewest provider downloads that satisfy the user's release-type and library
settings.

## Target Coverage Optimizer

The next matching/curation step should evaluate release choices artist-wide
before permanently locking each release group to a single edition.

Example: a release group has a 20-track edition and a 25-track edition. Tracks
1-15 overlap, but the last 5 tracks of the 20-track edition and the last 10
tracks of the 25-track edition are different recordings. If the missing
recordings from the 20-track path are available together on one EP, while the
missing recordings from the 25-track path require five separate singles or are
unavailable, the optimizer should prefer the 20-track edition plus the EP.

That means the optimizer should:

- build an artist-wide candidate graph of covered MusicBrainz releases;
- remove candidates excluded by release-type, secondary-type, explicit/clean,
  spatial/video, and library-type settings before computing coverage;
- compute recording sets per candidate release;
- choose releases by marginal new recording coverage versus cost, where cost is
  mainly number of releases/provider downloads and secondarily redundancy;
- treat track count as a tie-breaker inside equivalent coverage, not as the
  first global objective;
- then write the resulting per-release-group slot selections.

This optimizer is target work and is tracked in `docs/TASKS.md`.

## Queue Coupling

`queueMonitoredItems` queues selected provider resources from `ReleaseGroupSlots`.

- Stereo slots download into the music root.
- Spatial slots download into the spatial root.
- Videos download from provider video IDs, but provider IDs stay in provider
  offer/provenance rows. Canonical video identity lives in `Recordings` when
  MusicBrainz has the video, and in provisional provider-only recording rows
  otherwise.

Download work stays in `download-processor.ts`; scheduled/non-download work
stays in scheduler commands.

Outstanding curation and matching work is tracked in `docs/TASKS.md`.
