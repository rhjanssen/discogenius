# Release Readiness

Use this skill when assessing whether Discogenius is ready to tag or push a
release.

## Workflow

1. Read `AGENTS.md`, `docs/TASKS.md`, and the top unreleased section of
   `CHANGELOG.md`.
2. Check `git status --short` and identify whether changes are release-related
   or unrelated local work.
3. Confirm `api/package.json` and `app/package.json` versions match the intended
   release tag. If they do not, the release is not ready until
   `.github/workflows/release/prepare-release.mjs --version <version>` has run.
4. Run full `yarn ci` before recommending a tag. Vite build alone is not enough
   because it can tolerate type errors.
5. If runtime packaging, Dockerfile, compose files, native tool setup, or tiddl
   behavior changed, run `docker compose up -d --build` and smoke-test the
   container.
6. For DB or import/download changes, validate against real data when possible.
   Use Bastille and Bakermat as the preferred test artists.
7. Report release readiness as one of:
   - ready: all blockers cleared and validation passed
   - nearly ready: only release metadata or packaging checks remain
   - not ready: code/docs/tests still have blockers

## Required Checks

- `yarn ci`
- package versions match the intended tag
- `CHANGELOG.md` has a dated section for the release before tagging
- no stale docs point at removed files or completed migration plans
- Docker validation when packaging/runtime changed
