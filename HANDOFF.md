# Session Handoff

- **Branch**: `cursor/apple-hold-clear-7af7`, from `main` (`dd0d98b1`, release 2.27.5).
- **Done**:
  - A persisted Apple `needs_reauth` hold (including "decryption server is stuck") is cleared as soon as ports 10020 and 20020 accept, including on the first probe at startup and again when the startup grace ends. A real sign-in / CKC session error is not cleared just because the ports are open.
  - No wrapper restart is requested during the first 20s after process start, and the supervisor (entrypoint v14) deletes a restart file left by the previous process before it starts the server.
  - If Docker DNS returns only IPv6, the port check also tries the hostname as IPv4.
- **Half-done**: none. Merged as #191 (`c3d283d0`). Release 2.27.6 follows on `main`.
- **Verification**: Apple hold, preflight, port-check, and wrapper-script tests pass locally (23 + 14). `bash -n` on the generated entrypoint passes. Full `yarn ci` is the GitHub check.
- **Live-verified**: not live-verified (cloud runner has no LAN access). Production report for 2.27.5: 1197 unconfirmed marks cleared; Apple stayed held on the pre-upgrade stuck error and one startup restart was logged.
- **Open questions for PO**: none. After 2.27.6, pull the image and recreate the stack. The stuck hold clears on its own once the wrapper ports answer.
