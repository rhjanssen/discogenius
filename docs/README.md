# Discogenius Documentation Map

- [ARCHITECTURE.md](ARCHITECTURE.md)
  - Current architecture and the stable boundaries we preserve while iterating.
- [CURATION_DEDUPLICATION.md](CURATION_DEDUPLICATION.md)
  - Deep-dive into release-group slot curation and discography deduplication.
- [TASKS.md](TASKS.md)
  - Versioned task backlog + roadmap — the source of truth for what ships next.
- [LIDARR_DB_ALIGNMENT_PLAN.md](LIDARR_DB_ALIGNMENT_PLAN.md) / [LIDARR_SCHEMA_AUDIT.md](LIDARR_SCHEMA_AUDIT.md)
  - The database-alignment migration (retire the legacy `Provider*` tables).
- [JOB_EXECUTION_THREADING_PLAN.md](JOB_EXECUTION_THREADING_PLAN.md)
  - Plan to move job execution onto worker threads.
- [ULTRABLUR_DOCUMENTATION.md](ULTRABLUR_DOCUMENTATION.md)
  - UltraBlur background subsystem.

Agent/contributor expectations live in [AGENTS.md](../AGENTS.md) at the
repository root. Shipped history lives in [CHANGELOG.md](../CHANGELOG.md).

Documentation rules:

1. Keep ARCHITECTURE.md focused on current state — no backlog inventory.
2. Keep curation design and semantics in CURATION_DEDUPLICATION.md.
3. Keep the forward-looking plan in TASKS.md; record shipped work in CHANGELOG.md.
4. Remove stale overlap docs instead of letting parallel versions drift.
