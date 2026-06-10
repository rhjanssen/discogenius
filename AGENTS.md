# Discogenius Agent Guide

Single source of truth for coding-agent expectations in this repository.
`CLAUDE.md` and `.github/copilot-instructions.md` defer to this file.

## What Discogenius Is

A self-hosted, Lidarr-style music library manager that uses streaming-service
rippers (TIDAL via tiddl, first) instead of torrent indexers, adds
discography deduplication on top of release-type filtering, and manages
stereo, spatial (Atmos), and music-video libraries — by default in three
separate library roots.

Core identity rules:

- MusicBrainz metadata is the canonical library identity (artists, release
  groups, releases, tracks, recordings). Lidarr's model is the reference.
- Providers (TIDAL) only supply availability, previews, lyrics, artwork, and
  download resources. Provider rows never create canonical entities or
  wanted state on their own.
- All TIDAL downloads (audio, Atmos, video) go through `tiddl`. There is one
  download backend; do not add direct downloader calls outside
  `api/src/services/providers/tidal/`.

## Layout

- `api/` — Express + TypeScript + better-sqlite3 (synchronous DB access only)
- `app/` — React + Vite + Fluent UI v9 + TanStack Query
- `e2e/` — Playwright tests
- `config/` — runtime state (TOML config, SQLite DB, provider tokens) — never commit
- `.ref_*` — read-only reference checkouts (Lidarr, Tidarr, arr-scripts…); consult them, never import from them

## Development Rules

- TypeScript everywhere; Yarn 1.x only.
- Keep routes thin; durable workflow logic lives in services/repositories.
- Long-running work goes through the queue (`api/src/services/jobs/`), never
  inline in route handlers.
- Queue separation: `download-processor.ts` handles exact download jobs;
  `scheduler.ts` handles everything else. Command exclusivity lives in
  `command.ts`; queue lifecycle in `queue.ts`.
- Validate external boundaries (HTTP payloads, CLI output, DB rows, file
  metadata) explicitly.
- Respect `monitored_lock` / `monitor_lock` columns: automation must never
  flip user-locked monitor state.

## Frontend Rules

- Fluent UI React v9 exclusively — components, `makeStyles`, and design
  tokens. No other UI kits, no ad-hoc CSS colors; use Fluent tokens.
- Data fetching via TanStack Query; theme state via `FluentThemeProvider` +
  `useTheme`.
- Reuse shared components/hooks before adding new one-off patterns.

## Validation Checklist

```
yarn --cwd api build     # after backend changes
yarn --cwd app build     # after frontend changes
yarn lint
yarn test:api            # node:test via tsx; full suite must stay green
docker compose up -d --build   # when runtime packaging changes
```

Known flake: the node test-runner occasionally fails a whole file with
"Unable to deserialize cloned data" — rerun the file in isolation before
assuming a real failure.

## Releases

The Docker image is published by `.github/workflows/release-dockerhub.yml`;
`yarn release:prepare` drives version bumps. Local Docker validation uses
`docker-compose.yml` (build) vs `docker-compose.example.yml` (published image).
