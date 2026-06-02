import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-refresh-album-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let refreshServiceModule: typeof import("./refresh-album-service.js");

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  refreshServiceModule = await import("./refresh-album-service.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM ProviderMediaArtists").run();
  dbModule.db.prepare("DELETE FROM ProviderMedia").run();
  dbModule.db.prepare("DELETE FROM Artists").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("track artist storage preserves the main credit when provider identities collapse to one canonical artist", () => {
  const artistMbid = "7808accb-6395-4b25-858c-678bbb73896b";
  const track = {
    tidal_id: "473839984",
    artist_id: "4526830",
    artists: [
      { id: "4526830", name: "Bastille" },
      { id: "provider-alias", name: "Bastille" },
      { id: "provider-alias-2", name: "Bastille" },
    ],
  };

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run(artistMbid, "Bastille");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)").run(artistMbid, "Bastille", artistMbid);
  dbModule.db.prepare(`
    INSERT INTO ProviderMedia (id, artist_id, title, type, explicit, quality)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(track.tidal_id, artistMbid, "SAVE MY SOUL", "SINGLE", 0, "HIRES_LOSSLESS");

  (refreshServiceModule.RefreshAlbumService as any).storeTrackArtists(
    track,
    artistMbid,
    new Map([
      ["provider-alias", artistMbid],
      ["provider-alias-2", artistMbid],
    ]),
  );

  assert.deepEqual(
    dbModule.db.prepare(`
      SELECT media_id, artist_id, type
      FROM ProviderMediaArtists
      WHERE media_id = ?
    `).all(track.tidal_id),
    [{
      media_id: track.tidal_id,
      artist_id: artistMbid,
      type: "MAIN",
    }],
  );
});
