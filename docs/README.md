# Discogenius Documentation Map

Operator and contributor docs. The root [README.md](../README.md) is the
getting-started guide; shipped history lives in [CHANGELOG.md](../CHANGELOG.md);
agent/contributor rules live in [AGENTS.md](../AGENTS.md).

- [ARCHITECTURE.md](ARCHITECTURE.md)
  - Current architecture and the stable boundaries we preserve while iterating.
- [DATA_MODEL_TARGET.md](DATA_MODEL_TARGET.md)
  - Data-model rules and the direction for providers, matching, library types,
    and catalog-source modes.
- [CURATION_DEDUPLICATION.md](CURATION_DEDUPLICATION.md)
  - How release-group slot curation and discography deduplication work.
- [MATCHING_SET_COVER_DESIGN.md](MATCHING_SET_COVER_DESIGN.md)
  - Recording-centric matching, coverage, and deduplication design.
- [MB_LOCAL_MODE.md](MB_LOCAL_MODE.md)
  - Local MusicBrainz catalog-provider notes and dev wiring.
- [STREAMING_PROVIDER_PLUGIN_CONTRACT.md](STREAMING_PROVIDER_PLUGIN_CONTRACT.md)
  - The shared contract every streaming provider adapter implements.
- [PROVIDER_DOWNLOADER_DECISION.md](PROVIDER_DOWNLOADER_DECISION.md)
  - Per-provider download backend decisions and the spotDL provenance boundary.
- [VIDEO_CONTENT_MATCHING_FEASIBILITY.md](VIDEO_CONTENT_MATCHING_FEASIBILITY.md)
  - Partial video-stream / Chromaprint grouping feasibility (defer refresh
    sampling; optional later import-only spike).
- [VIDEO_MATCHING_VS_LIDARR_JELLYFIN.md](VIDEO_MATCHING_VS_LIDARR_JELLYFIN.md)
  - MV↔audio matching vs Lidarr/Jellyfin: durable IDs/duration/variant vs
    brittle Bastille TV-show phrases; keep/simplify/stop.
- [YOUTUBE_SEMI_OFFICIAL_SOURCES.md](YOUTUBE_SEMI_OFFICIAL_SOURCES.md)
  - VEVO / MTV (and similar) as YouTube music-video sources — defer with
    guardrails; no network-channel harvest.
- [EXTERNAL_DEPENDENCIES.md](EXTERNAL_DEPENDENCIES.md)
  - How external tools, sidecars, and catalog stacks are packaged.
- [LIDARR_STRUCTURE_ALIGNMENT.md](LIDARR_STRUCTURE_ALIGNMENT.md)
  - How our file/folder layout maps to Lidarr's.
- [ULTRABLUR_DOCUMENTATION.md](ULTRABLUR_DOCUMENTATION.md)
  - UltraBlur background subsystem.
- [TASKS.md](TASKS.md)
  - Outstanding work and release blockers only. Shipped detail belongs in
    CHANGELOG.

## Documentation rules

1. Keep ARCHITECTURE.md focused on current state — no backlog inventory.
2. Keep only outstanding work in TASKS.md; record shipped work in CHANGELOG.md.
3. Prefer one living doc per topic. Remove stale overlap instead of letting
   parallel versions drift.
