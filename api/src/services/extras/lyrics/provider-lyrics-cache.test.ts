import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after } from "node:test";
import test from "node:test";
import { prepareActiveSchemaEnv, closeActiveSchemaDb } from "../../../test-support/active-schema-fixture.js";

const { tempDir } = prepareActiveSchemaEnv("provider-lyrics-cache");
const dbModule = await import("../../../database.js");
const lyrics = await import("./lyric-service.js");
const { trackIdsWithDeliveredSyncedLyrics } = await import("../../mediafiles/track-lyrics-materializer.js");
const { streamingProviderManager } = await import("../../providers/index.js");

after(() => closeActiveSchemaDb(dbModule, tempDir));

async function withProviderLyrics(
  answer: (id: string) => Promise<unknown>,
  body: (calls: string[]) => Promise<void>,
): Promise<void> {
  const tidal = streamingProviderManager.getStreamingProvider("tidal") as any;
  const original = tidal.getLyrics;
  const calls: string[] = [];
  tidal.getLyrics = async (id: string) => {
    calls.push(String(id));
    return answer(String(id));
  };
  lyrics.resetProviderLyricsMissesForTests();
  try {
    await body(calls);
  } finally {
    tidal.getLyrics = original;
    lyrics.resetProviderLyricsMissesForTests();
  }
}

test("a track without lyrics is asked once and remembered until the TTL ends", async () => {
  await withProviderLyrics(async () => null, async (calls) => {
    const now = Date.now();
    assert.equal(await lyrics.fetchProviderLyrics("tidal", "1", now), null);
    assert.equal(await lyrics.fetchProviderLyrics("tidal", "1", now + 60_000), null);
    assert.equal(await lyrics.fetchProviderLyrics("tidal", "1", now + lyrics.PROVIDER_LYRICS_MISS_TTL_MS - 1), null);
    assert.deepEqual(calls, ["1"]);
    await lyrics.fetchProviderLyrics("tidal", "1", now + lyrics.PROVIDER_LYRICS_MISS_TTL_MS + 1);
    assert.deepEqual(calls, ["1", "1"]);
  });
});

test("an empty lyrics answer counts as absent, a provider error is not remembered", async () => {
  await withProviderLyrics(async (id) => {
    if (id === "err") throw new Error("TIDAL session is not available");
    return { text: "", subtitles: "", provider: "tidal" };
  }, async (calls) => {
    await lyrics.fetchProviderLyrics("tidal", "empty");
    await lyrics.fetchProviderLyrics("tidal", "empty");
    await lyrics.fetchProviderLyrics("tidal", "err");
    await lyrics.fetchProviderLyrics("tidal", "err");
    assert.deepEqual(calls, ["empty", "err", "err"]);
  });
});

test("real lyrics are returned and not cached as a miss", async () => {
  await withProviderLyrics(async () => ({ text: "la la", subtitles: "[00:01.00]la la", provider: "tidal" }), async (calls) => {
    const first = await lyrics.fetchProviderLyrics("tidal", "9");
    assert.equal(first?.subtitles, "[00:01.00]la la");
    await lyrics.fetchProviderLyrics("tidal", "9");
    assert.deepEqual(calls, ["9", "9"]);
  });
});

test("tracks whose downloader already wrote synced lyrics are skipped for prefetch", () => {
  const workspace = fs.mkdtempSync(path.join(tempDir, "tiddl-workspace-"));
  const album = path.join(workspace, "555");
  fs.mkdirSync(album, { recursive: true });
  fs.writeFileSync(path.join(album, "101.flac"), "audio");
  fs.writeFileSync(path.join(album, "101.lrc"), "[00:01.00]synced line\n[00:02.00]another\n");
  fs.writeFileSync(path.join(album, "102.flac"), "audio");
  fs.writeFileSync(path.join(album, "102.lrc"), "plain text only\n");
  fs.writeFileSync(path.join(album, "103.flac"), "audio");

  assert.deepEqual([...trackIdsWithDeliveredSyncedLyrics(workspace, ["101", "102", "103"])], ["101"]);
  assert.deepEqual([...trackIdsWithDeliveredSyncedLyrics(null, ["101"])], []);
  assert.deepEqual([...trackIdsWithDeliveredSyncedLyrics(path.join(workspace, "missing"), ["101"])], []);
});
