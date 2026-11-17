# Session Handoff

- **Branch**: `agent/issue-136` (updating PR #136 / `agent/issue-133`)
- **What is done**:
  - **Issue #133 / PR #136**: Addressed all PO review feedback on Apple wrapper process termination, readiness check, and hold backoff:
    1. **Regression in `recordProviderAuthFailure` fixed**: `since` now updates to `now` when transitioning from `ok` to `needs_reauth`, retaining `since` only when already `needs_reauth`. Unit tests cover both transitions.
    2. **Targeted stuck rewrite & cleanup**: Removed unused `force` option from `recordProviderAuthFailure`. Only `apple-music` with `APPLE_WRAPPER_STUCK_MESSAGE` rewrites once when already held and does not rewrite again on duplicate calls. Generic `/stuck/i` messages on other providers are ignored. Added tests for all paths.
    3. **Thread-safe restart state derivation**: `hasAttemptedWrapperRestart`, `reconcileWrapperLoginStatus`, and `probeAppleWrapperHealth` derive whether a restart was attempted directly from persisted `authRow` in SQLite (`lastError === APPLE_WRAPPER_STUCK_MESSAGE`) rather than module globals across worker threads. Module globals are restricted to main-thread probe backoff timing. Added unit tests independent of in-memory state.
    4. **Preserved real session failures**: `runAppleWrapperHoldProbe` checks wrapper `login_status.json` (`status === "failed"` with session/login error, distinguishing from crash-loop or unreachable text) before restarting or overwriting with the stuck message, preventing real session errors from being hidden. Added unit tests for session failure vs crash-loop.
    5. **Correct stuck message timing & crash-loop guidance**: The hold probe requests restart on first failure without premature stuck error, and records `APPLE_WRAPPER_STUCK_MESSAGE` on the subsequent probe when the previous restart didn't resolve the dead ports. Supervisor entrypoint v11 now instructs the user to restart the wrapper container (`docker compose restart apple-music-wrapper`) on crash-loop when session marker exists.
    6. **Dual port readiness check**: Supervisor probes both ports 10020 and 20020 with 1s timeout to catch accept backlogs since the decrypt protocol has no ping. Updated unit tests and in-container Docker shell verification.
  - **Verification**:
    - Full `yarn ci` passed (eslint 0 errors, api & app typecheck, 100% passing api & app unit tests, clean production builds).
    - In-container Docker shell test verified startup, process tree, clean process termination on restart, and both ports 10020 and 20020 answering.
- **What is half-done**:
  - None. All review items from PR #136 resolved.
- **What was verified against running container**:
  - Docker shell-level test verified container startup with v11 entrypoint, verified parent/child process structure, simulated restart via `restart_server.txt`, verified all previous processes were terminated without orphans, and verified both ports 10020 and 20020 answer immediately after restart.
- **Open questions for PO**:
  - None. PR #136 is ready for merge.
