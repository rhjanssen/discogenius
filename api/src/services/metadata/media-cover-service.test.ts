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
let configModule: typeof import("../config/config.js");
const originalFetch = globalThis.fetch;

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  configModule = await import("../config/config.js");
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

  assert.equal(artworkUrl, `/media-cover/Albums/${albumMbid}/cover.jpg?source=canonical`);
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

test("albumCoverLocalUrl emits local media-cover URL even without stored image URLs", () => {
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

  assert.equal(artworkUrl, `/media-cover/Albums/${albumMbid}/cover.jpg?source=canonical`);
});

test("provider artwork fallbacks only produce browser-renderable URLs", () => {
  assert.equal(
    mediaCoverServiceModule.renderableProviderArtworkUrl(
      "11111111-1111-1111-1111-111111111111",
      "tidal",
    ),
    "https://resources.tidal.com/images/11111111/1111/1111/1111/111111111111/320x320.jpg",
  );
  assert.equal(
    mediaCoverServiceModule.renderableProviderArtworkUrl("/media-cover/Albums/album/cover.jpg", "tidal"),
    "/media-cover/Albums/album/cover.jpg",
  );
  assert.equal(
    mediaCoverServiceModule.renderableProviderArtworkUrl("opaque-provider-id", "other-provider"),
    null,
  );
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

  assert.equal(artworkUrl, `/media-cover/Albums/${albumMbid}/cover.jpg?source=canonical`);
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
    // The cached source is fetched at origin resolution; the UI proxies are
    // derived locally by writeResizedMediaCovers.
    size: "origin",
  }]);
  assert.equal(fetchCalls.includes(providerUrl), true);
  const albumCache = path.join(tempDir, "media-cover", "Albums", albumMbid);
  assert.equal(fs.existsSync(path.join(albumCache, "cover.jpg")), false);
  assert.equal(fs.existsSync(path.join(albumCache, "cover-500.jpg")), true);
  assert.equal(fs.existsSync(path.join(albumCache, "cover-250.jpg")), true);
});

test("artwork preference controls whether canonical or provider album art is fetched first", async () => {
  const providerModule = await import("../providers/index.js");
  const canonicalUrl = "https://metadata.example/canonical-cover.jpg";
  const providerUrl = "https://provider.example/preferred-cover.jpg";
  const image = jpeg.encode({
    width: 600,
    height: 600,
    data: Buffer.alloc(600 * 600 * 4, 255),
  }, 92).data;
  const fetchCalls: string[] = [];

  providerModule.streamingProviderManager.registerStreamingProvider({
    id: "preference-artwork-provider",
    name: "Preference Artwork Provider",
    capabilities: { artwork: true },
    getArtworkUrl: () => providerUrl,
  } as any);
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetchCalls.push(String(url));
    return new Response(image, {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    });
  }) as typeof fetch;

  try {
    configModule.updateConfig("metadata", { artwork_preference: "provider" });
    const providerPreferred = await mediaCoverServiceModule.resolveAlbumArtwork({
      albumMbid: "provider-preference-release-group",
      servarrMetadataData: { images: [{ coverType: "Cover", url: canonicalUrl }] },
      providerCandidates: [{
        provider: "preference-artwork-provider",
        entityId: "provider-preference-album",
        imageId: "provider-preference-image",
      }],
    });
    assert.equal(providerPreferred, "/media-cover/Albums/provider-preference-release-group/cover.jpg");
    assert.deepEqual(fetchCalls, [providerUrl]);

    fetchCalls.length = 0;
    configModule.updateConfig("metadata", { artwork_preference: "canonical" });
    const canonicalPreferred = await mediaCoverServiceModule.resolveAlbumArtwork({
      albumMbid: "canonical-preference-release-group",
      servarrMetadataData: { images: [{ coverType: "Cover", url: canonicalUrl }] },
      providerCandidates: [{
        provider: "preference-artwork-provider",
        entityId: "canonical-preference-album",
        imageId: "canonical-preference-image",
      }],
    });
    assert.equal(canonicalPreferred, "/media-cover/Albums/canonical-preference-release-group/cover.jpg");
    assert.deepEqual(fetchCalls, [canonicalUrl]);
  } finally {
    configModule.updateConfig("metadata", { artwork_preference: "canonical" });
    globalThis.fetch = originalFetch;
  }
});

test("canonical artwork resolution falls through a dead metadata URL to Cover Art Archive", async () => {
  const albumMbid = "dead-metadata-cover-release-group";
  const metadataUrl = "https://metadata.example/dead-cover.jpg";
  const caaUrl = `https://coverartarchive.org/release-group/${albumMbid}/front`;
  const calls: string[] = [];
  const image = jpeg.encode({
    width: 600,
    height: 600,
    data: Buffer.alloc(600 * 600 * 4, 255),
  }, 92).data;

  globalThis.fetch = (async (url: string | URL | Request) => {
    const source = String(url);
    calls.push(source);
    return source === metadataUrl
      ? new Response("", { status: 404 })
      : new Response(image, { status: 200, headers: { "content-type": "image/jpeg" } });
  }) as typeof fetch;

  try {
    const artworkUrl = await mediaCoverServiceModule.resolveAlbumArtwork({
      albumMbid,
      servarrMetadataData: { images: [{ coverType: "Cover", url: metadataUrl }] },
    });
    assert.equal(artworkUrl, `/media-cover/Albums/${albumMbid}/cover.jpg`);
    assert.deepEqual(calls, [metadataUrl, caaUrl]);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

  assert.match(String(artworkUrl), new RegExp(`^/media-cover/Videos/${recording.id}/cover\\.jpg(?:\\?lastWrite=\\d+)?$`));
  assert.deepEqual(artworkRequests, [{
    entityType: "video",
    providerId: "provider-video-id",
    imageId: "video-image-id",
    size: "origin",
  }]);
  assert.deepEqual(fetchCalls, [providerUrl]);
  const videoCache = path.join(tempDir, "media-cover", "Videos", String(recording.id));
  assert.equal(fs.existsSync(path.join(videoCache, "cover.jpg")), true);
  assert.equal(fs.existsSync(path.join(videoCache, "cover-250.jpg")), true);
  assert.equal(fs.existsSync(path.join(videoCache, "cover-500.jpg")), false);
  assert.match(
    String(mediaCoverServiceModule.videoCoverLocalUrl(recording.id)),
    new RegExp(`^/media-cover/Videos/${recording.id}/cover\\.jpg\\?lastWrite=\\d+$`),
  );
});

test("video cover proxies preserve source aspect ratio (no forced 3:2 crop)", async () => {
  const cases = [
    { label: "16:9", width: 1280, height: 720, videoId: "aspect-16x9-video" },
    { label: "3:2", width: 1080, height: 720, videoId: "aspect-3x2-video" },
    { label: "4:3", width: 800, height: 600, videoId: "aspect-4x3-video" },
  ] as const;

  for (const sample of cases) {
    const image = jpeg.encode({
      width: sample.width,
      height: sample.height,
      data: Buffer.alloc(sample.width * sample.height * 4, 180),
    }, 92).data;
    const sourceUrl = `https://provider.example/artwork/${sample.videoId}.jpg`;

    globalThis.fetch = (async () => new Response(image, {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    })) as typeof fetch;

    try {
      const cached = await mediaCoverServiceModule.ensureCachedMediaCover({
        entityId: sample.videoId,
        coverEntity: "Video",
        coverType: "Cover",
        sourceUrl,
      });
      assert.equal(cached, `/media-cover/Videos/${sample.videoId}/cover.jpg`);

      const folder = path.join(tempDir, "media-cover", "Videos", sample.videoId);
      const origin = jpeg.decode(fs.readFileSync(path.join(folder, "cover.jpg")), { useTArray: true });
      const proxy250 = jpeg.decode(fs.readFileSync(path.join(folder, "cover-250.jpg")), { useTArray: true });

      assert.equal(origin.width, sample.width, `${sample.label} origin width`);
      assert.equal(origin.height, sample.height, `${sample.label} origin height`);
      assert.equal(fs.existsSync(path.join(folder, "cover-500.jpg")), false, `${sample.label} no 500 proxy`);
      assert.equal(proxy250.height, 250, `${sample.label} proxy-250 height`);

      const expected250Width = Math.max(1, Math.round(sample.width * 250 / sample.height));
      assert.equal(proxy250.width, expected250Width, `${sample.label} proxy-250 width`);

      const sourceRatio = sample.width / sample.height;
      assert.ok(
        Math.abs(proxy250.width / proxy250.height - sourceRatio) < 0.02,
        `${sample.label} proxy-250 must keep aspect (got ${proxy250.width}x${proxy250.height})`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
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

  assert.match(String(artworkUrl), new RegExp(`^/media-cover/Videos/${recording.id}/cover\\.jpg(?:\\?lastWrite=\\d+)?$`));
  assert.deepEqual(artworkRequests, [{
    entityType: "video",
    providerId: "provider-video-without-image-id",
    imageId: null,
    size: "origin",
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
  assert.equal(fs.existsSync(path.join(tempDir, "media-cover", "Albums", albumMbid, "cover.jpg")), false);
  assert.equal(fs.existsSync(path.join(tempDir, "media-cover", "Albums", albumMbid, "cover-500.jpg")), true);
  assert.equal(fs.existsSync(path.join(tempDir, "media-cover", "Albums", albumMbid, "cover-250.jpg")), true);

  const secondArtworkUrl = await mediaCoverServiceModule.resolveAlbumArtwork({ albumMbid });
  assert.equal(secondArtworkUrl, artworkUrl);
  assert.equal(calls.length, 1);
});

test("provider-fulfilled canonical cache is stale once Servarr imagery exists", () => {
  const albumMbid = "stale-provider-fallback-cache";
  const providerUrl = "https://resources.tidal.com/images/aaaaaaaa/bbbb/cccc/dddd/eeeeeeeeeeee/750x750.jpg";
  const servarrUrl = "https://images.lidarr.audio/cache/https://coverartarchive.org/release/example/real-cover.jpg";
  const folder = path.join(tempDir, "media-cover", "Albums", albumMbid);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "cover-250.jpg"), Buffer.alloc(32, 1));
  fs.writeFileSync(
    path.join(folder, ".cover.source.json"),
    JSON.stringify({ url: providerUrl, preference: "canonical", fulfilledBy: "provider" }),
  );

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("stale-provider-artist", "Artist");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, images) VALUES (?, ?, ?, ?)")
    .run(
      albumMbid,
      "stale-provider-artist",
      "Stale Provider Cache",
      JSON.stringify([{ coverType: "Cover", url: providerUrl, source: "provider-fallback" }]),
    );

  configModule.updateConfig("metadata", { artwork_preference: "canonical" });
  assert.equal(
    mediaCoverServiceModule.isArtworkPreferenceCacheCurrent(albumMbid, "Album", "Cover"),
    true,
    "provider fallback stays current while no canonical image exists",
  );

  dbModule.db.prepare("UPDATE Albums SET images = ? WHERE mbid = ?").run(
    JSON.stringify([
      { coverType: "Cover", url: servarrUrl },
      { coverType: "Cover", url: providerUrl, source: "provider-fallback" },
    ]),
    albumMbid,
  );

  assert.equal(
    mediaCoverServiceModule.isArtworkPreferenceCacheCurrent(albumMbid, "Album", "Cover"),
    false,
    "canonical preference must retry once Servarr/CAA imagery appears",
  );
});

test("oversized cached derivatives fall back to the smaller original", () => {
  const folder = path.join(tempDir, "media-cover", "Albums", "oversized-proxy");
  fs.mkdirSync(folder, { recursive: true });
  const original = path.join(folder, "cover.jpg");
  const derivative = path.join(folder, "cover-500.jpg");
  fs.writeFileSync(original, Buffer.alloc(100, 1));
  fs.writeFileSync(derivative, Buffer.alloc(150, 2));

  assert.equal(
    mediaCoverServiceModule.resolveMediaCoverFilePath(folder, "cover-500.jpg"),
    original,
  );
});

test("stable poster.jpg alias resolves to the largest UI derivative", () => {
  const folder = path.join(tempDir, "media-cover", "artist-poster-alias");
  fs.mkdirSync(folder, { recursive: true });
  const poster500 = path.join(folder, "poster-500.jpg");
  const poster250 = path.join(folder, "poster-250.jpg");
  fs.writeFileSync(poster500, Buffer.alloc(120, 1));
  fs.writeFileSync(poster250, Buffer.alloc(40, 2));

  assert.equal(
    mediaCoverServiceModule.resolveMediaCoverFilePath(folder, "poster.jpg"),
    poster500,
  );
  assert.equal(
    mediaCoverServiceModule.getMediaCoverFilePathFromUrl("/media-cover/artist-poster-alias/poster.jpg"),
    poster500,
  );
});

test("getCachedMediaCoverSourceUrlFromLocalUrl returns remote origin from source marker", () => {
  const albumMbid = "origin-source-album-mbid";
  const folder = path.join(tempDir, "media-cover", "Albums", albumMbid);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "cover-500.jpg"), Buffer.alloc(80, 1));
  fs.writeFileSync(
    path.join(folder, ".cover.source.json"),
    JSON.stringify({ url: "https://resources.tidal.com/images/abcd/origin.jpg" }),
  );

  assert.equal(
    mediaCoverServiceModule.getCachedMediaCoverSourceUrlFromLocalUrl(
      `/media-cover/Albums/${albumMbid}/cover.jpg`,
    ),
    "https://resources.tidal.com/images/abcd/origin.jpg",
  );
  assert.equal(
    mediaCoverServiceModule.getCachedMediaCoverSourceUrlFromLocalUrl(
      `/media-cover/Albums/${albumMbid}/cover-500.jpg`,
    ),
    "https://resources.tidal.com/images/abcd/origin.jpg",
  );
  assert.equal(
    mediaCoverServiceModule.getCachedMediaCoverSourceUrlFromLocalUrl(
      `/media-cover/Albums/missing-album/cover.jpg`,
    ),
    null,
  );
});

test("artist profile selectors never fall back to Fanart or Banner", () => {
  const fanartUrl = "https://images.lidarr.audio/cache/https://example.test/fanart.jpg";
  const bannerUrl = "https://images.lidarr.audio/cache/https://example.test/banner.jpg";
  const posterUrl = "https://images.lidarr.audio/cache/https://example.test/poster.jpg";

  assert.equal(
    mediaCoverServiceModule.getServarrMetadataArtistImageUrl({
      Images: [
        { CoverType: "Banner", Url: bannerUrl, Width: 1381, Height: 575 },
        { CoverType: "Fanart", Url: fanartUrl, Width: 1920, Height: 1080 },
        { CoverType: "Poster", Url: posterUrl, Width: 1000, Height: 1000 },
      ],
    }),
    posterUrl,
  );

  assert.equal(
    mediaCoverServiceModule.getServarrMetadataArtistImageUrl({
      Images: [
        { CoverType: "Banner", Url: bannerUrl, Width: 1381, Height: 575 },
        { CoverType: "Fanart", Url: fanartUrl, Width: 1920, Height: 1080 },
      ],
    }),
    null,
  );

  assert.equal(
    mediaCoverServiceModule.getServarrMetadataArtistImageUrl({
      Images: [
        { CoverType: "Banner", Url: bannerUrl, Width: 1381, Height: 575 },
        { CoverType: "Fanart", Url: fanartUrl, Width: 1920, Height: 1080 },
      ],
    }, ["Fanart"]),
    fanartUrl,
  );
});

test("artist provider artwork candidates follow streaming.provider_priority", async () => {
  const providerModule = await import("../providers/index.js");
  const artistMbid = "artist-priority-art-mbid";
  const { db } = dbModule;

  for (const id of ["priority-art-tidal", "priority-art-spotify"]) {
    providerModule.streamingProviderManager.registerStreamingProvider({
      id,
      name: id,
      capabilities: { artwork: true },
      getArtworkUrl: () => null,
    } as any);
  }

  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run(artistMbid, "Priority Art Artist");
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, asset_id, match_confidence, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("priority-art-spotify", "artist", "spotify-artist-1", artistMbid, "spotify-pic", 0.99, "2026-01-02T00:00:00Z");
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, asset_id, match_confidence, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("priority-art-tidal", "artist", "tidal-artist-1", artistMbid, "tidal-pic", 0.5, "2026-01-01T00:00:00Z");

  try {
    configModule.updateConfig("streaming", {
      provider_priority: ["priority-art-tidal", "priority-art-spotify"],
    });

    const candidates = mediaCoverServiceModule.loadArtistProviderArtworkCandidates(artistMbid);
    assert.deepEqual(
      candidates.map((candidate) => ({ provider: candidate.provider, imageId: candidate.imageId })),
      [
        { provider: "priority-art-tidal", imageId: "tidal-pic" },
        { provider: "priority-art-spotify", imageId: "spotify-pic" },
      ],
    );
  } finally {
    configModule.updateConfig("streaming", { provider_priority: [] });
  }
});

test("album provider artwork candidates prefer stereo slot then spatial then other matches", () => {
  const { db } = dbModule;
  const albumMbid = "album-slot-art-mbid";
  const artistMbid = "album-slot-art-artist";

  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run(artistMbid, "Slot Art Artist");
  db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run(albumMbid, artistMbid, "Slot Art Album");

  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid, asset_id, cover, match_confidence, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("tidal", "album", "stereo-album-1", artistMbid, albumMbid, "stereo-cover", null, 0.4, "2026-01-01T00:00:00Z");
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid, asset_id, cover, match_confidence, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("spotify", "album", "spatial-album-1", artistMbid, albumMbid, "spatial-cover", null, 0.5, "2026-01-02T00:00:00Z");
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid, asset_id, cover, match_confidence, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("apple-music", "album", "other-album-1", artistMbid, albumMbid, "other-cover", null, 0.99, "2026-01-03T00:00:00Z");

  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_provider, selected_provider_id
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(artistMbid, albumMbid, "spatial", 1, "spotify", "spatial-album-1");
  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_provider, selected_provider_id
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(artistMbid, albumMbid, "stereo", 1, "tidal", "stereo-album-1");

  const withStereo = mediaCoverServiceModule.loadAlbumProviderArtworkCandidates(albumMbid);
  assert.deepEqual(
    withStereo.map((candidate) => ({ provider: candidate.provider, entityId: candidate.entityId, imageId: candidate.imageId })),
    [
      { provider: "tidal", entityId: "stereo-album-1", imageId: "stereo-cover" },
      { provider: "spotify", entityId: "spatial-album-1", imageId: "spatial-cover" },
      { provider: "apple-music", entityId: "other-album-1", imageId: "other-cover" },
    ],
  );

  db.prepare("DELETE FROM ReleaseGroupSlots WHERE release_group_mbid = ? AND slot = ?")
    .run(albumMbid, "stereo");
  const spatialOnly = mediaCoverServiceModule.loadAlbumProviderArtworkCandidates(albumMbid);
  assert.equal(spatialOnly[0]?.provider, "spotify");
  assert.equal(spatialOnly[0]?.imageId, "spatial-cover");
});

test("stale provider cache still serves existing derivatives while upgrade is pending", () => {
  const albumMbid = "stale-but-serve-album";
  const providerUrl = "https://resources.tidal.com/images/aaaaaaaa/bbbb/cccc/dddd/eeeeeeeeeeee/750x750.jpg";
  const servarrUrl = "https://images.lidarr.audio/cache/https://coverartarchive.org/release/example/real-cover.jpg";
  const folder = path.join(tempDir, "media-cover", "Albums", albumMbid);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "cover-500.jpg"), Buffer.alloc(64, 1));
  fs.writeFileSync(path.join(folder, "cover-250.jpg"), Buffer.alloc(32, 1));
  fs.writeFileSync(
    path.join(folder, ".cover.source.json"),
    JSON.stringify({ url: providerUrl, preference: "canonical", fulfilledBy: "provider" }),
  );

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("stale-but-serve-artist", "Artist");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, images) VALUES (?, ?, ?, ?)")
    .run(
      albumMbid,
      "stale-but-serve-artist",
      "Stale But Serve",
      JSON.stringify([
        { coverType: "Cover", url: servarrUrl },
        { coverType: "Cover", url: providerUrl, source: "provider-fallback" },
      ]),
    );

  configModule.updateConfig("metadata", { artwork_preference: "canonical" });
  assert.equal(mediaCoverServiceModule.isArtworkPreferenceCacheCurrent(albumMbid, "Album", "Cover"), false);
  assert.equal(
    mediaCoverServiceModule.resolveMediaCoverFilePath(folder, "cover.jpg"),
    path.join(folder, "cover-500.jpg"),
  );
  assert.equal(fs.existsSync(path.join(folder, "cover-500.jpg")), true);
});

test("ensureCachedMediaCover keeps prior files when a canonical upgrade fetch fails", async () => {
  const albumMbid = "failed-upgrade-retention-album";
  const providerUrl = "https://resources.tidal.com/images/bbbbbbbb/cccc/dddd/eeee/ffffffffffff/750x750.jpg";
  const canonicalUrl = "https://images.lidarr.audio/cache/https://coverartarchive.org/release/example/upgrade-cover.jpg";
  const folder = path.join(tempDir, "media-cover", "Albums", albumMbid);
  const image = jpeg.encode({
    width: 600,
    height: 600,
    data: Buffer.alloc(600 * 600 * 4, 255),
  }, 92).data;

  globalThis.fetch = (async (url: string | URL | Request) => {
    const source = String(url);
    if (source === providerUrl) {
      return new Response(image, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const initialUrl = await mediaCoverServiceModule.ensureCachedMediaCover({
      entityId: albumMbid,
      coverEntity: "Album",
      coverType: "Cover",
      sourceUrl: providerUrl,
      fulfilledBy: "provider",
    });
    assert.equal(initialUrl, `/media-cover/Albums/${albumMbid}/cover.jpg`);
    assert.equal(fs.existsSync(path.join(folder, "cover-500.jpg")), true);
    assert.equal(fs.existsSync(path.join(folder, "cover-250.jpg")), true);

    const failedUpgrade = await mediaCoverServiceModule.ensureCachedMediaCover({
      entityId: albumMbid,
      coverEntity: "Album",
      coverType: "Cover",
      sourceUrl: canonicalUrl,
      fulfilledBy: "canonical",
    });
    assert.equal(failedUpgrade, null);
    assert.equal(fs.existsSync(path.join(folder, "cover-500.jpg")), true);
    assert.equal(fs.existsSync(path.join(folder, "cover-250.jpg")), true);
    const marker = JSON.parse(fs.readFileSync(path.join(folder, ".cover.source.json"), "utf-8"));
    assert.equal(marker.url, providerUrl);
    assert.equal(marker.fulfilledBy, "provider");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ensureCachedMediaCover keeps prior files when a successful fetch cannot be decoded", async () => {
  const albumMbid = "failed-decode-retention-album";
  const providerUrl = "https://resources.tidal.com/images/cccccccc/dddd/eeee/ffff/000000000000/750x750.jpg";
  const badCanonicalUrl = "https://images.lidarr.audio/cache/https://coverartarchive.org/release/example/bad-cover.bin";
  const folder = path.join(tempDir, "media-cover", "Albums", albumMbid);
  const image = jpeg.encode({
    width: 600,
    height: 600,
    data: Buffer.alloc(600 * 600 * 4, 255),
  }, 92).data;

  globalThis.fetch = (async (url: string | URL | Request) => {
    const source = String(url);
    if (source === providerUrl) {
      return new Response(image, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    if (source === badCanonicalUrl) {
      return new Response(Buffer.from("not-an-image"), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    await mediaCoverServiceModule.ensureCachedMediaCover({
      entityId: albumMbid,
      coverEntity: "Album",
      coverType: "Cover",
      sourceUrl: providerUrl,
      fulfilledBy: "provider",
    });

    const failedUpgrade = await mediaCoverServiceModule.ensureCachedMediaCover({
      entityId: albumMbid,
      coverEntity: "Album",
      coverType: "Cover",
      sourceUrl: badCanonicalUrl,
      fulfilledBy: "canonical",
    });
    assert.equal(failedUpgrade, `/media-cover/Albums/${albumMbid}/cover.jpg`);
    assert.equal(fs.existsSync(path.join(folder, "cover-500.jpg")), true);
    assert.equal(fs.existsSync(path.join(folder, "cover-250.jpg")), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizeArtworkUrl upgrades cropped YouTube, square Apple, and TIDAL 3:2 video thumbs", () => {
  assert.equal(
    mediaCoverServiceModule.normalizeArtworkUrl(
      "https://i.ytimg.com/vi/-oyOHAew3Bc/hq720.jpg?sqp=-oaymwEXCNUGEOADIAQqCwjVARCqCBh4INgESFo&rs=AOn4CLAJ8V-N1UzOLZFqL7WnPxzYz7h8pQ",
    ),
    "https://i.ytimg.com/vi/-oyOHAew3Bc/hq720.jpg",
  );
  assert.equal(
    mediaCoverServiceModule.normalizeArtworkUrl(
      "https://is1-ssl.mzstatic.com/image/thumb/Video221/v4/c1/f2/33/c1f233cd-8f77-9d2f-8097-7d9ce47c627b/24UMGIM84106.crop.jpg/1080x1080mv.jpg",
    ),
    "https://is1-ssl.mzstatic.com/image/thumb/Video221/v4/c1/f2/33/c1f233cd-8f77-9d2f-8097-7d9ce47c627b/24UMGIM84106.crop.jpg/1920x1080mv.jpg",
  );
  assert.equal(
    mediaCoverServiceModule.normalizeArtworkUrl("https://i.ytimg.com/vi/abc123/hq720.jpg"),
    "https://i.ytimg.com/vi/abc123/hq720.jpg",
  );
  assert.equal(
    mediaCoverServiceModule.normalizeArtworkUrl(
      "https://resources.tidal.com/images/238db1f8/3d1c/4810/bf02/df33c72315ab/1080x720.jpg",
    ),
    "https://resources.tidal.com/images/238db1f8/3d1c/4810/bf02/df33c72315ab/origin.jpg",
  );
  // Square album art must not be rewritten to origin.
  assert.equal(
    mediaCoverServiceModule.normalizeArtworkUrl(
      "https://resources.tidal.com/images/21824bc6/1cfd/44da/9f78/c400e83cf133/640x640.jpg",
    ),
    "https://resources.tidal.com/images/21824bc6/1cfd/44da/9f78/c400e83cf133/640x640.jpg",
  );
});
