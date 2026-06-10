# Discogenius AI Coding Agent Instructions

Read [AGENTS.md](../AGENTS.md) at the repository root — it is the single
source of truth for agent expectations (architecture boundaries, hard rules,
validation checklist).

Quick orientation:

- Monorepo: `api/` (Express + TypeScript + better-sqlite3), `app/`
  (React + Vite + Fluent UI v9), `e2e/` (Playwright).
- MusicBrainz metadata is canonical; providers (TIDAL) supply availability
  and download resources only. All TIDAL downloads go through `tiddl`.
- Validate with `yarn lint`, `yarn --cwd api build`, `yarn --cwd app build`,
  and `yarn test:api` before finishing a change.
