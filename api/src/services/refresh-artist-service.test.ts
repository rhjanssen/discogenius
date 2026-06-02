import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-refresh-artist-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let refreshServiceModule: typeof import("./refresh-artist-service.js");

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  refreshServiceModule = await import("./refresh-artist-service.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("unmatched provider offers retain discovery provenance without claiming canonical ownership", () => {
  const artistMbid = "artist-mbid-bastille";
  const album = {
    provider_id: "314738795",
    title: "Happier",
    artist_name: "Marshmello & Bastille",
    quality: "LOSSLESS",
  };

  (refreshServiceModule.RefreshArtistService as any).storeProviderAlbumOffers(
    "tidal",
    artistMbid,
    [album],
    new Map(),
  );

  const row = dbModule.db.prepare(`
    SELECT artist_mbid, release_group_mbid, match_status, data
    FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'album' AND provider_id = ?
  `).get(album.provider_id) as {
    artist_mbid: string | null;
    release_group_mbid: string | null;
    match_status: string;
    data: string;
  };

  assert.equal(row.artist_mbid, null);
  assert.equal(row.release_group_mbid, null);
  assert.equal(row.match_status, "unmatched");
  assert.equal(JSON.parse(row.data).discoveredFromArtistMbid, artistMbid);
});

test("matched provider offers attach to the canonical MusicBrainz artist and release group", () => {
  const artistMbid = "artist-mbid-bastille";
  const album = {
    provider_id: "provider-album-1",
    title: "Doom Days",
    artist_name: "Bastille",
    quality: "LOSSLESS",
  };

  (refreshServiceModule.RefreshArtistService as any).storeProviderAlbumOffers(
    "tidal",
    artistMbid,
    [album],
    new Map([
      [album.provider_id, {
        providerId: album.provider_id,
        status: "verified",
        confidence: 1,
        method: "musicbrainz-release-upc",
        releaseMbid: "release-mbid-1",
        releaseGroup: {
          mbid: "release-group-mbid-1",
          title: "Doom Days",
        },
        evidence: {
          providerTitle: "Doom Days",
        },
      }],
    ]),
  );

  const row = dbModule.db.prepare(`
    SELECT artist_mbid, release_group_mbid, release_mbid, match_status
    FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'album' AND provider_id = ?
  `).get(album.provider_id) as {
    artist_mbid: string | null;
    release_group_mbid: string | null;
    release_mbid: string | null;
    match_status: string;
  };

  assert.equal(row.artist_mbid, artistMbid);
  assert.equal(row.release_group_mbid, "release-group-mbid-1");
  assert.equal(row.release_mbid, "release-mbid-1");
  assert.equal(row.match_status, "verified");
});
