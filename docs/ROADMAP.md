# Discogenius Roadmap

_Last updated: 2026-03-13_

This roadmap is intentionally short and forward-looking.

- Architecture current-state detail lives in docs/ARCHITECTURE.md.
- Architecture consolidation backlog and Lidarr-alignment work items live in docs/ARCHITECTURE_WORKPLAN.md.
- Release mechanics live in docs/RELEASE_DISTRIBUTION_PLAN.md.

This file should not become an implementation changelog.

## Alpha priorities

1. Stabilize the core library workflow:
   - music downloads through Orpheus
   - video downloads through tidal-dl-ng
   - queue, import, organize, and retry behavior

2. Tighten library management:
   - better rename and retag maintenance flows
   - clearer monitoring and lock behavior
   - stronger reconciliation between disk state and database state

3. Improve manual import quality:
   - better identification confidence and fallback paths
   - smoother review and mapping UX for unmapped files

4. Ship a clean public alpha:
   - concise docs
   - reliable Docker deployment story
   - versioned public releases and images

## Near-term product work

- Faster and more predictable artist, album, and dashboard pages while background jobs are running.
- Better activity visibility for queued maintenance, imports, and retries.
- More polish around mobile layouts and queue/status presentation.
- Continue reducing service monolith pressure in scan/import/monitoring orchestration while preserving current Discogenius feature behavior.

## Longer-term direction

- More robust import decision logic and fingerprint-assisted identification.
- Additional library-maintenance tooling once the alpha workflow is stable.
- **Multi-provider support:** A provider-agnostic internal ID model built on MusicBrainz Release Groups (for albums) and ISRCs (for tracks) as cross-provider join keys. The schema foundation (`mb_release_group_id`, `provider_ids` table) is in place. Full support requires migrating primary keys from TIDAL IDs to internal UUIDs and adding pluggable metadata source and download backend interfaces — a significant architecture shift planned well post-1.0. See docs/ARCHITECTURE_WORKPLAN.md for the detailed ID model plan.
