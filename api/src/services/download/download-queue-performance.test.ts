import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { performance } from "node:perf_hooks";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
} from "../../test-support/active-schema-fixture.js";

const { tempDir } = prepareActiveSchemaEnv("download-queue-perf");
const { db, dbModule } = await openActiveSchemaDb();
const { DownloadQueueQueryService } = await import("./download-queue-query-service.js");

after(() => closeActiveSchemaDb(dbModule, tempDir));

const TOTAL_ROWS = 150_000;

before(() => {
  const insertCmd = db.prepare(`
    INSERT INTO commands (id, name, ref_id, payload, status, queue_order)
    VALUES (?, 'DownloadAlbum', ?, '{}', 'started', ?)
  `);
  const insertQueue = db.prepare(`
    INSERT INTO DownloadQueue (
      ref_key, media_kind, command_name, plan_id, edition_id, provider, provider_id,
      artist_id, album_id, title, artist, queue_order, command_id
    ) VALUES (?, 'album', 'DownloadAlbum', ?, ?, ?, ?, 'artist-1', ?, ?, 'Test Artist', ?, ?)
  `);

  db.transaction(() => {
    insertCmd.run(1, "album:rg-running:stereo", 0);
    insertQueue.run(
      "album:rg-running:stereo",
      1000,
      2000,
      "tidal",
      "prov-run-1",
      "rg-running",
      "Running Album",
      0,
      1,
    );

    for (let i = 1; i < TOTAL_ROWS; i++) {
      const provider = i % 3 === 0 ? "apple-music" : "tidal";
      const albumId = i % 500 === 0 ? "rg-target-album" : `rg-${i}`;
      insertQueue.run(
        `album:rg-${i}:stereo`,
        1000 + i,
        2000 + i,
        provider,
        `prov-${i}`,
        albumId,
        `Album ${i}`,
        i,
        null,
      );
    }
  })();
});

test("DownloadQueue keyset cursor pagination, filters, and fields meet <500ms p95 at 150k rows (#77)", async () => {
  DownloadQueueQueryService.invalidateSnapshots();

  // First page with limit 500 (above old 200 cap)
  const firstPage = await DownloadQueueQueryService.getQueueAsync({ limit: 500 });
  assert.equal(firstPage.total, TOTAL_ROWS);
  assert.equal(firstPage.items.length, 500);
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.nextCursor, "nextCursor should be returned when more rows exist");

  const first = firstPage.items[0];
  assert.equal(first.status, "started");
  assert.equal(first.ref_key, "album:rg-running:stereo");
  assert.equal(first.plan_id, 1000);
  assert.equal(first.edition_id, 2000);

  const second = firstPage.items[1];
  assert.equal(second.status, "queued");
  assert.equal(second.queuePosition, 1);
  assert.equal(second.ref_key, "album:rg-1:stereo");
  assert.equal(second.plan_id, 1001);
  assert.equal(second.edition_id, 2001);

  // Cursor walk across pages and measure p95 latency
  const durationsMs: number[] = [];
  let cursor = firstPage.nextCursor!;
  for (let i = 0; i < 20; i++) {
    DownloadQueueQueryService.invalidateSnapshots();
    const start = performance.now();
    const page = await DownloadQueueQueryService.getQueueAsync({ limit: 500, cursor });
    durationsMs.push(performance.now() - start);
    assert.equal(page.items.length, 500);
    assert.ok(page.nextCursor);
    cursor = page.nextCursor!;
  }
  durationsMs.sort((a, b) => a - b);
  const p95 = durationsMs[Math.floor(durationsMs.length * 0.95)];
  assert.ok(p95 < 500, `Expected p95 < 500ms at 150k rows, got ${p95.toFixed(1)}ms`);

  // Filters: status, provider, album
  DownloadQueueQueryService.invalidateSnapshots();
  const startedOnly = await DownloadQueueQueryService.getQueueAsync({ limit: 50, status: "started" });
  assert.equal(startedOnly.total, 1);
  assert.equal(startedOnly.items[0].ref_key, "album:rg-running:stereo");

  const completedOnly = await DownloadQueueQueryService.getQueueAsync({ limit: 50, status: "completed" });
  assert.equal(completedOnly.total, 0);
  assert.equal(completedOnly.items.length, 0);

  const appleOnly = await DownloadQueueQueryService.getQueueAsync({ limit: 50, provider: "apple-music" });
  assert.ok(appleOnly.total > 0);
  assert.ok(appleOnly.items.every((item) => item.provider === "apple-music"));

  const albumOnly = await DownloadQueueQueryService.getQueueAsync({ limit: 50, album: "rg-target-album" });
  assert.ok(albumOnly.total > 0);
  assert.ok(albumOnly.items.every((item) => item.album_id === "rg-target-album"));
});
