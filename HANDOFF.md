# Session Handoff

- **Branch**: `cursor/download-reliability-7af7`, from `main` (`3acad553`, release 2.27.4).
- **Done**:
  - **#187**: Apple port checks try every resolved address and return as soon as one accepts, so an IPv6 refusal or a hanging IPv6 connect no longer cancels or outwaits the IPv4 listener. A second read happens before `restart_server.txt` is written. The first 20s after process start do not hold Apple while the sidecar is still binding. The wrapper supervisor (entrypoint v13) does not fork a second server while 10020/20020 are still listening.
  - **#189**: A ripper `Unavailable` (and the same class of download failure) is counted, not stored as permanent on the first hit. After the existing threshold, one preview/stream check decides: a working preview stays retryable and is counted on the health page; a failed preview is the only write of `unavailable` (`Confirmed unavailable:`). Startup and housekeeping clear unconfirmed download marks and in-progress streaks. The album tracklist hides a confirmed-unavailable offer.
  - **Download watchdog**: availability checks and quality-profile conversion tick progress. An interrupted import is reparked and run again instead of failed as "not replayed".
- **Half-done**: none. Merged as #190 (`59e70213`). Release 2.27.5 follows on `main`.
- **Verification**:
  - `yarn ci` exits 0 in 308.09s (lint 1 pre-existing warning, typecheck, api tests, app tests, build).
  - API TAP before the first `1..N`: 2850 tests, 2840 pass, 9 skipped, 1 clone-flake (`src/services/music/album-command-service.test.ts`, `Unable to deserialize cloned data`). Isolated retry of that file: 8/8 pass. No other `not ok`.
- **Live-verified**: not live-verified (cloud runner has no LAN access to the live container).
- **Open questions for PO**: none. After the image is published, pull the new tag on the TrueNAS host and recreate the stack so the wrapper entrypoint rewrites to v13.
