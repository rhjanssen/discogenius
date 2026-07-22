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
  dbModule.db.prepare("DELETE FROM ReleaseGroupSlots").run();
  dbModule.db.prepare("DELETE FROM Tracks").run();
  dbModule.db.prepare("DELETE FROM AlbumReleases").run();
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
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES ('rg-inline', 'artist-mbid', 'Inline Album', 'album')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, date, track_count)
    VALUES ('rel-inline', 'rg-inline', 'artist-mbid', 'Inline Album', '2024-01-01', 1)
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
      mbid, release_mbid, recording_mbid, recording_id, medium_position, position, number, title
    ) VALUES ('track-inline', 'rel-inline', 'audio-inline', ?, 1, 1, '1', 'Song')
  `).run(audio.id);
  dbModule.db.prepare(`
    INSERT INTO RecordingRelations (
      source_recording_id, target_recording_id, relation_type, confidence
    ) VALUES (?, ?, 'provider_video_for', 0.99)
  `).run(video.id, audio.id);

  assert.equal(layoutModule.canVideoPlaceInline(video.id), false);

  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_release_mbid
    ) VALUES ('artist-mbid', 'rg-inline', 'stereo', 1, 'rel-inline')
  `).run();

  assert.equal(layoutModule.canVideoPlaceInline(video.id), true);
  assert.equal(layoutModule.canVideoPlaceInline(audio.id), false);
});
