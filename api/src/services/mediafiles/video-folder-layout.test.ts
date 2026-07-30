import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-video-layout-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let layoutModule: typeof import("./video-folder-layout.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  layoutModule = await import("./video-folder-layout.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM TrackFiles").run();
  dbModule.db.prepare("DELETE FROM RecordingRelations").run();
  dbModule.db.prepare("DELETE FROM LibraryEditions").run();
  dbModule.db.prepare("DELETE FROM LibraryAlbums").run();
  dbModule.db.prepare("DELETE FROM Libraries").run();
  dbModule.db.prepare("DELETE FROM Tracks").run();
  dbModule.db.prepare("DELETE FROM AlbumEditions").run();
  dbModule.db.prepare("DELETE FROM Albums").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM Artists").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("video folder layout helpers map three-way modes", () => {
  assert.equal(layoutModule.normalizeVideoFolderLayout(undefined), "separated");
  assert.equal(layoutModule.normalizeVideoFolderLayout("inline"), "inline");
  assert.equal(layoutModule.normalizeVideoFolderLayout("inline_only"), "inline_only");
  assert.equal(layoutModule.allowsInlineVideoPlacement("separated"), false);
  assert.equal(layoutModule.allowsInlineVideoPlacement("inline"), true);
  assert.equal(layoutModule.allowsInlineVideoPlacement("inline_only"), true);
  assert.equal(layoutModule.requiresAlbumLinkedVideosOnly("inline"), false);
  assert.equal(layoutModule.requiresAlbumLinkedVideosOnly("inline_only"), true);
});

test("canVideoPlaceInline requires provider_video_for and monitored stereo RG", () => {
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES ('artist-mbid', 'Layout Artist')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Artists (id, mbid, name)
    VALUES ('artist-mbid', 'artist-mbid', 'Layout Artist')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_metadata_id, artist_mbid, title, primary_type)
    SELECT 'rg-inline', id, 'artist-mbid', 'Inline Album', 'album'
    FROM ArtistMetadata
    WHERE mbid = 'artist-mbid'
  `).run();
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_id, release_group_mbid, artist_metadata_id,
      artist_mbid, title, date, track_count
    )
    SELECT
      'rel-inline', release_group.id, 'rg-inline', artist.id,
      'artist-mbid', 'Inline Album', '2024-01-01', 1
    FROM Albums release_group
    JOIN ArtistMetadata artist ON artist.mbid = 'artist-mbid'
    WHERE release_group.mbid = 'rg-inline'
  `).run();

  const audio = dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES ('audio-inline', 'Song', 'artist-mbid', 0)
    RETURNING id
  `).get() as { id: number };
  const video = dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title, artist_mbid, is_video)
    VALUES ('video-inline', 'Song Video', 'artist-mbid', 1)
    RETURNING id
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO Tracks (
      mbid, album_edition_id, release_mbid, recording_mbid, recording_id,
      medium_position, position, number, title
    )
    SELECT 'track-inline', release.id, 'rel-inline', 'audio-inline', ?, 1, 1, '1', 'Song'
    FROM AlbumEditions release
    WHERE release.mbid = 'rel-inline'
  `).run(audio.id);
  dbModule.db.prepare(`
    INSERT INTO RecordingRelations (
      source_recording_id, target_recording_id, relation_type, confidence
    ) VALUES (?, ?, 'provider_video_for', 0.99)
  `).run(video.id, audio.id);

  assert.equal(layoutModule.canVideoPlaceInline(video.id), false);

  dbModule.db.prepare(`
    INSERT OR IGNORE INTO MetadataProfiles (name, release_type_policy)
    VALUES ('Video Layout Test', '{}')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Libraries (
      name, root_path, metadata_profile_id, quality_profile_id
    )
    SELECT
      'Video Layout Stereo',
      ?,
      metadata_profile.id,
      quality_profile.id
    FROM MetadataProfiles metadata_profile
    JOIN quality_profiles quality_profile
      ON COALESCE(quality_profile.allowed_source_formats, '[]') NOT LIKE '%spatial%'
    WHERE metadata_profile.name = 'Video Layout Test'
    ORDER BY quality_profile.id
    LIMIT 1
  `).run(path.join(tempDir, "video-layout-stereo"));
  dbModule.db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, monitored, selection_mode, locked,
      reason, curation_version
    )
    SELECT library.id, release_group.id, 1, 'auto', 0, 'test', 1
    FROM Libraries library
    JOIN Albums release_group ON release_group.mbid = 'rg-inline'
    WHERE library.name = 'Video Layout Stereo'
  `).run();

  assert.equal(layoutModule.canVideoPlaceInline(video.id), true);
  assert.equal(layoutModule.canVideoPlaceInline(audio.id), false);
});
