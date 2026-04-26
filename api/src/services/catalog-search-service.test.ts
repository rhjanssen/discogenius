import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { StreamingCatalogProvider } from "./streaming-catalog-provider.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-catalog-search-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.catalog-search.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let catalogSearchModule: typeof import("./catalog-search-service.js");

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  catalogSearchModule = await import("./catalog-search-service.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM library_files").run();
  db.prepare("DELETE FROM media").run();
  db.prepare("DELETE FROM albums").run();
  db.prepare("DELETE FROM artists").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedCatalogRows() {
  dbModule.db.prepare(`
    INSERT INTO artists (id, name, picture, popularity, monitor)
    VALUES (?, ?, ?, ?, ?)
  `).run(1, "Local Artist", "artist-image", 90, 1);

  dbModule.db.prepare(`
    INSERT INTO albums (
      id, artist_id, title, release_date, type, explicit, quality,
      cover, num_tracks, num_volumes, num_videos, duration, monitor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(10, 1, "Local Album", "2024-01-01", "ALBUM", 0, "LOSSLESS", "cover-image", 1, 1, 0, 180, 1);

  dbModule.db.prepare(`
    INSERT INTO media (
      id, artist_id, album_id, title, track_number, volume_number,
      explicit, type, quality, duration, monitor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(100, 1, 10, "Unrelated Local Track", 1, 1, 0, "Track", "LOSSLESS", 180, 1);
}

test("searchCatalog is local-first and skips remote providers outside live auth mode", async () => {
  seedCatalogRows();
  let remoteCalls = 0;
  const provider: StreamingCatalogProvider = {
    id: "tidal",
    hasRemoteAuth: () => true,
    search: async () => {
      remoteCalls += 1;
      return [{ id: 2, type: "artist", name: "Remote Artist" }];
    },
  };

  const response = await catalogSearchModule.searchCatalog({
    query: "Local",
    limit: 5,
  }, {
    database: dbModule.db,
    provider,
    providerAuthMode: () => "disconnected",
  });

  assert.equal(remoteCalls, 0);
  assert.equal(response.mode, "disconnected");
  assert.equal(response.remoteCatalogAvailable, false);
  assert.equal(response.results.artists[0]?.id, "1");
  assert.equal(response.results.albums[0]?.id, "10");
});

test("searchCatalog merges remote provider results and annotates local library state", async () => {
  seedCatalogRows();
  const provider: StreamingCatalogProvider = {
    id: "tidal",
    hasRemoteAuth: () => true,
    search: async () => [
      { id: 1, type: "artist", name: "Local Artist" },
      { id: 2, type: "artist", name: "Remote Artist", picture: "remote-image" },
      { id: 100, type: "track", title: "Remote Name For Local Track", artist_name: "Local Artist" },
    ],
  };

  const response = await catalogSearchModule.searchCatalog({
    query: "Local",
    limit: 5,
  }, {
    database: dbModule.db,
    provider,
    providerAuthMode: () => "live",
    remoteTimeoutMs: 1000,
  });

  assert.equal(response.remoteCatalogAvailable, true);
  assert.deepEqual(response.results.artists.map((artist) => artist.id), ["1", "2"]);
  assert.equal(response.results.tracks[0]?.id, "100");
  assert.equal(response.results.tracks[0]?.in_library, true);
  assert.equal(response.results.tracks[0]?.monitored, true);
});

test("searchCatalog validates short queries before touching providers", async () => {
  const provider: StreamingCatalogProvider = {
    id: "tidal",
    hasRemoteAuth: () => true,
    search: async () => {
      throw new Error("should not search");
    },
  };

  await assert.rejects(
    () => catalogSearchModule.searchCatalog({ query: "a" }, {
      database: dbModule.db,
      provider,
      providerAuthMode: () => "live",
    }),
    catalogSearchModule.CatalogSearchValidationError,
  );
});
