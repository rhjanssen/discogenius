import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-scan-meta-match-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let matchModule: typeof import("./library-scan-metadata-match.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  matchModule = await import("./library-scan-metadata-match.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM Artists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedArtist() {
  const { db } = dbModule;
  db.prepare(`
    INSERT OR IGNORE INTO ArtistMetadata (mbid, name) VALUES ('artist-mbid', 'Bastille')
  `).run();
  db.prepare(`
    INSERT INTO Artists (id, mbid, name, monitored) VALUES ('artist-1', 'artist-mbid', 'Bastille', 1)
  `).run();
}

function seedOffer(params: {
  providerId: string;
  title: string;
  albumId: string;
  duration: number;
  recordingId?: number;
}) {
  const { db } = dbModule;
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, title, duration,
      provider_album_id, library_slot, recording_id, quality, match_status
    ) VALUES (
      'tidal', 'track', ?, 'artist-mbid', ?, ?,
      ?, 'stereo', ?, 'LOSSLESS', 'matched'
    )
  `).run(
    params.providerId,
    params.title,
    params.duration,
    params.albumId,
    params.recordingId ?? null,
  );
}

test("metadata rematch links missing album tracks via sibling folder offers", () => {
  const { db } = dbModule;
  seedArtist();
  seedOffer({ providerId: "1001", title: "Million Pieces", albumId: "album-1", duration: 284 });
  seedOffer({ providerId: "1002", title: "Another Place", albumId: "album-1", duration: 258 });
  seedOffer({ providerId: "1003", title: "Glory", albumId: "album-1", duration: 200 });

  const folder = "/library/stereo-music/Bastille/Roots of ReOrchestrated (2021)";
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, provider, provider_entity_type, provider_id, file_type, library_slot,
      library_root, file_path, relative_path, filename, extension
    ) VALUES (
      'artist-1', 'tidal', 'track', '1003', 'track', 'stereo',
      'music', ?, 'Bastille/Roots/03 - Glory.flac', '03 - Glory.flac', 'flac'
    )
  `).run(`${folder}/03 - Glory.flac`);

  const match = matchModule.matchAudioFileByMetadata(
    `${folder}/01 - Million Pieces.flac`,
    "artist-1",
    "music",
    { title: "Million Pieces", durationSeconds: 284 },
  );

  assert.ok(match);
  assert.equal(match!.mediaId, "1001");
  assert.equal(match!.albumId, "album-1");
  assert.equal(match!.duplicateOfExisting, false);
});

test("metadata rematch marks rename leftovers as duplicates of an existing TrackFile", () => {
  const { db } = dbModule;
  seedArtist();
  seedOffer({ providerId: "2001", title: "Good Grief", albumId: "album-2", duration: 206 });

  const folder = "/library/stereo-music/Bastille/Wild World (2016)";
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, provider, provider_entity_type, provider_id, file_type, library_slot,
      library_root, file_path, relative_path, filename, extension
    ) VALUES (
      'artist-1', 'tidal', 'track', '2001', 'track', 'stereo',
      'music', ?, 'Bastille/Wild World/101 - Good Grief.flac', '101 - Good Grief.flac', 'flac'
    )
  `).run(`${folder}/101 - Good Grief.flac`);

  const match = matchModule.matchAudioFileByMetadata(
    `${folder}/201 - Good Grief.flac`,
    "artist-1",
    "music",
    { title: "Good Grief", durationSeconds: 206 },
  );

  assert.ok(match);
  assert.equal(match!.mediaId, "2001");
  assert.equal(match!.duplicateOfExisting, true);
  assert.equal(match!.existingFilePath, `${folder}/101 - Good Grief.flac`);
});

test("metadata rematch does not equate studio tracks with remix variants", () => {
  seedArtist();
  seedOffer({ providerId: "3001", title: "Blame", albumId: "album-3", duration: 176 });
  seedOffer({ providerId: "3002", title: "Blame (Bunker Sessions)", albumId: "album-3", duration: 183 });

  const folder = "/library/stereo-music/Bastille/Blame (2017)";
  const { db } = dbModule;
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, provider, provider_entity_type, provider_id, file_type, library_slot,
      library_root, file_path, relative_path, filename, extension
    ) VALUES (
      'artist-1', 'tidal', 'track', '3002', 'track', 'stereo',
      'music', ?, 'Bastille/Blame/02 - Blame (Bunker Sessions).flac', '02 - Blame (Bunker Sessions).flac', 'flac'
    )
  `).run(`${folder}/02 - Blame (Bunker Sessions).flac`);

  const match = matchModule.matchAudioFileByMetadata(
    `${folder}/01 - Blame.flac`,
    "artist-1",
    "music",
    { title: "Blame", durationSeconds: 176 },
  );

  assert.ok(match);
  assert.equal(match!.mediaId, "3001");
  assert.equal(match!.duplicateOfExisting, false);
});
