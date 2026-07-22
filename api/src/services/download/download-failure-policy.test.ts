import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

process.env.DISCOGENIUS_DOWNLOAD_SAME_OFFER_ATTEMPTS = "3";
process.env.DISCOGENIUS_DOWNLOAD_SAME_OFFER_BACKOFF_MS = "100";

const {
  classifyDownloadFailure,
  sameOfferBackoffMs,
  formatFallbackSuccessMessage,
  executeWithSameOfferRetries,
  isDownloadCancellationError,
} = await import("./download-failure-policy.js");

test("classifyDownloadFailure treats tiddl exit-1 / traceback as transient", () => {
  assert.equal(
    classifyDownloadFailure(new Error("tiddl exited with code 1: Traceback (most recent call last)")),
    "transient",
  );
  assert.equal(classifyDownloadFailure(new Error("ECONNRESET")), "transient");
  assert.equal(classifyDownloadFailure(new Error("429 Too Many Requests")), "transient");
});

test("classifyDownloadFailure treats 404 / not found as permanent", () => {
  assert.equal(classifyDownloadFailure(new Error("tiddl exited with code 1: track not found")), "permanent");
  assert.equal(classifyDownloadFailure(new Error("HTTP 404 Not Found")), "permanent");
  assert.equal(classifyDownloadFailure(new Error("Album unavailable")), "permanent");
});

test("sameOfferBackoffMs doubles from base", () => {
  assert.equal(sameOfferBackoffMs(1), 100);
  assert.equal(sameOfferBackoffMs(2), 200);
  assert.equal(sameOfferBackoffMs(3), 400);
});

test("formatFallbackSuccessMessage uses light wording", () => {
  const message = formatFallbackSuccessMessage("apple-music", "tidal");
  assert.match(message, /Downloaded from .+ after .+ failed\. File is ready\./);
});

test("executeWithSameOfferRetries retries transient failures then succeeds", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const result = await executeWithSameOfferRetries(
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
    async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("tiddl exited with code 1: Traceback");
      }
      return "ok";
    },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [100, 200]);
});

test("executeWithSameOfferRetries skips retry for permanent failures", async () => {
  let calls = 0;
  await assert.rejects(
    () => executeWithSameOfferRetries(
      { sleep: async () => undefined },
      async () => {
        calls += 1;
        throw new Error("HTTP 404 track not found");
      },
    ),
    /404 track not found/,
  );
  assert.equal(calls, 1);
});

test("executeWithSameOfferRetries does not retry cancellations", async () => {
  let calls = 0;
  await assert.rejects(
    () => executeWithSameOfferRetries(
      { sleep: async () => undefined },
      async () => {
        calls += 1;
        throw new Error("Download cancelled");
      },
    ),
    /cancelled/,
  );
  assert.equal(calls, 1);
  assert.equal(isDownloadCancellationError(new Error("Download cancelled")), true);
});
