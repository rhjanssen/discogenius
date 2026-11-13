import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import {
  clearAcoustIdLookupCacheForTest,
  lookupAcoustIdDetailed,
} from "./fingerprint.js";

test("AcoustID lookup submits the documented single-fingerprint contract and preserves ambiguity", async () => {
  clearAcoustIdLookupCacheForTest();
  let requestBody = "";
  const outcome = await lookupAcoustIdDetailed(
    { fingerprint: "fingerprint-data", duration: 181.4 },
    {
      clientId: "test-client",
      post: async (_url, body) => {
        requestBody = gunzipSync(body).toString("utf8");
        return {
          status: 200,
          data: {
            status: "ok",
            results: [
              {
                id: "acoustid-one",
                score: 0.98,
                recordings: [
                  { id: "recording-one" },
                  { id: "recording-two" },
                  { id: "recording-one" },
                ],
              },
            ],
          },
        };
      },
    },
  );

  assert.equal(outcome.status, "matched");
  assert.equal(outcome.cached, false);
  assert.deepEqual(outcome.matches, [{
    id: "acoustid-one",
    score: 0.98,
    recordingIds: ["recording-one", "recording-two"],
  }]);
  const params = new URLSearchParams(requestBody);
  assert.equal(params.get("client"), "test-client");
  assert.equal(params.get("meta"), "recordingids");
  assert.equal(params.get("duration"), "181");
  assert.equal(params.get("fingerprint"), "fingerprint-data");
  assert.equal(params.has("batch"), false);
  assert.equal(params.has("duration.0"), false);
});

test("AcoustID lookup caches successful and no-match outcomes without retaining raw keys", async () => {
  clearAcoustIdLookupCacheForTest();
  let calls = 0;
  const post = async () => {
    calls += 1;
    return { status: 200, data: { status: "ok", results: [] } };
  };

  const first = await lookupAcoustIdDetailed(
    { fingerprint: "no-match-fingerprint", duration: 180 },
    { clientId: "test-client", post },
  );
  const second = await lookupAcoustIdDetailed(
    { fingerprint: "no-match-fingerprint", duration: 180 },
    { clientId: "test-client", post },
  );

  assert.equal(first.status, "no_match");
  assert.equal(first.cached, false);
  assert.equal(second.status, "no_match");
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
});

test("AcoustID lookup distinguishes missing configuration, invalid input, and service failure", async () => {
  clearAcoustIdLookupCacheForTest();
  assert.equal(
    (await lookupAcoustIdDetailed(
      { fingerprint: "fingerprint", duration: 180 },
      { clientId: null },
    )).status,
    "missing_client",
  );
  assert.equal(
    (await lookupAcoustIdDetailed(
      { fingerprint: "", duration: 0 },
      { clientId: "test-client" },
    )).status,
    "invalid_input",
  );
  const failed = await lookupAcoustIdDetailed(
    { fingerprint: "fingerprint", duration: 180 },
    {
      clientId: "test-client",
      post: async () => {
        throw new Error("network unavailable");
      },
    },
  );
  assert.equal(failed.status, "service_error");
  assert.match(failed.error || "", /network unavailable/);
});

test("AcoustID lookup serializes concurrent requests and retries HTTP 429 with backoff", async () => {
  clearAcoustIdLookupCacheForTest();
  let calls = 0;
  const timestamps: number[] = [];

  const retried = await lookupAcoustIdDetailed(
    { fingerprint: "fp-429", duration: 180 },
    {
      clientId: "test-client",
      minIntervalMs: 10,
      retryDelaysMs: [15, 30],
      post: async () => {
        calls += 1;
        timestamps.push(Date.now());
        if (calls < 2) {
          return {
            status: 429,
            headers: {},
            data: { status: "error", error: { code: 5, message: "rate limit exceeded" } },
          };
        }
        return {
          status: 200,
          data: { status: "ok", results: [{ id: "aid-1", score: 0.95, recordings: [{ id: "rec-1" }] }] },
        };
      },
    },
  );
  assert.equal(retried.status, "matched");
  assert.equal(calls, 2);
  assert.equal(retried.matches[0]?.recordingIds[0], "rec-1");
  assert.ok(timestamps[1] - timestamps[0] >= 10);

  // Concurrent uncached lookups are serialized by at least minIntervalMs
  const order: number[] = [];
  await Promise.all([
    lookupAcoustIdDetailed(
      { fingerprint: "fp-a", duration: 180 },
      {
        clientId: "test-client",
        minIntervalMs: 25,
        post: async () => {
          order.push(Date.now());
          return { status: 200, data: { status: "ok", results: [] } };
        },
      },
    ),
    lookupAcoustIdDetailed(
      { fingerprint: "fp-b", duration: 181 },
      {
        clientId: "test-client",
        minIntervalMs: 25,
        post: async () => {
          order.push(Date.now());
          return { status: 200, data: { status: "ok", results: [] } };
        },
      },
    ),
  ]);
  assert.equal(order.length, 2);
  assert.ok(order[1] - order[0] >= 20);
});
