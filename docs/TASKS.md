# Discogenius — Versioned Task Backlog

Single source of truth for outstanding work. Keep statuses current; a fresh
session should read this to pick up work — see "Transferring to a new session"
at the bottom.

Status: ⬜ pending · 🟡 in progress · ✅ done · ♻️ marked done before, needs revisit.

## Implementation-order rationale
1. **Finish UI/UX + download/artwork/search fixes (2.0.4–2.0.7)** — quick wins, no deep dependencies.
2. **Clean the DB (2.0.8)** before generalizing anything schema-level — don't
   build new features on the legacy `Provider*` tables.
3. **Multithreading (2.0.9)** — heavy multi-library downloads need the API to
   stay responsive.
4. **Apple Music provider (2.1.0)** — harden the provider abstraction with a
   real second provider *before* reworking the library system, so library types
   work with N providers rather than being redesigned again later.
5. **Config→DB + library-type rework (2.2.0)** — the biggest schema/UX change;
   wants the clean DB and a settled provider abstraction under it.
6. **Import lists (2.3.0)** — builds on the followed-artist set + providers.
7. **Local MusicBrainz mode + matching engine + multi-user (3.0)** — the largest
   shift (changes the canonical data source); matching benefits from MB's
   ISRC/UPC. Split from the library rework so neither overloads a release.

---

## 2.0.4 — Mobile / UI cluster
- **#51 Mobile top nav bar** ⬜ — desktop-style top header (logo, search, nav)
  replaces the four bottom tabs; remove the dedicated search page/route. Large
  nav restructure.
- **#50 Album mobile inline action buttons** ⬜ — icon+label inline (not stacked);
  3 actions; deliberate album-page deviation.
- **#42 Auth page polish** ⬜ — glassmorphism provider card, stronger logo glow,
  remove icon frame squares, remove auto-redirect.
- **Finish loading-skeleton parity** ⬜ — DataGrid / TrackTable / Queue / Activity.
- **Verify `/api/v1/queue` under a full queue** ⬜ — indexed (15s→0.01s) but only
  re-checked near-empty; confirm under a real backlog.

## 2.0.5 — Library / artist views + collaborators
- **#40 Library albums table/list view** ⬜ — w/ provider+quality column; grid/list
  toggle; mobile variant.
- **#41 Artist page list/table view** ⬜ — design-first.
- **#43 Fetch-on-click collaborating artists** ⬜ — progressive, non-cascading
  (scan+match a monitored artist's collaborators, no curate/monitor, no snowball).

## 2.0.6 — UI/download bugfix + polish ✅
Shipped: queue/tracklist badge sizing, album-page quality-pill dedup for the
Atmos-fallback case, split-download hover fix, Atmos→stereo fallback routing +
permanent `--dolby-atmos allow`, job-scoped download workspaces (ENOENT race),
ghost-queue-item fix, background grain/GPU (backdrop-filter) fixes, clean tiddl
config/args split, and a stale-`/search` CI test removal.

## 2.0.7 — Artist/image/search + UI polish ✅
Shipped: immediate artist artwork/info hydration on hot-load/search-add; one
shared album-art resolver (canonical→provider fallback, no duplicate paths);
track/video search artwork resolves to real URLs; first-order collaborators get
a deep canonical+provider scan while staying unmonitored/uncurated; per-artist
filter persistence; local+MB-only search (no provider live-search); tracklist
(clickable artists, Duration+Quality columns, single-volume row hidden, play/stop
controls); Plex-style low-res+blur UltraBlur with decoded cross-fade; slimmer
Docker runtime image.

## 2.0.8 — Database alignment (clean canonical schema)
- **Monitoring download flow** ✅ — fixed "active monitoring on, artists curated,
  but nothing downloaded overnight." The scheduled/manual monitoring cycle's terminal
  `DownloadMissing` raced in-flight intake (gate ignored
  `RefreshArtist`/`RescanFolders`/`CurateArtist`) and could run before curation had
  created any monitored slots. Now: the cycle pre-download gate also waits on
  `hasActiveArtistWorkflowJobs()`, then queues `DownloadMissing` as the terminal
  monitoring-cycle pass. Standalone artist add, scan, curation, and collaborator
  scanning do not auto-download; downloads stay tied to an explicit manual/scheduled
  monitoring cycle or download command, matching the Lidarr-style order of
  operations.
- **Retire legacy `Provider*` tables** 🟡 — full 5-phase migration to a single
  canonical graph + `ProviderItems`. See docs/LIDARR_DB_ALIGNMENT_PLAN.md.
  Phase 0 (inventory) + Phase 1 dry-run done; target model clarified (Recordings
  = canonical track/work info + standalone videos; Tracks = release↔recording map).
  **Phase 1 shipped:** (a) `backfillCanonicalTrackFiles` gap-fill in housekeeping;
  (b) canonical-aware library-file dedupe (slot-aware `(canonical_recording_mbid,
  file_type, library_slot)` pass alongside the legacy media-id pass). Both tested
  (`runtime-maintenance-backfill.test.ts`); real-DB dry-run = 0 orphan-risk, 100%
  canonical resolution. **Phase 2 started:** `library-files-query-service` now
  decorates library-file listings from canonical `TrackFiles` identity +
  `Recordings`/`ProviderItems`, not `ProviderMedia`/`ProviderAlbums`;
  `command-history` now resolves download activity descriptions from
  `ProviderItems` + canonical artist/release/recording data; `scan-refresh-state`
  now uses `ProviderItems.updated_at` for track/video scan freshness instead of
  `ProviderMedia.last_scanned`; `refresh-policy` now reads canonical
  `Albums.first_release_date` and `ProviderItems.updated_at` instead of legacy
  provider release/scan columns; `providers/tidal/tidal-provider` now falls back
  to canonical `ProviderItems` for album download-progress track lists instead
  of `ProviderMedia`; `import-matcher-service` now resolves fingerprint album
  candidates from canonical `TrackFiles` identity + `ProviderItems` instead of
  joining `ProviderMedia`; `library-files.ts` (path computation, video layout/root
  resolution, pruning) is fully canonical; `library-metadata-backfill` now
  discovers album/lyrics/video sidecars from canonical `ProviderItems` and carries
  provider/canonical identity into sidecar rows; `metadata-files` now uses
  canonical/provider-item metadata for local NFO/artwork fallbacks;
  `lyric-service` now shares cached lyrics via canonical `ProviderItems`/MBIDs;
  `rename-track-file-service` now replicates separated-root sidecars by canonical
  release-group/track/recording identity plus `ProviderItems`; `audio-tag-service`
  now builds retag target context from canonical identity + `ProviderItems`
  before legacy fallback data. **Phase 3 supplement homing started:** v24 adds
  canonical provider-supplement columns on `Albums`/`AlbumReleases`/`Recordings`;
  `refresh-album-service` mirrors album/release/track supplements there while
  keeping legacy compatibility writes, and NFO/audio-tag fallbacks read the
  catalog values first. Provider UPC/ISRC are matching evidence and stay on
  `ProviderItems`, not catalog barcode/ISRC columns. Dead legacy provider
  module/version repair helpers
  (`module-fixer`, `version-grouper`) were removed after verifying zero
  production imports, and `DownloadMissingForce` no longer carries an obsolete
  provider skip-flag reset. Runtime monitor-gap repair now writes canonical
  `ReleaseGroupSlots`/`Recordings` monitor state, not provider monitor columns.
  Slot identity must remain release-specific: stereo and spatial selections can
  point at different `AlbumReleases` and provider UPC/ISRC evidence inside one
  release group, while an Atmos-only provider offer can intentionally fill both
  stereo and spatial slots when no stereo offer is available.
  `CheckUpgrades` now scans `TrackFiles` canonical/provider identity +
  `ProviderItems` instead of `ProviderMedia`/`ProviderAlbums` and queues
  canonical-only audio/video upgrade downloads; schema v27 re-keys
  `upgrade_queue` to provider resource identity while retaining nullable legacy
  shadow ids during the transition. **Remaining:** other read/write
  paths still join `TrackFiles.media_id→ProviderMedia→ProviderAlbums`
  (organizer, audio-tag MB/AcoustID write-back and legacy tag fallbacks);
  the unique-index +
  import-upsert canonical-identity switch is a numbered schema migration bundled
  with Phase 3; then Phases 4–5. Precise next steps in the plan doc's Phase 1/2
  progress sections.
- **Schema/index cleanups** ⬜ — prune redundant `TrackFiles` canonical_* indexes;
  fold `AlbumReleaseMedia`→`AlbumReleases.data`; consider whether provider-keyed
  `upgrade_queue` should stay separate or fold into `job_queue`.
  See docs/LIDARR_SCHEMA_AUDIT.md.

## 2.0.9 — Multithreaded job execution
- **Job execution → worker_threads** ⬜ — move the download processor, then the
  command executor, off the main event loop (own SQLite connections + message
  bridge for SSE/cache/progress). Lidarr-style parallelism on the clean schema.
  See docs/JOB_EXECUTION_THREADING_PLAN.md. (Cooperative yielding + perf indexing
  shipped in 2.0.3 as the interim mitigation.)

## 2.1.0 — Apple Music provider plugin
- **Apple Music at TIDAL parity** ⬜ — own auth/token, catalog + artist-catalog
  search, followed/favorite import, audio (lossless/spatial where available) +
  video downloads, lyrics, artwork, ISRC/UPC.
- **Harden the provider abstraction** ⬜ — adding a provider should be a clean
  plugin; providers stay availability/download resources only (never create
  canonical entities). Includes the multi-provider selection/switching UX.

## 2.2.0 — Configurable library types + config-in-DB
The headline 2.x feature. Generalizes today's hardcoded stereo/spatial/video
slots into **user-defined library types**.
- **Config → DB** ⬜ — move settings out of `config.toml` into DB tables with a
  settings UI (better than TOML; prerequisite for editable library defs).
- **Library-type model** ⬜ — in Settings, add/edit library types, each =
  `{ name, root/location, content kind (audio|video), desired quality }`
  (e.g. Lossless / Lossy / Dolby Atmos / Music Video). Replaces the fixed
  stereo/spatial/video slots; **migrate** `ReleaseGroupSlots` from the 3 fixed
  slots to dynamic library-type ids.
- **Download/curate per library type** ⬜ — a monitored artist's full discography
  is downloaded into **every applicable library type**, so the same song ends up
  as a Lossless *and* Lossy *and* Atmos *and* Music-Video version across the
  libraries. Release-type filtering/curation stays **global** (not per-artist).
- *Note:* this subsumes Lidarr's per-artist "metadata/quality profile" idea —
  quality/format is chosen per **library type**, not per artist. (For now a single
  shared followed-artist set feeds all library types; per-artist library
  selection could come later.)

## 2.3.0 — Import lists
- **Import sources** ⬜ — the shared followed-artist set, plus marking a **provider
  playlist** (e.g. a TIDAL/Apple playlist) or an **external chart/top-40 list** as
  an import source that seeds monitored artists/albums.
- **Import-list exclusions** ⬜ — don't re-add removed items.

## 3.0 — Local MusicBrainz mode + matching engine + multi-user

### Local MusicBrainz database — deep integration (the big one) ⬜
Connect directly to a **local MusicBrainz database** ("MB-local mode"):
- Do **not** scan/replicate canonical metadata — it's all already in the local DB.
  We only (a) match provider releases to monitored artists and (b) curate using
  the **full ISRC/UPC** data the local MB DB exposes.
- Library view "show unmonitored" then lists **every artist in the MB database**.
- **Mode switching:** the user can switch between MB-local and "normal" mode.
  Switching MB-local → normal triggers a **migration/DB-build at that moment** to
  replicate the canonical data needed for the monitored artists (normal mode has
  no full MB DB to lean on).
- Substantial: dual data-source abstraction, mode toggle, on-switch migration,
  matching/curation reading ISRC/UPC straight from MB.

### Unified edition-aware matching engine (#3 + #23) ♻️
One normalized `scoreTrackMatch` shared by read-service + slot-service —
recording-MBID/ISRC exact → position+volume+duration(~8s) w/ base-title gate →
string fallback; tests incl. single+album combine to prevent false coverage.
Fixes wrong-version selection + false "unavailable" tracks; add IMVDb for videos.
(Benefits directly from MB-local mode's ISRC/UPC.)

### Multi-user ⬜ — users + roles/auth.

---

## Deprioritized / optional (not scheduled)
Per Robert: **not prioritized** — pick up only if a concrete need appears.
- Notifications (Discord/webhook), Tags, Blocklist (failed releases).
- Per-artist metadata/quality profiles (replaced by the 2.2.0 library-type model).
- Metadata-consumer profiles / `.nfo` writing (MBID embedding already largely
  done — see [[acoustid-mbid-embedding-facts]] in notes).

---

## Transferring this backlog to a new session
The harness task list (TaskCreate/TaskList) is **per-session and ephemeral** —
it doesn't survive resets or move between tools. **This committed file is the
portable mechanism.**
- **Claude Code / this harness:** *"Read docs/TASKS.md, re-seed it as tracked
  tasks, then start the 2.0.4 items."* Can fan out with subagents/workflows for
  research/independent work; sequential coding is done inline.
- **OpenAI Codex:** *"Read docs/TASKS.md and work the 2.0.4 section."* Its own
  planner; no equivalent subagent system — the file is the contract.
- **Claude Desktop:** chat app (+ MCP), not an autonomous coder — point it at the
  repo for context; edit in a coding harness.
