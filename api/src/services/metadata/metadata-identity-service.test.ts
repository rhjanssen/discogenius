import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-metadata-identity-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let identityModule: typeof import("./metadata-identity-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  identityModule = await import("./metadata-identity-service.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM metadata_identity_status").run();
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM AlbumEditions").run();
  dbModule.db.prepare("DELETE FROM Albums").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
  dbModule.db.prepare("DELETE FROM Artists").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("provider-scoped identity lookup keeps equal album and track IDs independent", async () => {
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES ('artist-mbid', 'Bastille')").run();
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES
      ('tidal-rg', 'artist-mbid', 'Tidal release', 'album'),
      ('apple-rg', 'artist-mbid', 'Apple release', 'album')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, updated_at
    ) VALUES ('tidal', 'release', '42', 'Tidal release', '2026-01-01'),
    ('apple-music', 'release', '42', 'Apple release', '2026-01-02'),
    ('tidal', 'track', '7', 'Tidal track', '2026-01-01'),
    ('apple-music', 'track', '7', 'Apple track', '2026-01-02')
  `).run();

  const tidalAlbum = await identityModule.MetadataIdentityService.resolveAlbum("42", { provider: "tidal" });
  const appleAlbum = await identityModule.MetadataIdentityService.resolveAlbum("42", { provider: "apple-music" });
  const tidalTrack = await identityModule.MetadataIdentityService.resolveTrack("7", { provider: "tidal" });
  const appleTrack = await identityModule.MetadataIdentityService.resolveTrack("7", { provider: "apple-music" });

  assert.equal(tidalAlbum.data?.releaseGroupId, "tidal-rg");
  assert.equal(appleAlbum.data?.releaseGroupId, "apple-rg");
  assert.equal(tidalTrack.data?.recordingId, "tidal-recording");
  assert.equal(appleTrack.data?.recordingId, "apple-recording");

  assert.equal(
    identityModule.MetadataIdentityService.getStatus("album", "42", { provider: "tidal" })?.data?.releaseGroupId,
    "tidal-rg",
  );
  assert.equal(
    identityModule.MetadataIdentityService.getStatus("album", "42", { provider: "apple-music" })?.data?.releaseGroupId,
    "apple-rg",
  );
  assert.equal(
    (dbModule.db.prepare("SELECT COUNT(*) AS count FROM metadata_identity_status WHERE entity_type = 'album'")
      .get() as { count: number }).count,
    2,
  );
});

test("provider-scoped video identity does not pick the newest colliding offer", () => {
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, updated_at
    ) VALUES ('tidal', 'video', '99', 'Tidal video', '2026-01-01'),
    ('apple-music', 'video', '99', 'Apple video', '2026-01-02')
  `).run();

  const result = identityModule.MetadataIdentityService.markVideoKnown("99", { provider: "tidal" });

  assert.equal(result.data?.recordingId, "tidal-video-recording");
  assert.equal(
    identityModule.MetadataIdentityService.getStatus("video", "99", { provider: "tidal" })?.data?.recordingId,
    "tidal-video-recording",
  );
});
