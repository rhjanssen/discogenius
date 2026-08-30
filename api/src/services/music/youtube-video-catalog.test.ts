import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
} from "../../test-support/active-schema-fixture.js";
import { seedAcceptedProviderVideoMatch } from "../../test-support/normalized-provider-fixtures.js";
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

test("sparse provider videos inherit a unique nearby YouTube cut identity", async () => {
  const refreshVideo = await import("./refresh-video-service.js");
  refreshVideo.RefreshVideoService.upsertArtistVideos(ARTIST_MBID, [{
    provider: "tidal",
    provider_id: "95976881",
    artist_mbid: ARTIST_MBID,
    artist_name: "Bastille",
    title: "Quarter Past Midnight",
    duration: 212,
    release_date: "2018-10-02",
    url: "https://listen.tidal.com/video/95976881",
  }]);

  const provider: YouTubeVideoCatalogProvider = {
    id: "youtube-music",
    name: "YouTube Music",
    search: async () => ({
      artists: [], albums: [], tracks: [],
      videos: [{
        providerId: "royalhall01",
        title: "Quarter Past Midnight (Live From Royal Albert Hall)",
        artist: { providerId: YOUTUBE_CHANNEL, name: "Bastille" },
        duration: 212,
      }, {
        providerId: "jimmykimmel",
        title: "Quarter Past Midnight (Live From Jimmy Kimmel Live!/2018)",
        artist: { providerId: YOUTUBE_CHANNEL, name: "Bastille" },
        duration: 212,
      }],
    }),
    getArtistVideos: async () => [],
    getVideo: async (id) => ({
      providerId: String(id),
      title: String(id) === "jimmykimmel"
        ? "Quarter Past Midnight (Live From Jimmy Kimmel Live!/2018)"
        : "Quarter Past Midnight (Live From Royal Albert Hall)",
      artist: { providerId: YOUTUBE_CHANNEL, name: "Bastille" },
      duration: 212,
      releaseDate: String(id) === "jimmykimmel" ? "2018-09-27" : "2018-07-25",
      url: `https://www.youtube.com/watch?v=${id}`,
    }),
  };

  const count = await catalog.supplementSparseProviderVideosFromYouTube(
    ARTIST_MBID,
    ARTIST_MBID,
    { getProvider: () => provider },
  );
  assert.equal(count, 1);

  const recordings = dbModule.db.prepare(`
    SELECT id, title, video_variant AS variant, youtube_video_id AS youtubeId
    FROM Recordings WHERE is_video = 1
  `).all() as Array<{ id: number; title: string; variant: string; youtubeId: string }>;
  assert.equal(recordings.length, 1, "the provider-only shell is folded into the catalog video");
  const recording = recordings[0];
  assert.equal(recording.youtubeId, "jimmykimmel");
  assert.equal(recording.variant, "live");
  assert.match(recording.title, /Jimmy Kimmel/);
  const offers = dbModule.db.prepare(`
    SELECT item.provider, item.provider_id AS providerId
    FROM ProviderVideoMatches video_match
    JOIN ProviderItems item ON item.id = video_match.provider_video_item_id
    WHERE video_match.recording_id = ? AND video_match.match_state = 'accepted'
    ORDER BY item.provider
  `).all(recording.id) as Array<{ provider: string; providerId: string }>;
  assert.deepEqual(offers, [{ provider: "tidal", providerId: "95976881" }, {
    provider: "youtube-music", providerId: "jimmykimmel",
  }]);
});

test("detailed YouTube facts merge a stale catalog summary with its provider twin", async () => {
  const youtubeRecording = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_mbid, title, length_ms, is_video, video_variant, metadata_status, youtube_video_id
    ) VALUES (?, 'Quarter Past Midnight', 200000, 1, 'official', 'youtube', 'X1VzzNbfPaM')
    RETURNING id
  `).get(ARTIST_MBID) as { id: number };
  const youtubeOffer = seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "youtube-music",
    providerVideoId: "X1VzzNbfPaM",
    recordingId: youtubeRecording.id,
    title: "Quarter Past Midnight",
    durationMs: 199000,
  });
  dbModule.db.prepare("UPDATE ProviderItems SET release_date = '2019-01-01' WHERE id = ?")
    .run(youtubeOffer.providerVideoItemId);
  const providerRecording = dbModule.db.prepare(`
    INSERT INTO Recordings (
      artist_mbid, title, length_ms, is_video, video_variant, metadata_status
    ) VALUES (?, 'Quarter Past Midnight', 205000, 1, 'video', 'provider_catalog')
    RETURNING id
  `).get(ARTIST_MBID) as { id: number };
  const tidalOffer = seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "tidal",
    providerVideoId: "89522194",
    recordingId: providerRecording.id,
    title: "Quarter Past Midnight",
    durationMs: 205000,
  });
  dbModule.db.prepare("UPDATE ProviderItems SET release_date = '2018-05-30' WHERE id = ?")
    .run(tidalOffer.providerVideoItemId);

  const provider: YouTubeVideoCatalogProvider = {
    id: "youtube-music",
    name: "YouTube Music",
    search: async () => ({
      artists: [], albums: [], tracks: [],
      videos: [{
        providerId: "X1VzzNbfPaM",
        title: "Quarter Past Midnight (Official Video)",
        artist: { providerId: YOUTUBE_CHANNEL, name: "Bastille" },
        duration: 206,
      }],
    }),
    getArtistVideos: async () => [],
    getVideo: async () => ({
      providerId: "X1VzzNbfPaM",
      title: "Quarter Past Midnight (Official Video)",
      artist: { providerId: YOUTUBE_CHANNEL, name: "Bastille" },
      duration: 205,
      releaseDate: "2018-05-23",
    }),
  };

  const count = await catalog.supplementSparseProviderVideosFromYouTube(
    ARTIST_MBID,
    ARTIST_MBID,
    { getProvider: () => provider },
  );
  assert.equal(count, 1);
  const videos = dbModule.db.prepare(`
    SELECT id, youtube_video_id AS youtubeId
    FROM Recordings WHERE is_video = 1
  `).all() as Array<{ id: number; youtubeId: string | null }>;
  assert.deepEqual(videos, [{ id: youtubeRecording.id, youtubeId: "X1VzzNbfPaM" }]);
  const offers = dbModule.db.prepare(`
    SELECT item.provider, item.duration_ms AS durationMs
    FROM ProviderVideoMatches video_match
    JOIN ProviderItems item ON item.id = video_match.provider_video_item_id
    WHERE video_match.recording_id = ? AND video_match.match_state = 'accepted'
    ORDER BY item.provider
  `).all(youtubeRecording.id) as Array<{ provider: string; durationMs: number }>;
  assert.deepEqual(offers, [
    { provider: "tidal", durationMs: 205000 },
    { provider: "youtube-music", durationMs: 205000 },
  ]);
});

test("sparse video resolution does not starve rows after the former 40-video ceiling", async () => {
  const refreshVideo = await import("./refresh-video-service.js");
  refreshVideo.RefreshVideoService.upsertArtistVideos(ARTIST_MBID, [{
    provider: "tidal",
    provider_id: "118907088",
    artist_mbid: ARTIST_MBID,
    artist_name: "Bastille",
    title: "Million Pieces",
    duration: 270,
    release_date: "2019-09-27",
  }]);
  for (let index = 0; index < 41; index += 1) {
    refreshVideo.RefreshVideoService.upsertArtistVideos(ARTIST_MBID, [{
      provider: "tidal",
      provider_id: `decoy-${index}`,
      artist_mbid: ARTIST_MBID,
      artist_name: "Bastille",
      title: `Unresolved provider video ${index}`,
      duration: 180 + index,
      release_date: "2019-09-27",
    }]);
  }
  const searches: string[] = [];
  const provider: YouTubeVideoCatalogProvider = {
    id: "youtube-music",
    name: "YouTube Music",
    search: async (query) => {
      searches.push(query);
      return {
        artists: [], albums: [], tracks: [],
        videos: query.endsWith("Million Pieces") ? [{
          providerId: "b4EflWHsfJo",
          title: "Million Pieces (M-22 Remix / Visualiser)",
          artist: { providerId: YOUTUBE_CHANNEL, name: "Bastille" },
          duration: 270,
        }] : [],
      };
    },
    getArtistVideos: async () => [],
    getVideo: async (id) => ({
      providerId: String(id),
      title: "Million Pieces (M-22 Remix / Visualiser)",
      artist: { providerId: YOUTUBE_CHANNEL, name: "Bastille" },
      duration: 270,
      releaseDate: "2019-09-26",
    }),
  };

  const firstCount = await catalog.supplementSparseProviderVideosFromYouTube(
    ARTIST_MBID,
    ARTIST_MBID,
    { getProvider: () => provider, resolutionBatchIndex: 0 },
  );
  assert.equal(firstCount, 0);
  assert.equal(searches.length, 40, "one refresh has a bounded search budget");

  const secondCount = await catalog.supplementSparseProviderVideosFromYouTube(
    ARTIST_MBID,
    ARTIST_MBID,
    { getProvider: () => provider, resolutionBatchIndex: 1 },
  );
  assert.equal(secondCount, 1);
  assert.equal(searches.length, 42, "the next pass reaches the remaining stable chunk");
  const resolved = dbModule.db.prepare(`
    SELECT title, video_variant AS variant, youtube_video_id AS youtubeId
    FROM Recordings WHERE youtube_video_id = 'b4EflWHsfJo'
  `).get() as { title: string; variant: string; youtubeId: string };
  assert.equal(resolved.youtubeId, "b4EflWHsfJo");
  assert.equal(resolved.variant, "visualizer");
  assert.match(resolved.title, /M-22 Remix/);
});

test("sparse video resolution rejects a same-title cover from another artist", async () => {
  const refreshVideo = await import("./refresh-video-service.js");
  refreshVideo.RefreshVideoService.upsertArtistVideos(ARTIST_MBID, [{
    provider: "tidal",
    provider_id: "wrong-uploader-source",
    artist_mbid: ARTIST_MBID,
    artist_name: "Bastille",
    title: "Pompeii",
    duration: 232,
    release_date: "2013-02-01",
  }]);
  let detailFetches = 0;
  const provider: YouTubeVideoCatalogProvider = {
    id: "youtube-music",
    name: "YouTube Music",
    search: async () => ({
      artists: [], albums: [], tracks: [],
      videos: [{
        providerId: "cover-video",
        title: "Pompeii",
        artist: { providerId: "cover-channel", name: "Unrelated Cover Band" },
        duration: 232,
      }],
    }),
    getArtistVideos: async () => [],
    getVideo: async () => {
      detailFetches += 1;
      throw new Error("wrong-artist candidate must be rejected before detail lookup");
    },
  };

  const count = await catalog.supplementSparseProviderVideosFromYouTube(
    ARTIST_MBID,
    ARTIST_MBID,
    { getProvider: () => provider },
  );
  assert.equal(count, 0);
  assert.equal(detailFetches, 0);
});

test("one YouTube identity cannot be assigned to two sparse provider shells", async () => {
  const firstRecording = dbModule.db.prepare(`
    INSERT INTO Recordings (artist_mbid, title, length_ms, is_video, video_variant, metadata_status)
    VALUES (?, 'Shared title', 180000, 1, 'video', 'provider_catalog')
    RETURNING id
  `).get(ARTIST_MBID) as { id: number };
  const secondRecording = dbModule.db.prepare(`
    INSERT INTO Recordings (artist_mbid, title, length_ms, is_video, video_variant, metadata_status)
    VALUES (?, 'Shared title', 180000, 1, 'video', 'provider_catalog')
    RETURNING id
  `).get(ARTIST_MBID) as { id: number };
  const first = seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "tidal",
    providerVideoId: "shared-source-1",
    recordingId: firstRecording.id,
    title: "Shared title",
    durationMs: 180000,
  });
  const second = seedAcceptedProviderVideoMatch(dbModule.db, {
    provider: "apple-music",
    providerVideoId: "shared-source-2",
    recordingId: secondRecording.id,
    title: "Shared title",
    durationMs: 180000,
  });
  dbModule.db.prepare("UPDATE ProviderItems SET release_date = '2020-01-02' WHERE id IN (?, ?)")
    .run(first.providerVideoItemId, second.providerVideoItemId);

  const provider: YouTubeVideoCatalogProvider = {
    id: "youtube-music",
    name: "YouTube Music",
    search: async () => ({
      artists: [], albums: [], tracks: [],
      videos: [{
        providerId: "one-catalog-video",
        title: "Shared title",
        artist: { providerId: YOUTUBE_CHANNEL, name: "Bastille" },
        duration: 180,
      }],
    }),
    getArtistVideos: async () => [],
    getVideo: async () => ({
      providerId: "one-catalog-video",
      title: "Shared title",
      artist: { providerId: YOUTUBE_CHANNEL, name: "Bastille" },
      duration: 180,
      releaseDate: "2020-01-02",
    }),
  };

  const count = await catalog.supplementSparseProviderVideosFromYouTube(
    ARTIST_MBID,
    ARTIST_MBID,
    { getProvider: () => provider },
  );
  assert.equal(count, 0);
  assert.equal(
    (dbModule.db.prepare("SELECT COUNT(*) AS count FROM Recordings WHERE youtube_video_id IS NOT NULL")
      .get() as { count: number }).count,
    0,
  );
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
