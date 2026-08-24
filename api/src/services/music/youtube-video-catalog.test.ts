import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
} from "../../test-support/active-schema-fixture.js";
import type { YouTubeVideoCatalogProvider } from "./youtube-video-catalog.js";

const { tempDir } = prepareActiveSchemaEnv("youtube-video-catalog");

const ARTIST_MBID = "7808accb-6395-4b25-858c-678bbb73896b";
const YOUTUBE_CHANNEL = "UCBp3w4Vadc5ZmmzVeg9qj3w";
const WATCH_ID = "a1xFsoRYrds";

let dbModule: typeof import("../../database.js");
let catalog: typeof import("./youtube-video-catalog.js");

function readyProbe() {
  return {
    pythonAvailable: true,
    ytmusicapiAvailable: true,
    bridgeScriptAvailable: true,
  };
}

function stubYouTubeProvider(options: {
  searchCalls?: string[];
  videoFetches?: string[];
}): YouTubeVideoCatalogProvider {
  const searchCalls = options.searchCalls ?? [];
  const videoFetches = options.videoFetches ?? [];
  return {
    id: "youtube-music",
    name: "YouTube Music",
    search: async (query) => {
      searchCalls.push(query);
      return {
        artists: [{ providerId: YOUTUBE_CHANNEL, name: "Bastille" }],
        albums: [],
        tracks: [],
        videos: [],
      };
    },
    getArtistVideos: async (id) => {
      videoFetches.push(String(id));
      return [{
        providerId: WATCH_ID,
        title: "Pompeii (Official Music Video)",
        artist: { providerId: YOUTUBE_CHANNEL, name: "Bastille" },
        duration: 232,
        url: `https://www.youtube.com/watch?v=${WATCH_ID}`,
      }];
    },
  };
}

before(async () => {
  const opened = await openActiveSchemaDb();
  dbModule = opened.dbModule;
  catalog = await import("./youtube-video-catalog.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM RecordingRelations").run();
  dbModule.db.prepare("DELETE FROM ProviderVideoMatches").run();
  dbModule.db.prepare("DELETE FROM ProviderArtistMatches").run();
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM LibraryArtists").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run(ARTIST_MBID, "Bastille");
});

after(() => {
  closeActiveSchemaDb(dbModule, tempDir);
});

test("YouTube catalog ingest upserts youtube_video_id with the download plugin disabled", async () => {
  const videoFetches: string[] = [];
  const searchCalls: string[] = [];
  const count = await catalog.syncYouTubeVideoCatalogForArtist("artist-1", ARTIST_MBID, {
    probeCapabilities: async () => readyProbe(),
    getProvider: () => stubYouTubeProvider({ searchCalls, videoFetches }),
  });

  assert.equal(count, 1);
  assert.deepEqual(videoFetches, [YOUTUBE_CHANNEL]);
  assert.equal(searchCalls.length, 1);

  const recording = dbModule.db.prepare(`
    SELECT id, mbid, youtube_video_id AS yt, metadata_status AS status
    FROM Recordings WHERE is_video = 1
  `).get() as { id: number; mbid: string | null; yt: string; status: string };
  assert.equal(recording.mbid, null);
  assert.equal(recording.yt, WATCH_ID);
  assert.equal(recording.status, "youtube");

  const match = dbModule.db.prepare(`
    SELECT item.provider, item.provider_id AS providerId
    FROM ProviderItems item
    JOIN ProviderVideoMatches video_match ON video_match.provider_video_item_id = item.id
    WHERE video_match.recording_id = ? AND video_match.match_state = 'accepted'
  `).get(recording.id) as { provider: string; providerId: string };
  assert.equal(match.provider, "youtube-music");
  assert.equal(match.providerId, WATCH_ID);
});

test("YouTube catalog ingest uses an MB artist channel URL without searching", async () => {
  dbModule.db.prepare(`
    UPDATE ArtistMetadata SET links = ? WHERE mbid = ?
  `).run(JSON.stringify([
    { type: "youtube", target: `https://www.youtube.com/channel/${YOUTUBE_CHANNEL}` },
  ]), ARTIST_MBID);

  const searchCalls: string[] = [];
  const videoFetches: string[] = [];
  await catalog.syncYouTubeVideoCatalogForArtist("artist-1", ARTIST_MBID, {
    probeCapabilities: async () => readyProbe(),
    getProvider: () => stubYouTubeProvider({ searchCalls, videoFetches }),
  });

  assert.equal(searchCalls.length, 0);
  assert.deepEqual(videoFetches, [YOUTUBE_CHANNEL]);
});

test("missing ytmusicapi is non-fatal and does not invent recordings", async () => {
  let fetched = false;
  const count = await catalog.syncYouTubeVideoCatalogForArtist("artist-1", ARTIST_MBID, {
    probeCapabilities: async () => ({
      pythonAvailable: true,
      ytmusicapiAvailable: false,
      bridgeScriptAvailable: true,
    }),
    getProvider: () => ({
      id: "youtube-music",
      name: "YouTube Music",
      search: async () => ({ artists: [], albums: [], tracks: [], videos: [] }),
      getArtistVideos: async () => {
        fetched = true;
        return [];
      },
    }),
  });
  assert.equal(count, 0);
  assert.equal(fetched, false);
  assert.equal(
    (dbModule.db.prepare("SELECT COUNT(*) AS n FROM Recordings WHERE is_video = 1").get() as { n: number }).n,
    0,
  );
});
