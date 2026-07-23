# Backend Development (api/)

Use this skill when writing or changing backend code under `api/src/` — routes,
services, the command queue, repositories, matching, import/download, or schema.

The backend mirrors **Lidarr's** architecture (`.ref_lidarr`,
`docs/LIDARR_STRUCTURE_ALIGNMENT.md`). When unsure how to shape a concern, look
at how Lidarr's `NzbDrone.Core/` splits it — but **the rules below and the
current contracts are the source of truth, not any single existing file.** This
codebase came through heavy alpha; some modules still carry patterns we are
moving away from. Don't copy a pattern just because it's there.

## Stack & non-negotiables

- **TypeScript everywhere; Yarn 1.x only.** ESM (`.js` import specifiers in TS).
- **Synchronous `better-sqlite3` on the single Node event loop.** There is no
  async DB. Any slow query stalls the *entire* app.
- Validate external boundaries (provider responses, request bodies) explicitly.
- Respect `monitored_lock` / `monitor_lock`: automation must never flip
  user-locked monitor state.

## Layer discipline (keep routes thin)

- **Routes** (`api/src/routes/**`) parse/validate input and delegate. No durable
  workflow logic in a handler.
- **Services** (`api/src/services/**`) own workflow logic; **repositories**
  (`api/src/repositories/**`) own SQL.
- **Long-running work goes through the command queue — never inline in a route.**
  - Enqueue a `CommandModel` via the queue manager
    (`services/commands/command-queue-manager.ts`).
  - `command-executor.ts` drains and dispatches to handlers in
    `services/commands/handlers/` (registered via `command-registry.ts`).
  - `scheduler.ts` enqueues due scheduled tasks.
  - In heavy inline loops call `CommandExecutor.yieldToEventLoop()` so the HTTP/SSE
    thread stays responsive.
- Use **Lidarr's command/event vocabulary** (standing rule): *refresh* = pull
  metadata; *scan* = react to a disk change. Keep `MediaFile` vs `TrackFile`
  divergence intentional (folder/route say `mediafiles`; the DB table stays
  `TrackFiles` for Lidarr parity — do not "correct" either to match the other).

## SQLite performance rules (these are correctness, not polish)

The event loop *is* the DB thread, so a bad query is an app-wide hang.

- **Never scan big tables.** Add indexes for every foreign-key / filter column.
- Replace `OR EXISTS (subquery)` with `OR col IN (subquery)`.
- Use `col = 1`, not `COALESCE(col,0) = 1`, for `is_video` / `monitored` so the
  index applies.
- Prefer release-group-scoped CTEs over OR-over-a-big-table.
- Prefer integer catalog FKs for new file joins; do not add provider-shadow
  catalog columns.
- Keep chunked writes (`runChunkedWrite`) for bulk catalog hydration; do not wrap
  a huge sync in one giant transaction.

## Data-model boundary (MusicBrainz is canonical)

- **MusicBrainz / the configured catalog provider is the source of truth.**
  Providers download media and supplement *allowed* catalog holes only (cover-art
  ids, copyright, replay-gain/peak, provider URLs/availability).
- Provider UPC/ISRC are **matching evidence** and live on `ProviderItems` /
  `ProviderItemMatches`, never on `Albums` / `AlbumReleases` / `Recordings`.
- There are no provider catalog tables. If a feature is populated *only* from
  provider data, re-source it from the catalog or remove it.
- See `docs/DATA_MODEL_TARGET.md` and `docs/MATCHING_SET_COVER_DESIGN.md` (the
  3.0 recording-centric matching direction).

## Matching

One shared matcher scores slot-candidate tracks. Beware camelCase-vs-snake_case
drift between callers (a recurring bug). The online catalog strips ISRC/UPC; use
local-MB mode for exact ISRC/UPC, otherwise match on MBID + duration + title
distance.

## Validation before you claim done

- `yarn --cwd api build` after backend changes (this is a real `tsc` typecheck).
- `yarn ci` (`lint && typecheck && test:api && build`) before recommending a
  release — the Vite app build tolerates type errors, so build-alone is not
  enough.
- API tests: `node api/scripts/run-tests.mjs <file>` for a focused run. The node
  test-runner occasionally fails a whole file with "Unable to deserialize cloned
  data" — rerun in isolation to confirm it's the known flake, not your change.
- For DB/import/download changes, validate against **real data** (Bastille /
  Bakermat) in the container when host tooling isn't enough.

## Reference conventions (`.ref_lidarr`)

- Command queue, `DecisionEngine`, `MediaFiles`/`Organizer`, `MetadataSource`
  map directly to our folders — consult the Lidarr concern before inventing a new
  shape.
- Lidarr encodes single-signal-vs-multi-signal matching in a `Distance`
  calculator (title + length + ids); our matcher follows that shape rather than
  accreting per-case title branches.
- Lidarr stays single-operator (no multi-user/roles) — so do we.
