import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { RankedDownloadOffer } from "./download-offer-fallback.js";

process.env.DISCOGENIUS_DOWNLOAD_SAME_OFFER_ATTEMPTS = "3";
process.env.DISCOGENIUS_DOWNLOAD_SAME_OFFER_BACKOFF_MS = "100";

const {
  classifyDownloadFailure,
  sameOfferBackoffMs,
  formatFallbackSuccessMessage,
  executeWithSameOfferRetries,
  isDownloadCancellationError,
} = await import("./download-failure-policy.js");
const { makeOfferAttemptKey, nextOfferAfterTried } = await import("./download-offer-fallback.js");

test("classifyDownloadFailure treats tiddl exit-1 / traceback as transient", () => {
  assert.equal(
    classifyDownloadFailure(new Error("tiddl exited with code 1: Traceback (most recent call last)")),
    "transient",
  );
  assert.equal(classifyDownloadFailure(new Error("ECONNRESET")), "transient");
  assert.equal(classifyDownloadFailure(new Error("429 Too Many Requests")), "transient");
});

test("a Deezer connection pool failure wrapped as not available is retried", async () => {
  const wrapped = new Error(
    "streamrip exited with code 1: Track 3135553 not available for stream on deezer: Connection pool is full",
  );
  assert.equal(classifyDownloadFailure(wrapped), "transient");
  assert.equal(classifyDownloadFailure(new Error("HTTPSConnectionPool(host='api.deezer.com'): Max retries exceeded")), "transient");
  assert.equal(classifyDownloadFailure(new Error("Traceback (most recent call last): Connection pool is full, discarding connection")), "transient");
  let calls = 0;
  const result = await executeWithSameOfferRetries({ sleep: async () => undefined }, async () => {
    calls += 1;
    if (calls < 3) throw wrapped;
    return "file";
  });
  assert.equal(result, "file");
  assert.equal(calls, 3);
});

test("a Deezer traceback around an unstreamable track is permanent", () => {
  const unstreamable = new Error(
    "streamrip exited with code 1: Traceback (most recent call last):\n"
    + "Track 3135553 not available for stream on deezer: no rights",
  );
  assert.equal(classifyDownloadFailure(unstreamable), "permanent");
  assert.equal(
    classifyDownloadFailure(new Error("Traceback (most recent call last): not available for stream on deezer")),
    "permanent",
  );
  assert.equal(
    classifyDownloadFailure(new Error("not available for stream on deezer: ReadTimeout")),
    "transient",
    "a real timeout still overrides the catalogue wrapper",
  );
});

test("exhausted transient retries still try the next provider", async () => {
  const offers: RankedDownloadOffer[] = [
    { provider: "deezer", providerId: "dz-1", quality: "lossless" },
    { provider: "tidal", providerId: "td-1", quality: "lossless" },
  ];
  const tried = new Set<string>([makeOfferAttemptKey(offers[0].provider, offers[0].providerId)]);
  const attempts: string[] = [];
  let current = offers[0];
  let downloaded: string | null = null;
  while (downloaded == null) {
    try {
      downloaded = await executeWithSameOfferRetries({ sleep: async () => undefined }, async () => {
        attempts.push(current.provider);
        if (current.provider === "deezer") throw new Error("ECONNRESET");
        return current.provider;
      });
    } catch (error) {
      const next = nextOfferAfterTried(offers, tried);
      assert.ok(next, "same-offer exhaustion must still reach the next provider");
      tried.add(makeOfferAttemptKey(next.provider, next.providerId));
      current = next;
      assert.ok(error);
    }
  }
  assert.equal(downloaded, "tidal");
  assert.deepEqual(attempts, ["deezer", "deezer", "deezer", "tidal"]);
});

test("catalogue, region, and entitlement failures stay permanent beside transport wording", () => {
  assert.equal(classifyDownloadFailure(new Error("Track not available in your country")), "permanent");
  assert.equal(classifyDownloadFailure(new Error("Traceback (most recent call last): track not found")), "permanent");
  assert.equal(classifyDownloadFailure(new Error("Album unavailable")), "permanent");
  assert.equal(classifyDownloadFailure(new Error("track no longer available")), "permanent");
  assert.equal(classifyDownloadFailure(new Error("quality unavailable")), "permanent");
  assert.equal(classifyDownloadFailure(new Error("Deezer requested quality unavailable: no media URL")), "permanent");
});

test("classifyDownloadFailure treats 404 / not found as permanent", () => {
  assert.equal(classifyDownloadFailure(new Error("tiddl exited with code 1: track not found")), "permanent");
  assert.equal(classifyDownloadFailure(new Error("HTTP 404 Not Found")), "permanent");
  assert.equal(classifyDownloadFailure(new Error("Album unavailable")), "permanent");
});

test("a provider auth error is not retried on the same offer", async () => {
  const { ProviderAuthError } = await import("../providers/provider-auth-error.js");
  let attempts = 0;
  await assert.rejects(executeWithSameOfferRetries({ sleep: async () => {} }, async () => {
    attempts += 1;
    throw new ProviderAuthError("tidal", "Tidal login expired (token has expired).");
  }), /token has expired/);
  assert.equal(attempts, 1);
});

test("missing downloader provisioning does not repeat same-offer attempts", async () => {
  let attempts = 0;
  await assert.rejects(executeWithSameOfferRetries({ sleep: async () => {} }, async () => {
    attempts++;
    throw new Error("Apple Music downloader provisioning is incomplete: missing decryption wrapper port 10020.");
  }), /provisioning is incomplete/);
  assert.equal(attempts, 1);
});

test("classifyDownloadFailure treats private YouTube and SoundCloud DRM as permanent", () => {
  assert.equal(
    classifyDownloadFailure(new Error("ERROR: [youtube] 6NhkjW9DYLw: Private video. Sign in if you've been granted access")),
    "permanent",
  );
  assert.equal(
    classifyDownloadFailure(new Error("yt-dlp SoundCloud: This video is DRM protected")),
    "permanent",
  );
  assert.equal(
    classifyDownloadFailure(new Error("SoundCloud album 1: all 3 track(s) are DRM/SNIP-only or unplayable for this account.")),
    "permanent",
  );
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
  assert.equal(isDownloadCancellationError(new Error("The operation was aborted")), true);
  assert.equal(isDownloadCancellationError(new Error("ECONNABORTED")), false);
  assert.equal(classifyDownloadFailure(new Error("ECONNABORTED")), "transient");
});
