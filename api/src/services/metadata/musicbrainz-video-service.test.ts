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
    SELECT SourceForeignRecordingId, TargetForeignRecordingId, RelationType
    FROM RecordingRelations
    WHERE SourceForeignRecordingId = ?
      AND TargetForeignRecordingId = ?
  `).get("video-recording-mbid-1", "audio-recording-mbid-1") as
    { SourceForeignRecordingId: string; TargetForeignRecordingId: string; RelationType: string } | undefined;
  assert.deepEqual(relation, {
    SourceForeignRecordingId: "video-recording-mbid-1",
    TargetForeignRecordingId: "audio-recording-mbid-1",
    RelationType: "music_video_for",
  });
});
