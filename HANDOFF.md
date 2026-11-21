# Session Handoff

- **Branch**: `agent/issue-163` (Issue #163)
- **What is done**:
  - Updated `DownloadWaitQueue.nextMissingRank()` in `api/src/services/download/download-wait-queue.ts` to allocate missing ranks in `QUEUE_RANK_STEP` (1024) steps before the first unclaimed upgrade (using `WHERE command_id IS NULL AND queue_order < ?` for `previous`) and, when the gap before the first unclaimed upgrade is exhausted, shift all unclaimed rows at or after `firstUpgrade.queue_order` forward by `QUEUE_RANK_SHIFT` (`1024 * 1024`) inside `enqueue()`'s transaction.
  - Added regression tests in `api/src/services/download/download-wait-queue.test.ts` verifying 200 missing enqueues behind waiting upgrades stay ahead of all upgrades in FIFO order with `missing-0` claimed first, and verifying repeated shifts (>1024 missing rows) leave claimed rows untouched while preserving `front` enqueue and manual `reorder`. Both tests failed before the fix and pass after.
  - Verified full `yarn ci` passes cleanly (lint, typecheck, api test suite, app tests, and production builds).
- **What is half-done**:
  - None.
- **What was live-verified**:
  - Not live-verified (cloud agent environment has no LAN/container access); verified against the active SQLite runtime schema (schema 46) via `download-wait-queue.test.ts` and full `yarn ci`.
- **Open questions for PO**:
  - None.
