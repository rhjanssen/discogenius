import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-mb-video-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.musicbrainz-video.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let videoService: typeof import("./musicbrainz-video-service.js");
let originalFetch: typeof globalThis.fetch;

before(async () => {
  originalFetch = globalThis.fetch;
  dbModule = await import("../../database.js");
  videoService = await import("./musicbrainz-video-service.js");
  dbModule.initDatabase();
});

after(() => {
  globalThis.fetch = originalFetch;
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("syncMusicBrainzVideosForArtist upserts relation artists before recording rows", async () => {
  dbModule.db.prepare("DELETE FROM RecordingRelations").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid-1", "Root Artist");

  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      "recording-count": 1,
      "recording-offset": 0,
      recordings: [
        {
          id: "video-recording-mbid-1",
          title: "Video Recording",
          video: true,
          length: 180000,
          "artist-credit": [
            { name: "Root Artist", artist: { id: "artist-mbid-1", name: "Root Artist" } },
          ],
          relations: [
            {
              type: "music video",
              "type-id": "music-video-type-id",
              recording: {
                id: "audio-recording-mbid-1",
                title: "Audio Recording",
                video: false,
                length: 178000,
                "artist-credit": [
                  { name: "Related Artist", artist: { id: "related-artist-mbid-1", name: "Related Artist" } },
                ],
              },
            },
          ],
        },
      ],
    }),
  } as Response)) as typeof globalThis.fetch;

  const synced = await videoService.syncMusicBrainzVideosForArtist("artist-mbid-1", { force: true });

  assert.equal(synced, 1);
  const relatedArtist = dbModule.db.prepare(`
    SELECT mbid, name
    FROM ArtistMetadata
    WHERE mbid = ?
  `).get("related-artist-mbid-1") as { mbid: string; name: string } | undefined;
  assert.deepEqual(relatedArtist, {
    mbid: "related-artist-mbid-1",
    name: "Related Artist",
  });

  const relation = dbModule.db.prepare(`
    SELECT source_recording_id, target_recording_id, source_foreign_recording_id, target_foreign_recording_id, relation_type
    FROM RecordingRelations
    WHERE source_foreign_recording_id = ?
      AND target_foreign_recording_id = ?
  `).get("video-recording-mbid-1", "audio-recording-mbid-1") as
    { source_recording_id: number | null; target_recording_id: number | null; source_foreign_recording_id: string; target_foreign_recording_id: string; relation_type: string } | undefined;
  assert.ok(relation);
  assert.equal(relation.source_foreign_recording_id, "video-recording-mbid-1");
  assert.equal(relation.target_foreign_recording_id, "audio-recording-mbid-1");
  assert.equal(relation.relation_type, "music_video_for");
  assert.ok(relation.source_recording_id, "relation should link to the local video recording row");
  assert.ok(relation.target_recording_id, "relation should link to the local audio recording row");

  const videoRecording = dbModule.db.prepare(`
    SELECT artist_mbid, artist_metadata_id
    FROM Recordings
    WHERE mbid = ?
  `).get("video-recording-mbid-1") as { artist_mbid: string | null; artist_metadata_id: number | null } | undefined;
  assert.ok(videoRecording);
  assert.equal(videoRecording.artist_mbid, "artist-mbid-1");
  assert.ok(videoRecording.artist_metadata_id, "video recording should link to local artist metadata");

  const resynced = await videoService.syncMusicBrainzVideosForArtist("artist-mbid-1", { force: true });
  assert.equal(resynced, 1);
  assert.equal(
    (dbModule.db.prepare("SELECT COUNT(*) AS count FROM Recordings").get() as { count: number }).count,
    2,
    "force refresh should update canonical recordings rather than duplicate them",
  );
});
