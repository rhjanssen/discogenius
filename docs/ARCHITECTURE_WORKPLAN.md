# Discogenius Architecture Workplan

Last updated: 2026-03-26

## Purpose

This document tracks architecture consolidation work that is planned or in progress.
It is intentionally backlog-oriented.

Current-state architecture belongs in docs/ARCHITECTURE.md.

## Focus Areas

1. Keep Lidarr-style workflow boundaries while staying TypeScript-native.
2. Reduce service monolith pressure in scan/import/download orchestration.
3. Improve observability and deterministic runtime behavior.
4. Keep curation and deduplication correctness ahead of feature breadth.

## High-Impact Hotspots

Measured 2026-03-13:

- api/src/services/download-processor.ts (~1323 lines): inline per-job logic still too dense
- api/src/services/library-scan.ts (~1275 lines): orchestration and side-effects still coupled
- api/src/services/import-matcher-service.ts (~993 lines): policy/scoring logic not fully spec-driven
- api/src/services/redundancy.ts (~948 lines): large but core; needs targeted decomposition, not rewrite
- api/src/services/import-service.ts (~835 lines): orchestration + policy blending
- api/src/services/scheduler.ts (~776 lines): per-job extraction still incomplete

## Pre-1.0 Work Items

1. ~~Add a database migration runner in api/src/database.ts (user_version-gated).~~ **Done** — legacy numbered migrations remain for old local databases, and the 1.0.x schema baseline now uses an independent integer `PRAGMA user_version` starting at `1`, with app/api/schema provenance tracked in `database_version_history`.
2. ~~Add a persistent history table and write path for key file lifecycle events.~~ **Done** — `history_events` table, backend write path, and `/api/history` endpoint are implemented.
3. ~~Phase 1: Add 8 manually-triggerable scheduler commands~~ **Done** — `RefreshAllMonitored`, `DownloadMissingForce`, `RescanAllRoots`, `HealthCheck`, `CompactDatabase`, `CleanupTempFiles`, `UpdateLibraryMetadata`, `ConfigPrune` are integrated into [api/src/services/command.ts](api/src/services/command.ts) and [api/src/services/scheduler.ts](api/src/services/scheduler.ts) with full payload typing, exclusivity rules, and REST route handlers via [api/src/routes/command.ts](api/src/routes/command.ts). ~~Phase 2: Extend UI in Dashboard/Settings to expose Phase 1 commands and allow periodic scheduling configuration.~~ **Partially done** — the backend exposes a typed `/api/system-task` catalog for scheduled tasks plus manual operator tasks, and the Dashboard overflow now surfaces selected run-now actions. Settings does not currently ship a general System Tasks control plane or editable per-task schedule UI.
4. Continue route thinning in high-traffic routes so route files remain adapters.
5. Finish import decision extraction into import-decision specifications.
6. Add a minimal typed health surface for auth/runtime/path checks.
7. Continue scheduler and download-processor handler extraction by job type.
8. Ensure config and file lifecycle events are emitted consistently where already modeled.
9. ~~Consolidate quality normalization paths to one authoritative implementation.~~ **Done** — `HIRES_LOSSLESS` is canonical throughout; `HI_RES_LOSSLESS` alias and `QUALITY_ALIASES` map removed from `quality.ts`.
10. Split the new system-task catalog into a dedicated command registry plus thinner activity/command routes so `/api/command`, `/api/system-task`, and `/api/status` stop sharing definition logic indirectly.

## Post-1.0 Work Items

- Root folder entity with richer root metadata and free-space checks.
- Rich UI history timeline backed by persistent history data.
- Additional housekeeping registration and visibility.
- Deeper upgrade automation and decision integration.
- Broader repository-pattern adoption in service code.

## Residual Low-Risk Follow-Ups (Optimization Increment)

- Add lightweight endpoint timing counters for `/api/activity`, `/api/activity/events`, and `/api/tasks` in non-debug builds to spot regressions early without adding heavy profiling overhead.
- If event volume grows substantially, evaluate cursor-style pagination for `/api/activity/events` as a future optimization; current offset pagination is correct and acceptable for present scale.

## Next Metadata Storage Step (Lidarr-Aligned, Pre-ID-Migration)

- Add additive `artist_metadata` and `album_metadata` cold tables keyed to current `artists.id` and `albums.id`; keep hot/library ownership on the existing core tables.
- Dual-write scanner output into both the current hot fields and the new cold metadata tables first, so read-path migration can happen without a schema flip.
- Move artist and album page reads to DB-first metadata access once dual-write is stable, instead of relying on scanner-shaped in-memory payload assembly.
- Collapse to one DB-backed album page contract after the DB-first read path lands.
- Keep this as a separate incremental step from the broader provider-neutral/internal-ID migration below; it should not depend on changing primary keys.

## Provider-Agnostic ID Model (Multi-Provider Foundation)

**Current state (as of 2026-03):**

The schema uses TIDAL IDs as primary keys for `artists`, `albums`, and `media`. Cross-provider identity is partially covered already:

- `isrc` on `media` — the industry-standard cross-provider track identity key (used by our dedup logic)
- `upc` on `albums` — specific pressing/edition identity
- `mbid` on `artists`, `albums`, `media` — sparsely populated MusicBrainz IDs
- `albums.mb_release_group_id` — MusicBrainz Release Group ID, the cross-provider join key for the **abstract album concept**
- `provider_ids` table — maps TIDAL-primary entity IDs to identifiers from other providers
- API contract normalization is in place for TIDAL entity payloads: `tidal.ts` emits canonical `id` in both search mappers and core getters (`getArtist`, `getTrack`, `getArtistVideos`, `getVideo`) while retaining `tidal_id` as a compatibility field.
- Import matching candidate identity now uses canonical `id` (including fingerprint-backed candidate paths) instead of `tidal_id` fallback keys.

**Why `mb_release_group_id` matters — and its limits:**

A TIDAL 16-bit album and a TIDAL 24-bit album of the same record are different TIDAL IDs, different MB Release IDs (different UPCs), but the **same MB Release Group**. The Release Group is the right join key when asking "do we have this album on provider X?" across providers.

**Important caveat:** MB guidelines explicitly group Standard and Deluxe editions (with bonus tracks/discs) into the **same Release Group**. This means `mb_release_group_id` is too coarse for our dedup logic, which must keep Standard and Deluxe separate. Our ISRC-set dedup in `redundancy.ts` is correctly finer-grained — a Deluxe edition has additional ISRCs for bonus tracks, so it produces a distinct ISRC set. **Never use `mb_release_group_id` as a dedup key.** Use it only as a cross-provider linking hint.

| Layer | Key | What it represents |
|---|---|---|
| Track identity | `isrc` | Same recording regardless of provider or format |
| Specific pressing | `upc` / `mbid` (Release) | A specific edition with specific UPC |
| Abstract album | `mb_release_group_id` | The "album concept" — cross-provider join key |
| Artist identity | `mbid` on artists | Cross-provider artist join key |

**Path to full multi-provider support (post-1.0):**

1. Populate `mb_release_group_id` via ISRC→MB or UPC→MB lookups during background scans (no audio needed, MB API supports both).
2. Populate `provider_ids` for TIDAL entities (retroactively storing TIDAL IDs there too) so all providers are stored symmetrically.
3. Migrate `artists.id`, `albums.id`, `media.id` from TIDAL IDs to internal UUIDs, with TIDAL ID moved to `provider_ids`. This is a breaking schema migration and should happen in a single versioned step.
4. Add pluggable metadata source interface (TIDAL API today, others later).
5. Add pluggable download backend registry (Orpheus and tidal-dl-ng today, others later).

Items 1–2 are low-risk and can start pre-1.0. Items 3–5 are post-1.0.

See also:

- `docs/RFC_PROVIDER_NEUTRAL_IDS.md` for the approved provider-neutral internal ID and migration direction
- `docs/RFC_PROVIDER_BACKEND_ABSTRACTION.md` for the approved provider/backend interface and capability-routing direction

**MusicBrainz enrichment background job:**

When a TIDAL track has an ISRC, a background MB lookup (`/ws/2/recording?isrc=<isrc>`) can return the MB Recording ID (→ `media.mbid`) and the containing MB Release Group IDs. When a TIDAL album has a UPC, a lookup (`/ws/2/release?barcode=<upc>`) returns the MB Release ID (→ `albums.mbid`) and its Release Group (→ `albums.mb_release_group_id`). This is rate-limited to 1 req/sec per MB policy and should be queued as a low-priority background job, not run inline.

## Intentionally Deferred

- Full DI container migration.
- Event sourcing or external message bus architecture.
- NZB/indexer-specific Lidarr feature parity that does not fit TIDAL-first workflow.

## Working Rules

1. Keep docs/ARCHITECTURE.md implementation-current and backlog-light.
2. Record architecture backlog changes here, not in roadmap.
3. Update docs/CURATION_DEDUPLICATION.md whenever curation semantics change.
