# Discogenius 2.8.0 Release Readiness

This is the human-readable companion to
[`release-readiness-2.8.0.json`](release-readiness-2.8.0.json). It records only
completed evidence. A green unit test is not treated as a load, recovery, live
integration, or browser result.

## Current verdict

**Not ready.** The completed schema-42 architecture is merged to `main` and the
hardening branch is green on the Windows gate, but the release-defining gates
are still unrun. Of 32 tracked capabilities, 1 is `passed` and 31 are
`untested`. Substantial hardening has landed as code and unit tests; almost
none of it has been exercised under load, restart, live integration, or in a
browser.

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
| `compose-isolation-audit-20260801` | `54a8193` | Release-hardening Compose audit | Passed | All mounts nested under a required disposable root; downloads disabled by default; port 3837 |

## Corrections applied on this pass

- **Global search was returning HTTP 500 on the active schema.** The album
  branch coalesced a retired `ProviderItems.quality` scalar. Schema 42 has no
  such column, so SQLite failed at prepare time for any query matching an
  album. Fixed in `13532a7`; quality now derives from
  `ProviderItemAudioVariants`. The existing route tests only covered artists,
  tracks and videos, which is why the album branch was never prepared.
- **The app test suite was not in the CI gate.** Six app test files added by
  this branch never executed. Wired into `yarn ci` in `54a8193`.

## Blocking gates

The machine-readable matrix is authoritative for individual capabilities.
These remain the largest blockers, none of which has been run:

- No deterministic 500+ primary-Artist mixed-load run from a committed SHA.
- No lease/heartbeat, worker-death, worker-hang, or poisoned-command recovery
  matrix beyond unit level.
- No container-restart proof for durable pause or authoritative queue order,
  and no 100k-row queue scale result.
- No real local-MusicBrainz concurrency sweep at full runtime, so the shipped
  concurrency default is unjustified by end-to-end evidence.
- No Servarr comparison result.
- No controlled TIDAL/Apple Music provider execution.
- No import, rename, retag, move, delete, or sidecar lifecycle run in isolated
  roots, and no hard-kill recovery decision.
- No desktop/tablet/mobile or rendered-browser pass.
- No Linux CI, Docker integrity audit, or soak of any duration.

## Evidence policy

- `passed` means the capability's stated release gate was exercised and its
  assertions passed.
- `failed` means a required assertion is known to be false.
- `untested` means the full gate has not been completed, even when narrower unit
  evidence exists.
- `deferred` is reserved for an explicitly accepted non-blocking deferral.

The release verdict cannot advance to release candidate while any critical
capability is failed or untested.
