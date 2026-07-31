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
