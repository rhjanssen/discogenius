import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-artwork-preference-"));
process.env.DB_PATH = path.join(tempDir, "artwork-preference.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let refreshModule: typeof import("./artwork-preference-refresh.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  refreshModule = await import("./artwork-preference-refresh.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM Albums").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("artwork preference refresh covers the entire canonical catalog with bounded work", async () => {
  const insertArtist = dbModule.db.prepare(
    "INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)",
  );
  insertArtist.run("artist-unmanaged", "Unmanaged Artist");
  insertArtist.run("artist-credited", "Credited Artist");

  const insertAlbum = dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, monitored)
    VALUES (?, ?, ?, ?)
  `);
  insertAlbum.run("album-unmonitored-a", "artist-unmanaged", "Unmonitored A", 0);
  insertAlbum.run("album-monitored", "artist-unmanaged", "Monitored", 1);
  insertAlbum.run("album-unmonitored-b", "artist-credited", "Unmonitored B", 0);

  const albumCalls: string[] = [];
  const artistCalls: Array<{ mbid: string; types: string[] }> = [];
  const progress: Array<{
    completed: number;
    total: number;
    albumsCompleted: number;
    artistsCompleted: number;
  }> = [];
  let active = 0;
  let maxActive = 0;
  let yields = 0;

  const enterResolver = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
  };

  const summary = await refreshModule.refreshArtworkPreferenceCache({
    concurrency: 2,
    resolveAlbum: async (options) => {
      albumCalls.push(String(options.albumMbid));
      await enterResolver();
      return "/media-cover/album.jpg";
    },
    resolveArtist: async (options) => {
      artistCalls.push({
        mbid: String(options.artistMbid),
        types: Array.isArray(options.preferredCoverTypes)
          ? [...options.preferredCoverTypes]
          : [String(options.preferredCoverTypes)],
      });
      await enterResolver();
      return "/media-cover/artist.jpg";
    },
    onProgress: (value) => progress.push({ ...value }),
    yieldToEventLoop: async () => {
      yields++;
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  });

  assert.deepEqual(new Set(albumCalls), new Set([
    "album-unmonitored-a",
    "album-monitored",
    "album-unmonitored-b",
  ]));
  assert.deepEqual(
    new Set(artistCalls.map((call) => call.mbid)),
    new Set(["artist-unmanaged", "artist-credited"]),
  );
  for (const artistMbid of ["artist-unmanaged", "artist-credited"]) {
    assert.deepEqual(
      artistCalls.filter((call) => call.mbid === artistMbid).map((call) => call.types),
      [["Poster", "Headshot"], ["Fanart"]],
    );
  }
  assert.ok(maxActive <= 2, `expected at most two active resolvers, saw ${maxActive}`);
  assert.equal(yields, 3);
  assert.deepEqual(progress.at(-1), {
    completed: 5,
    total: 5,
    albumsCompleted: 3,
    artistsCompleted: 2,
  });
  assert.deepEqual(summary, {
    total: 5,
    completed: 5,
    failed: 0,
    albums: 3,
    artists: 2,
  });
});
