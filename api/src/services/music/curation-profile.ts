/**
 * Phase timing for curation, in the same shape as the write/read profilers in
 * `database.ts`: off unless `DISCOGENIUS_CURATION_PROFILE_MS` is set, so there
 * is no cost on the hot path when it is not being investigated.
 *
 * Curation is the last mostly-synchronous stretch of a command, and three
 * artists an hour were poison-failing inside it. Which *phase* costs the wall
 * time decides where the cooperative yields belong, and guessing "it must be
 * the coverage union-find" is exactly the kind of assumption that sends a fix
 * to the wrong loop.
 */
const PROFILE_MS = (() => {
  const raw = Number.parseInt(String(process.env.DISCOGENIUS_CURATION_PROFILE_MS ?? ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
})();

export function curationProfilingEnabled(): boolean {
  return PROFILE_MS > 0;
}

export interface CurationPhaseTimer {
  /** Time `phase` and return its value. */
  phase<T>(name: string, work: () => T): T;
  /** Log the accumulated breakdown, slowest first. */
  report(label: string): void;
}

export function createCurationPhaseTimer(): CurationPhaseTimer {
  if (!PROFILE_MS) {
    return { phase: (_name, work) => work(), report: () => {} };
  }
  const totals = new Map<string, { ms: number; calls: number }>();
  // Report at intervals as well as at the end. The pass this was written to
  // diagnose never reaches its end — the watchdog kills the command first — so
  // an end-of-pass-only summary produces exactly nothing for the case that
  // matters. Log a running breakdown whenever the pass crosses another
  // threshold's worth of wall time.
  let nextRunningReportAt = PROFILE_MS;
  let elapsed = 0;
  return {
    phase(name, work) {
      const startedAt = Date.now();
      // Entry logging, not just exit. Every timing wrapper here reports in
      // `finally`, which makes a phase that never *returns* completely
      // invisible — and a phase that never returns is precisely the failure
      // being chased. The last entry line before the log goes quiet names it.
      console.warn(`[curation-profile] > ${name} (call ${(totals.get(name)?.calls ?? 0) + 1})`);
      try {
        return work();
      } finally {
        const took = Date.now() - startedAt;
        const entry = totals.get(name) ?? { ms: 0, calls: 0 };
        entry.ms += took;
        entry.calls += 1;
        totals.set(name, entry);
        elapsed += took;
        if (elapsed >= nextRunningReportAt) {
          nextRunningReportAt = elapsed + Math.max(PROFILE_MS, 5_000);
          const running = [...totals.entries()]
            .sort((left, right) => right[1].ms - left[1].ms)
            .map(([phaseName, value]) => `${phaseName}=${value.ms}ms/${value.calls}`)
            .join(" ");
          console.warn(`[curation-profile] in-progress total=${elapsed}ms ${running}`);
        }
      }
    },
    report(label) {
      const rows = [...totals.entries()].sort((left, right) => right[1].ms - left[1].ms);
      const total = rows.reduce((sum, [, value]) => sum + value.ms, 0);
      if (total < PROFILE_MS) return;
      const breakdown = rows
        .map(([name, value]) => `${name}=${value.ms}ms/${value.calls}`)
        .join(" ");
      console.warn(`[curation-profile] ${label} total=${total}ms ${breakdown}`);
    },
  };
}
