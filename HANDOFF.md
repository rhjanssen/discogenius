# Session Handoff

- **Branch**: `agent/issue-133`
- **What is done**:
  - **Issue #133**: Resolved Apple wrapper restart orphaned process issue and download hold hang (`https://github.com/rhjanssen/discogenius/issues/133`).
    - **Supervisor Entrypoint v11** (`WRAPPER_ENTRYPOINT_SCRIPT`):
      * Starts `./wrapper` under `setsid` in its own process group (`PGID == PID`).
      * Added `ports_bound()` check via `/proc/net/tcp` and `/dev/tcp`.
      * Added `stop_server()` which kills the whole process group (`kill -TERM -$SERVER_PID`, `kill -9 -$SERVER_PID`, `kill -9 $SERVER_PID`, `wait $SERVER_PID`, and `pkill -9 -f "wrapper.*-M 20020"` fallback) and waits up to 10s until ports 10020/20020 are completely unbound.
      * In `start_server()`, probes port 10020 every 1s for up to 15s to verify it accepts connections before declaring readiness. If verification fails, kills the process group and retries respecting the 120s / 5-restart crash-loop window.
      * Applied clean stop across startup, restart-file request, died/restart supervisor loop, and login paths.
      * Bumped `WRAPPER_ENTRYPOINT_VERSION` to `discogenius-wrapper-entrypoint v11` so existing installs receive the updated supervisor script.
    - **Exponential Backoff Re-probing & Escalation**:
      * Added `calculateWrapperRestartBackoffMs` (5m -> 10m -> 15m capped) for periodic re-probing while held for an unreachable wrapper with an active session.
      * Re-requests `restart_server.txt` on re-probe failure and resets state upon wrapper recovery.
    - **Banner & Health Diagnostics**:
      * When session marker exists but wrapper ports stay dead after restart attempts, banner and health status report `"Apple decryption server is stuck; restart the wrapper container"` instead of suggesting re-authentication.
      * Updated `recordProviderAuthFailure` and `providerAuthCopy` to display the stuck message and prevent misleading re-auth guidance.
    - **Automated Tests**:
      * Unit tests in `apple-music-hold-probe.test.ts` for backoff calculation, session checks, escalation, stuck message recording, and recovery.
      * Shell-level / Docker tests in `apple-music-wrapper-restart.test.ts` verifying v11 script contents and in-container verification that restart requests cleanly terminate child processes and leave port 10020 answering with 0 orphaned processes.
  - **Verification**:
    - Full `yarn ci` passed (eslint 0 errors, api & app typecheck, 100% passing api & app unit tests, clean production builds).
- **What is half-done**:
  - None. All acceptance criteria for Issue #133 are met.
- **What was verified against running container**:
  - Live Docker shell-level test verified container startup with v11 entrypoint, verified parent/child process structure, simulated restart via `restart_server.txt`, verified all previous processes were terminated without orphans, and verified port 10020 answers immediately after restart.
- **Open questions for PO**:
  - None. PR ready for review and merge.
