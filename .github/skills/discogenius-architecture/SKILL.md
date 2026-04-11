---
name: discogenius-architecture
description: Architecture workflow skill for Discogenius. Use when splitting service responsibilities, queue/event boundaries, datastore ownership, scan-import-curation orchestration, and related documentation updates.
---

# Discogenius Architecture

## When to use

Use this skill when changes touch one or more of:

- queue lifecycle and command exclusivity
- app event boundaries and follow-up orchestration
- scan/import/curation workflow handoffs
- repository/datastore ownership boundaries
- architecture documentation updates

## Core boundaries

1. Keep routes thin; queue long-running work.
2. Keep download and non-download orchestration separated.
3. Keep event-driven handoffs explicit (scan completion -> curation, etc.).
4. Keep file inventory canonical in library_files.
5. Keep lock semantics authoritative (monitor_lock rows are intentional user state).

## Queue and workflow guidance

- Use queue.ts and command.ts for lifecycle and exclusivity.
- Keep scheduler.ts for non-download command execution.
- Keep download-processor.ts for exact media download jobs.
- Prefer adding focused handlers/services over expanding monolithic switch blocks.

## Event guidance

- Publish typed app events for major state transitions.
- Use listeners for cross-domain chaining instead of hard-coded direct calls where possible.
- Keep event payloads explicit and workflow-aware.

## Datastore and service ownership

- Use better-sqlite3 synchronously.
- Keep schema changes deterministic and documented.
- Prefer repositories/services over route-level SQL orchestration.
- Preserve existing Discogenius schema semantics unless a migration is intentional.

## Scan/import/curation boundaries

- refresh-artist-service.ts + refresh-album-service.ts + refresh-playlist-service.ts + refresh-video-service.ts + media-seed-service.ts: TIDAL metadata refresh and targeted intake boundaries.
- library-scan.ts + import services: disk/import reconciliation and apply/finalize workflow.
- curation-service.ts + artist-workflow.ts: curation and dedup decisions plus queue coupling.
- task-scheduler.ts: scheduled pass orchestration (Lidarr-aligned per-artist pipeline).

## Documentation update requirements

When architecture behavior changes, update docs in the same change:

- docs/ARCHITECTURE.md for current-state architecture behavior
- docs/ARCHITECTURE_WORKPLAN.md for planned architecture work
- docs/CURATION_DEDUPLICATION.md when curation/redundancy semantics change
- docs/README.md if documentation ownership/scope changes

Keep docs concise, implementation-grounded, and non-duplicative.
