import assert from "node:assert/strict";
import crypto from "node:crypto";
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

function sourceRevision(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function linkProviderArtworkCandidate(options: {
  releaseGroupMbid: string;
  provider: string;
  providerId: string;
  libraryClass?: "stereo" | "spatial";
}): void {
  const { db } = dbModule;
  const releaseGroup = db.prepare(`
    SELECT id, artist_metadata_id, artist_mbid, title
    FROM Albums
    WHERE mbid = ?
  `).get(options.releaseGroupMbid) as {
    id: number;
    artist_metadata_id: number | null;
    artist_mbid: string;
    title: string;
  };
  db.prepare(`
    INSERT OR IGNORE INTO AlbumReleases (
      mbid, release_group_id, release_group_mbid, artist_metadata_id,
      artist_mbid, title
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    `${options.releaseGroupMbid}-release`,
    releaseGroup.id,
    options.releaseGroupMbid,
    releaseGroup.artist_metadata_id,
    releaseGroup.artist_mbid,
    releaseGroup.title,
  );
  const release = db.prepare(`
    SELECT id FROM AlbumReleases WHERE mbid = ?
  `).get(`${options.releaseGroupMbid}-release`) as { id: number };
  const providerItem = db.prepare(`
    SELECT id
    FROM ProviderItems
    WHERE provider = ? AND provider_id = ?
    ORDER BY id
    LIMIT 1
  `).get(options.provider, options.providerId) as { id: number };
  db.prepare(`
    INSERT INTO ProviderReleaseMatches (
      provider_release_item_id, release_id, relation, match_state,
      decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 1, 'test', 1)
    ON CONFLICT(provider_release_item_id, release_id) DO UPDATE SET
      match_state = 'accepted',
      confidence = 1
  `).run(providerItem.id, release.id);

  if (!options.libraryClass) return;
  db.prepare(`
    INSERT OR IGNORE INTO MetadataProfiles (name, release_type_policy)
    VALUES ('Artwork Test', '{}')
  `).run();
  if (options.libraryClass === "spatial") {
    db.prepare(`
      INSERT OR IGNORE INTO quality_profiles (
        name, cutoff, items, allowed_source_formats, preference_order
      ) VALUES ('Artwork Spatial', 'DOLBY_ATMOS', '["DOLBY_ATMOS"]', '["spatial"]', '["spatial"]')
    `).run();
  }
  const metadataProfile = db.prepare(`
    SELECT id FROM MetadataProfiles WHERE name = 'Artwork Test'
  `).get() as { id: number };
  const qualityProfile = db.prepare(`
    SELECT id
    FROM quality_profiles
    WHERE ${options.libraryClass === "spatial"
      ? "name = 'Artwork Spatial'"
      : "COALESCE(allowed_source_formats, '[]') NOT LIKE '%spatial%'"}
    ORDER BY id
    LIMIT 1
  `).get() as { id: number };
  const libraryName = `Artwork ${options.libraryClass} ${options.releaseGroupMbid}`;
  db.prepare(`
    INSERT OR IGNORE INTO Libraries (
      name, root_path, metadata_profile_id, quality_profile_id
    ) VALUES (?, ?, ?, ?)
  `).run(
    libraryName,
    path.join(tempDir, "libraries", options.libraryClass, options.releaseGroupMbid),
    metadataProfile.id,
    qualityProfile.id,
  );
  const library = db.prepare(`
    SELECT id FROM Libraries WHERE name = ?
  `).get(libraryName) as { id: number };
  db.prepare(`
    INSERT OR IGNORE INTO LibraryReleaseGroups (
      library_id, release_group_id, monitored, selection_mode, locked,
      reason, curation_version
    ) VALUES (?, ?, 1, 'auto', 0, 'test', 1)
  `).run(library.id, releaseGroup.id);
  db.prepare(`
    INSERT OR IGNORE INTO LibraryReleases (
      library_id, release_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'auto', 0, 'test', 1)
  `).run(library.id, release.id);
  const libraryRelease = db.prepare(`
    SELECT id FROM LibraryReleases WHERE library_id = ? AND release_id = ?
  `).get(library.id, release.id) as { id: number };
  const releaseMatch = db.prepare(`
    SELECT id
    FROM ProviderReleaseMatches
    WHERE provider_release_item_id = ? AND release_id = ?
  `).get(providerItem.id, release.id) as { id: number };
  db.prepare(`
    INSERT INTO AcquisitionPlans (
      library_release_id, provider, composition, download_mode, state,
      planner_version, policy_hash, computed_at
    ) VALUES (?, ?, 'single_source', 'album', 'current', 1, 'test', CURRENT_TIMESTAMP)
    ON CONFLICT(library_release_id) DO UPDATE SET
      provider = excluded.provider,
      state = 'current'
  `).run(libraryRelease.id, options.provider);
  const plan = db.prepare(`
    SELECT id FROM AcquisitionPlans WHERE library_release_id = ?
  `).get(libraryRelease.id) as { id: number };
  db.prepare("DELETE FROM AcquisitionPlanSources WHERE plan_id = ?").run(plan.id);
  db.prepare(`
    INSERT INTO AcquisitionPlanSources (
      plan_id, provider_release_match_id, role, sort_order
    ) VALUES (?, ?, 'primary', 0)
  `).run(plan.id, releaseMatch.id);
}

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

  assert.equal(
    artworkUrl,
    `/media-cover/Albums/${albumMbid}/cover.jpg?source=canonical&rev=${sourceRevision(remoteUrl)}`,
  );
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

test("response URL mapping performs no filesystem stat scans", () => {
  const originalStatSync = fs.statSync;
  let statCalls = 0;
  (fs as any).statSync = (...args: Parameters<typeof fs.statSync>) => {
    statCalls += 1;
    return originalStatSync(...args);
  };

  try {
    assert.equal(
      mediaCoverServiceModule.albumCoverLocalUrl({
        albumMbid: "stat-free-album",
        images: { images: [] },
      }),
      "/media-cover/Albums/stat-free-album/cover.jpg?source=canonical",
    );
    assert.equal(
      mediaCoverServiceModule.mapArtistArtworkToLocalUrl({
        artistMbid: "stat-free-artist",
        servarrMetadataData: { images: [] },
      }),
      "/media-cover/stat-free-artist/poster.jpg?source=canonical",
    );
    assert.equal(
      mediaCoverServiceModule.videoCoverLocalUrl("stat-free-video"),
      "/media-cover/Videos/stat-free-video/cover.jpg",
    );
    assert.equal(statCalls, 0);
  } finally {
    (fs as any).statSync = originalStatSync;
  }
});

test("local artwork revisions are stable for one normalized source and change with the source", () => {
  const albumMbid = "revisioned-album";
  const firstSource = "https://example.test/artwork/first.jpg";
  const secondSource = "https://example.test/artwork/second.jpg";
  const map = (source: string) => mediaCoverServiceModule.mapAlbumArtworkToLocalUrl({
    albumMbid,
    servarrMetadataData: {
      images: [{ coverType: "Cover", url: source }],
    },
  });

  const first = map(firstSource);
  assert.equal(first, map(firstSource));
  assert.notEqual(first, map(secondSource));
  assert.equal(
    first,
    `/media-cover/Albums/${albumMbid}/cover.jpg?source=canonical&rev=${sourceRevision(firstSource)}`,
  );
  assert.equal(
    mediaCoverServiceModule.videoCoverLocalUrl("revisioned-video", firstSource),
    `/media-cover/Videos/revisioned-video/cover.jpg?rev=${sourceRevision(firstSource)}`,
  );
});

test("media-cover entity ids reject dot traversal segments", () => {
  assert.equal(mediaCoverServiceModule.normalizeMediaCoverEntityId("."), null);
  assert.equal(mediaCoverServiceModule.normalizeMediaCoverEntityId(".."), null);
  assert.equal(
    mediaCoverServiceModule.getMediaCoverFilePathFromUrl(
      "/media-cover/Albums/%2e%2e/cover.jpg",
    ),
    null,
  );
  assert.equal(
    mediaCoverServiceModule.getMediaCoverFilePathFromUrl(
      "/media-cover/Videos/%2e%2e/cover.jpg",
    ),
    null,
  );
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

  assert.equal(
    artworkUrl,
    `/media-cover/Albums/${albumMbid}/cover.jpg?source=canonical&rev=${sourceRevision(servarrMetadataUrl)}`,
  );
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
  assert.equal(fs.existsSync(path.join(albumCache, "cover.jpg")), true);
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
      provider, entity_type, provider_id, title, cover_id
    ) VALUES (?, 'video', ?, ?, ?)
  `).run( "test-video-artwork-provider", "provider-video-id", "Video Title", "video-image-id" );

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
    size: "origin",
  }]);
  assert.deepEqual(fetchCalls, [providerUrl]);
  const videoCache = path.join(tempDir, "media-cover", "Videos", String(recording.id));
  assert.equal(fs.existsSync(path.join(videoCache, "cover.jpg")), true);
  assert.equal(fs.existsSync(path.join(videoCache, "cover-250.jpg")), true);
  assert.equal(fs.existsSync(path.join(videoCache, "cover-500.jpg")), false);
  assert.equal(
    mediaCoverServiceModule.videoCoverLocalUrl(recording.id),
    `/media-cover/Videos/${recording.id}/cover.jpg`,
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

test("ensureCachedMediaCover falls back to a lower-res YouTube thumbnail when hq720 404s", async () => {
  const videoId = "yt-fallback-video";
  const sourceUrl = "https://i.ytimg.com/vi/jZMTjKwOHWM/hq720.jpg";
  const image = jpeg.encode({
    width: 640,
    height: 480,
    data: Buffer.alloc(640 * 480 * 4, 120),
  }, 92).data;
  const requested: string[] = [];

  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = String(url);
    requested.push(href);
    if (/\/(hq720|maxresdefault)\.jpg/.test(href)) {
      return new Response("not found", { status: 404 });
    }
    if (/\/(sddefault|hqdefault)\.jpg/.test(href)) {
      return new Response(image, { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const cached = await mediaCoverServiceModule.ensureCachedMediaCover({
      entityId: videoId,
      coverEntity: "Video",
      coverType: "Cover",
      sourceUrl,
    });
    assert.equal(cached, `/media-cover/Videos/${videoId}/cover.jpg`);
    assert.ok(requested.some((href) => href.includes("/hq720.jpg")), "hq720 should be attempted first");
    assert.ok(requested.some((href) => href.includes("/sddefault.jpg")), "sddefault fallback should serve the bytes");

    const folder = path.join(tempDir, "media-cover", "Videos", videoId);
    assert.ok(fs.existsSync(path.join(folder, "cover.jpg")), "cover bytes are written via the fallback");

    // The source marker records the logical hq720 URL so a later request short-circuits.
    const marker = JSON.parse(fs.readFileSync(path.join(folder, ".cover.source.json"), "utf-8"));
    assert.equal(marker.url, sourceUrl);
  } finally {
    globalThis.fetch = originalFetch;
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
      provider, entity_type, provider_id, title
    ) VALUES (?, 'video', ?, ?)
  `).run( "test-video-provider-id-artwork-provider", "provider-video-without-image-id", "Provider Id Video" );

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
  assert.equal(fs.existsSync(path.join(tempDir, "media-cover", "Albums", albumMbid, "cover.jpg")), true);
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

test("canonical cache checks compare the selected source and isolate cover-type aliases", async () => {
  const albumMbid = "changed-canonical-source-album";
  const artistMbid = "cover-type-aware-artist";
  const oldUrl = "https://example.test/artwork/old-cover.jpg";
  const newUrl = "https://example.test/artwork/new-cover.jpg";
  const providerFanart = "https://provider.example/fanart.jpg";
  const bannerUrl = "https://example.test/artwork/banner.jpg";
  const landscapeUrl = "https://example.test/artwork/landscape.jpg";
  const albumFolder = path.join(tempDir, "media-cover", "Albums", albumMbid);
  const artistFolder = path.join(tempDir, "media-cover", artistMbid);

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name, images) VALUES (?, ?, ?)")
    .run(artistMbid, "Cover Type Artist", JSON.stringify([
      { coverType: "Banner", url: bannerUrl },
    ]));
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, images) VALUES (?, ?, ?, ?)")
    .run(albumMbid, artistMbid, "Changed Cover", JSON.stringify([
      { coverType: "Cover", url: newUrl },
    ]));
  fs.mkdirSync(albumFolder, { recursive: true });
  fs.writeFileSync(path.join(albumFolder, "cover-500.jpg"), Buffer.alloc(32, 1));
  fs.writeFileSync(
    path.join(albumFolder, ".cover.source.json"),
    JSON.stringify({ url: oldUrl, preference: "canonical", fulfilledBy: "canonical" }),
  );
  fs.mkdirSync(artistFolder, { recursive: true });
  fs.writeFileSync(path.join(artistFolder, "fanart-500.jpg"), Buffer.alloc(32, 1));
  fs.writeFileSync(
    path.join(artistFolder, ".fanart.source.json"),
    JSON.stringify({ url: providerFanart, preference: "canonical", fulfilledBy: "provider" }),
  );

  configModule.updateConfig("metadata", { artwork_preference: "canonical" });
  assert.equal(
    mediaCoverServiceModule.isArtworkPreferenceCacheCurrent(albumMbid, "Album", "Cover"),
    false,
    "a canonical URL change must make the marker stale",
  );
  assert.equal(
    mediaCoverServiceModule.isArtworkPreferenceCacheCurrent(artistMbid, "Artist", "Fanart"),
    true,
    "a Banner must not masquerade as requested Fanart",
  );

  dbModule.db.prepare("UPDATE ArtistMetadata SET images = ? WHERE mbid = ?")
    .run(JSON.stringify([{ coverType: "Landscape", url: landscapeUrl }]), artistMbid);
  assert.equal(
    mediaCoverServiceModule.isArtworkPreferenceCacheCurrent(artistMbid, "Artist", "Fanart"),
    false,
    "Landscape is an intentional Fanart alias",
  );

  fs.writeFileSync(path.join(artistFolder, "poster-500.jpg"), Buffer.alloc(32, 2));
  fs.writeFileSync(
    path.join(artistFolder, ".poster.source.json"),
    JSON.stringify({ url: providerFanart, preference: "canonical", fulfilledBy: "provider" }),
  );
  dbModule.db.prepare("UPDATE ArtistMetadata SET images = ? WHERE mbid = ?")
    .run(JSON.stringify([{ coverType: "Headshot", url: newUrl }]), artistMbid);
  assert.equal(
    mediaCoverServiceModule.isArtworkPreferenceCacheCurrent(artistMbid, "Artist", "Poster"),
    false,
    "Headshot is an intentional profile alias for Poster",
  );
});

test("normalized canonical sources do not create a permanent stale-marker loop", () => {
  const albumMbid = "normalized-canonical-marker-album";
  const artistMbid = "normalized-canonical-marker-artist";
  const rawUrl = "https://i.ytimg.com/vi/normalized-source/hq720.jpg?sqp=cropped";
  const normalizedUrl = "https://i.ytimg.com/vi/normalized-source/hq720.jpg";
  const folder = path.join(tempDir, "media-cover", "Albums", albumMbid);
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run(artistMbid, "Normalized Marker Artist");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, images) VALUES (?, ?, ?, ?)")
    .run(
      albumMbid,
      artistMbid,
      "Normalized Marker Album",
      JSON.stringify([{ coverType: "Cover", url: rawUrl }]),
    );
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "cover-500.jpg"), Buffer.alloc(32, 1));
  fs.writeFileSync(
    path.join(folder, ".cover.source.json"),
    JSON.stringify({ url: normalizedUrl, preference: "canonical", fulfilledBy: "canonical" }),
  );

  configModule.updateConfig("metadata", { artwork_preference: "canonical" });
  assert.equal(
    mediaCoverServiceModule.isArtworkPreferenceCacheCurrent(albumMbid, "Album", "Cover"),
    true,
  );
});

test("provider source changes invalidate markers, replace fallback evidence, and revise local URLs", async () => {
  const providerModule = await import("../providers/index.js");
  const providerId = "provider-artwork-source-change";
  const albumMbid = "provider-source-change-album";
  const artistMbid = "provider-source-change-artist";
  const oldUrl = "https://provider.example/artwork/old-provider-cover.jpg";
  const newUrl = "https://provider.example/artwork/new-provider-cover.jpg";
  const canonicalUrl = "https://example.test/artwork/provider-source-canonical.jpg";
  const folder = path.join(tempDir, "media-cover", "Albums", albumMbid);
  const image = jpeg.encode({
    width: 600,
    height: 600,
    data: Buffer.alloc(600 * 600 * 4, 199),
  }, 90).data;

  providerModule.streamingProviderManager.registerStreamingProvider({
    id: providerId,
    name: "Provider Artwork Source Change",
    capabilities: { artwork: true },
    getArtworkUrl: (request: any) => request.imageId || null,
  } as any);
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run(artistMbid, "Provider Source Change Artist");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, images) VALUES (?, ?, ?, ?)")
    .run(
      albumMbid,
      artistMbid,
      "Provider Source Change Album",
      JSON.stringify([
        { coverType: "Cover", url: canonicalUrl },
        { coverType: "Cover", url: oldUrl, source: "provider-fallback" },
      ]),
    );
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, cover_id
    ) VALUES (?, 'release', ?, ?)
  `).run( providerId, "provider-source-change-offer", newUrl );
  linkProviderArtworkCandidate({
    releaseGroupMbid: albumMbid,
    provider: providerId,
    providerId: "provider-source-change-offer",
    libraryClass: "stereo",
  });
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "cover-500.jpg"), Buffer.alloc(32, 1));
  fs.writeFileSync(
    path.join(folder, ".cover.source.json"),
    JSON.stringify({ url: oldUrl, preference: "provider", fulfilledBy: "provider" }),
  );

  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(image, {
    status: 200,
    headers: { "content-type": "image/jpeg" },
  })) as typeof fetch;
  configModule.updateConfig("metadata", { artwork_preference: "provider" });
  try {
    const tidalAssetId = "11111111-2222-3333-4444-555555555555";
    const tidalOrigin = "https://resources.tidal.com/images/11111111/2222/3333/4444/555555555555/origin.jpg";
    assert.equal(
      mediaCoverServiceModule.mapAlbumArtworkToLocalUrl({
        albumMbid: "raw-tidal-revision-album",
        providerCandidates: [{ provider: "tidal", imageId: tidalAssetId }],
      }),
      `/media-cover/Albums/raw-tidal-revision-album/cover.jpg?source=provider&rev=${sourceRevision(tidalOrigin)}`,
      "renderable provider asset ids must participate in the revision identity",
    );
    assert.equal(
      mediaCoverServiceModule.isArtworkPreferenceCacheCurrent(albumMbid, "Album", "Cover"),
      false,
      "the live provider asset must invalidate the old provider marker",
    );
    const candidates = mediaCoverServiceModule.loadAlbumProviderArtworkCandidates(albumMbid);
    assert.equal(
      mediaCoverServiceModule.albumCoverLocalUrl({
        albumMbid,
        images: {
          images: [
            { coverType: "Cover", url: canonicalUrl },
            { coverType: "Cover", url: oldUrl, source: "provider-fallback" } as any,
          ],
        },
        providerCandidates: candidates,
      }),
      `/media-cover/Albums/${albumMbid}/cover.jpg?source=provider&rev=${sourceRevision(newUrl)}`,
    );

    await mediaCoverServiceModule.resolveAlbumArtwork({ albumMbid });
    const stored = dbModule.db.prepare("SELECT images FROM Albums WHERE mbid = ?")
      .get(albumMbid) as { images: string };
    const storedImages = JSON.parse(stored.images);
    assert.equal(
      storedImages.some((entry: any) => entry.source === "provider-fallback" && entry.url === newUrl),
      true,
    );
    assert.equal(
      storedImages.some((entry: any) => entry.source === "provider-fallback" && entry.url === oldUrl),
      false,
    );
    assert.equal(
      mediaCoverServiceModule.isArtworkPreferenceCacheCurrent(albumMbid, "Album", "Cover"),
      true,
    );
  } finally {
    globalThis.fetch = priorFetch;
    configModule.updateConfig("metadata", { artwork_preference: "canonical" });
  }
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

  assert.equal(
    mediaCoverServiceModule.getServarrMetadataArtistImageUrl({
      Images: [
        { CoverType: "Banner", Url: bannerUrl, Width: 1381, Height: 575 },
        { CoverType: "Poster", Url: posterUrl, Width: 1000, Height: 1000 },
      ],
    }, ["Fanart", "Background", "Landscape"]),
    null,
    "missing Fanart must not fall back to an unrelated Banner or Poster",
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
      provider, entity_type, provider_id, cover_id, updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run( "priority-art-spotify", "artist", "spotify-artist-1", "spotify-pic", "2026-01-02T00:00:00Z" );
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, cover_id, updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run( "priority-art-tidal", "artist", "tidal-artist-1", "tidal-pic", "2026-01-01T00:00:00Z" );

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

test("album provider artwork candidates prefer nonspatial plans, then spatial plans, then other matches", () => {
  const { db } = dbModule;
  const albumMbid = "album-slot-art-mbid";
  const artistMbid = "album-slot-art-artist";

  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run(artistMbid, "Slot Art Artist");
  db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run(albumMbid, artistMbid, "Slot Art Album");

  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, cover_id, updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run( "tidal", "album", "stereo-album-1", "stereo-cover", "2026-01-01T00:00:00Z" );
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, cover_id, updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run( "spotify", "album", "spatial-album-1", "spatial-cover", "2026-01-02T00:00:00Z" );
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, cover_id, updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run( "apple-music", "album", "other-album-1", "other-cover", "2026-01-03T00:00:00Z" );

  linkProviderArtworkCandidate({
    releaseGroupMbid: albumMbid,
    provider: "tidal",
    providerId: "stereo-album-1",
    libraryClass: "stereo",
  });
  linkProviderArtworkCandidate({
    releaseGroupMbid: albumMbid,
    provider: "spotify",
    providerId: "spatial-album-1",
    libraryClass: "spatial",
  });
  linkProviderArtworkCandidate({
    releaseGroupMbid: albumMbid,
    provider: "apple-music",
    providerId: "other-album-1",
  });

  const withStereo = mediaCoverServiceModule.loadAlbumProviderArtworkCandidates(albumMbid);
  assert.deepEqual(
    withStereo.map((candidate) => ({ provider: candidate.provider, entityId: candidate.entityId, imageId: candidate.imageId })),
    [
      { provider: "tidal", entityId: "stereo-album-1", imageId: "stereo-cover" },
      { provider: "spotify", entityId: "spatial-album-1", imageId: "spatial-cover" },
      { provider: "apple-music", entityId: "other-album-1", imageId: "other-cover" },
    ],
  );

  db.prepare(`
    UPDATE AcquisitionPlans
    SET state = 'stale'
    WHERE id IN (
      SELECT plan.id
      FROM AcquisitionPlans plan
      JOIN LibraryReleases library_release ON library_release.id = plan.library_release_id
      JOIN Libraries library ON library.id = library_release.library_id
      WHERE library.name = ?
    )
  `).run(`Artwork stereo ${albumMbid}`);
  const spatialOnly = mediaCoverServiceModule.loadAlbumProviderArtworkCandidates(albumMbid);
  assert.equal(spatialOnly[0]?.provider, "spotify");
  assert.equal(spatialOnly[0]?.imageId, "spatial-cover");
});

test("Bad Blood artwork ranks the title-close accepted release ahead of another edition", () => {
  const { db } = dbModule;
  const albumMbid = "bf37b1a0-d94f-4230-b2c7-09b17f9f8a68";
  const artistMbid = "7808accb-6395-4b25-858c-678bbb73896b";
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run(artistMbid, "Bastille");
  db.prepare("INSERT INTO Albums (mbid, artist_mbid, title) VALUES (?, ?, ?)")
    .run(albumMbid, artistMbid, "Bad Blood");
  const insert = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid,
      title, asset_id, match_confidence
    ) VALUES ('apple-music', 'album', ?, ?, ?, ?, ?, 1)
  `);
  insert.run("1705033078", artistMbid, albumMbid, "Pompeii MMXXIII", "pompeii-cover");
  insert.run(
    "1710633308",
    artistMbid,
    albumMbid,
    "Bad Blood X (10th Anniversary Edition)",
    "bad-blood-cover",
  );
  linkProviderArtworkCandidate({
    releaseGroupMbid: albumMbid,
    provider: "apple-music",
    providerId: "1705033078",
  });
  linkProviderArtworkCandidate({
    releaseGroupMbid: albumMbid,
    provider: "apple-music",
    providerId: "1710633308",
  });

  const candidates = mediaCoverServiceModule.loadAlbumProviderArtworkCandidates(albumMbid);
  assert.equal(candidates[0]?.entityId, "1710633308");
  assert.equal(candidates[0]?.imageId, "bad-blood-cover");
  assert.equal(candidates[1]?.entityId, "1705033078");
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

test("unsupported WebP masters are retained even when proxies cannot be decoded", async () => {
  const albumMbid = "webp-master-retention-album";
  const sourceUrl = "https://example.test/master.webp";
  const bytes = Buffer.from("RIFF0000WEBPVP8 unsupported-fixture", "utf8");
  globalThis.fetch = (async () => new Response(bytes, {
    status: 200,
    headers: { "content-type": "image/webp" },
  })) as typeof fetch;
  try {
    const localUrl = await mediaCoverServiceModule.ensureCachedMediaCover({
      entityId: albumMbid,
      coverEntity: "Album",
      coverType: "Cover",
      sourceUrl,
      fulfilledBy: "canonical",
    });
    assert.equal(localUrl, `/media-cover/Albums/${albumMbid}/cover.webp`);
    const master = path.join(tempDir, "media-cover", "Albums", albumMbid, "cover.webp");
    assert.deepEqual(fs.readFileSync(master), bytes);
    assert.equal(fs.existsSync(path.join(path.dirname(master), "cover-500.jpg")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cached sidecar sync replaces equal-length wrong artwork using SHA-256", () => {
  const albumMbid = "equal-size-sidecar-album";
  const folder = path.join(tempDir, "media-cover", "Albums", albumMbid);
  const sidecar = path.join(tempDir, "library", albumMbid, "cover.jpg");
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  fs.writeFileSync(path.join(folder, "cover.jpg"), Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(sidecar, Buffer.from([4, 3, 2, 1]));

  assert.equal(
    mediaCoverServiceModule.syncCachedMediaCoverToFile({
      entityId: albumMbid,
      coverEntity: "Album",
      coverTypes: "cover",
      outputPath: sidecar,
    }),
    "written",
  );
  assert.deepEqual(fs.readFileSync(sidecar), Buffer.from([1, 2, 3, 4]));
  assert.equal(
    mediaCoverServiceModule.syncCachedMediaCoverToFile({
      entityId: albumMbid,
      coverEntity: "Album",
      coverTypes: "cover",
      outputPath: sidecar,
    }),
    "unchanged",
  );
});

test("cached sidecar sync preserves the prior file when atomic replacement fails", () => {
  const albumMbid = "failed-atomic-sidecar-album";
  const folder = path.join(tempDir, "media-cover", "Albums", albumMbid);
  const sidecarFolder = path.join(tempDir, "library", albumMbid);
  const sidecar = path.join(sidecarFolder, "cover.jpg");
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(sidecarFolder, { recursive: true });
  fs.writeFileSync(path.join(folder, "cover.jpg"), Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(sidecar, Buffer.from([4, 3, 2, 1]));

  const originalRenameSync = fs.renameSync;
  fs.renameSync = (() => {
    throw new Error("simulated atomic replacement failure");
  }) as typeof fs.renameSync;
  try {
    assert.throws(
      () => mediaCoverServiceModule.syncCachedMediaCoverToFile({
        entityId: albumMbid,
        coverEntity: "Album",
        coverTypes: "cover",
        outputPath: sidecar,
      }),
      /simulated atomic replacement failure/,
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.deepEqual(fs.readFileSync(sidecar), Buffer.from([4, 3, 2, 1]));
  assert.deepEqual(
    fs.readdirSync(sidecarFolder).filter((name) => name.endsWith(".tmp")),
    [],
  );
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
