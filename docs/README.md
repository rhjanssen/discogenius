# Discogenius documentation map

Operator and contributor docs. The root [README.md](../README.md) is the getting-started guide; shipped history lives in [CHANGELOG.md](../CHANGELOG.md); agent/contributor rules live in [AGENTS.md](../AGENTS.md).

## Living

- [ARCHITECTURE.md](ARCHITECTURE.md)
  Current process shape and the boundaries we keep while iterating.
- [LAYERS.md](LAYERS.md)
  Facts vs decisions vs search results. A recomputable row is not identity.
- [SCHEMA_41_AUTHORITY_CUTOVER.md](SCHEMA_41_AUTHORITY_CUTOVER.md)
  Four authorities (catalog, provider, typed matches, library). Slot/match/plan cutover shipped. Artist identity (`ArtistMetadata` + `LibraryArtists`) shipped as schema 46.
- [DATA_MODEL_TARGET.md](DATA_MODEL_TARGET.md)
  Living data-model rules. Libraries and `AlbumEditions`, not slots or `AlbumReleases`.
- [CURATION_DEDUPLICATION.md](CURATION_DEDUPLICATION.md)
  Release-group curation, edition coverage, discography dedup.
- [MATCHING_SET_COVER_DESIGN.md](MATCHING_SET_COVER_DESIGN.md)
  Recording-centric coverage. Per-edition minimum set cover **shipped** in `acquisition-plan-optimizer.ts`.
- [TAG_IO_STRATEGY.md](TAG_IO_STRATEGY.md)
  TagLib vs Mutagen vs Mediabunny; what actually writes tags.
- [HEALTH_DIAGNOSTICS.md](HEALTH_DIAGNOSTICS.md)
  `/ping` vs `/health` vs `CheckHealth`.
- [STATISTICS_TRUTH_GATE.md](STATISTICS_TRUTH_GATE.md)
  Which tables own the numbers the UI shows.
- [MB_LOCAL_MODE.md](MB_LOCAL_MODE.md)
  Local MusicBrainz catalog-provider notes and wiring.
- [STREAMING_PROVIDER_PLUGIN_CONTRACT.md](STREAMING_PROVIDER_PLUGIN_CONTRACT.md)
  Shared adapter contract.
- [PROVIDER_DOWNLOADER_DECISION.md](PROVIDER_DOWNLOADER_DECISION.md)
  Per-provider download backends and the spotDL boundary.
- [EXTERNAL_DEPENDENCIES.md](EXTERNAL_DEPENDENCIES.md)
  How tools, sidecars, and catalog stacks are packaged.
- [TASKS.md](TASKS.md)
  Outstanding work only. Shipped detail belongs in CHANGELOG.

## Historical

- [LIDARR_STRUCTURE_ALIGNMENT.md](LIDARR_STRUCTURE_ALIGNMENT.md)
  Folder-mapping snapshot against Lidarr. Not the live architecture. Artist identity and monitoring are in SCHEMA_41 and DATA_MODEL_TARGET.

## Also here

- [ULTRABLUR_DOCUMENTATION.md](ULTRABLUR_DOCUMENTATION.md)
  UltraBlur background subsystem.
- [DOWNLOAD_IMPORT_LIVENESS.md](DOWNLOAD_IMPORT_LIVENESS.md)
  Download/import resume behavior.
- [RELEASE_HARDENING_LOAD_HARNESS.md](RELEASE_HARDENING_LOAD_HARNESS.md)
  Local load harness.
- [TEST_SUITE_AUDIT.md](TEST_SUITE_AUDIT.md)
  Frozen 2026-07-31 snapshot. Method, not a live count.

## Documentation rules

1. ARCHITECTURE.md is current state, not a backlog.
2. Outstanding work lives in TASKS.md; shipped work lives in CHANGELOG.md.
3. One living doc per topic. Delete stale overlap instead of keeping a second copy.
