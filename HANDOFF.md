# Session Handoff

- **Branch**: `agent/issue-135`
- **What is done**:
  - **Issue #135**: Lyrics prefetch time budget, circuit breaker, progress ticking, and completed workspace recovery:
    - **Prefetch time budget**: Lyrics and tag-supplement prefetch is now best-effort bounded by a hard budget `max(60s, 2s * tracks) capped at 5min` (`calculateLyricsPrefetchBudgetMs`). Lookups exceeding the deadline are skipped and marked `null` in prefetched map so import proceeds immediately without delaying media placement; missing lyrics can be backfilled later.
    - **Circuit breaker** (`lyrics-circuit-breaker.ts`): Trips after 5 consecutive timeouts or 5xx responses from a provider's lyrics endpoint, pausing lyrics lookups for that provider across all jobs for 15 minutes cooldown with a logged warning. Resets failure counter on success or 404.
    - **Shorter timeout and fewer retries**: Lyrics lookups use a 10s per-attempt timeout and at most 1 retry (`maxRetries = 2`, `timeoutMs = 10_000` on TIDAL and bounded in `fetchProviderLyrics`), avoiding the default 45s timeout and 3 retries.
    - **Progress ticking**: Each completed or failed lookup ticks command progress (`subphaseTick: true` and `CommandQueueManager.touchProgress`) updating `last_progress_at` so the download watchdog never terminates a worker making progress.
    - **Worker-loss recovery**: `recoverInterruptedDownloadAttempts` and job dispatch detect when a download workspace is already complete (`isDownloadWorkspaceComplete`), transitioning directly to an `importPending` handoff (`transitionCompleteDownloadToImportHandoff`) without re-running `tiddl` or network prefetch from scratch.
    - **Tests**: Added unit tests in `lyrics-circuit-breaker.test.ts`, `lyrics-prefetch-budget.test.ts`, and updated `download-processor-liveness.test.ts` verifying timeout budget compliance, circuit breaker, progress ticking, and completed-workspace recovery. Verified with full `yarn ci`.
- **What is half-done**:
  - None.
- **What was NOT verified on LAN**:
  - Live TIDAL connection with actual network timeouts on LAN homelab container. Cloud VM cannot reach the LAN.
- **Open questions / notes for PO**:
  - PR opened: https://github.com/rhjanssen/discogenius/pull/137
