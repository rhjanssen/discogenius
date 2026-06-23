# Discogenius Documentation Map

- [ARCHITECTURE.md](ARCHITECTURE.md)
  - Current architecture and the stable boundaries we preserve while iterating.
- [CURATION_DEDUPLICATION.md](CURATION_DEDUPLICATION.md)
  - Deep-dive into release-group slot curation and discography deduplication.
- [TASKS.md](TASKS.md)
  - Outstanding work and release blockers. Shipped detail belongs in CHANGELOG.
- [DATA_MODEL_TARGET.md](DATA_MODEL_TARGET.md)
  - Current data-model rules plus the future direction for providers, matching,
    library types, and MB-local mode.
- [MB_LOCAL_MODE.md](MB_LOCAL_MODE.md)
  - Local MusicBrainz catalog-provider notes and dev wiring.
- [RELEASE_CENTRIC_MATCHING_PLAN.md](RELEASE_CENTRIC_MATCHING_PLAN.md)
  - Remaining release-centric matching work.
- [UPGRADE_CUTOFF_MODEL_PLAN.md](UPGRADE_CUTOFF_MODEL_PLAN.md)
  - Planned cleanup for replacing `upgrade_queue` with cutoff/history semantics.
- [LIDARR_STRUCTURE_ALIGNMENT.md](LIDARR_STRUCTURE_ALIGNMENT.md)
  - Current file/folder alignment notes and deferred split candidates.
- [ULTRABLUR_DOCUMENTATION.md](ULTRABLUR_DOCUMENTATION.md)
  - UltraBlur background subsystem.

Agent/contributor expectations live in [AGENTS.md](../AGENTS.md) at the
repository root. Shipped history lives in [CHANGELOG.md](../CHANGELOG.md).

Documentation rules:

1. Keep ARCHITECTURE.md focused on current state — no backlog inventory.
2. Keep curation design and semantics in CURATION_DEDUPLICATION.md.
3. Keep only outstanding work in TASKS.md; record shipped work in CHANGELOG.md.
4. Remove stale overlap docs instead of letting parallel versions drift.
