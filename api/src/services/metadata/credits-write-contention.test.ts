import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { performance } from "node:perf_hooks";
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";
import type { CatalogProvider, CatalogTrackArtistCredit } from "../catalog/catalog-provider.js";
import type { RelationshipBundle } from "../catalog/relationship-credit-model.js";

const { tempDir } = prepareActiveSchemaEnv("credits-contention");

let database: Awaited<ReturnType<typeof openActiveSchemaDb>>;
let syncModule: typeof import("./track-artist-credit-sync.js");
let relStoreModule: typeof import("./relationship-credit-store.js");
let lockModule: typeof import("../commands/worker/sqlite-write-lock.js");

before(async () => {
  database = await openActiveSchemaDb();
  syncModule = await import("./track-artist-credit-sync.js");
  relStoreModule = await import("./relationship-credit-store.js");
  lockModule = await import("../commands/worker/sqlite-write-lock.js");
});

after(() => {
  lockModule.captureSqliteWriteLockLabels(false);
  closeActiveSchemaDb(database.dbModule, tempDir);
});

test("track-artist-credits:sync does not acquire write gate across non-transactional read work when credits are unchanged", async () => {
  const db = database.db;
  const artistId = Number(
    db.prepare("INSERT INTO ArtistMetadata (mbid, name, sort_name) VALUES ('artist-unchanged', 'Bastille', 'Bastille')")
      .run().lastInsertRowid,
  );
  db.prepare("INSERT INTO Albums (mbid, title, artist_mbid) VALUES ('rg-1', 'Bad Blood', 'artist-unchanged')").run();
  const editionId = Number(
    db.prepare("INSERT INTO AlbumEditions (mbid, title, release_group_mbid, artist_mbid) VALUES ('edition-1', 'Bad Blood', 'rg-1', 'artist-unchanged')")
      .run().lastInsertRowid,
  );
  const recId = Number(
    db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid) VALUES ('rec-unchanged', 'Pompeii', 'artist-unchanged')")
      .run().lastInsertRowid,
  );
  const trackId = Number(
    db.prepare(`
      INSERT INTO Tracks (mbid, release_mbid, recording_mbid, album_edition_id, recording_id, medium_position, position, title)
      VALUES ('track-unchanged', 'edition-1', 'rec-unchanged', ?, ?, 1, 1, 'Pompeii')
    `).run(editionId, recId).lastInsertRowid,
  );

  // Stored credits already match
  db.prepare("INSERT INTO TrackArtistCredits (track_id, artist_id, ordinal, credited_name, join_phrase) VALUES (?, ?, 0, 'Bastille', '')")
    .run(trackId, artistId);
  db.prepare("INSERT INTO RecordingArtistCredits (recording_id, artist_id, ordinal, credited_name, join_phrase) VALUES (?, ?, 0, 'Bastille', '')")
    .run(recId, artistId);

  const fakeCatalog = {
    async getTrackArtistCredits(mbids: string[]) {
      return new Map([
        [
          "track-unchanged",
          [
            {
              artistId: "artist-unchanged",
              artistName: "Bastille",
              artistSortName: "Bastille",
              creditedName: "Bastille",
              joinPhrase: "",
            },
          ],
        ],
      ]);
    },
  } as unknown as CatalogProvider;

  lockModule.captureSqliteWriteLockLabels(true);
  lockModule.takeSqliteWriteLockLabels();

  const result = await syncModule.TrackArtistCreditSync.syncTrackMbids(["track-unchanged"], { catalog: fakeCatalog });
  const labels = lockModule.takeSqliteWriteLockLabels();
  lockModule.captureSqliteWriteLockLabels(false);

  assert.equal(result.changed, 0, "no changes reported");
  assert.equal(result.artistsRepaired, 0, "no artists repaired");
  assert.equal(
    labels.filter((l) => l.startsWith("track-artist-credits")).length,
    0,
    "no track-artist-credits write gate held when unchanged",
  );
});

test("track-artist-credits:sync takes write gate only for changed credits and repairs artists with indexed lookups", async () => {
  const db = database.db;
  const artistId = Number(
    db.prepare("INSERT INTO ArtistMetadata (mbid, name, sort_name) VALUES ('artist-differ', 'Old Name', 'Old Sort')")
      .run().lastInsertRowid,
  );
  db.prepare("INSERT INTO Albums (mbid, title, artist_mbid) VALUES ('rg-2', 'Album 2', 'artist-differ')").run();
  const editionId = Number(
    db.prepare("INSERT INTO AlbumEditions (mbid, title, release_group_mbid, artist_mbid) VALUES ('edition-2', 'Album 2', 'rg-2', 'artist-differ')")
      .run().lastInsertRowid,
  );
  const recId = Number(
    db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid) VALUES ('rec-differ', 'Track Differ', 'artist-differ')")
      .run().lastInsertRowid,
  );
  const trackId = Number(
    db.prepare(`
      INSERT INTO Tracks (mbid, release_mbid, recording_mbid, album_edition_id, recording_id, medium_position, position, title)
      VALUES ('track-differ', 'edition-2', 'rec-differ', ?, ?, 1, 1, 'Track Differ')
    `).run(editionId, recId).lastInsertRowid,
  );

  db.prepare("INSERT INTO TrackArtistCredits (track_id, artist_id, ordinal, credited_name, join_phrase) VALUES (?, ?, 0, 'Old Name', '')")
    .run(trackId, artistId);

  const fakeCatalog = {
    async getTrackArtistCredits(mbids: string[]) {
      return new Map([
        [
          "track-differ",
          [
            {
              artistId: "artist-differ",
              artistName: "New Canonical Name",
              artistSortName: "Name, New Canonical",
              creditedName: "New Credited",
              joinPhrase: "",
            },
          ],
        ],
      ]);
    },
  } as unknown as CatalogProvider;

  lockModule.captureSqliteWriteLockLabels(true);
  lockModule.takeSqliteWriteLockLabels();

  const result = await syncModule.TrackArtistCreditSync.syncTrackMbids(["track-differ"], { catalog: fakeCatalog });
  const labels = lockModule.takeSqliteWriteLockLabels();
  lockModule.captureSqliteWriteLockLabels(false);

  assert.equal(result.changed, 1, "changed 1 track");
  assert.equal(result.artistsRepaired, 1, "repaired 1 artist name");
  assert.ok(labels.includes("track-artist-credits:sync"), "acquired track-artist-credits:sync for write");
  assert.ok(labels.includes("track-artist-credits:artist-names"), "acquired track-artist-credits:artist-names for write");

  // Verify stored rows
  const updatedArtist = db.prepare("SELECT name, sort_name FROM ArtistMetadata WHERE mbid = 'artist-differ'").get() as {
    name: string;
    sort_name: string;
  };
  assert.equal(updatedArtist.name, "New Canonical Name");
  assert.equal(updatedArtist.sort_name, "Name, New Canonical");
});

test("applyRelationshipRefreshAsync yields write gate between batches allowing concurrent writers to interleave", async () => {
  const db = database.db;
  const numRecordings = 250; // across multiple 100-item chunks
  const recMbids: string[] = [];

  for (let i = 0; i < numRecordings; i++) {
    const mbid = `rec-bundle-${i}`;
    recMbids.push(mbid);
    db.prepare("INSERT OR IGNORE INTO Recordings (mbid, title) VALUES (?, ?)")
      .run(mbid, `Song ${i}`);
  }

  const bundle: RelationshipBundle = {
    queriedRecordingMbids: recMbids,
    queriedReleaseMbids: [],
    credits: recMbids.map((mbid, index) => ({
      scope: "recording" as const,
      entityMbid: mbid,
      role: "performer",
      attribute: "vocals",
      artistMbid: "artist-unchanged",
      creditedName: "Bastille",
      sortName: "Bastille",
      order: index,
      mediumPosition: null,
    })),
    works: [],
  };

  lockModule.captureSqliteWriteLockLabels(true);
  lockModule.takeSqliteWriteLockLabels();

  let interleavedWriterRan = false;
  let interleavedWaitedMs = 0;

  // Launch relationship refresh async
  const refreshPromise = relStoreModule.applyRelationshipRefreshAsync(db, bundle);

  // Concurrently simulate an import or heartbeat writer wanting the write gate
  const simulateHeartbeat = async () => {
    // Wait briefly so refresh enters its first batch
    await new Promise((resolve) => setTimeout(resolve, 2));
    const start = performance.now();
    await database.dbModule.withSqliteWriteGate(() => {
      interleavedWriterRan = true;
    }, "command:heartbeat");
    interleavedWaitedMs = performance.now() - start;
  };

  await Promise.all([refreshPromise, simulateHeartbeat()]);

  const labels = lockModule.takeSqliteWriteLockLabels();
  lockModule.captureSqliteWriteLockLabels(false);

  assert.ok(interleavedWriterRan, "interleaved command:heartbeat writer executed");
  assert.ok(
    interleavedWaitedMs < 2000,
    `interleaved writer completed promptly (${interleavedWaitedMs.toFixed(1)}ms < 2000ms) without multi-second starvation`,
  );

  const relCreditLabels = labels.filter((l) => l === "servarr:relationship-credits");
  assert.ok(relCreditLabels.length >= 2, `refresh took write gate per batch (got ${relCreditLabels.length} batches)`);
  assert.ok(labels.includes("command:heartbeat"), "recorded command:heartbeat in write lock trace");
});
