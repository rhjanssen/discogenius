# Schema 41 authority cutover

Discogenius 2.8.0 separates four kinds of durable state:

1. canonical MusicBrainz catalogue facts;
2. provider-native identity, membership, credits, availability, and variants;
3. typed provider-to-canonical match evidence;
4. per-library curation, acquisition plans, and imported-file completion.

The executable target DDL lives in
`api/src/database/schema/domain-v41.ts`. It is intentionally clean-start only.
No schema-39/40 compatibility tables or migrations belong in the final runtime.

## Authority map

| Retired writer or concept | Schema 41 authority | Cutover requirement |
| --- | --- | --- |
| Canonical integer and MBID foreign keys written together | Integer foreign keys; MBIDs only on canonical entity rows | Resolve MBIDs once at boundaries and remove synchronization triggers |
| `ProviderItems` canonical IDs and match fields | Typed `Provider*Matches` tables | Provider ingestion writes facts only; matcher writes edges only |
| `ProviderItems.provider_album_id` | `ProviderReleaseMembers` | One provider track may have many distinct release occurrences |
| Scalar provider artist fields | `ProviderItemCredits` | Preserve ordered credits without inventing roles or join phrases |
| `ProviderItems.quality` / `library_slot` | `ProviderItemAudioVariants` | One provider identity may expose several stereo/spatial renditions |
| `ProviderItemMatches` | `ProviderArtistMatches`, `ProviderReleaseMatches`, `ProviderTrackMatches`, `ProviderVideoMatches` | Match state and manual decision source remain separate |
| `ReleaseGroupSlots` monitoring/selection | `LibraryReleaseGroups` and `LibraryReleases` | Stereo and Spatial are default library rows, not enum authorities |
| Credited content changing canonical ownership | `LibraryReleaseScopes` | Scope explains why content is wanted; canonical credits still own naming and placement |
| `ReleaseGroupSlotTargets` | Canonical `Tracks` selected through `LibraryReleases` | Wanted/availability/completion state is derived, not duplicated |
| `ReleaseGroupSlotSources` | `AcquisitionPlanSources` | Sources reference accepted typed release matches |
| `ReleaseGroupSlotTrackAssignments` | `AcquisitionPlanTracks` | Assignments reference canonical tracks, typed matches, and normalized variants |
| Semicolon `selected_provider_id` composites | Rows in `AcquisitionPlanSources` | No delimited operational identifiers |
| Operational parsing of `match_evidence` | Typed columns and foreign keys | Evidence JSON is bounded diagnostics only |
| Position-selected canonical tracks | Shared one-to-one track matcher | Position is supporting evidence, never identity |
| Audio `monitored` columns on catalogue rows | Per-library curation tables | Video recording monitoring may remain recording-scoped |
| Download command success as completion | `TrackFiles` with `library_id`, release, track, and recording FKs | Only successfully imported assigned files are complete |
| Provider/manual artwork conflation | `MediaCoverSelections` | Persist source kind, revision, hash, and optional source identity |

## Cutover ledger

The implementation commits update this ledger as callers move. A legacy
authority is removed only after its last reader and writer have migrated.

| Legacy authority | Known writers/readers at audit | Replacement status |
| --- | --- | --- |
| Schema-40 slot target/source/assignment tables | `release-group-slot-service`, startup regeneration, orphan housekeeping | Target DDL complete; operational cutover pending |
| Generic provider match graph | `provider-matches`, artist/album/video refresh, query services | Target DDL complete; operational cutover pending |
| Provider/canonical mixed item rows | provider ingestion, refresh, download, organizer, UI query services | Target DDL complete; operational cutover pending |
| Fixed stereo/spatial slot selection | curation, download-missing, album/track/library queries and routes | Target DDL complete; operational cutover pending |
| Delimited acquisition reconstruction | `release-group-acquisition-plan` and download execution | Target DDL complete; operational cutover pending |
| Library-slot completion | import, scan, organizer, download-state and query services | Target DDL complete; operational cutover pending |

## Invariants

- Canonical entity MBIDs are unique external identifiers, never relation-table
  join authorities.
- A provider item is unique by `(provider, entity_type, provider_id)` and is not
  duplicated for libraries or audio variants.
- A provider release relation is calculated from accepted matched sets and is
  directional: `exact`, `source_superset`, `source_subset`, or `overlap`.
- Only an accepted provider-track match with an exact canonical `track_id` can
  be selected into an acquisition plan.
- One acquisition plan belongs to one selected library release and one provider.
- Completion is proved only by an imported `TrackFiles` row in that library.
- Canonical credits control display, tags, naming, and file placement.
