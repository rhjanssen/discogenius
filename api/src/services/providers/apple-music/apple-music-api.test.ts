import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { appleMusicApiRequest, type FetchLike } from "./apple-music-api.js";
import { ProviderRateLimitError, ProviderRequestState } from "../provider-request-state.js";

const token = { developer_token: "test", media_user_token: "test", storefront: "us" };

test("Apple Retry-After cooldown is shared across workers and prevents another HTTP request", async () => {
  const state = new ProviderRequestState();
  let calls = 0;
  const before = Date.now();
  const fetchImpl: FetchLike = async (_url, init) => {
    calls++;
    assert.ok(init?.signal, "network request has a deadline");
    return { ok: false, status: 429, headers: { get: () => "120" }, json: async () => ({}) };
  };
  await assert.rejects(appleMusicApiRequest("/v1/me/storefront", { token, fetchImpl, requestState: state }), ProviderRateLimitError);
  assert.equal(calls, 1);
  assert.ok(state.retryAt("apple-music") >= before + 120_000);
  const entry = fileURLToPath(new URL("./apple-music-api.ts", import.meta.url));
  const worker = new Worker(`
    require('tsx/cjs');
    const {workerData,parentPort}=require('node:worker_threads');
    const {appleMusicApiRequest}=require(workerData.entry);
    let calls=0;
    appleMusicApiRequest('/v1/me/storefront',{
      token:workerData.token,
      fetchImpl:async()=>{calls++;return {ok:true,status:200,json:async()=>({})};}
    }).then(()=>parentPort.postMessage({unexpectedSuccess:true}),error=>parentPort.postMessage({calls,name:error.name,status:error.status,retryAt:error.retryAt}));
  `, { eval: true, workerData: { entry, token, providerRequestCooldowns: state.buffer } });
  try {
    const [message] = await once(worker, "message");
    assert.deepEqual(message, { calls: 0, name: "ProviderRateLimitError", status: 429, retryAt: state.retryAt("apple-music") });
  } finally { await worker.terminate(); }
});

test("Apple parses HTTP-date Retry-After and uses a bounded default when it is absent", async () => {
  for (const value of [new Date(Date.now() + 180_000).toUTCString(), null, "invalid"]) {
    const state = new ProviderRequestState();
    const before = Date.now();
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 429, headers: { get: () => value }, json: async () => ({}) });
    await assert.rejects(appleMusicApiRequest("/test", { token, fetchImpl, requestState: state }), ProviderRateLimitError);
    if (value && value !== "invalid") assert.equal(state.retryAt("apple-music"), Date.parse(value));
    else assert.ok(state.retryAt("apple-music") >= before + 60_000);
  }
});

test("expired provider cooldown permits requests and another response cannot shorten an active cooldown", async () => {
  const state = new ProviderRequestState();
  state.defer("apple-music", Date.now() - 1);
  const value = await appleMusicApiRequest("/test", {
    token, requestState: state,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ healthy: true }) }),
  });
  assert.deepEqual(value, { healthy: true });
  const deadline = Date.now() + 120_000;
  state.defer("apple-music", deadline);
  assert.equal(state.defer("apple-music", Date.now() + 60_000), deadline);
});
