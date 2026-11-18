# Discogenius Agent Guide & Memories

Accumulated architectural constraints and user preferences. Auto-loaded every
session. This file is the single source of truth for rules; `docs/` holds the
living design/operator docs and `docs/TASKS.md` is the backlog.

## Project identity & goals
- Self-hosted music library manager: streaming-service rippers instead of
  torrent indexers, plus discography deduplication on top of release-type
  filtering. Stereo, spatial (Atmos) and music-video libraries, by default in
  three separate roots.
- Providers (TIDAL, Apple Music, Amazon Music, Spotify, YouTube / YouTube Music,
  Deezer) are availability/download resources behind one adapter contract
  (`docs/STREAMING_PROVIDER_PLUGIN_CONTRACT.md`); TIDAL is the most exercised.
- **Key decisions**: keep the TypeScript stack; frontend stays pure Fluent UI
  v9; MusicBrainz is canonical identity.
- Core views are catalog-primary (online catalog or local MusicBrainz). Provider
  data may supplement canonical holes (artwork asset ids, copyright, provider
  URLs, availability/downloads), but do not preserve provider-only
  catalog/discovery features (similar artists/albums, top tracks) unless the
  catalog can drive them. Drop provider-only sections rather than adding
  provider catalog tables.

## Layout
- `api/` — Express + TypeScript + better-sqlite3 (synchronous DB access only)
- `app/` — React + Vite + Fluent UI v9 + TanStack Query
- `e2e/` — Playwright tests
- `config/` — runtime state (TOML config, SQLite DB, provider tokens) — never commit
- `.ref_*` — read-only reference checkouts (from `install.sh`, not this repo).
  Check them first when copying an approach; never import from them:
  `.ref_apple-music-downloader`,
  `.ref_arr_scripts`, `.ref_fluentui`, `.ref_immich`, `.ref_jellyfin`,
  `.ref_kodi`, `.ref_lidarr`, `.ref_musicbrainz-docker`, `.ref_picard`,
  `.ref_qbittorrent`, `.ref_tidarr`, `.ref_tiddl`, `.ref_yt-dlp`.
- `docs/LIDARR_STRUCTURE_ALIGNMENT.md` is a historical folder-mapping reference.

## How to work (every change)
- **Smallest change that meets the issue's acceptance criteria.** Subtract
  before you add: delete what your change makes dead, migrate every caller and
  drop the old path in the same PR. No speculative guards, options, wrappers or
  abstractions.
- **Fix root causes.** Reproduce first, then fix where the system first went
  wrong. A guard, retry, fallback or swallowed error is a fix only if the state
  it handles is legitimate; otherwise find what produced it. `rg` for every
  instance of the same fault. Two failed fixes on one assumption: write the
  assumption down and test it before a third.
- **Keep context lean.** Targeted `rg` and ranged reads; never dump large files,
  logs, lockfiles or test output. Send long output to a file and grep it.
- **Proceed on reversible work** inside the issue without asking. Stop and
  propose findings only for product decisions, larger fix rounds beyond the
  issue, or irreversible steps (data deletion, releases, live data).
- **Tests assert observable behaviour** (return values, HTTP responses, rows read
  back, what a provider receives), with expected values taken from the
  requirement. A test must fail when the behaviour breaks and survive an
  internal refactor. A bug fix gets a test that fails before the fix.
- **No narrating comments.** Comment only a non-obvious *why* or an external
  constraint. No commented-out code, debug logging or scratch files.
- **Explain every number you report** (test counts, timings, row counts): say
  what was measured and rule out skipped, cached or retried work.
- **A lesson that keeps recurring becomes a test, type or lint**, not more text here.

## Architecture & development rules
- TypeScript everywhere; Yarn 1.x only.
- Keep routes thin; durable workflow logic lives in services/repositories.
- Long-running work goes through the command queue
  (`api/src/services/commands/`), never inline in route handlers. `CommandModel`s
  (the `commands` table) are enqueued via the queue manager, `command-executor.ts`
  drains and dispatches to handlers in `commands/handlers/`, and `scheduler.ts`
  enqueues due scheduled tasks. Use `CommandExecutor.yieldToEventLoop()` in heavy
  inline loops.
- Parse external data (request bodies, provider responses, config, files) once
  at the boundary into typed models; trust internal types after that. Command
  handlers must converge when re-run or resumed after a crash.
- Respect `monitored_lock` / `monitor_lock`: automation must never flip
  user-locked monitor state. Automatic curation (`enable_redundancy_filter`,
  default on) is optional. Off monitors one edition per release group and
  never auto-unmonitors. A user unmonitor writes `LibraryUserExclusions` and
  curation does not put that album or edition back. With Remove unmonitored
  files on, a user unmonitor deletes that album's files immediately; a
  curation unmonitor deletes a file only when the same recording is already
  on a monitored edition. A stale automatic match never unmonitors a
  file-owning edition and never deletes its files.
- **Provider tooling** stays inside the provider adapter/backend. TIDAL's `tiddl`
  lives in `api/src/services/providers/tidal/`; its auth/config live under
  `config/providers/tidal/.tiddl`. tiddl steering = config (global) + args
  (per-job).
- **Atmos vs stereo**: TIDAL Atmos has a SEPARATE stereo stream. Spatial-only
  media never fills stereo. A spatial source may satisfy stereo only through an
  explicit conversion policy that produces and verifies a stereo output; no
  such implicit conversion is currently allowed.
- **Hi-Res needs ffmpeg**: TIDAL ships hi-res as FLAC-in-MP4; tiddl extracts via
  ffmpeg.
- **Matching**: one shared matcher scores slot-candidate tracks. Beware
  camelCase vs snake_case differences between callers. A matcher version bump
  must not make stored automatic matches non-candidates. Readers keep using
  them. The shared-item rule is applied to the stored rows, and a local replay
  rewrites the cache without provider traffic. `matcher_version` is not a veto
  and it stays inside the acquisition-plan fingerprint. A replay that finds
  the same automatic assignments updates that hash and the version stamp; it
  does not rebuild the plan. An acquisition plan owned by a download or import
  defers only the release being rewritten. It is retried later. It is not a
  process-lifetime failure, and it must not roll back the rest of the batch.
  A provider item that maps to the same recording on two editions is the
  plan's own track, not ambiguous provenance. Karaoke, tribute, "in the style
  of", "cover version", and "originally performed by" releases are not the
  MusicBrainz album: new automatic matches refuse them. Matcher version stays
  5 so stored accepted rows are not replayed away, and curation does not
  unmonitor or delete because of them. `listDerivativeSourceFiles` lists
  on-disk files from those sources and deletes nothing. Provider album art
  and the album provider id are used only when that provider item is this
  edition (single-source plan, or relation `exact` / `source_superset`).
  Overlap and source_subset donors fall back to Cover Art Archive. A short
  hybrid or YouTube import keeps the organized tracks, records each missing
  offer, and leaves only those tracks wanted.
- **Catalog refresh dependents.** One dependent row must not fail a whole
  artist refresh. A MusicBrainz recording redirect re-keys video artwork
  (`ArtworkSources` / `ArtworkLibraryLinks` / `ArtworkProxyVariants` /
  `ArtworkMutationJournal`) onto the surviving recording in the same
  transaction; artwork files are never deleted to pass the guard. An obsolete
  edition track detaches or re-points `LibraryVideos` (video files stay;
  monitoring stays). `ArtistTopTracks` and `TrackLibraryIndex` cascade with
  the track. Owned `TrackFiles`, sidecar `canonical_track_mbid` rows, live
  download/import snapshots, and standalone waiting requests still fail closed.
- **Online catalog** (default) strips ISRC/UPC. Use local-MB mode for exact
  ISRC/UPC; otherwise match on MBID + duration + title distance.

## Performance facts
- The API uses **synchronous better-sqlite3 on the single Node event loop**, so
  any slow query stalls the whole app.
- Never scan big tables. Use indexes for foreign-key/filter columns.
- Replace `OR EXISTS(subquery)` with `OR col IN (subquery)`.
- Use `col = 1` not `COALESCE(col,0)=1` for `is_video`/`monitored` so indexes
  apply.

## Robert's preferences & testing
- Use artists **Bastille** and **Bakermat** for live app tests.
- Real-data testing over mocks (live provider token in `config/`).
- **Reviewing other AI's work**: be critical; run FULL `yarn ci` (vite `app
  build` tolerates type errors) and verify behavioural claims against the
  running container before trusting them.
- **Native tools**: do not claim ffmpeg/fpcalc are untestable on Windows. Use
  `winget install` or test inside the Docker container (the Dockerfile bundles
  `ffmpeg` + `libchromaprint-tools` for fpcalc).

## Multi-agent roles & handover
- **Product Owner (Homelab Bot / Grok Bot)**: sets priorities, defines acceptance
  criteria, and manages the backlog via GitHub Issues on `rhjanssen/discogenius`
  (using labels such as `ready`, `in-progress`, `needs-review`) alongside
  `docs/TASKS.md`. Reviews and merges PRs.
- **Developer Agents (Cursor, Claude Code, Google Antigravity / Gemini, Codex)**:
  pick up the next `ready` issue (or task assigned via `HANDOFF.md`), work on a
  dedicated branch, verify with `yarn ci` (and against the running container when
  on the LAN), and open a PR.
- **Session handover (`HANDOFF.md`)**: the agent that stops overwrites it with
  branch, done, half-done, what was live-verified, and open questions for the
  PO. A short note, never a growing log.
- **Quota-aware routing** (`scripts/agent-env/usage-status.mjs`, `dispatch.mjs`,
  `.github/workflows/agent-dispatch.yml`):
  - Route dev work to Claude or Gemini first. Cursor shares quota with Grok Bot
    (PO), so use it only when both are out.
  - `node scripts/agent-env/usage-status.mjs [--json]` prints live usage
    (Claude 5h/7d, local cooldowns, `quota-exhausted:*` labels) and `recommendedAgent`.
  - Triggers: label `agent:auto|claude|gemini|cursor` (assigning a labelled or
    `ready` issue also fires), comment `@agent-auto|@claude|@gemini|@cursor`, or
    `node scripts/agent-env/dispatch.mjs --to <auto|claude-cloud|gemini|antigravity|cursor-cloud> --issue <N>`.
  - Failover: agents work on `agent/issue-<N>`. On quota exhaustion the workflow
    pushes WIP, labels `quota-exhausted:<agent>`, and the other agent resumes
    from that branch and `HANDOFF.md`.

## Cloud & local agent environment (Cursor, Claude Code, Google Antigravity / Gemini)
- All agents share `scripts/agent-env/install.sh` (`ffmpeg`/`fpcalc` check,
  `yarn install`, `.ref_*` clones, library dirs; idempotent, `SKIP_REFS=1` skips
  clones) and `scripts/agent-env/start.sh` (API `127.0.0.1:3737` + Vite
  `127.0.0.1:8080`, repo-local `library/` and `downloads/`; exits 0 when up; sets
  `DISCOGENIUS_DEV_HOST=0.0.0.0` where IPv6 is missing).
- **Cursor `environment.json`**: `install`/`start` = `cd /agent/repos/discogenius
  && bash scripts/agent-env/{install,start}.sh`.
- **Claude Code on the web**: setup runs one dir above the checkout (`cd
  discogenius && bash scripts/agent-env/install.sh`); no start hook, so run
  `start.sh` in the background when needed. `CLAUDE.md` imports this file.
- **Antigravity (`agy`) / Gemini** loads `AGENTS.md` and `.agents/skills.json`
  (`skills/*/SKILL.md`) natively, locally and in GitHub Actions.
- Cloud agents cannot reach the LAN (NAS `192.168.1.50`, MusicBrainz mirror
  `192.168.1.100`, live container), have no provider tokens unless set as
  secrets, and have no `tiddl`. Use the public catalogue route there; live-server
  work stays with a LAN agent (Antigravity, local Claude Code, or Grok Bot).

## Before you say done
1. Full `yarn ci` is green; failing test NAMES compared with `main` (below).
2. The new or changed path has a behaviour test that fails without the change.
3. Blast radius: `rg` every consumer of what you changed (symbols, SQL columns,
   API JSON fields, string literals, CHECK values). Name the one fact that makes
   the change safe and prove it with a test or script, not prose.
4. Checked against the real artifact: the running app with Bastille and
   Bakermat when on the LAN; otherwise write "not live-verified" in the PR.
5. Diff has no dead code, debug output, scratch files or narrating comments.
6. PR body: goal, what changed, how it was verified (commands and results),
   what was not verified. Then update `HANDOFF.md`.

## Validation checklist
- `yarn ci` = `yarn lint && yarn typecheck && yarn test:api && yarn build`;
  always before a PR or release tag (catches tsc-only errors).
- `docker compose up -d --build` when runtime packaging changes.
- **Production-service tests boot the ACTIVE schema** via
  `api/src/test-support/active-schema-fixture.ts` (see Database rules); testing
  against `domain-baseline.ts` once shipped an UPDATE to a non-existent column
  with a fully green suite.
- **Judge a change by failing test NAMES, not counts.** Capture the TAP output
  before and after and `comm` the sorted `not ok` lines; zero newly-failing is
  the gate. `api/scripts/run-tests.mjs` retries clone-flake files in isolation
  and APPENDS that output, so cut at the first `1..N` line before comparing or
  you will read the retry summary as the main one.
- Flake: a whole file failing with "Unable to deserialize cloned data" — rerun
  it in isolation before calling it a regression.
- Renames are done one table family per commit, gated by `tsc` plus the
  failure-name comparison. A value used as a string literal (e.g. an
  `entity_type` CHECK) must land together with its fixture sweep — `tsc` cannot
  see those call sites.

## Releases
- The Docker image is published by `.github/workflows/release-dockerhub.yml`;
  `yarn release:prepare` drives version bumps.
- Local Docker validation: `docker-compose.yml` (build) vs
  `docker-compose.example.yml` (published image).
- Hand-write the CHANGELOG `## [x.y.z]` section first, then
  `node .github/workflows/release/prepare-release.mjs --version x.y.z`. Commit
  `release: x.y.z`, tag `vX.Y.Z`, push.

## Catalogue model — the target, not the current state
Schema 41 is an unpublished clean start: there are **no compatibility
migrations**, no legacy aliases, no dual writers. Where the code still diverges
from the model below, the code is wrong and moves toward the model.

**Vocabulary.** An **album** is a release group. An **edition** (album edition)
is one specific release of it. A **provider edition** is a provider's
album/release resource.

    Albums                  album_id        our release-group entity
    AlbumEditions           edition_id      our release entity
    LibraryAlbums / LibraryEditions         per-library curation
    ProviderItems           provider_edition_id / track / video / artist
    ProviderEditionMatches / ProviderEditionMembers / ProviderTrackMatches /
    ProviderVideoMatches / ProviderArtistMatches / ProviderArtistIgnores

**MBID columns keep MusicBrainz vocabulary.** Our entities are albums and
editions; identifiers borrowed from MusicBrainz stay `release_group_mbid` and
`release_mbid`, so it is always obvious which side of the boundary a value came
from. Same reason `foreign_release_id` keeps its name.

**Four authorities, never mixed:**
1. canonical MusicBrainz catalogue facts,
2. provider-native resource/capability facts,
3. typed provider→canonical match decisions,
4. per-library curation / acquisition / completion.

**Rules that follow from this:**
- **`provider_id` alone is NEVER an identity.** It is unique only within
  `(provider, entity_type)`. Carry `ProviderItems.id`, or the full triple. Every
  ProviderItems join needs both predicates.
- Typed match tables are the ONLY provider→canonical link. There is no
  `ProviderItemMatches` (retired) and no MBID shadow column on `ProviderItems`.
  A provider video with no accepted `ProviderVideoMatches` row has no canonical
  identity, and readers must fail closed rather than invent one.
- A track's edition context is a **`ProviderEditionMembers` occurrence** — one
  provider track legitimately sits on several provider editions. Resolve it from
  the acquisition plan, else a unique membership, else NULL. **Never
  `ORDER BY … LIMIT 1`.** Where a caller has no context, answer only when all
  relevant candidates agree; otherwise NULL.
- **`ProviderItemAudioVariants` is SOURCE CAPABILITY**, never a local file's
  imported quality. Read a file's own quality by probing it or from its
  `TrackFiles` technical facts.
- Operations report **exact row identity**. An importer says which
  `TrackFiles.id` it produced; callers never re-find rows by `provider_id`, and
  never position-match two lists. Missing or ambiguous identity is an error.
- Never assume one selected edition per album.
- Every acquisition plan is mono-provider. A composite may use several editions from one provider, never TIDAL plus Deezer (or any other cross-provider mix). A per-track fallback inside an album download stays on the command provider. A whole-album fallback switches the provider and remaps every offer.
- **MusicBrainz / the configured catalog provider is the source of truth for
  audio.** Video recordings are catalog identity with a MusicBrainz `mbid`
  and/or a YouTube `youtube_video_id`. Public YouTube listing is core catalog
  (ytmusicapi), not the YouTube Music download plugin. Apple/TIDAL/etc. match
  onto those rows through `ProviderVideoMatches`. Mint a `provider_catalog`
  recording only when neither catalog has the video.
- Providers download media and may supplement allowed catalogue holes (cover-art
  ids, copyright, replay gain/peak, provider URLs/availability). Provider
  UPC/ISRC are matching evidence and live on `ProviderItems`. If a feature is
  populated exclusively from provider data, re-source it from the catalogue or
  remove it. Prefer integer catalogue FKs; never add provider-shadow catalogue
  columns.

## Database rules
- Never touch the host SQLite DB directly while the container is running. For
  ad-hoc inspection, `docker exec discogenius sh -c 'node /tmp/x.js'` opening
  better-sqlite3 with `{readonly:true, fileMustExist:true}`.
- **Two schema definitions exist and they are not the same thing.**
  `createBaselineSchemaV41()` in `api/src/database.ts` is what `initDatabase()`
  builds and what production runs (currently `user_version` 46).
  `api/src/database/schema/domain-baseline.ts` is the aspirational CORE schema
  (catalogue/library only) and is contract-tested but never created at runtime.
  The active schema converges onto the target; until it has, a test proving
  something against `domain-baseline` proves nothing about production.

## Import & M4A
- M4A stores tags fine (iTunes atoms). Atmos MP4 durations come from
  `probeMediaDuration()` (ffprobe) because `music-metadata` fails on them.
- A track stays "unknown" when `music-metadata` fails and the filename-title
  fuzzy match to a provider/MB recording also fails.

## AcoustID & MBID embedding
- `fpcalc` produces a Chromaprint fingerprint + duration; the AcoustID
  web-service lookup maps it to an AcoustID and, when available, MusicBrainz
  recording IDs (it does not return MBIDs without the lookup).
- Fingerprinting is for unknown/mistagged imports; we only fingerprint files with
  NO mbid. We already embed the full `MUSICBRAINZ_*` tag set when present, and
  downloads get MBIDs embedded directly.
- Plex matches by its own fingerprint/database, not embedded MBID tags. Jellyfin
  natively reads `MUSICBRAINZ_*` tags.
