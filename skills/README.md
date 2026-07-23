# Project Skills

Project-local skills and workflows live here. Each skill must have its own
subdirectory containing a `SKILL.md` file.

Available skills:

- `container-ops`: operating a deployed/running container — health, logs,
  read-only DB inspection, native tools, the Apple wrapper sidecar, smoke tests.
- `backend-dev`: backend work under `api/` — layer discipline, the command queue,
  synchronous-SQLite performance rules, the MusicBrainz-canonical data boundary
  (guided by `.ref_lidarr`).
- `frontend-dev`: UI work under `app/` — pure Fluent UI v9, design tokens, Griffel
  `makeStyles`, TanStack Query, browser verification (guided by `.ref_fluentui`).
- `provider-adapter`: adding/changing a streaming provider against the plugin
  contract, keeping providers swappable and core canonical (guided by
  `.ref_lidarr` / `.ref_jellyfin`).
- `repo-management`: documentation hygiene, release mechanics, and pruning toward
  the 2.8/3.0 stabilization.
- `release-readiness`: go/no-go release gating assessment for Discogenius.

Each skill cites the reference checkout(s) under `.ref_*` it draws conventions
from. Do not add one-off task notes here. Use `docs/TASKS.md` for backlog items
and `CHANGELOG.md` for shipped history.
