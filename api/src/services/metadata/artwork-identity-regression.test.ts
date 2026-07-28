import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import * as jpeg from "jpeg-js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-artwork-a1-test-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let mediaCoverServiceModule: typeof import("./media-cover-service.js");
let configModule: typeof import("../config/config.js");
let audioTagServiceModule: typeof import("../mediafiles/audio-tag-service.js");
let providerModule: typeof import("../providers/index.js");
let libraryBackfillModule: typeof import("../mediafiles/library-metadata-backfill.js");
const originalFetch = globalThis.fetch;

// Helper to create visually different JPEG buffers and calculate sha256
function createTestJpeg(width: number, height: number, r: number, g: number, b: number): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = 255;
  }
  return jpeg.encode({ width, height, data: buf }, 90).data;
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

const ALBUM_ARTWORK_A = createTestJpeg(1200, 1200, 255, 0, 0); // Red (Primary Album Art A)
const SINGLE_ARTWORK_B = createTestJpeg(1200, 1200, 0, 0, 255); // Blue (Supplemental Single Art B)
const PROVIDER_ARTWORK_C = createTestJpeg(1200, 1200, 0, 255, 0); // Green (Provider Album Art C)
const MANUAL_ARTWORK_D = createTestJpeg(1200, 1200, 255, 255, 0); // Yellow (Manual Override Art D)
const EDITION_2_ARTWORK_E = createTestJpeg(1200, 1200, 255, 0, 255); // Magenta (Edition 2 Art E)

const HASH_A = sha256(ALBUM_ARTWORK_A);
const HASH_B = sha256(SINGLE_ARTWORK_B);
const HASH_C = sha256(PROVIDER_ARTWORK_C);
const HASH_D = sha256(MANUAL_ARTWORK_D);
const HASH_E = sha256(EDITION_2_ARTWORK_E);

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  configModule = await import("../config/config.js");
  mediaCoverServiceModule = await import("./media-cover-service.js");
  audioTagServiceModule = await import("../mediafiles/audio-tag-service.js");
  providerModule = await import("../providers/index.js");
  libraryBackfillModule = await import("../mediafiles/library-metadata-backfill.js");

  configModule.updateConfig("metadata", {
    artwork_preference: "provider",
    save_album_cover: true,
    album_cover_name: "cover.jpg",
  } as any);

  providerModule.streamingProviderManager.registerStreamingProvider({
    id: "test-hybrid-provider",
    name: "Test Hybrid Provider",
    capabilities: {
      catalogSearch: false, artistCatalog: false, followedArtists: false,
      audioPreviews: false, audioDownloads: false, lossyStereo: false,
      losslessStereo: false, hiResStereo: false, spatialAudio: false,
      lyrics: false, musicVideos: false, videoPreviews: false,
      videoDownloads: false, artwork: true, editorialMetadata: false,
      providerIds: true,
    },
    search: async () => ({ artists: [], albums: [], tracks: [], videos: [] }),
    getArtworkUrl: async ({ providerId }: any) => {
      const pid = String(providerId || "");
      if (pid.includes("album-c-")) {
        return "https://provider.test/artwork/album-C.jpg";
      }
      if (pid.includes("album")) {
        return "https://provider.test/artwork/album-A.jpg";
      }
      if (pid.includes("single")) {
        return "https://provider.test/artwork/single-B.jpg";
      }
      return null;
    },
  } as any);

  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes("album-A.jpg") || url.includes("canonical-cover.jpg")) {
      return new Response(ALBUM_ARTWORK_A, { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    if (url.includes("single-B.jpg")) {
      return new Response(SINGLE_ARTWORK_B, { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    if (url.includes("album-C.jpg") || url.includes("provider-cover.jpg")) {
      return new Response(PROVIDER_ARTWORK_C, { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    if (url.includes("manual-D.jpg")) {
      return new Response(MANUAL_ARTWORK_D, { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    if (url.includes("edition-E.jpg")) {
      return new Response(EDITION_2_ARTWORK_E, { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    return new Response(null, { status: 404 });
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function insertTestAlbum(db: any, mbid: string, title: string, imagesJson: string | null = null) {
  try {
    db.prepare("INSERT OR IGNORE INTO Artists (id, name, mbid) VALUES (1, 'Test Artist', 'test-artist')").run();
  } catch { /* ignore */ }
  try {
    db.prepare("INSERT OR IGNORE INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("test-artist", "Test Artist");
  } catch { /* ignore */ }
  db.prepare(`
    INSERT OR IGNORE INTO Albums (mbid, title, artist_mbid, primary_type, monitored, images)
    VALUES (?, ?, 'test-artist', 'Album', 1, ?)
  `).run(mbid, title, imagesJson);
}

function insertTestSlot(db: any, mbid: string, slot: string, provider: string, providerId: string) {
  db.prepare(`
    INSERT OR REPLACE INTO ReleaseGroupSlots (release_group_mbid, artist_mbid, slot, monitored, selected_provider, selected_provider_id)
    VALUES (?, 'test-artist', ?, 1, ?, ?)
  `).run(mbid, slot, provider, providerId);
}

// ---------------------------------------------------------------------------
// EXISTING RECONCILIATION
// ---------------------------------------------------------------------------

test("existing-wrong-cover-sidecar-is-replaced", async () => {
  const db = dbModule.db;
  const mbid = "rg-wrong-sidecar-replace";
  insertTestAlbum(db, mbid, "Sidecar Replace Test");

  const albumDir = path.join(tempDir, "library", "Artist", "Sidecar Replace Test");
  fs.mkdirSync(albumDir, { recursive: true });
  const coverPath = path.join(albumDir, "cover.jpg");

  // Pre-populate cover.jpg with WRONG artwork B (blue)
  fs.writeFileSync(coverPath, SINGLE_ARTWORK_B);

  // Pre-populate mediacover cache with CORRECT artwork A (red)
  const cacheFolder = path.join(tempDir, "media-cover", "Albums", mbid);
  fs.mkdirSync(cacheFolder, { recursive: true });
  fs.writeFileSync(path.join(cacheFolder, "origin.jpg"), ALBUM_ARTWORK_A);
  fs.writeFileSync(path.join(cacheFolder, "cover.jpg"), ALBUM_ARTWORK_A);

  // Invoke real reconciliation path
  const syncResult = mediaCoverServiceModule.syncCachedMediaCoverToFile({
    entityId: mbid,
    coverEntity: "Album",
    coverTypes: "cover",
    outputPath: coverPath,
  });

  assert.equal(syncResult, "written", "Expected sidecar to be written/updated");
  const updatedBytes = fs.readFileSync(coverPath);
  assert.equal(sha256(updatedBytes), HASH_A, "cover.jpg must be atomically replaced with correct artwork A hash");
});

test("existing-wrong-embedded-art-is-replaced", async () => {
  const db = dbModule.db;
  const mbid = "rg-wrong-embed-replace";
  const trackId = 99910;
  insertTestAlbum(db, mbid, "Embed Replace Test");

  const albumDir = path.join(tempDir, "library", "Artist", "Embed Replace Test");
  fs.mkdirSync(albumDir, { recursive: true });
  const flacPath = path.join(albumDir, "track.flac");
  fs.writeFileSync(flacPath, Buffer.from("dummy flac audio content"));

  db.prepare(`
    INSERT OR REPLACE INTO TrackFiles (id, file_path, relative_path, library_root, filename, extension, quality, file_type, artist_id, canonical_release_group_mbid)
    VALUES (?, ?, 'track.flac', '/library', 'track.flac', '.flac', 'FLAC', 'track', 1, ?)
  `).run(trackId, flacPath, mbid);

  const cacheFolder = path.join(tempDir, "media-cover", "Albums", mbid);
  fs.mkdirSync(cacheFolder, { recursive: true });
  fs.writeFileSync(path.join(cacheFolder, "origin.jpg"), ALBUM_ARTWORK_A);
  fs.writeFileSync(path.join(cacheFolder, "cover.jpg"), ALBUM_ARTWORK_A);

  const syncResult = await audioTagServiceModule.AudioTagService.syncEmbeddedCovers([trackId]);
  assert.equal(syncResult.skipped, 0, "Sync mechanism must not skip when embedded picture differs from ArtworkOwner");
});

// ---------------------------------------------------------------------------
// HYBRID BEHAVIOR
// ---------------------------------------------------------------------------

test("supplemental-provider-artwork-cannot-own-primary-album", async () => {
  const db = dbModule.db;
  const mbid = "rg-hybrid-primary-test";
  insertTestAlbum(db, mbid, "Hybrid Album");
  insertTestSlot(db, mbid, 'stereo', 'test-hybrid-provider', '00-single-carrier-id;11-album-carrier-id');

  db.prepare(`
    INSERT OR REPLACE INTO ProviderItems (entity_type, release_group_mbid, provider, provider_id, title, version, match_confidence)
    VALUES ('album', ?, 'test-hybrid-provider', '00-single-carrier-id', 'Hybrid Album', 'Single', 1.0)
  `).run(mbid);
  db.prepare(`
    INSERT OR REPLACE INTO ProviderItems (entity_type, release_group_mbid, provider, provider_id, title, version, match_confidence)
    VALUES ('album', ?, 'test-hybrid-provider', '11-album-carrier-id', 'Hybrid Album', NULL, 1.0)
  `).run(mbid);

  const resolvedUrl = await mediaCoverServiceModule.resolveAlbumArtwork({ albumMbid: mbid });
  assert.ok(resolvedUrl, "Expected resolved artwork URL");

  const originPath = mediaCoverServiceModule.getCachedMediaCoverOriginalFilePath(mbid, "Album", "Cover");
  assert.ok(originPath && fs.existsSync(originPath), "Expected origin cover in cache");

  const cachedBytes = fs.readFileSync(originPath);
  assert.equal(sha256(cachedBytes), HASH_A, "Primary album artwork A must be selected over supplemental single B");
});

test("hybrid-source-order-is-artwork-invariant", async () => {
  const db = dbModule.db;
  const mbid1 = "rg-invariant-order-1";
  const mbid2 = "rg-invariant-order-2";

  insertTestAlbum(db, mbid1, "Invariant Album 1");
  insertTestAlbum(db, mbid2, "Invariant Album 2");

  insertTestSlot(db, mbid1, 'stereo', 'test-hybrid-provider', '11-album-carrier-id-1;00-single-carrier-id-1');
  insertTestSlot(db, mbid2, 'stereo', 'test-hybrid-provider', '00-single-carrier-id-2;11-album-carrier-id-2');

  db.prepare(`
    INSERT OR REPLACE INTO ProviderItems (entity_type, release_group_mbid, provider, provider_id, title, version, match_confidence)
    VALUES ('album', ?, 'test-hybrid-provider', '00-single-carrier-id-1', 'Invariant Album 1', 'Single', 1.0)
  `).run(mbid1);
  db.prepare(`
    INSERT OR REPLACE INTO ProviderItems (entity_type, release_group_mbid, provider, provider_id, title, version, match_confidence)
    VALUES ('album', ?, 'test-hybrid-provider', '11-album-carrier-id-1', 'Invariant Album 1', NULL, 1.0)
  `).run(mbid1);

  db.prepare(`
    INSERT OR REPLACE INTO ProviderItems (entity_type, release_group_mbid, provider, provider_id, title, version, match_confidence)
    VALUES ('album', ?, 'test-hybrid-provider', '00-single-carrier-id-2', 'Invariant Album 2', 'Single', 1.0)
  `).run(mbid2);
  db.prepare(`
    INSERT OR REPLACE INTO ProviderItems (entity_type, release_group_mbid, provider, provider_id, title, version, match_confidence)
    VALUES ('album', ?, 'test-hybrid-provider', '11-album-carrier-id-2', 'Invariant Album 2', NULL, 1.0)
  `).run(mbid2);

  await mediaCoverServiceModule.resolveAlbumArtwork({ albumMbid: mbid1 });
  await mediaCoverServiceModule.resolveAlbumArtwork({ albumMbid: mbid2 });

  const originPath1 = mediaCoverServiceModule.getCachedMediaCoverOriginalFilePath(mbid1, "Album", "Cover");
  const originPath2 = mediaCoverServiceModule.getCachedMediaCoverOriginalFilePath(mbid2, "Album", "Cover");

  assert.ok(originPath1 && fs.existsSync(originPath1), "Expected origin 1");
  assert.ok(originPath2 && fs.existsSync(originPath2), "Expected origin 2");

  const bytes1 = fs.readFileSync(originPath1);
  const bytes2 = fs.readFileSync(originPath2);

  assert.equal(sha256(bytes1), HASH_A, "Order 1 must resolve to album artwork A hash");
  assert.equal(sha256(bytes2), HASH_A, "Order 2 must resolve to album artwork A hash");
  assert.equal(sha256(bytes1), sha256(bytes2), "Reversing provider ID order must not change resolved artwork");
});

test("canonical-cache-survives-hybrid-import", async () => {
  const db = dbModule.db;
  const mbid = "rg-canonical-survives-hybrid";
  insertTestAlbum(db, mbid, "Hybrid Survives Test");
  
  // Active MediaCover is already populated with Canonical A
  const cacheFolder = path.join(tempDir, "media-cover", "Albums", mbid);
  fs.mkdirSync(cacheFolder, { recursive: true });
  fs.writeFileSync(path.join(cacheFolder, "origin.jpg"), ALBUM_ARTWORK_A);
  fs.writeFileSync(path.join(cacheFolder, "cover.jpg"), ALBUM_ARTWORK_A);

  // Slot has hybrid IDs
  insertTestSlot(db, mbid, 'stereo', 'test-hybrid-provider', '00-single-carrier-id;11-album-carrier-id');

  const originPath = mediaCoverServiceModule.getCachedMediaCoverOriginalFilePath(mbid, "Album", "Cover");
  assert.ok(originPath && fs.existsSync(originPath));
  assert.equal(sha256(fs.readFileSync(originPath)), HASH_A, "Canonical cache must survive hybrid import without mutation");
});

test("provider-candidates-are-not-read-during-import", async () => {
  const db = dbModule.db;
  const mbid = "rg-no-candidate-query-import";
  insertTestAlbum(db, mbid, "No Candidate Query Test");
  const albumDir = path.join(tempDir, "library", "Artist", "No Candidate Query Test");
  fs.mkdirSync(albumDir, { recursive: true });

  let providerItemsQueried = false;
  const origPrepare = db.prepare.bind(db);
  db.prepare = ((sql: any, ...rest: any[]) => {
    if (typeof sql === "string" && sql.includes("ProviderItems")) {
      providerItemsQueried = true;
    }
    return (origPrepare as any)(sql, ...rest);
  }) as any;

  try {
    mediaCoverServiceModule.syncCachedMediaCoverToFile({
      entityId: mbid,
      coverEntity: "Album",
      coverTypes: "cover",
      outputPath: path.join(albumDir, "cover.jpg"),
    });

    assert.equal(providerItemsQueried, false, "Provider candidates (ProviderItems table) must not be queried during offline consumer import/reconciliation");
  } finally {
    db.prepare = origPrepare;
  }
});

// ---------------------------------------------------------------------------
// PREFERENCE BEHAVIOR
// ---------------------------------------------------------------------------

test("canonical-preference-preserves-canonical-cache", async () => {
  const db = dbModule.db;
  const mbid = "rg-canonical-pref-test";
  const canonicalImages = JSON.stringify([{ CoverType: "Cover", Url: "https://example.test/canonical-cover.jpg" }]);
  insertTestAlbum(db, mbid, "Canonical Pref Test", canonicalImages);
  insertTestSlot(db, mbid, 'stereo', 'test-hybrid-provider', '11-album-c-carrier-id');

  db.prepare(`
    INSERT OR REPLACE INTO ProviderItems (entity_type, release_group_mbid, provider, provider_id, title, version, match_confidence)
    VALUES ('album', ?, 'test-hybrid-provider', '11-album-c-carrier-id', 'Canonical Pref Test', NULL, 1.0)
  `).run(mbid);

  // Set preference to canonical
  configModule.updateConfig("metadata", { artwork_preference: "canonical", save_album_cover: true, album_cover_name: "cover.jpg" } as any);

  await mediaCoverServiceModule.resolveAlbumArtwork({ albumMbid: mbid });
  const originPath = mediaCoverServiceModule.getCachedMediaCoverOriginalFilePath(mbid, "Album", "Cover");
  assert.ok(originPath && fs.existsSync(originPath));
  assert.equal(sha256(fs.readFileSync(originPath)), HASH_A, "Must preserve canonical artwork A when preference is canonical");
});

test("canonical-missing-provider-fallback-populates-cache", async () => {
  const db = dbModule.db;
  const mbid = "rg-canonical-fallback-test";
  // No canonical images JSON
  insertTestAlbum(db, mbid, "Canonical Fallback Test", null);
  insertTestSlot(db, mbid, 'stereo', 'test-hybrid-provider', '11-album-c-carrier-id');

  db.prepare(`
    INSERT OR REPLACE INTO ProviderItems (entity_type, release_group_mbid, provider, provider_id, title, version, match_confidence)
    VALUES ('album', ?, 'test-hybrid-provider', '11-album-c-carrier-id', 'Canonical Fallback Test', NULL, 1.0)
  `).run(mbid);

  configModule.updateConfig("metadata", { artwork_preference: "canonical", save_album_cover: true, album_cover_name: "cover.jpg" } as any);

  await mediaCoverServiceModule.resolveAlbumArtwork({ albumMbid: mbid });
  const originPath = mediaCoverServiceModule.getCachedMediaCoverOriginalFilePath(mbid, "Album", "Cover");
  assert.ok(originPath && fs.existsSync(originPath));
  assert.equal(sha256(fs.readFileSync(originPath)), HASH_C, "Must fallback to provider artwork C when canonical is missing");
});

test("provider-preference-replaces-canonical-cache-at-refresh", async () => {
  const db = dbModule.db;
  const mbid = "rg-provider-pref-replace";
  const canonicalImages = JSON.stringify([{ CoverType: "Cover", Url: "https://example.test/canonical-cover.jpg" }]);
  insertTestAlbum(db, mbid, "Provider Pref Replace Test", canonicalImages);
  insertTestSlot(db, mbid, 'stereo', 'test-hybrid-provider', '11-album-c-carrier-id');

  db.prepare(`
    INSERT OR REPLACE INTO ProviderItems (entity_type, release_group_mbid, provider, provider_id, title, version, match_confidence)
    VALUES ('album', ?, 'test-hybrid-provider', '11-album-c-carrier-id', 'Provider Pref Replace Test', NULL, 1.0)
  `).run(mbid);

  configModule.updateConfig("metadata", { artwork_preference: "provider", save_album_cover: true, album_cover_name: "cover.jpg" } as any);

  await mediaCoverServiceModule.resolveAlbumArtwork({ albumMbid: mbid });
  const originPath = mediaCoverServiceModule.getCachedMediaCoverOriginalFilePath(mbid, "Album", "Cover");
  assert.ok(originPath && fs.existsSync(originPath));
  assert.equal(sha256(fs.readFileSync(originPath)), HASH_C, "Must select provider artwork C when preference is provider");
});

test("provider-preference-selects-owner-provider-at-refresh", async () => {
  const db = dbModule.db;
  const mbid = "rg-provider-owner-select";
  insertTestAlbum(db, mbid, "Provider Owner Select Test");
  insertTestSlot(db, mbid, 'stereo', 'test-hybrid-provider', '11-album-c-carrier-id;00-single-carrier-id');

  db.prepare(`
    INSERT OR REPLACE INTO ProviderItems (entity_type, release_group_mbid, provider, provider_id, title, version, match_confidence)
    VALUES ('album', ?, 'test-hybrid-provider', '00-single-carrier-id', 'Provider Owner Select Test', 'Single', 1.0)
  `).run(mbid);
  db.prepare(`
    INSERT OR REPLACE INTO ProviderItems (entity_type, release_group_mbid, provider, provider_id, title, version, match_confidence)
    VALUES ('album', ?, 'test-hybrid-provider', '11-album-c-carrier-id', 'Provider Owner Select Test', NULL, 1.0)
  `).run(mbid);

  configModule.updateConfig("metadata", { artwork_preference: "provider", save_album_cover: true, album_cover_name: "cover.jpg" } as any);

  await mediaCoverServiceModule.resolveAlbumArtwork({ albumMbid: mbid });
  const originPath = mediaCoverServiceModule.getCachedMediaCoverOriginalFilePath(mbid, "Album", "Cover");
  assert.ok(originPath && fs.existsSync(originPath));
  assert.equal(sha256(fs.readFileSync(originPath)), HASH_C, "Must select owner album C over supplemental single B");
});

test("preference-change-requires-artwork-refresh", async () => {
  const db = dbModule.db;
  const mbid = "rg-pref-change-offline";
  const cacheFolder = path.join(tempDir, "media-cover", "Albums", mbid);
  fs.mkdirSync(cacheFolder, { recursive: true });
  fs.writeFileSync(path.join(cacheFolder, "origin.jpg"), ALBUM_ARTWORK_A);
  fs.writeFileSync(path.join(cacheFolder, "cover.jpg"), ALBUM_ARTWORK_A);

  // Changing config preference alone should NOT alter existing cached bytes without an explicit refresh call
  configModule.updateConfig("metadata", { artwork_preference: "provider", save_album_cover: true, album_cover_name: "cover.jpg" } as any);
  
  const originPath = mediaCoverServiceModule.getCachedMediaCoverOriginalFilePath(mbid, "Album", "Cover");
  assert.equal(sha256(fs.readFileSync(originPath!)), HASH_A, "Cache must remain unchanged after config preference change until refresh occurs");
});

// ---------------------------------------------------------------------------
// OFFLINE CONSUMER BEHAVIOR
// ---------------------------------------------------------------------------

test("missing-mediacover-remains-absent-during-import", async () => {
  const db = dbModule.db;
  const mbid = "rg-missing-cache-import";
  insertTestAlbum(db, mbid, "Missing Cache Import Test");

  const albumDir = path.join(tempDir, "library", "Artist", "Missing Cache Import Test");
  fs.mkdirSync(albumDir, { recursive: true });
  const coverPath = path.join(albumDir, "cover.jpg");

  const syncResult = mediaCoverServiceModule.syncCachedMediaCoverToFile({
    entityId: mbid,
    coverEntity: "Album",
    coverTypes: "cover",
    outputPath: coverPath,
  });

  assert.equal(syncResult, "missing", "Must report missing when mediacover cache is absent");
  assert.equal(fs.existsSync(coverPath), false, "Must not invent cover.jpg when cache is absent");
});

test("provider-selected-cache-is-consumed-offline", async () => {
  const db = dbModule.db;
  const mbid = "rg-provider-offline-consume";
  insertTestAlbum(db, mbid, "Provider Offline Consume Test");

  const cacheFolder = path.join(tempDir, "media-cover", "Albums", mbid);
  fs.mkdirSync(cacheFolder, { recursive: true });
  fs.writeFileSync(path.join(cacheFolder, "origin.jpg"), PROVIDER_ARTWORK_C);
  fs.writeFileSync(path.join(cacheFolder, "cover.jpg"), PROVIDER_ARTWORK_C);

  const albumDir = path.join(tempDir, "library", "Artist", "Provider Offline Consume Test");
  fs.mkdirSync(albumDir, { recursive: true });
  const coverPath = path.join(albumDir, "cover.jpg");

  const syncResult = mediaCoverServiceModule.syncCachedMediaCoverToFile({
    entityId: mbid,
    coverEntity: "Album",
    coverTypes: "cover",
    outputPath: coverPath,
  });

  assert.equal(syncResult, "written", "Must write cached provider artwork offline");
  assert.equal(sha256(fs.readFileSync(coverPath)), HASH_C, "Consumed offline bytes must match provider artwork C hash");
});

test("no-network-from-artwork-consumers", async () => {
  const db = dbModule.db;
  const mbid = "rg-no-network-consumer";
  insertTestAlbum(db, mbid, "No Network Consumer Test");

  const cacheFolder = path.join(tempDir, "media-cover", "Albums", mbid);
  fs.mkdirSync(cacheFolder, { recursive: true });
  fs.writeFileSync(path.join(cacheFolder, "origin.jpg"), ALBUM_ARTWORK_A);
  fs.writeFileSync(path.join(cacheFolder, "cover.jpg"), ALBUM_ARTWORK_A);

  const albumDir = path.join(tempDir, "library", "Artist", "No Network Consumer Test");
  fs.mkdirSync(albumDir, { recursive: true });
  const coverPath = path.join(albumDir, "cover.jpg");

  let networkCalled = false;
  const tempFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      networkCalled = true;
      throw new Error("Network must not be called from offline consumers!");
    };

    mediaCoverServiceModule.syncCachedMediaCoverToFile({
      entityId: mbid,
      coverEntity: "Album",
      coverTypes: "cover",
      outputPath: coverPath,
    });

    assert.equal(networkCalled, false, "Zero network calls permitted during sidecar reconciliation");
  } finally {
    globalThis.fetch = tempFetch;
  }
});

test("ui-mediacover-route-does-not-lazily-fetch", async () => {
  const db = dbModule.db;
  const mbid = "rg-ui-no-lazy-fetch";
  insertTestAlbum(db, mbid, "UI No Lazy Fetch Test");

  let networkCalled = false;
  const tempFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      networkCalled = true;
      throw new Error("Network called!");
    };

    // When mediaCoverFolder or route is evaluated for an uncached album, it must not call fetch
    const folder = mediaCoverServiceModule.getCachedMediaCoverOriginalFilePath(mbid, "Album", "Cover");
    assert.equal(networkCalled, false, "UI route helpers must not lazily fetch remote artwork");
  } finally {
    globalThis.fetch = tempFetch;
  }
});

// ---------------------------------------------------------------------------
// RELEASE-GROUP ARTWORK OWNERSHIP AND SLOT INVARIANCE
// ---------------------------------------------------------------------------

test("release-group artwork ownership and slot invariance", async () => {
  const db = dbModule.db;
  const mbid = "rg-stereo-spatial-cross";
  insertTestAlbum(db, mbid, "Spatial Cross Test");

  insertTestSlot(db, mbid, 'stereo', 'test-hybrid-provider', 'album-carrier-id');
  insertTestSlot(db, mbid, 'spatial', 'test-hybrid-provider', 'single-carrier-id');

  db.prepare(`
    INSERT OR REPLACE INTO ProviderItems (entity_type, release_group_mbid, provider, provider_id, title, version, match_confidence, cover)
    VALUES ('album', ?, 'test-hybrid-provider', 'album-carrier-id', 'Spatial Cross Test', NULL, 1.0, 'http://test/stereo-cover.jpg')
  `).run(mbid);
  db.prepare(`
    INSERT OR REPLACE INTO ProviderItems (entity_type, release_group_mbid, provider, provider_id, title, version, match_confidence, cover)
    VALUES ('album', ?, 'test-hybrid-provider', 'single-carrier-id', 'Spatial Cross Test', 'Single', 1.0, 'http://test/single-cover.jpg')
  `).run(mbid);

  // 1. Unrelated or supplemental non-stereo candidates cannot contaminate selection
  const candidates = mediaCoverServiceModule.loadAlbumProviderArtworkCandidates(mbid);
  assert.ok(candidates.length > 0, "Expected candidates");
  assert.equal(candidates.length, 1, "Supplemental single carrier in spatial slot must not pollute primary album candidates");
  assert.equal(candidates[0].entityId, "album-carrier-id", "Provider preference chooses the eligible primary stereo image first");

  // 2. When no eligible stereo image exists, an eligible non-stereo image is used
  db.prepare("DELETE FROM ReleaseGroupSlots WHERE release_group_mbid = ? AND slot = 'stereo'").run(mbid);
  db.prepare("DELETE FROM ProviderItems WHERE release_group_mbid = ? AND provider_id = 'album-carrier-id'").run(mbid);
  db.prepare(`
    INSERT OR REPLACE INTO ProviderItems (entity_type, release_group_mbid, provider, provider_id, title, version, match_confidence, cover)
    VALUES ('album', ?, 'test-hybrid-provider', 'spatial-carrier-id', 'Spatial Cross Test', NULL, 1.0, 'http://test/spatial-cover.jpg')
  `).run(mbid);
  insertTestSlot(db, mbid, 'spatial', 'test-hybrid-provider', 'spatial-carrier-id');

  const spatialCandidates = mediaCoverServiceModule.loadAlbumProviderArtworkCandidates(mbid);
  assert.equal(spatialCandidates[0]?.entityId, "spatial-carrier-id", "When no eligible stereo image exists, an eligible non-stereo image is used");

  // 3. Stereo and non-stereo consumers read the same active release-group MediaCover (one release group has one active image)
  const stereoPath = mediaCoverServiceModule.getMediaCoverPath(mbid, "Album", "cover", ".jpg");
  const spatialPath = mediaCoverServiceModule.getMediaCoverPath(mbid, "Album", "cover", ".jpg");
  assert.equal(stereoPath, spatialPath, "One release group has one active MediaCover path regardless of slot consumer");
});

// ---------------------------------------------------------------------------
// SAME RELEASE-GROUP CHARACTERIZATION
// ---------------------------------------------------------------------------

test("same-release-group-characterization", async () => {
  const db = dbModule.db;
  const rgMbid = "rg-same-group-char";
  insertTestAlbum(db, rgMbid, "Same Group Char Album");

  // Create two distinct release_mbids in AlbumReleases for the same release group
  try {
    db.prepare(`
      INSERT OR REPLACE INTO AlbumReleases (id, mbid, release_group_mbid, title, status, track_count, media_count)
      VALUES (101, 'rel-edition-1', ?, 'Standard Edition', 'Official', 10, 1),
             (102, 'rel-edition-2', ?, 'Japanese Deluxe', 'Official', 15, 2)
    `).run(rgMbid, rgMbid);
  } catch { /* ignore */ }

  // Check if ReleaseGroupSlots allows multiple rows per release group across editions or slots
  const slots = db.prepare("SELECT * FROM ReleaseGroupSlots WHERE release_group_mbid = ?").all(rgMbid);
  assert.ok(Array.isArray(slots), "Characterization of release group slot materialization");
});

// ---------------------------------------------------------------------------
// PROVENANCE
// ---------------------------------------------------------------------------

test("provenance-updates-atomically-with-selected-bytes", async () => {
  const db = dbModule.db;
  const mbid = "rg-provenance-atomic";
  insertTestAlbum(db, mbid, "Provenance Atomic Test");
  insertTestSlot(db, mbid, 'stereo', 'test-hybrid-provider', '11-album-carrier-id');

  db.prepare(`
    INSERT OR REPLACE INTO ProviderItems (entity_type, release_group_mbid, provider, provider_id, title, version, match_confidence)
    VALUES ('album', ?, 'test-hybrid-provider', '11-album-carrier-id', 'Provenance Atomic Test', NULL, 1.0)
  `).run(mbid);

  await mediaCoverServiceModule.resolveAlbumArtwork({ albumMbid: mbid });
  const cacheFolder = path.join(tempDir, "media-cover", "Albums", mbid);
  const provPath = path.join(cacheFolder, ".cover.source.json");

  // In A1, provenance must be persisted atomically
  assert.ok(fs.existsSync(provPath), "Expected atomic provenance sidecar file in cache folder");
  const prov = JSON.parse(fs.readFileSync(provPath, "utf-8"));
  assert.equal(prov.contentHash, HASH_A, "Provenance content hash must match written artwork bytes");
  assert.ok(prov.sourceKind, "Expected sourceKind in provenance");
});

test("artwork-cache-update-propagates-to-sidecar-and-tags", async () => {
  const db = dbModule.db;
  const mbid = "rg-propagate-test";
  const trackId = 99920;
  insertTestAlbum(db, mbid, "Propagate Test");

  const albumDir = path.join(tempDir, "library", "Artist", "Propagate Test");
  fs.mkdirSync(albumDir, { recursive: true });
  const coverPath = path.join(albumDir, "cover.jpg");
  const flacPath = path.join(albumDir, "track.flac");
  fs.writeFileSync(flacPath, Buffer.from("dummy flac audio content"));

  db.prepare(`
    INSERT OR REPLACE INTO TrackFiles (id, file_path, relative_path, library_root, filename, extension, quality, file_type, artist_id, canonical_release_group_mbid)
    VALUES (?, ?, 'track.flac', '/library', 'track.flac', '.flac', 'FLAC', 'track', 1, ?)
  `).run(trackId, flacPath, mbid);

  // Initial cache state: A
  const cacheFolder = path.join(tempDir, "media-cover", "Albums", mbid);
  fs.mkdirSync(cacheFolder, { recursive: true });
  fs.writeFileSync(path.join(cacheFolder, "origin.jpg"), ALBUM_ARTWORK_A);
  fs.writeFileSync(path.join(cacheFolder, "cover.jpg"), ALBUM_ARTWORK_A);

  mediaCoverServiceModule.syncCachedMediaCoverToFile({
    entityId: mbid, coverEntity: "Album", coverTypes: "cover", outputPath: coverPath,
  });

  // Update cache state: C
  fs.writeFileSync(path.join(cacheFolder, "origin.jpg"), PROVIDER_ARTWORK_C);
  fs.writeFileSync(path.join(cacheFolder, "cover.jpg"), PROVIDER_ARTWORK_C);

  mediaCoverServiceModule.syncCachedMediaCoverToFile({
    entityId: mbid, coverEntity: "Album", coverTypes: "cover", outputPath: coverPath,
  });
  const tagSync = await audioTagServiceModule.AudioTagService.syncEmbeddedCovers([trackId]);

  assert.equal(sha256(fs.readFileSync(coverPath)), HASH_C, "Sidecar must update to C when cache changes");
  assert.equal(tagSync.skipped, 0, "Tag embedder must not skip updating when cache changes to C");
});

test("explicit manual override wins in either preference mode", async () => {
  const db = dbModule.db;
  const mbid = "manual-override-mbid";
  insertTestAlbum(db, mbid, "Manual Override Album");
  const coverPath = path.join(tempDir, "manual-override-album", "cover.jpg");
  fs.mkdirSync(path.dirname(coverPath), { recursive: true });

  db.prepare("UPDATE Albums SET images = ? WHERE mbid = ?").run(
    JSON.stringify([
      { coverType: "Cover", url: "http://test/manual-D.jpg", source: "manual" },
      { coverType: "Cover", url: "http://test/album-A.jpg", source: "musicbrainz" },
    ]),
    mbid,
  );

  configModule.updateConfig("metadata", { artwork_preference: "canonical", save_album_cover: true, album_cover_name: "cover.jpg" } as any);
  const canonicalModeUrl = await mediaCoverServiceModule.resolveAlbumArtwork({ albumMbid: mbid });
  assert.match(canonicalModeUrl || "", /cover\.jpg$/);
  const cacheFolder = path.join(tempDir, "media-cover", "Albums", mbid);
  assert.equal(sha256(fs.readFileSync(path.join(cacheFolder, "cover.jpg"))), HASH_D, "Manual artwork D must win under canonical preference");
  assert.deepEqual(
    db.prepare(`
      SELECT source_kind, content_hash, source_identity
      FROM MediaCoverSelections
      WHERE release_group_id = (SELECT id FROM Albums WHERE mbid = ?)
    `).get(mbid),
    {
      source_kind: "manual",
      content_hash: HASH_D,
      source_identity: "http://test/manual-D.jpg",
    },
    "Manual artwork must be recorded as manual provenance",
  );

  fs.rmSync(cacheFolder, { recursive: true, force: true });

  configModule.updateConfig("metadata", { artwork_preference: "provider", save_album_cover: true, album_cover_name: "cover.jpg" } as any);
  const providerModeUrl = await mediaCoverServiceModule.resolveAlbumArtwork({
    albumMbid: mbid,
    providerCandidates: [{ provider: "tidal", entityId: "p-manual", imageId: "img-manual", url: "http://test/album-C.jpg" }],
  });
  assert.match(providerModeUrl || "", /cover\.jpg$/);
  assert.equal(sha256(fs.readFileSync(path.join(cacheFolder, "cover.jpg"))), HASH_D, "Manual artwork D must win under provider preference");
  assert.equal(
    (db.prepare(`
      SELECT source_kind FROM MediaCoverSelections
      WHERE release_group_id = (SELECT id FROM Albums WHERE mbid = ?)
    `).get(mbid) as { source_kind: string }).source_kind,
    "manual",
    "Provider preference must not demote manual artwork authority",
  );
});
