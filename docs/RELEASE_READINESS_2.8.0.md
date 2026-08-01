# Discogenius 2.8.0 Release Readiness

This is the human-readable companion to
[`release-readiness-2.8.0.json`](release-readiness-2.8.0.json). It records only
completed evidence. A green unit test is not treated as a load, recovery, live
integration, or browser result.

## Current verdict

**Not ready.** The completed schema-42 architecture is merged to `main`, the
Windows baseline CI is green, and focused hardening has begun. The required
500-Artist load, failure/restart recovery, live metadata/provider integration,
file-lifecycle, responsive browser, Linux CI, final Docker integrity, and long
soak gates are not yet complete.

## Recorded runs

| Run | Git SHA | Layer | Result | Evidence |
| --- | --- | --- | --- | --- |
| `merge-smoke-20260801` | `96f87c0` | API/app typecheck and focused architecture tests | Passed | Typecheck passed; 76/76 focused tests passed |
| `baseline-windows-ci-20260801` | `0df2fc3^` | Windows `yarn ci` baseline before hardening | Passed with warnings | 1,143/1,143 API tests passed; lint had 7 warnings; Vite reported two chunks over 500 kB |
| `queue-pause-unit-20260801` | `0df2fc3` | Durable queue-control/schema/processor tests | Passed | 44/44 focused tests passed; API build passed |
| `scheduler-hardening-unit-20260801` | `cabcac0` | Schedule persistence, UTC timing, and run-history tests | Passed | 27/27 focused tests passed; API build passed |

## Blocking gates

The machine-readable matrix is authoritative for individual capabilities.
These are the largest current blockers:

- No completed deterministic 500+ primary-Artist mixed-load run.
- No completed lease/heartbeat, worker-death, worker-hang, or poisoned-command
  recovery proof.
- No container-restart proof for durable pause and authoritative queue order.
- No completed real local-MusicBrainz concurrency sweep or Servarr comparison.
- No controlled TIDAL/Apple Music provider integration result.
- No complete import, rename, retag, move, delete, and sidecar lifecycle run in
  isolated roots.
- No desktop/tablet/mobile/accessibility release pass under background load.
- No final Windows and Linux CI pair, Docker database integrity audit, or long
  soak.

## Evidence policy

- `passed` means the capability's stated release gate was exercised and its
  assertions passed.
- `failed` means a required assertion is known to be false.
- `untested` means the full gate has not been completed, even when narrower unit
  evidence exists.
- `deferred` is reserved for an explicitly accepted non-blocking deferral.

The release verdict cannot advance to release candidate while any critical
capability is failed or untested.
