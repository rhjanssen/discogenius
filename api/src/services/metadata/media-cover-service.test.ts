import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import * as jpeg from "jpeg-js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-media-cover-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let mediaCoverServiceModule: typeof import("./media-cover-service.js");
const originalFetch = globalThis.fetch;

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  mediaCoverServiceModule = await import("./media-cover-service.js");
});

after(() => {
  globalThis.fetch = originalFetch;
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("Servarr Metadata Server album artwork maps to the album MediaCover route", () => {
  const albumMbid = "album-with-canonical-cover";
  const remoteUrl = "https://images.lidarr.audio/cache/https://coverartarchive.org/release/example/cover.jpg";
  const artworkUrl = mediaCoverServiceModule.albumCoverLocalUrl({
    albumMbid,
    images: {
      Images: [
        {
          CoverType: "Cover",
          Url: remoteUrl,
          Width: 1200,
          Height: 1200,
        },
      ],
    },
  });

  assert.equal(artworkUrl, `/media-cover/Albums/${albumMbid}/cover.jpg`);
});

test("Servarr Metadata Server selectors return raw URLs for durable storage", () => {
  const remoteUrl = "https://images.lidarr.audio/cache/https://coverartarchive.org/release/example/storage-cover.jpg";

  assert.equal(mediaCoverServiceModule.getServarrMetadataAlbumImageUrl({
    Images: [
      {
        CoverType: "Cover",
        Url: remoteUrl,
        Width: 1200,
        Height: 1200,
      },
    ],
  }), remoteUrl);
});

test("provider artwork ids are not converted by core sync selectors", () => {
  const albumMbid = "album-with-provider-id";
  const artworkUrl = mediaCoverServiceModule.albumCoverLocalUrl({
    albumMbid,
    images: {
      Images: [
        {
          CoverType: "Cover",
          Url: null,
        },
      ],
    },
  });

  assert.equal(artworkUrl, null);
});

test("Servarr Metadata Server album artwork wins over cached provider fallback artwork", () => {
  const albumMbid = "album-with-provider-fallback";
  const servarrMetadataUrl = "https://images.lidarr.audio/cache/https://coverartarchive.org/release/example/Servarr Metadata Server-cover.jpg";
  const providerUrl = "https://resources.tidal.com/images/11111111/1111/1111/1111/111111111111/750x750.jpg";

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Artist");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, images) VALUES (?, ?, ?, ?)")
    .run(
      albumMbid,
      "artist-mbid",
      "provider Fallback Album",
      JSON.stringify([{ coverType: "Cover", url: providerUrl, source: "provider-fallback" }]),
    );

  const artworkUrl = mediaCoverServiceModule.albumCoverLocalUrl({
    albumMbid,
    images: {
      Images: [
        {
          CoverType: "Cover",
          Url: servarrMetadataUrl,
          Width: 1200,
          Height: 1200,
        },
      ],
    },
  });

  assert.equal(artworkUrl, `/media-cover/Albums/${albumMbid}/cover.jpg`);
});

test("provider artwork ids resolve through the provider interface before caching", async () => {
  const providerModule = await import("../providers/index.js");
  const albumMbid = "provider-artwork-release-group";
  const image = jpeg.encode({
    width: 600,
    height: 600,
    data: Buffer.alloc(600 * 600 * 4, 255),
  }, 92).data;
  const fetchCalls: string[] = [];
  const artworkRequests: any[] = [];
  const providerUrl = "https://provider.example/artwork/provider-image-id.jpg";

  providerModule.streamingProviderManager.registerStreamingProvider({
    id: "test-artwork-provider",
    name: "Test Artwork Provider",
    capabilities: {
      catalogSearch: false,
      artistCatalog: false,
      followedArtists: false,
      audioPreviews: false,
      audioDownloads: false,
      lossyStereo: false,
      losslessStereo: false,
      hiResStereo: false,
      spatialAudio: false,
      lyrics: false,
      musicVideos: false,
      videoPreviews: false,
      videoDownloads: false,
      artwork: true,
      editorialMetadata: false,
      providerIds: true,
    },
    search: async () => ({ artists: [], albums: [], tracks: [], videos: [] }),
    getArtist: async () => { throw new Error("not implemented"); },
    getArtistAlbums: async () => [],
    getAlbum: async () => { throw new Error("not implemented"); },
    getAlbumTracks: async () => [],
    getTrack: async () => { throw new Error("not implemented"); },
    getAuthStatus: async () => ({
      connected: true,
      tokenExpired: false,
      refreshTokenExpired: false,
      hoursUntilExpiry: 1,
      canAccessShell: false,
      canAccessLocalLibrary: false,
      remoteCatalogAvailable: true,
      canAuthenticate: false,
    }),
    getArtworkUrl: (request: any) => {
      artworkRequests.push(request);
      return providerUrl;
    },
  } as any);

  globalThis.fetch = (async (url: string | URL | Request) => {
    const text = String(url);
    fetchCalls.push(text);
    if (text.includes("coverartarchive.org")) {
      return new Response("", { status: 404 });
    }
    return new Response(image, {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  }) as typeof fetch;

  const artworkUrl = await mediaCoverServiceModule.resolveAlbumArtwork({
    albumMbid,
    providerCandidates: [{
      provider: "test-artwork-provider",
      entityId: "provider-album-id",
      imageId: "provider-image-id",
    }],
  });

  assert.equal(artworkUrl, `/media-cover/Albums/${albumMbid}/cover.jpg`);
  assert.deepEqual(artworkRequests, [{
    entityType: "album",
    providerId: "provider-album-id",
    imageId: "provider-image-id",
    size: 1200,
  }]);
  assert.equal(fetchCalls.includes(providerUrl), true);
});

test("provider video artwork ids resolve through the provider interface before caching", async () => {
  const providerModule = await import("../providers/index.js");
  const image = jpeg.encode({
    width: 1280,
    height: 720,
    data: Buffer.alloc(1280 * 720 * 4, 255),
  }, 92).data;
  const fetchCalls: string[] = [];
  const artworkRequests: any[] = [];
  const providerUrl = "https://provider.example/artwork/video-image-id.jpg";

  providerModule.streamingProviderManager.registerStreamingProvider({
    id: "test-video-artwork-provider",
    name: "Test Video Artwork Provider",
    capabilities: {
      catalogSearch: false,
      artistCatalog: false,
      followedArtists: false,
      audioPreviews: false,
      audioDownloads: false,
      lossyStereo: false,
      losslessStereo: false,
      hiResStereo: false,
      spatialAudio: false,
      lyrics: false,
      musicVideos: true,
      videoPreviews: false,
      videoDownloads: false,
      artwork: true,
      editorialMetadata: false,
      providerIds: true,
    },
    search: async () => ({ artists: [], albums: [], tracks: [], videos: [] }),
    getArtist: async () => { throw new Error("not implemented"); },
    getArtistAlbums: async () => [],
    getAlbum: async () => { throw new Error("not implemented"); },
    getAlbumTracks: async () => [],
    getTrack: async () => { throw new Error("not implemented"); },
    getAuthStatus: async () => ({
      connected: true,
      tokenExpired: false,
      refreshTokenExpired: false,
      hoursUntilExpiry: 1,
      canAccessShell: false,
      canAccessLocalLibrary: false,
      remoteCatalogAvailable: true,
      canAuthenticate: false,
    }),
    getArtworkUrl: (request: any) => {
      artworkRequests.push(request);
      return providerUrl;
    },
  } as any);

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("video-artist-mbid", "Video Artist");
  const recording = dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_mbid, title, is_video,
      metadata_status, cover_image_id, monitored
    )
    VALUES (?, ?, ?, ?, 1, 'provider_only', ?, 1)
    RETURNING id
  `).get("provider-video-id", "video-recording-mbid", "video-artist-mbid", "Video Title", "video-image-id") as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, recording_id,
      title, asset_id, match_status, match_confidence
    )
    VALUES (?, 'video', ?, ?, ?, ?, ?, 'verified', 1)
  `).run(
    "test-video-artwork-provider",
    "provider-video-id",
    "video-artist-mbid",
    recording.id,
    "Video Title",
    "video-image-id",
  );

  globalThis.fetch = (async (url: string | URL | Request) => {
    fetchCalls.push(String(url));
    return new Response(image, {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  }) as typeof fetch;

  assert.equal(mediaCoverServiceModule.videoCoverLocalUrl(recording.id), `/media-cover/Videos/${recording.id}/cover.jpg`);

  const artworkUrl = await mediaCoverServiceModule.resolveVideoArtwork({ videoId: recording.id });

  assert.equal(artworkUrl, `/media-cover/Videos/${recording.id}/cover.jpg`);
  assert.deepEqual(artworkRequests, [{
    entityType: "video",
    providerId: "provider-video-id",
    imageId: "video-image-id",
    size: "1080x720",
  }]);
  assert.deepEqual(fetchCalls, [providerUrl]);
  assert.equal(fs.existsSync(path.join(tempDir, "media-cover", "Videos", String(recording.id), "cover.jpg")), true);
});

test("provider video artwork can resolve from provider id when no image id is stored", async () => {
  const providerModule = await import("../providers/index.js");
  const image = jpeg.encode({
    width: 1280,
    height: 720,
    data: Buffer.alloc(1280 * 720 * 4, 255),
  }, 92).data;
  const artworkRequests: any[] = [];
  const providerUrl = "https://provider.example/artwork/provider-video-without-image-id.jpg";

  providerModule.streamingProviderManager.registerStreamingProvider({
    id: "test-video-provider-id-artwork-provider",
    name: "Test Video Provider Id Artwork Provider",
    capabilities: {
      catalogSearch: false,
      artistCatalog: false,
      followedArtists: false,
      audioPreviews: false,
      audioDownloads: false,
      lossyStereo: false,
      losslessStereo: false,
      hiResStereo: false,
      spatialAudio: false,
      lyrics: false,
      musicVideos: true,
      videoPreviews: false,
      videoDownloads: false,
      artwork: true,
      editorialMetadata: false,
      providerIds: true,
    },
    search: async () => ({ artists: [], albums: [], tracks: [], videos: [] }),
    getArtist: async () => { throw new Error("not implemented"); },
    getArtistAlbums: async () => [],
    getAlbum: async () => { throw new Error("not implemented"); },
    getAlbumTracks: async () => [],
    getTrack: async () => { throw new Error("not implemented"); },
    getAuthStatus: async () => ({
      connected: true,
      tokenExpired: false,
      refreshTokenExpired: false,
      hoursUntilExpiry: 1,
      canAccessShell: false,
      canAccessLocalLibrary: false,
      remoteCatalogAvailable: true,
      canAuthenticate: false,
    }),
    getArtworkUrl: (request: any) => {
      artworkRequests.push(request);
      return providerUrl;
    },
  } as any);

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("video-provider-id-artist-mbid", "Video Provider Id Artist");
  const recording = dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_mbid, title, is_video,
      metadata_status, monitored
    )
    VALUES (?, ?, ?, ?, 1, 'provider_only', 1)
    RETURNING id
  `).get("provider-video-without-image-id", "video-provider-id-recording-mbid", "video-provider-id-artist-mbid", "Provider Id Video") as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, recording_id,
      title, match_status, match_confidence
    )
    VALUES (?, 'video', ?, ?, ?, ?, 'verified', 1)
  `).run(
    "test-video-provider-id-artwork-provider",
    "provider-video-without-image-id",
    "video-provider-id-artist-mbid",
    recording.id,
    "Provider Id Video",
  );

  globalThis.fetch = (async () => new Response(image, {
    status: 200,
    headers: { "content-type": "image/jpeg" },
  })) as typeof fetch;

  assert.equal(mediaCoverServiceModule.videoCoverLocalUrl(recording.id), `/media-cover/Videos/${recording.id}/cover.jpg`);

  const artworkUrl = await mediaCoverServiceModule.resolveVideoArtwork({ videoId: recording.id });

  assert.equal(artworkUrl, `/media-cover/Videos/${recording.id}/cover.jpg`);
  assert.deepEqual(artworkRequests, [{
    entityType: "video",
    providerId: "provider-video-without-image-id",
    imageId: null,
    size: "1080x720",
  }]);
});

test("album artwork resolver caches Cover Art Archive artwork locally when metadata has no image", async () => {
  const albumMbid = "cover-art-archive-release-group";
  const calls: string[] = [];
  const image = jpeg.encode({
    width: 600,
    height: 600,
    data: Buffer.alloc(600 * 600 * 4, 255),
  }, 92).data;

  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(image, {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  }) as typeof fetch;

  const artworkUrl = await mediaCoverServiceModule.resolveAlbumArtwork({ albumMbid });

  assert.equal(artworkUrl, `/media-cover/Albums/${albumMbid}/cover.jpg`);
  assert.deepEqual(calls, [`https://coverartarchive.org/release-group/${albumMbid}/front`]);
  assert.equal(fs.existsSync(path.join(tempDir, "media-cover", "Albums", albumMbid, "cover.jpg")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "media-cover", "Albums", albumMbid, "cover-500.jpg")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "media-cover", "Albums", albumMbid, "cover-250.jpg")), true);

  const secondArtworkUrl = await mediaCoverServiceModule.resolveAlbumArtwork({ albumMbid });
  assert.equal(secondArtworkUrl, artworkUrl);
  assert.equal(calls.length, 1);
});
