import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { enableVideoLibraryForTests, seedLibraryArtistMonitoring } from "../../test-support/active-schema-fixture.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-repeated-failures-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.repeated-failures.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.DISCOGENIUS_DOWNLOAD_SAME_OFFER_ATTEMPTS = "3";
process.env.DISCOGENIUS_DOWNLOAD_SAME_OFFER_BACKOFF_MS = "0";
process.env.DISCOGENIUS_OFFER_FAILURE_THRESHOLD = "3";

const databaseModule = await import("../../database.js");
databaseModule.initDatabase();
const { db } = databaseModule;
const configModule = await import("../config/config.js");
configModule.updateConfig("filtering", { include_videos: true });
enableVideoLibraryForTests(db);
await import("../providers/index.js");

const { DownloadProcessor } = await import("./download-processor.js");
const { downloadBackendRegistry } = await import("./download-backend.js");
const { ProviderUnavailableError } = await import("./provider-unavailable-error.js");
const { AppleMusicBackend } = await import("../providers/apple-music/apple-music-backend.js");
const { YtDlpBackend } = await import("../providers/youtube-music/yt-dlp-backend.js");
const {
  clearYouTubeMusicCredentials,
  saveYouTubeMusicCredentials,
} = await import("../providers/youtube-music/youtube-music-auth.js");
const { DownloadMissingService } = await import("../music/download-missing-service.js");
const { resolvePreferredVideoOffer } = await import("../music/video-offer-resolver.js");
const { listRankedVideoOffers } = await import("./download-offer-fallback.js");
const {
  clearAcquisitionPlanningRevision,
  getPendingAcquisitionPlanningRevision,
} = await import("../music/acquisition-planning-control.js");

function resetPlanningStale(): void {
  const rev = getPendingAcquisitionPlanningRevision();
  if (rev) clearAcquisitionPlanningRevision(rev);
}
const { presentFailure } = await import("../commands/failure-presentation.js");
const { providerNeedsReauth, recordProviderAuthOk } = await import("../providers/provider-auth-state.js");

after(() => {
  clearYouTubeMusicCredentials();
  databaseModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createMockAppleProcess(stdoutLines: string[], exitCode: number) {
  const cp = new EventEmitter() as any;
  cp.stdout = new PassThrough();
  cp.stderr = new PassThrough();
  cp.killed = false;
  cp.kill = () => {
    cp.killed = true;
    return true;
  };
  queueMicrotask(() => {
    for (const line of stdoutLines) {
      cp.stdout.write(`${line}\n`);
    }
    cp.stdout.end();
    cp.stderr.end();
    cp.emit("close", exitCode);
  });
  return cp;
}

function createMockYtDlpProcess(stderr: string, exitCode: number) {
  const cp = new EventEmitter() as any;
  cp.stdout = new PassThrough();
  cp.stderr = new PassThrough();
  cp.kill = () => true;
  queueMicrotask(() => {
    if (stderr) cp.stderr.write(stderr);
    cp.stdout.end();
    cp.stderr.end();
    cp.emit("close", exitCode);
  });
  return cp;
}

function activeEntry(provider: string, type: "album" | "track" | "video", providerId: string) {
  return {
    provider,
    type,
    providerId,
    workerId: "repeated-failures-test",
    abortController: new AbortController(),
    cancelRequested: false,
  };
}

test("Apple exit-0 'Failed to get album response.' counts as a failure and marks the offer unavailable on the 3rd identical failure", async () => {
  resetPlanningStale();
  db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability)
    VALUES ('apple-music', 'release', '1121490551', 'Braver Than We Are', 'available')
  `).run();

  downloadBackendRegistry.register(new AppleMusicBackend({
    preflight: async () => {},
    loadToken: () => ({ media_user_token: "test-token", storefront: "us" }),
    syncToken: () => {},
    getAlbumTracks: async () => [],
    spawn: () => createMockAppleProcess([
      "Queue 1 of 1: Album",
      "Failed to get album response.",
      "Failed to rip album: empty response",
    ], 0),
    countMediaFiles: () => 0,
  }));

  const processor = new DownloadProcessor() as any;
  const runOnce = (commandId: number) => processor.downloadItem(
    commandId,
    "1121490551",
    "album",
    {
      provider: "apple-music",
      providerId: "1121490551",
      type: "album",
      title: "Braver Than We Are",
      artist: "Meat Loaf",
    },
    activeEntry("apple-music", "album", "1121490551"),
  );

  try {
    // 1st failure: fails, stays available
    await assert.rejects(() => runOnce(96001), /Failed to get album response/);
    let row = db.prepare(`
      SELECT availability, availability_reason FROM ProviderItems
      WHERE provider = 'apple-music' AND entity_type = 'release' AND provider_id = '1121490551'
    `).get() as { availability: string; availability_reason: string | null };
    assert.equal(row.availability, "available");
    assert.equal(getPendingAcquisitionPlanningRevision(), null);

    // 2nd identical failure: still stays available
    await assert.rejects(() => runOnce(96002), /Failed to get album response/);
    row = db.prepare(`
      SELECT availability, availability_reason FROM ProviderItems
      WHERE provider = 'apple-music' AND entity_type = 'release' AND provider_id = '1121490551'
    `).get() as { availability: string; availability_reason: string | null };
    assert.equal(row.availability, "available");
    assert.equal(getPendingAcquisitionPlanningRevision(), null);

    // 3rd identical failure: marked unavailable and planning goes stale
    await assert.rejects(() => runOnce(96003), /Failed to get album response/);
    row = db.prepare(`
      SELECT availability, availability_reason FROM ProviderItems
      WHERE provider = 'apple-music' AND entity_type = 'release' AND provider_id = '1121490551'
    `).get() as { availability: string; availability_reason: string | null };
    assert.equal(row.availability, "unavailable");
    assert.match(String(row.availability_reason), /Failed to get album response/);
    assert.notEqual(getPendingAcquisitionPlanningRevision(), null);
  } finally {
    clearInterval(processor.progressFlushTimer);
    processor.progressBuffer?.clear();
  }
});

test("transient network failures do not mark an offer unavailable even after 3 consecutive failures, and success resets a failure streak", async () => {
  resetPlanningStale();
  db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability)
    VALUES
      ('apple-music', 'release', '674064561', 'Christmas', 'available'),
      ('apple-music', 'release', '674064562', 'Transient Album', 'available')
  `).run();

  let failAlbumResponse = true;
  downloadBackendRegistry.register({
    id: "apple-music-downloader",
    supportedProviders: ["apple-music"],
    capabilities: ["stereo"],
    async download(request) {
      if (request.providerId === "674064562") {
        throw new Error("ETIMEDOUT");
      }
      if (failAlbumResponse) {
        throw new Error("apple-music-downloader exited with code 0: Failed to get album response.");
      }
    },
  });

  const processor = new DownloadProcessor() as any;
  try {
    // 3 transient network failures must never mark the offer unavailable
    for (const commandId of [96101, 96102, 96103]) {
      await assert.rejects(
        () => processor.downloadItem(
          commandId,
          "674064562",
          "album",
          { provider: "apple-music", providerId: "674064562", type: "album", title: "Transient Album" },
          activeEntry("apple-music", "album", "674064562"),
        ),
        /ETIMEDOUT/,
      );
    }
    const transientRow = db.prepare(`
      SELECT availability FROM ProviderItems
      WHERE provider = 'apple-music' AND entity_type = 'release' AND provider_id = '674064562'
    `).get() as { availability: string };
    assert.equal(transientRow.availability, "available");

    // 2 identical failures, then 1 success, then 1 failure -> streak reset, still available
    await assert.rejects(
      () => processor.downloadItem(
        96104,
        "674064561",
        "album",
        { provider: "apple-music", providerId: "674064561", type: "album", title: "Christmas" },
        activeEntry("apple-music", "album", "674064561"),
      ),
      /Failed to get album response/,
    );
    await assert.rejects(
      () => processor.downloadItem(
        96105,
        "674064561",
        "album",
        { provider: "apple-music", providerId: "674064561", type: "album", title: "Christmas" },
        activeEntry("apple-music", "album", "674064561"),
      ),
      /Failed to get album response/,
    );

    failAlbumResponse = false;
    await processor.downloadItem(
      96106,
      "674064561",
      "album",
      { provider: "apple-music", providerId: "674064561", type: "album", title: "Christmas" },
      activeEntry("apple-music", "album", "674064561"),
    );

    failAlbumResponse = true;
    await assert.rejects(
      () => processor.downloadItem(
        96107,
        "674064561",
        "album",
        { provider: "apple-music", providerId: "674064561", type: "album", title: "Christmas" },
        activeEntry("apple-music", "album", "674064561"),
      ),
      /Failed to get album response/,
    );
    const resetRow = db.prepare(`
      SELECT availability FROM ProviderItems
      WHERE provider = 'apple-music' AND entity_type = 'release' AND provider_id = '674064561'
    `).get() as { availability: string };
    assert.equal(resetRow.availability, "available");
  } finally {
    clearInterval(processor.progressFlushTimer);
    processor.progressBuffer?.clear();
  }
});

test("age-restricted YouTube video is marked needs_cookies and skipped until YouTube cookies are configured", async () => {
  clearYouTubeMusicCredentials();
  resetPlanningStale();

  db.prepare(`INSERT INTO ArtistMetadata (mbid, name) VALUES ('artist-yt-age', 'King Dark')`).run();
  seedLibraryArtistMonitoring(db, "artist-yt-age");
  const video = db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, length_ms, is_video, metadata_status)
    VALUES ('rec-yt-age', 'artist-yt-age', 'Twilight Zone', 240000, 1, 'musicbrainz')
    RETURNING id
  `).get() as { id: number };
  const providerItem = db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, video_quality, availability)
    VALUES ('youtube-music', 'video', 'wIaaBuGNwNw', 'Twilight Zone', 'FHD', 'available')
    RETURNING id
  `).get() as { id: number };
  db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'accepted', 'automatic', 1, 'test', 1)
  `).run(providerItem.id, video.id);
  const videoLibrary = db.prepare(`SELECT id FROM Libraries WHERE name = 'Video'`).get() as { id: number };
  db.prepare(`
    INSERT INTO LibraryVideos (library_id, video_recording_id, selection_mode)
    VALUES (?, ?, 'auto')
  `).run(videoLibrary.id, video.id);

  let ytRuns = 0;
  downloadBackendRegistry.register(new YtDlpBackend({
    spawnImpl: () => {
      ytRuns += 1;
      return createMockYtDlpProcess(
        "ERROR: [youtube] wIaaBuGNwNw: Sign in to confirm your age. Use --cookies-from-browser or --cookies for the authentication.\n",
        1,
      );
    },
    mediaFileFinder: async () => [],
  }));

  const processor = new DownloadProcessor() as any;
  try {
    await assert.rejects(
      () => processor.downloadItem(
        96201,
        "wIaaBuGNwNw",
        "video",
        {
          provider: "youtube-music",
          providerId: "wIaaBuGNwNw",
          type: "video",
          canonicalRecordingId: String(video.id),
          canonicalRecordingMbid: "rec-yt-age",
          title: "Twilight Zone",
          artist: "King Dark",
        },
        activeEntry("youtube-music", "video", "wIaaBuGNwNw"),
      ),
      (error: unknown) => error instanceof ProviderUnavailableError && error.availability === "needs_cookies",
    );

    assert.equal(ytRuns, 1, "age-gated YouTube video without cookies gets no same-offer retries");
    const itemRow = db.prepare(`
      SELECT availability, availability_reason FROM ProviderItems
      WHERE provider = 'youtube-music' AND entity_type = 'video' AND provider_id = 'wIaaBuGNwNw'
    `).get() as { availability: string; availability_reason: string | null };
    assert.equal(itemRow.availability, "needs_cookies");
    assert.match(String(itemRow.availability_reason), /Sign in to confirm your age/i);
    assert.notEqual(getPendingAcquisitionPlanningRevision(), null);

    // Without cookies configured, DownloadMissing and offer resolvers skip it
    const withoutCookies = await DownloadMissingService.queueMonitoredItems();
    assert.equal(withoutCookies.videos, 0, "age-restricted video must be skipped when cookies are not configured");
    assert.equal(resolvePreferredVideoOffer(String(video.id)), null);
    assert.deepEqual(listRankedVideoOffers(String(video.id)), []);

    // Once YouTube cookies are configured, it becomes eligible again
    saveYouTubeMusicCredentials({ cookies: "SID=test-sid; HSID=test-hsid" });
    assert.equal(resolvePreferredVideoOffer(String(video.id))?.providerId, "wIaaBuGNwNw");
    assert.equal(listRankedVideoOffers(String(video.id)).length, 1);
    const withCookies = await DownloadMissingService.queueMonitoredItems();
    assert.equal(withCookies.videos, 1, "age-restricted video must be queued once cookies are configured");

    // With cookies configured, an age-gate error is NOT silently turned into needs_cookies
    const backendWithCookies = new YtDlpBackend({
      spawnImpl: () => createMockYtDlpProcess(
        "ERROR: [youtube] wIaaBuGNwNw: Sign in to confirm your age. This video may be inappropriate for some users.\n",
        1,
      ),
      mediaFileFinder: async () => [],
    });
    const withCookiesError = await backendWithCookies.download(
      {
        provider: "youtube-music",
        entityType: "video",
        providerId: "wIaaBuGNwNw",
        downloadPath: path.join(tempDir, "yt-with-cookies"),
      },
      { onProgress: () => {} },
    ).then(() => null, (err: unknown) => err);
    assert.equal(withCookiesError instanceof ProviderUnavailableError, false);
  } finally {
    clearYouTubeMusicCredentials();
    clearInterval(processor.progressFlushTimer);
    processor.progressBuffer?.clear();
  }
});

test("a failed bundled music video inside an Apple Music album download does not fail the album and blames media-user-token", async () => {
  await recordProviderAuthOk("apple-music", { force: true });
  const albumOutput = [
    "Track 1 of 2: songs",
    "6836780775",
    "Downloading 6836780775",
    "Downloaded",
    "Decrypted",
    "Track 2 of 2: music-videos",
    "⚠ Failed to dl MV: media-user-token may wrong or expired",
    "=======  [✔ ] Completed: 1/2  |  [⚠ ] Warnings: 0  |  [✖ ] Errors: 1  =======",
    "Error detected, exiting...",
  ];

  let spawnedProcess: any = null;
  const progressEvents: any[] = [];
  const backend = new AppleMusicBackend({
    preflight: async () => {},
    loadToken: () => ({ media_user_token: "expired-token", storefront: "us" }),
    syncToken: () => {},
    getAlbumTracks: async () => [{ id: "6836780775" }],
    spawn: () => {
      spawnedProcess = createMockAppleProcess(albumOutput, 1);
      return spawnedProcess;
    },
    countMediaFiles: () => 1,
  });

  await backend.download(
    {
      provider: "apple-music",
      entityType: "album",
      providerId: "6836780774",
      trackIds: ["6836780775"],
      downloadPath: path.join(tempDir, "apple-ozzy-album"),
    },
    { onProgress: (event) => progressEvents.push(event) },
  );

  assert.equal(spawnedProcess?.killed, false, "embedded MV failure must not kill the album download");
  assert.equal(providerNeedsReauth("apple-music"), false, "embedded MV token failure must not hold audio downloads");

  const finalProgress = progressEvents.at(-1);
  assert.equal(finalProgress?.outcome, "completedWithWarning");
  assert.match(String(finalProgress?.warningMessage), /media-user-token/i);
  assert.match(String(finalProgress?.warningMessage), /missing or expired/i);

  // Standalone MV download still fails with an explicit media-user-token message
  const standaloneMvBackend = new AppleMusicBackend({
    preflight: async () => {},
    loadToken: () => ({ media_user_token: "expired-token", storefront: "us" }),
    syncToken: () => {},
    spawn: () => createMockAppleProcess([
      "Queue 1 of 1: Music Video",
      "⚠ Failed to dl MV: media-user-token may wrong or expired",
      "=======  [✔ ] Completed: 0/1  |  [⚠ ] Warnings: 0  |  [✖ ] Errors: 1  =======",
    ], 1),
    countMediaFiles: () => 0,
  });
  const mvError = await standaloneMvBackend.download(
    {
      provider: "apple-music",
      entityType: "video",
      providerId: "6836780799",
      downloadPath: path.join(tempDir, "apple-standalone-mv"),
    },
    { onProgress: () => {} },
  ).then(() => null, (err: unknown) => err) as Error | null;
  assert.ok(mvError instanceof Error);
  assert.match(mvError.message, /media-user-token/i);
  assert.match(mvError.message, /missing or expired/i);
  assert.doesNotMatch(mvError.message, /decryption wrapper/i);
  assert.equal(presentFailure(mvError.message, { provider: "apple-music" })?.category, "account");
});

test("repeated failure on a fallback provider marks the fallback ProviderItems row unavailable and DownloadMissing skips unavailable videos", async () => {
  resetPlanningStale();
  db.prepare(`INSERT INTO ArtistMetadata (mbid, name) VALUES ('artist-cher', 'Cher')`).run();
  seedLibraryArtistMonitoring(db, "artist-cher");
  const artist = db.prepare(`SELECT id FROM ArtistMetadata WHERE mbid = 'artist-cher'`).get() as { id: number };
  const album = db.prepare(`
    INSERT INTO Albums (mbid, artist_metadata_id, artist_mbid, title)
    VALUES ('rg-cher-xmas', ?, 'artist-cher', 'Christmas')
    RETURNING id
  `).get(artist.id) as { id: number };
  const edition = db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_id, release_group_mbid, artist_metadata_id, artist_mbid, title)
    VALUES ('rel-cher-xmas', ?, 'rg-cher-xmas', ?, 'artist-cher', 'Christmas')
    RETURNING id
  `).get(album.id, artist.id) as { id: number };

  const deezerItem = db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability)
    VALUES ('deezer', 'release', 'dz-cher-1', 'Christmas', 'available')
    RETURNING id
  `).get() as { id: number };
  const appleItem = db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability)
    VALUES ('apple-music', 'release', '674064561-fb', 'Christmas', 'available')
    RETURNING id
  `).get() as { id: number };
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (provider_item_id, variant_key, quality_class, availability)
    VALUES (?, 'lossless', 'lossless', 'available'), (?, 'lossless', 'lossless', 'available')
  `).run(deezerItem.id, appleItem.id);
  db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, match_state, decision_source,
      relation, confidence, method, matcher_version
    ) VALUES
      (?, ?, 'accepted', 'automatic', 'exact', 1, 'test', 1),
      (?, ?, 'accepted', 'automatic', 'exact', 1, 'test', 1)
  `).run(deezerItem.id, edition.id, appleItem.id, edition.id);

  downloadBackendRegistry.register({
    id: "streamrip-deezer",
    supportedProviders: ["deezer"],
    capabilities: ["stereo"],
    async download() {
      throw new Error("ETIMEDOUT");
    },
  });
  downloadBackendRegistry.register(new AppleMusicBackend({
    preflight: async () => {},
    loadToken: () => ({ media_user_token: "test-token", storefront: "us" }),
    syncToken: () => {},
    getAlbumTracks: async () => [],
    spawn: () => createMockAppleProcess([
      "Queue 1 of 1: Album",
      "Failed to get album response.",
    ], 0),
    countMediaFiles: () => 0,
  }));

  const processor = new DownloadProcessor() as any;
  try {
    for (const commandId of [96301, 96302, 96303]) {
      await assert.rejects(
        () => processor.downloadItem(
          commandId,
          "dz-cher-1",
          "album",
          {
            provider: "deezer",
            providerId: "dz-cher-1",
            releaseGroupMbid: "rg-cher-xmas",
            type: "album",
            title: "Christmas",
            artist: "Cher",
          },
          activeEntry("deezer", "album", "dz-cher-1"),
        ),
        /Failed to get album response/,
      );
    }

    const appleRow = db.prepare(`
      SELECT availability FROM ProviderItems WHERE id = ?
    `).get(appleItem.id) as { availability: string };
    const deezerRow = db.prepare(`
      SELECT availability FROM ProviderItems WHERE id = ?
    `).get(deezerItem.id) as { availability: string };
    assert.equal(appleRow.availability, "unavailable", "fallback Apple offer must be marked unavailable after 3 identical failures");
    assert.equal(deezerRow.availability, "available", "primary Deezer offer that only timed out stays available");

    // Verify DownloadMissingService skips videos marked unavailable
    const unavailableVideo = db.prepare(`
      INSERT INTO Recordings (mbid, artist_mbid, title, length_ms, is_video, metadata_status)
      VALUES ('rec-cher-removed-vid', 'artist-cher', 'Removed Video', 180000, 1, 'musicbrainz')
      RETURNING id
    `).get() as { id: number };
    const unavailableProviderVideo = db.prepare(`
      INSERT INTO ProviderItems (provider, entity_type, provider_id, title, video_quality, availability)
      VALUES ('youtube-music', 'video', 'KLW0TLSmdr4', 'Removed Video', 'FHD', 'unavailable')
      RETURNING id
    `).get() as { id: number };
    db.prepare(`
      INSERT INTO ProviderVideoMatches (
        provider_video_item_id, recording_id, match_state, decision_source,
        confidence, method, matcher_version
      ) VALUES (?, ?, 'accepted', 'automatic', 1, 'test', 1)
    `).run(unavailableProviderVideo.id, unavailableVideo.id);
    const videoLibrary = db.prepare(`SELECT id FROM Libraries WHERE name = 'Video'`).get() as { id: number };
    db.prepare(`
      INSERT INTO LibraryVideos (library_id, video_recording_id, selection_mode)
      VALUES (?, ?, 'auto')
    `).run(videoLibrary.id, unavailableVideo.id);

    const missing = await DownloadMissingService.queueMonitoredItems(String(artist.id));
    assert.equal(missing.videos, 0, "DownloadMissing must skip videos marked unavailable");
  } finally {
    clearInterval(processor.progressFlushTimer);
    processor.progressBuffer?.clear();
  }
});
