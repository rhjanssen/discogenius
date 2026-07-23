# Repository Management

Use this skill for repo hygiene and releases: where documentation belongs, how to
cut a release, and keeping the tree clean as the project matures out of alpha
toward stable 2.8 / 3.0. For a go/no-go release assessment, use the
`release-readiness` skill; this skill is the *mechanics* and *hygiene*.

## Where things belong (one living doc per topic)

- **`AGENTS.md`** — durable rules, constraints, preferences. Auto-loaded every
  session; the single source of truth for *rules*.
- **`docs/`** — living design/operator docs. One doc per topic; remove stale
  overlap instead of letting parallel versions drift. `docs/README.md` is the map.
- **`docs/TASKS.md`** — outstanding work only (pending/in-progress/decided/revisit).
  Shipped detail must not accumulate here.
- **`CHANGELOG.md`** — shipped history, one dated `## [x.y.z]` section per release.
- **`skills/<name>/SKILL.md`** — reusable how-to for a recurring task.

Anti-patterns to fix on sight: a "feasibility/audit" doc whose verdict already
lives in `TASKS.md` (delete the long form, keep the backlog line); a doc that
claims a feature shipped when the code says otherwise; a code comment or doc that
points at a removed file/function as if it still exists. This repo went through
heavy alpha where features were "done", regressed, and redone — treat doc claims
as *suspect until verified against the code*, and prune the contradictions.

### Pruning a stale doc (the safe procedure)

1. Read it in full and classify each part: **implemented & not worth documenting**
   → remove; **still wanted** (a 2.8/2.9/3.0 intention) → keep, or fold the
   backlog-worthy essence into `TASKS.md`.
2. Preserve the *why* for any deferred decision as a `TASKS.md` line (verdict +
   revisit trigger), so the reasoning survives the doc's deletion.
3. `grep` the repo for references to the file and fix every one (docs map, other
   docs, code comments). Leave historical `CHANGELOG.md` links alone — they record
   what existed at that release.
4. `git rm` the file; run `yarn --cwd api build` if any code comment referenced it.

## Cutting a release

The Docker image is published by `.github/workflows/release-dockerhub.yml` on a
`v*.*.*` tag push. The tag workflow runs `yarn ci`, asserts `app`+`api`
`package.json` versions equal the tag, builds/pushes
`rhjanssen/discogenius:<version>` (+`:latest` for non-prerelease), and publishes a
GitHub release from the matching `CHANGELOG.md` section.

Steps:
1. **Hand-write the `## [x.y.z]` CHANGELOG section first** (curated, human — the
   commit-subject autogen in `prepare-release.mjs` is a fallback, not the goal).
2. `node .github/workflows/release/prepare-release.mjs --version x.y.z` (bumps
   both `package.json`s; leaves your CHANGELOG section intact if present).
3. `yarn install` if needed, then `yarn ci` locally — the workflow will also gate
   on it, but catch failures before tagging.
4. Stage **only** release-related files. Leave unrelated local work (and never
   `.env`) out of the release commit. Verify with `git status --short` and a
   local↔origin sync check.
5. Commit `release: x.y.z`, tag `vX.Y.Z`, push branch + tag.
6. Confirm the run: `gh run list --workflow=release-dockerhub.yml`, then verify
   Docker Hub actually has the tag before telling the user it's out.

Prereqs live in `docker-compose.yml` (local build) vs `docker-compose.example.yml`
(published image) — keep the wrapper/sidecar blocks in sync across both.

## Runtime state & secrets never get committed

- `config/` is runtime state (TOML config, SQLite DB, provider tokens) — never
  commit. `.env` is gitignored; keep shippable defaults in `.env.example` only.
- `.ref_*` are read-only reference checkouts — consult, never import from them,
  and never vendor them into the image.
- Don't commit build output (`api/dist/`, `dist/`) or scratch DB helpers.

## Toward the 2.8 / 3.0 stabilization

The project is leaving alpha; the goal is a tree a long-term operator can trust.
When Robert calls the history reset, the aim is "as if 2.8/3.0 is the initial
commit": a curated `CHANGELOG` (drop the alpha thrash), no docs describing
superseded methods, and no code comments referencing removed approaches. Do that
pruning **incrementally now** so the eventual squash is a clean checkpoint, not a
rescue. Distinguish *load-bearing* rationale comments ("this path exists because X
regressed") — keep them — from *stale* ones ("we used to call the old FooService")
— fix them.

## Reference conventions

- **Lidarr** (`.ref_lidarr/CONTRIBUTING.md`): lint before commit, pinned Node,
  scripted version bumps — releases are mechanical and gated, not ad-hoc.
- **Fluent UI** (`.ref_fluentui`): change files (`beachball`) force an explicit,
  reviewed changelog entry per change — our analogue is the hand-written
  `CHANGELOG` section before tagging.
- **Jellyfin** (`.ref_jellyfin`: `BannedSymbols.txt`, `.editorconfig`,
  `.DotSettings`): conventions are enforced **mechanically** (analyzers/lint), not
  by memory. Prefer encoding a rule in eslint/tsc/`yarn ci` over documenting it
  and hoping.
