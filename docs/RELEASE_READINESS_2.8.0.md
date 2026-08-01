# Discogenius 2.8.0 Release Readiness

This is the human-readable companion to
[`release-readiness-2.8.0.json`](release-readiness-2.8.0.json). It records only
completed evidence. A green unit test is not treated as a load, recovery, live
integration, or browser result.

## Current verdict

**Not ready — development only.** All hardening work is merged into `main`,
which is now the authoritative development branch. Windows CI is green in a
single root invocation covering both suites, a fresh schema-42 runtime builds
and deploys on the ordinary Compose deployment, and global search is verified
end to end, as is durable download pause across restart. Of 32 tracked
capabilities, 4 are `passed` and 28 are `untested`.

The release-defining gates — load, restart and failure recovery, live
metadata/provider integration, file lifecycle, responsive browser sweep, Linux
CI and soak — remain unrun. Substantial hardening has landed as code and unit
tests; most of it has not been exercised under load, restart, or live
integration.

Nothing is currently recorded as `failed`. That is not a statement of health —
the five previously-failed capabilities were reclassified to `untested` because
their recorded evidence predated the hardening commits that addressed them, and
the replacement gates have not been run.

## Recorded runs

| Run | Git SHA | Layer | Result | Evidence |
| --- | --- | --- | --- | --- |
| `merge-smoke-20260801` | `96f87c0` | API/app typecheck and focused architecture tests | Passed | Typecheck passed; 76/76 focused tests passed |
| `baseline-windows-ci-20260801` | `0df2fc3^` | Windows `yarn ci` baseline before hardening | Passed with warnings | 1,143/1,143 API tests passed; lint had 7 warnings; Vite reported two chunks over 500 kB |
| `queue-pause-unit-20260801` | `0df2fc3` | Durable queue-control/schema/processor tests | Passed | 44/44 focused tests passed; API build passed |
| `scheduler-hardening-unit-20260801` | `cabcac0` | Schedule persistence, UTC timing, and run-history tests | Passed | 27/27 focused tests passed; API build passed |
| `search-active-schema-20260801` | `13532a7` | Active-schema global search regression | Passed | Reproduced HTTP 500 on a fresh schema-42 database; fixed; 7/7 search route tests pass |
| `baseline-windows-ci-20260801b` | `13532a7` | Windows CI | Passed with warnings | `yarn ci` exit 0 in 268.9s; 1,214/1,214 API tests; 0 skips; 7 lint warnings; two chunks over 500 kB |
| `app-suite-20260801` | `54a8193` | App vitest suite | Passed | 19 files / 78 tests passed; suite was previously absent from CI |
| `compose-isolation-audit-20260801` | `54a8193` | Compose deployment decision | Superseded | Dedicated RC Compose file removed by decision; validation now uses the default `docker-compose.yml` |
| `post-merge-windows-ci-20260801` | `60a3cb8` | Windows CI, single root invocation | Passed with warnings | `yarn ci` exit 0 in 155.5s; 1,214 API + 78 frontend tests in one run; 0 skips; 7 lint warnings |
| `docker-normal-compose-20260801` | `60a3cb8` | Normal Compose build and deploy | Passed | Image `sha256:4a58c361…`; container healthy in ~10s; compiled `search.js` in the image carries the fix |
| `schema-integrity-runtime-20260801` | `60a3cb8` | Fresh schema-42 runtime integrity | Passed | `user_version=42`, `quick_check=ok`, `foreign_key_check=0 rows`, 74 tables — empty and populated |
| `global-search-runtime-20260801` | `d722cee` | Global search on compiled runtime + browser | Passed | All four types 200 on empty and populated catalogs; album grid renders; console clean |
| `durable-pause-restart-20260801` | `2f64ba7` | Durable download pause across container restart | Passed | Blocker found and fixed; pause and resume both survive restart; 75 queued downloads stayed queued while paused |

## Corrections applied on this pass

- **Every container restart silently paused downloads for good.** Graceful
  shutdown called `downloadProcessor.pause()`, which persists
  `download_queue_paused=true`. Because the persisted row wins over the startup
  default, the next start came back paused with nothing to un-pause it — a
  routine `docker compose restart` stopped downloading permanently. Fixed in
  `2f64ba7` by separating the shutdown halt (`suspend()`) from the operator
  pause, and re-verified in both directions on the deployed runtime.
- **Global search was returning HTTP 500 on the active schema.** The album
  branch coalesced a retired `ProviderItems.quality` scalar. Schema 42 has no
  such column, so SQLite failed at prepare time for any query matching an
  album. Fixed in `13532a7`; quality now derives from
  `ProviderItemAudioVariants`. The existing route tests only covered artists,
  tracks and videos, which is why the album branch was never prepared.
- **The app test suite was not in the CI gate.** Six app test files added by
  this branch never executed. Wired into `yarn ci` in `54a8193`.

## Runtime environment

Release validation uses the repository's ordinary Compose deployment
(`docker compose` with no `-f`). There is no dedicated release-candidate Compose
file, project name, or port. Runtime data is disposable and every runtime gate
starts from a wiped `config`/`downloads`/`library` and a freshly created schema
42.

Because the ordinary deployment bind-mounts repository-relative directories,
filesystem safety is a precondition of each test rather than a property of the
deployment: resolve and print the Stereo, Spatial, Video, download, staging and
unmapped host paths, prove each is an empty disposable directory, and fail
closed when ambiguous.

## Blocking gates

The machine-readable matrix is authoritative for individual capabilities.
These remain the largest blockers, none of which has been run:

- No deterministic 500+ primary-Artist mixed-load run from a committed SHA.
- No lease/heartbeat, worker-death, worker-hang, or poisoned-command recovery
  matrix beyond unit level.
- No container-restart proof for authoritative queue order, and no 100k-row
  queue scale result. (Durable pause is now proven; queue order is not.)
- No real local-MusicBrainz concurrency sweep at full runtime, so the shipped
  concurrency default is unjustified by end-to-end evidence.
- No Servarr comparison result.
- No controlled TIDAL/Apple Music provider execution.
- No import, rename, retag, move, delete, or sidecar lifecycle run in isolated
  roots, and no hard-kill recovery decision.
- No desktop/tablet/mobile or rendered-browser pass.
- No Linux CI or soak of any duration.

## Live-runtime observations (not gates)

Recorded from a real Servarr-sourced refresh of Bastille on the deployed
runtime. These are encouraging but do not substitute for the gates above:

- The `commands` table carries the full liveness column set, and a mid-refresh
  snapshot showed **0 started commands with a missing or expired lease**.
- **0 duplicate `queue_order` values among active commands** and no NULL orders.
  Whole-table duplicates occur only where a completed row and a new queued row
  share a slot in the sparse 1024-step sequence — that gap allocation is what
  makes a single-edge reorder O(1), so the meaningful invariant is uniqueness
  scoped to active commands.
- Credited-Artist expansion stayed bounded: one added Artist produced 25
  Artists total, with active commands rising to ~99 and then draining.
- WAL reached 37.8 MB against a 38.6 MB main database during refresh. Bounded
  WAL growth is an open question for the load and soak gates.

## Evidence policy

- `passed` means the capability's stated release gate was exercised and its
  assertions passed.
- `failed` means a required assertion is known to be false.
- `untested` means the full gate has not been completed, even when narrower unit
  evidence exists.
- `deferred` is reserved for an explicitly accepted non-blocking deferral.

The release verdict cannot advance to release candidate while any critical
capability is failed or untested.
