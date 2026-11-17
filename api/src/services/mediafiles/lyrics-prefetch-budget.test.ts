import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import {
  calculateLyricsPrefetchBudgetMs,
  prefetchProviderLyrics,
} from "./track-lyrics-materializer.js";
import {
  isLyricsCircuitOpen,
  resetLyricsCircuitBreakerForTests,
} from "../extras/lyrics/lyrics-circuit-breaker.js";
import { streamingProviderManager } from "../providers/index.js";
import { Config } from "../config/config.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-lyrics-budget-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.lyrics-budget.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetLyricsCircuitBreakerForTests();
});

test("calculateLyricsPrefetchBudgetMs applies formula: max(60s, 2s * tracks) capped at 5m", () => {
  // 10 tracks: 2s * 10 = 20s -> clamped to min 60s
  assert.equal(calculateLyricsPrefetchBudgetMs(10), 60_000);
  // 30 tracks: 2s * 30 = 60s -> 60s
  assert.equal(calculateLyricsPrefetchBudgetMs(30), 60_000);
  // 105 tracks: 2s * 105 = 210s -> 210_000ms
  assert.equal(calculateLyricsPrefetchBudgetMs(105), 210_000);
  // 200 tracks: 2s * 200 = 400s -> capped at 300_000ms (5 min)
  assert.equal(calculateLyricsPrefetchBudgetMs(200), 300_000);
});

test("prefetchProviderLyrics completes within budget when provider calls hang, and ticks progress for every item", async () => {
  let calls = 0;
  const slowProvider = {
    id: "slow-provider",
    name: "Slow Provider",
    capabilities: { lyrics: true, tracks: true, albums: true },
    getLyrics: async (id: string) => {
      calls++;
      // Simulate slow call (300ms each)
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { text: `lyrics for ${id}`, subtitles: "", provider: "slow-provider" };
    },
  };
  (streamingProviderManager as any).providers.set("slow-provider", slowProvider);

  try {
    const trackIds = ["track-1", "track-2", "track-3", "track-4", "track-5", "track-6", "track-7", "track-8"];
    const ticks: Array<{ completed: number; total: number }> = [];

    const start = Date.now();
    // Budget: 150ms. With 300ms per call, only first batch should complete or time out, remaining skipped.
    const result = await prefetchProviderLyrics(
      "slow-provider",
      trackIds,
      2, // concurrency 2
      null,
      {
        budgetMs: 150,
        onProgressTick: (completed, total) => {
          ticks.push({ completed, total });
        },
      },
    );
    const elapsed = Date.now() - start;

    // Must finish within budget allowance (< 800ms, not 8 * 300ms = 2400ms)
    assert.ok(elapsed < 800, `Prefetch took ${elapsed}ms, should finish within budget window`);

    // All track ids should be resolved or marked skipped (null)
    for (const id of trackIds) {
      assert.ok(Object.hasOwn(result, `slow-provider\0${id}`), `Key for ${id} must exist in result`);
    }

    // Progress tick should have reached total items
    assert.ok(ticks.length > 0);
    const lastTick = ticks[ticks.length - 1];
    assert.equal(lastTick.completed, trackIds.length);
    assert.equal(lastTick.total, trackIds.length);
  } finally {
    (streamingProviderManager as any).providers.delete("slow-provider");
  }
});

test("prefetchProviderLyrics skips lookups immediately when circuit breaker is open", async () => {
  let calls = 0;
  const failingProvider = {
    id: "breaker-provider",
    name: "Breaker Provider",
    capabilities: { lyrics: true, tracks: true, albums: true },
    getLyrics: async () => {
      calls++;
      const err = new Error("Gateway Timeout 504");
      (err as any).status = 504;
      throw err;
    },
  };
  (streamingProviderManager as any).providers.set("breaker-provider", failingProvider);

  try {
    // Run with 6 tracks: 5 consecutive failures will trip the circuit breaker
    const trackIds = ["b1", "b2", "b3", "b4", "b5", "b6", "b7"];
    await prefetchProviderLyrics("breaker-provider", trackIds, 1, null, { budgetMs: 5000 });

    assert.equal(isLyricsCircuitOpen("breaker-provider"), true);
    assert.equal(calls, 5); // 6th and 7th were not called because circuit opened

    // A second job calling prefetchProviderLyrics for the same provider immediately skips
    const secondStart = Date.now();
    const secondResult = await prefetchProviderLyrics("breaker-provider", ["b8", "b9"], 1, null, { budgetMs: 5000 });
    const secondElapsed = Date.now() - secondStart;

    assert.ok(secondElapsed < 50, `Immediate skip should be near-instant, took ${secondElapsed}ms`);
    assert.deepEqual(secondResult, {});
  } finally {
    (streamingProviderManager as any).providers.delete("breaker-provider");
  }
});
