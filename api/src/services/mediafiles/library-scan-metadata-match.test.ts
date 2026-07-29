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
  db.prepare("DELETE FROM LibraryReleases").run();
  db.prepare("DELETE FROM LibraryReleaseGroups").run();
  db.prepare("DELETE FROM Libraries").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM AlbumReleases").run();
  db.prepare("DELETE FROM Albums").run();
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
      provider, entity_type, provider_id, title, duration_ms
    ) VALUES ('tidal', 'track', ?, ?, ?)
  `).run(
    params.providerId,
    params.title,
    params.duration,
    params.albumId,
    params.recordingId ?? null,
  );
}

/**
 * Seed a minimal canonical catalog: a release group with one selected release
 * and one track (recording + release-track MBIDs), so embedded-MBID linking has
 * something to resolve against.
 */
function seedCatalogTrack(params: {
  releaseGroupMbid: string;
  releaseMbid: string;
  trackMbid: string;
  recordingMbid: string;
  title: string;
  slot?: string;
}) {
  const { db } = dbModule;
  const slot = params.slot || "stereo";
  db.prepare(`INSERT OR IGNORE INTO Albums (mbid, artist_mbid, title) VALUES (?, 'artist-mbid', ?)`)
    .run(params.releaseGroupMbid, params.title);
  db.prepare(`
    INSERT OR IGNORE INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title)
    VALUES (?, ?, 'artist-mbid', ?)
  `).run(params.releaseMbid, params.releaseGroupMbid, params.title);
  db.prepare(`INSERT OR IGNORE INTO Recordings (mbid, title) VALUES (?, ?)`)
    .run(params.recordingMbid, params.title);
  db.prepare(`
    INSERT OR IGNORE INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, title)
    VALUES (?, ?, ?, 1, 1, ?)
  `).run(params.trackMbid, params.releaseMbid, params.recordingMbid, params.title);
  const artist = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'")
    .get() as { id: number };
  const releaseGroup = db.prepare("SELECT id FROM Albums WHERE mbid = ?")
    .get(params.releaseGroupMbid) as { id: number };
  const release = db.prepare("SELECT id FROM AlbumReleases WHERE mbid = ?")
    .get(params.releaseMbid) as { id: number };
  const recording = db.prepare("SELECT id FROM Recordings WHERE mbid = ?")
    .get(params.recordingMbid) as { id: number };
  const track = db.prepare("SELECT id FROM Tracks WHERE mbid = ?")
    .get(params.trackMbid) as { id: number };
  db.prepare(`
    UPDATE Albums SET artist_metadata_id = ? WHERE id = ?
  `).run(artist.id, releaseGroup.id);
  db.prepare(`
    UPDATE AlbumReleases
    SET release_group_id = ?, artist_metadata_id = ?
    WHERE id = ?
  `).run(releaseGroup.id, artist.id, release.id);
  db.prepare(`
    UPDATE Tracks SET album_release_id = ?, recording_id = ? WHERE id = ?
  `).run(release.id, recording.id, track.id);
  db.prepare(`
    INSERT OR IGNORE INTO MetadataProfiles (name, release_type_policy)
    VALUES ('Scan Metadata Test', '{}')
  `).run();
  if (slot === "spatial") {
    db.prepare(`
      INSERT OR IGNORE INTO quality_profiles (
        name, cutoff, items, allowed_source_formats, preference_order
      ) VALUES ('Scan Metadata Spatial', 'DOLBY_ATMOS', '["DOLBY_ATMOS"]', '["spatial"]', '["spatial"]')
    `).run();
  }
  const metadataProfile = db.prepare(`
    SELECT id FROM MetadataProfiles WHERE name = 'Scan Metadata Test'
  `).get() as { id: number };
  const qualityProfile = db.prepare(`
    SELECT id
    FROM quality_profiles
    WHERE ${slot === "spatial"
      ? "name = 'Scan Metadata Spatial'"
      : "COALESCE(allowed_source_formats, '[]') NOT LIKE '%spatial%'"}
    ORDER BY id
    LIMIT 1
  `).get() as { id: number };
  const libraryName = `Scan ${slot} ${params.releaseGroupMbid}`;
  db.prepare(`
    INSERT INTO Libraries (
      name, root_path, metadata_profile_id, quality_profile_id
    ) VALUES (?, ?, ?, ?)
  `).run(
    libraryName,
    path.join(tempDir, "libraries", slot, params.releaseGroupMbid),
    metadataProfile.id,
    qualityProfile.id,
  );
  const library = db.prepare("SELECT id FROM Libraries WHERE name = ?")
    .get(libraryName) as { id: number };
  db.prepare(`
    INSERT INTO LibraryReleaseGroups (
      library_id, release_group_id, monitored, selection_mode, locked,
      reason, curation_version
    ) VALUES (?, ?, 1, 'auto', 0, 'test', 1)
  `).run(library.id, releaseGroup.id);
  db.prepare(`
    INSERT INTO LibraryReleases (
      library_id, release_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'auto', 0, 'test', 1)
  `).run(library.id, release.id);
}

test("catalog-direct link resolves from embedded release-track MBID with no provider offer", () => {
  seedArtist();
  seedCatalogTrack({
    releaseGroupMbid: "rg-itunes",
    releaseMbid: "rel-itunes",
    trackMbid: "track-bad-blood",
    recordingMbid: "rec-bad-blood",
    title: "Bad Blood (live)",
  });

  const link = matchModule.resolveCatalogTrackFromEmbeddedMbids(
    { musicbrainzTrackId: "track-bad-blood" },
    "stereo",
  );

  assert.ok(link);
  assert.equal(link!.trackMbid, "track-bad-blood");
  assert.equal(link!.recordingMbid, "rec-bad-blood");
  assert.equal(link!.releaseMbid, "rel-itunes");
  assert.equal(link!.releaseGroupMbid, "rg-itunes");
});

test("metadata rematch links a provider-free file straight to the catalog via embedded MBIDs", () => {
  seedArtist();
  seedCatalogTrack({
    releaseGroupMbid: "rg-itunes",
    releaseMbid: "rel-itunes",
    trackMbid: "track-pompeii",
    recordingMbid: "rec-pompeii",
    title: "Pompeii (live)",
  });

  const match = matchModule.matchAudioFileByMetadata(
    "/library/stereo-music/Bastille/iTunes Festival - London 2013 (2013)/02 - Pompeii (live).m4a",
    "artist-1",
    "music",
    {
      title: "Pompeii (live)",
      musicbrainzTrackId: "track-pompeii",
      musicbrainzRecordingId: "rec-pompeii",
      musicbrainzAlbumId: "rel-itunes",
      durationSeconds: 210,
    },
  );

  assert.ok(match);
  // No provider offer exists, but the file still links to the catalog.
  assert.equal(match!.mediaId, "");
  assert.equal(match!.canonicalTrackMbid, "track-pompeii");
  assert.equal(match!.canonicalRecordingMbid, "rec-pompeii");
  assert.equal(match!.canonicalReleaseMbid, "rel-itunes");
  assert.equal(match!.canonicalReleaseGroupMbid, "rg-itunes");
  assert.equal(match!.duplicateOfExisting, false);
});

test("metadata rematch enriches a provider-offer match with canonical MBIDs", () => {
  seedArtist();
  seedCatalogTrack({
    releaseGroupMbid: "rg-wild",
    releaseMbid: "rel-wild",
    trackMbid: "track-good-grief",
    recordingMbid: "rec-good-grief",
    title: "Good Grief",
  });
  seedOffer({ providerId: "5001", title: "Good Grief", albumId: "album-wild", duration: 206 });

  const match = matchModule.matchAudioFileByMetadata(
    "/library/stereo-music/Bastille/Wild World (2016)/01 - Good Grief.flac",
    "artist-1",
    "music",
    {
      title: "Good Grief",
      musicbrainzTrackId: "track-good-grief",
      musicbrainzRecordingId: "rec-good-grief",
      musicbrainzAlbumId: "rel-wild",
      durationSeconds: 206,
    },
  );

  assert.ok(match);
  assert.equal(match!.mediaId, "5001");
  assert.equal(match!.canonicalTrackMbid, "track-good-grief");
  assert.equal(match!.canonicalRecordingMbid, "rec-good-grief");
});

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
  // Alternate edition of the same recording — must not win over the folder sibling.
  seedOffer({ providerId: "2002", title: "Good Grief", albumId: "album-2-complete", duration: 206 });

  const folder = "/library/stereo-music/Bastille/Wild World (2016)";
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, provider, provider_entity_type, provider_id, file_type, library_slot,
      library_root, file_path, relative_path, filename, extension, duration
    ) VALUES (
      'artist-1', 'tidal', 'track', '2001', 'track', 'stereo',
      'music', ?, 'Bastille/Wild World/101 - Good Grief.flac', '101 - Good Grief.flac', 'flac', 206
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
