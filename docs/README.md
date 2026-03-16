# Discogenius Documentation Map

Last updated: 2026-03-13

This folder is organized by document role so current architecture, architecture work planning, and subsystem deep-dives stay separate.

## Canonical Documents

- ARCHITECTURE.md
  - Current architecture state and stable structural principles.
  - Describes what exists today, not backlog inventory.

- ARCHITECTURE_WORKPLAN.md
  - Architecture improvement backlog (Lidarr alignment, consolidation, code-quality work).
  - Tracks planned/in-progress architecture work.

- CURATION_DEDUPLICATION.md
  - Canonical deep-dive for Discogenius curation/redundancy workflow.
  - Covers end-to-end flow, lock semantics, and monitored semantics.

- ROADMAP.md
  - Forward-looking product priorities only.
  - Does not duplicate architecture implementation detail.

- TESTING_PLAN.md
  - Release-candidate validation checklist and runtime verification workflow.

- ULTRABLUR_DOCUMENTATION.md
  - UltraBlur subsystem scope, ownership, and implementation behavior.

## Documentation Rules

1. Keep ARCHITECTURE.md focused on current state.
2. Keep architecture backlog/planning in ARCHITECTURE_WORKPLAN.md.
3. Keep curation-specific design and semantics in CURATION_DEDUPLICATION.md.
4. If architecture behavior changes, update ARCHITECTURE.md and any affected deep-dive docs in the same change.
5. Update ROADMAP.md only when product priorities change.
6. Remove stale overlap docs instead of letting parallel versions drift.
