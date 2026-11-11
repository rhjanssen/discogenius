import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-timeout-test-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.timeout.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.DISCOGENIUS_DOWNLOAD_SAME_OFFER_ATTEMPTS = "3";
process.env.DISCOGENIUS_DOWNLOAD_SAME_OFFER_BACKOFF_MS = "0";

const databaseModule = await import("../../database.js");
databaseModule.initDatabase();
const { db } = databaseModule;
const { DownloadProcessor } = await import("./download-processor.js");
const { downloadBackendRegistry } = await import("./download-backend.js");
const { streamingProviderManager } = await import("../../providers/index.js");
const { CommandQueueManager } = await import("../commands/command-queue-manager.js");

function registerProvider(id: string): void {
  if ([...streamingProviderManager.getAllStreamingProviders()].some((provider) => provider.id === id)) return;
  streamingProviderManager.registerStreamingProvider({
    id,
    name: id,
    capabilities: {},
  } as never);
}

function entryFor(provider: string) {
  return {
    provider,
    type: "album" as const,
    providerId: "album-timeout-1",
    workerId: "timeout-test",
    abortController: new AbortController(),
    cancelRequested: false,
  };
}

function seedAlbumAndOffers(input: {
  artistId: number;
  artistMbid: string;
  artistName: string;
  albumId: number;
  albumMbid: string;
  albumTitle: string;
  provider: string;
  tracks: Array<{
    id: number;
    mbid: string;
    title: string;
    providerTrackId: string;
    trackNum: number;
  }>;
}) {
  registerProvider(input.provider);
  db.prepare("INSERT OR REPLACE INTO ArtistMetadata (id, mbid, name) VALUES (?, ?, ?)").run(
    input.artistId,
    input.artistMbid,
    input.artistName,
  );
  db.prepare("INSERT OR REPLACE INTO Albums (id, mbid, title, artist_mbid, primary_type) VALUES (?, ?, ?, ?, 'Album')").run(
    input.albumId,
    input.albumMbid,
    input.albumTitle,
    input.artistMbid,
  );
  db.prepare(`
    INSERT OR REPLACE INTO AlbumEditions (id, mbid, release_group_id, title, release_group_mbid, artist_mbid)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.albumId,
    `edition-${input.albumMbid}`,
    input.albumId,
    input.albumTitle,
    input.albumMbid,
    input.artistMbid,
  );

  for (const t of input.tracks) {
    db.prepare("INSERT OR REPLACE INTO Recordings (id, mbid, title, length_ms, is_video) VALUES (?, ?, ?, 180000, 0)").run(
      t.id,
      `rec-${t.mbid}`,
      t.title,
    );
    db.prepare(`
      INSERT OR REPLACE INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title, release_mbid, recording_mbid)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      t.id,
      t.mbid,
      input.albumId,
      t.id,
      t.trackNum,
      t.title,
      `edition-${input.albumMbid}`,
      `rec-${t.mbid}`,
    );

    const itemId = 1000 + t.id;
    db.prepare(`
      INSERT OR REPLACE INTO ProviderItems (id, provider, entity_type, provider_id, title, availability)
      VALUES (?, ?, 'track', ?, ?, 'available')
    `).run(itemId, input.provider, t.providerTrackId, t.title);

    db.prepare(`
      INSERT OR REPLACE INTO ProviderTrackMatches (
        id, provider_track_item_id, recording_id, track_id, match_state,
        decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, ?, ?, 'accepted', 'automatic', 1, 'fixture', 5)
    `).run(itemId, itemId, t.id, t.id);

    db.prepare(`
      INSERT OR REPLACE INTO ProviderItemAudioVariants (
        id, provider_item_id, variant_key, quality_class, availability
      ) VALUES (?, ?, 'lossless', 'lossless', 'available')
    `).run(itemId, itemId);
  }
}

test("mid-album abort-timeout retries and then completes (#108)", async () => {
  const tracks = [
    { id: 101, mbid: "armstrong-track-1", title: "When the Saints Go Marching In", providerTrackId: "tidal-track-101", trackNum: 1 },
    { id: 102, mbid: "armstrong-track-2", title: "Mack the Knife", providerTrackId: "tidal-track-102", trackNum: 2 },
    { id: 103, mbid: "armstrong-track-3", title: "Ain't Misbehavin'", providerTrackId: "tidal-track-103", trackNum: 3 },
  ];

  seedAlbumAndOffers({
    artistId: 10,
    artistMbid: "artist-armstrong-1",
    artistName: "Louis Armstrong",
    albumId: 100,
    albumMbid: "album-armstrong-1",
    albumTitle: "Best of Armstrong",
    provider: "tidal",
    tracks,
  });

  const downloadedTracks: string[] = [];
  let track2Attempts = 0;

  downloadBackendRegistry.register({
    id: "tiddl",
    supportedProviders: ["tidal"],
    capabilities: ["stereo"],
    async preflight() {},
    async download(request) {
      if (request.providerId === "tidal-track-102") {
        track2Attempts += 1;
        if (track2Attempts === 1) {
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }
      }
      downloadedTracks.push(request.providerId);
      fs.writeFileSync(path.join(request.downloadPath, `${request.providerId}.flac`), "mock-flac-data");
    },
  });

  const commandId = 96001;
  const trackOffers = tracks.map((t) => ({
    provider: "tidal",
    providerTrackId: t.providerTrackId,
    canonicalTrackMbid: t.mbid,
    canonicalRecordingMbid: `rec-${t.mbid}`,
    title: t.title,
  }));

  db.prepare(`
    INSERT INTO commands (id, name, payload, status, worker_id)
    VALUES (?, 'DownloadAlbum', ?, 'started', 'timeout-test')
  `).run(commandId, JSON.stringify({
    provider: "tidal",
    providerId: "tidal-album-1",
    type: "album",
    acquisitionMode: "trackOffers",
    title: "Best of Armstrong",
    artist: "Louis Armstrong",
    trackOffers,
  }));

  const processor = new DownloadProcessor() as any;
  const progressEmissions: any[] = [];
  processor.persistDownloadState = (_cid: number, state: any) => {
    progressEmissions.push(state);
  };

  try {
    await processor.downloadAlbumTrackOffers(commandId, {
      provider: "tidal",
      providerId: "tidal-album-1",
      type: "album",
      acquisitionMode: "trackOffers",
      title: "Best of Armstrong",
      artist: "Louis Armstrong",
      trackOffers,
    }, entryFor("tidal"));

    // Track 2 retried and succeeded on attempt 2
    assert.equal(track2Attempts, 2, "Track 2 must have been attempted twice (1 timeout + 1 retry)");
    assert.deepEqual(downloadedTracks, ["tidal-track-101", "tidal-track-102", "tidal-track-103"]);

    // Clean completion: no completedWithWarning outcome
    const warningState = progressEmissions.find((p) => p.outcome === "completedWithWarning");
    assert.equal(warningState, undefined, "Clean completion must not have completedWithWarning outcome");

    const finalProgress = progressEmissions[progressEmissions.length - 1];
    assert.equal(finalProgress.statusMessage, "Download finished, preparing import");
  } finally {
    clearInterval(processor.progressFlushTimer);
    processor.progressBuffer?.clear();
  }
});

test("mid-album abort-timeout that keeps failing the same track ends as completed with warning when other tracks succeeded (#108)", async () => {
  const tracks = [
    { id: 201, mbid: "armstrong-track-201", title: "Basin Street Blues", providerTrackId: "tidal-track-201", trackNum: 1 },
    { id: 202, mbid: "armstrong-track-202", title: "Wolverine Blues", providerTrackId: "tidal-track-202", trackNum: 2 },
    { id: 203, mbid: "armstrong-track-203", title: "St. Louis Blues", providerTrackId: "tidal-track-203", trackNum: 3 },
  ];

  seedAlbumAndOffers({
    artistId: 20,
    artistMbid: "artist-armstrong-2",
    artistName: "Louis Armstrong",
    albumId: 200,
    albumMbid: "album-armstrong-2",
    albumTitle: "Decca Sessions",
    provider: "tidal",
    tracks,
  });

  const downloadedTracks: string[] = [];
  let track2Attempts = 0;

  downloadBackendRegistry.register({
    id: "tiddl",
    supportedProviders: ["tidal"],
    capabilities: ["stereo"],
    async preflight() {},
    async download(request) {
      if (request.providerId === "tidal-track-202") {
        track2Attempts += 1;
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      downloadedTracks.push(request.providerId);
      fs.writeFileSync(path.join(request.downloadPath, `${request.providerId}.flac`), "mock-flac-data");
    },
  });

  const commandId = 96002;
  const trackOffers = tracks.map((t) => ({
    provider: "tidal",
    providerTrackId: t.providerTrackId,
    canonicalTrackMbid: t.mbid,
    canonicalRecordingMbid: `rec-${t.mbid}`,
    title: t.title,
  }));

  db.prepare(`
    INSERT INTO commands (id, name, payload, status, worker_id)
    VALUES (?, 'DownloadAlbum', ?, 'started', 'timeout-test')
  `).run(commandId, JSON.stringify({
    provider: "tidal",
    providerId: "tidal-album-2",
    type: "album",
    acquisitionMode: "trackOffers",
    title: "Decca Sessions",
    artist: "Louis Armstrong",
    trackOffers,
  }));

  const processor = new DownloadProcessor() as any;
  const progressEmissions: any[] = [];
  processor.persistDownloadState = (_cid: number, state: any) => {
    progressEmissions.push(state);
  };

  try {
    await processor.downloadAlbumTrackOffers(commandId, {
      provider: "tidal",
      providerId: "tidal-album-2",
      type: "album",
      acquisitionMode: "trackOffers",
      title: "Decca Sessions",
      artist: "Louis Armstrong",
      trackOffers,
    }, entryFor("tidal"));

    // Track 2 exhausted all 3 same-offer attempts
    assert.equal(track2Attempts, 3, "Track 2 must have been retried within retry budget (3 attempts)");
    // Tracks 1 and 3 were successfully downloaded
    assert.deepEqual(downloadedTracks, ["tidal-track-201", "tidal-track-203"]);

    // Album completes with warning listing the failed track
    const warningState = progressEmissions.find((p) => p.outcome === "completedWithWarning");
    assert.ok(warningState, "Expected finished state to have outcome completedWithWarning");
    assert.match(warningState.warningMessage, /Completed with 1 failed track\(s\)/);
    assert.match(warningState.warningMessage, /tidal-track-202/);
    assert.match(warningState.warningMessage, /The operation was aborted due to timeout/);
  } finally {
    clearInterval(processor.progressFlushTimer);
    processor.progressBuffer?.clear();
  }
});

test("clean album still completes with no warning (#108)", async () => {
  const tracks = [
    { id: 301, mbid: "clean-track-1", title: "Clean Track 1", providerTrackId: "tidal-clean-1", trackNum: 1 },
    { id: 302, mbid: "clean-track-2", title: "Clean Track 2", providerTrackId: "tidal-clean-2", trackNum: 2 },
  ];

  seedAlbumAndOffers({
    artistId: 30,
    artistMbid: "artist-clean",
    artistName: "Clean Artist",
    albumId: 300,
    albumMbid: "album-clean",
    albumTitle: "Clean Album",
    provider: "tidal",
    tracks,
  });

  const downloadedTracks: string[] = [];

  downloadBackendRegistry.register({
    id: "tiddl",
    supportedProviders: ["tidal"],
    capabilities: ["stereo"],
    async preflight() {},
    async download(request) {
      downloadedTracks.push(request.providerId);
      fs.writeFileSync(path.join(request.downloadPath, `${request.providerId}.flac`), "mock-flac-data");
    },
  });

  const commandId = 96003;
  const trackOffers = tracks.map((t) => ({
    provider: "tidal",
    providerTrackId: t.providerTrackId,
    canonicalTrackMbid: t.mbid,
    canonicalRecordingMbid: `rec-${t.mbid}`,
    title: t.title,
  }));

  db.prepare(`
    INSERT INTO commands (id, name, payload, status, worker_id)
    VALUES (?, 'DownloadAlbum', ?, 'started', 'timeout-test')
  `).run(commandId, JSON.stringify({
    provider: "tidal",
    providerId: "tidal-album-clean",
    type: "album",
    acquisitionMode: "trackOffers",
    title: "Clean Album",
    artist: "Clean Artist",
    trackOffers,
  }));

  const processor = new DownloadProcessor() as any;
  const progressEmissions: any[] = [];
  processor.persistDownloadState = (_cid: number, state: any) => {
    progressEmissions.push(state);
  };

  try {
    await processor.downloadAlbumTrackOffers(commandId, {
      provider: "tidal",
      providerId: "tidal-album-clean",
      type: "album",
      acquisitionMode: "trackOffers",
      title: "Clean Album",
      artist: "Clean Artist",
      trackOffers,
    }, entryFor("tidal"));

    assert.deepEqual(downloadedTracks, ["tidal-clean-1", "tidal-clean-2"]);
    const warningState = progressEmissions.find((p) => p.outcome === "completedWithWarning");
    assert.equal(warningState, undefined, "Clean download must have no warnings");
  } finally {
    clearInterval(processor.progressFlushTimer);
    processor.progressBuffer?.clear();
  }
});

test("replaying a recorded case equivalent to Louis Armstrong — Highlights From His Decca Years (timeout on one track after 13 of 34 already progressed) (#108)", async () => {
  // 34 tracks
  const tracks = Array.from({ length: 34 }, (_, i) => {
    const num = i + 1;
    const title = num === 14 ? "Wolverine Blues" : `Louis Armstrong Track ${num}`;
    return {
      id: 400 + num,
      mbid: `armstrong-decca-${num}`,
      title,
      providerTrackId: `tidal-decca-${num}`,
      trackNum: num,
    };
  });

  seedAlbumAndOffers({
    artistId: 40,
    artistMbid: "artist-armstrong-decca",
    artistName: "Louis Armstrong",
    albumId: 400,
    albumMbid: "album-armstrong-decca",
    albumTitle: "Highlights From His Decca Years",
    provider: "tidal",
    tracks,
  });

  const downloadedTracks: string[] = [];
  let wolverineBluesAttempts = 0;

  downloadBackendRegistry.register({
    id: "tiddl",
    supportedProviders: ["tidal"],
    capabilities: ["stereo"],
    async preflight() {},
    async download(request) {
      if (request.providerId === "tidal-decca-14") {
        wolverineBluesAttempts += 1;
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      downloadedTracks.push(request.providerId);
      fs.writeFileSync(path.join(request.downloadPath, `${request.providerId}.flac`), "mock-flac-data");
    },
  });

  const commandId = 96004;
  const trackOffers = tracks.map((t) => ({
    provider: "tidal",
    providerTrackId: t.providerTrackId,
    canonicalTrackMbid: t.mbid,
    canonicalRecordingMbid: `rec-${t.mbid}`,
    title: t.title,
  }));

  db.prepare(`
    INSERT INTO commands (id, name, payload, status, worker_id)
    VALUES (?, 'DownloadAlbum', ?, 'started', 'timeout-test')
  `).run(commandId, JSON.stringify({
    provider: "tidal",
    providerId: "tidal-album-decca",
    type: "album",
    acquisitionMode: "trackOffers",
    title: "Highlights From His Decca Years",
    artist: "Louis Armstrong",
    trackOffers,
  }));

  const processor = new DownloadProcessor() as any;
  const progressEmissions: any[] = [];
  processor.persistDownloadState = (_cid: number, state: any) => {
    progressEmissions.push(state);
  };

  try {
    // Replaying must NOT fail with "The operation was aborted due to timeout"
    await processor.downloadAlbumTrackOffers(commandId, {
      provider: "tidal",
      providerId: "tidal-album-decca",
      type: "album",
      acquisitionMode: "trackOffers",
      title: "Highlights From His Decca Years",
      artist: "Louis Armstrong",
      trackOffers,
    }, entryFor("tidal"));

    // 33 of 34 tracks were obtained
    assert.equal(downloadedTracks.length, 33, "33 tracks must have been downloaded");
    assert.equal(wolverineBluesAttempts, 3, "Wolverine Blues must have been retried 3 times before failing");
    assert.equal(downloadedTracks.includes("tidal-decca-14"), false);

    // Completed with warning listing Wolverine Blues
    const warningState = progressEmissions.find((p) => p.outcome === "completedWithWarning");
    assert.ok(warningState, "Must complete with warning outcome");
    assert.match(warningState.warningMessage, /Completed with 1 failed track\(s\)/);
    assert.match(warningState.warningMessage, /tidal-decca-14/);
    assert.match(warningState.warningMessage, /The operation was aborted due to timeout/);
  } finally {
    clearInterval(processor.progressFlushTimer);
    processor.progressBuffer?.clear();
  }
});

test("persistent network error after retries fails clearly when no tracks were obtained (#108)", async () => {
  const tracks = [
    { id: 501, mbid: "fail-track-1", title: "Fail Track 1", providerTrackId: "tidal-fail-1", trackNum: 1 },
    { id: 502, mbid: "fail-track-2", title: "Fail Track 2", providerTrackId: "tidal-fail-2", trackNum: 2 },
  ];

  seedAlbumAndOffers({
    artistId: 50,
    artistMbid: "artist-fail",
    artistName: "Fail Artist",
    albumId: 500,
    albumMbid: "album-fail",
    albumTitle: "Fail Album",
    provider: "tidal",
    tracks,
  });

  downloadBackendRegistry.register({
    id: "tiddl",
    supportedProviders: ["tidal"],
    capabilities: ["stereo"],
    async preflight() {},
    async download() {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    },
  });

  const commandId = 96005;
  const trackOffers = tracks.map((t) => ({
    provider: "tidal",
    providerTrackId: t.providerTrackId,
    canonicalTrackMbid: t.mbid,
    canonicalRecordingMbid: `rec-${t.mbid}`,
    title: t.title,
  }));

  db.prepare(`
    INSERT INTO commands (id, name, payload, status, worker_id)
    VALUES (?, 'DownloadAlbum', ?, 'started', 'timeout-test')
  `).run(commandId, JSON.stringify({
    provider: "tidal",
    providerId: "tidal-album-fail",
    type: "album",
    acquisitionMode: "trackOffers",
    title: "Fail Album",
    artist: "Fail Artist",
    trackOffers,
  }));

  const processor = new DownloadProcessor() as any;

  try {
    await assert.rejects(
      () => processor.downloadAlbumTrackOffers(commandId, {
        provider: "tidal",
        providerId: "tidal-album-fail",
        type: "album",
        acquisitionMode: "trackOffers",
        title: "Fail Album",
        artist: "Fail Artist",
        trackOffers,
      }, entryFor("tidal")),
      /The operation was aborted due to timeout/,
    );
  } finally {
    clearInterval(processor.progressFlushTimer);
    processor.progressBuffer?.clear();
  }
});

test("mid-album non-transient error on one track still fails the job (#108)", async () => {
  const tracks = [
    { id: 601, mbid: "armstrong-track-601", title: "Track One", providerTrackId: "tidal-track-601", trackNum: 1 },
    { id: 602, mbid: "armstrong-track-602", title: "Track Two", providerTrackId: "tidal-track-602", trackNum: 2 },
    { id: 603, mbid: "armstrong-track-603", title: "Track Three", providerTrackId: "tidal-track-603", trackNum: 3 },
  ];

  seedAlbumAndOffers({
    artistId: 60,
    artistMbid: "artist-armstrong-6",
    artistName: "Louis Armstrong",
    albumId: 600,
    albumMbid: "album-armstrong-6",
    albumTitle: "Hard Failure Sessions",
    provider: "tidal",
    tracks,
  });

  const downloadedTracks: string[] = [];

  downloadBackendRegistry.register({
    id: "tiddl",
    supportedProviders: ["tidal"],
    capabilities: ["stereo"],
    async preflight() {},
    async download(request) {
      if (request.providerId === "tidal-track-602") {
        throw new Error("downloader provisioning is incomplete");
      }
      downloadedTracks.push(request.providerId);
      fs.writeFileSync(path.join(request.downloadPath, `${request.providerId}.flac`), "mock-flac-data");
    },
  });

  const commandId = 96006;
  const trackOffers = tracks.map((t) => ({
    provider: "tidal",
    providerTrackId: t.providerTrackId,
    canonicalTrackMbid: t.mbid,
    canonicalRecordingMbid: `rec-${t.mbid}`,
    title: t.title,
  }));

  db.prepare(`
    INSERT INTO commands (id, name, payload, status, worker_id)
    VALUES (?, 'DownloadAlbum', ?, 'started', 'timeout-test')
  `).run(commandId, JSON.stringify({
    provider: "tidal",
    providerId: "tidal-album-6",
    type: "album",
    acquisitionMode: "trackOffers",
    title: "Hard Failure Sessions",
    artist: "Louis Armstrong",
    trackOffers,
  }));

  const processor = new DownloadProcessor() as any;
  const progressEmissions: any[] = [];
  processor.persistDownloadState = (_cid: number, state: any) => {
    progressEmissions.push(state);
  };

  try {
    await assert.rejects(
      () => processor.downloadAlbumTrackOffers(commandId, {
        provider: "tidal",
        providerId: "tidal-album-6",
        type: "album",
        acquisitionMode: "trackOffers",
        title: "Hard Failure Sessions",
        artist: "Louis Armstrong",
        trackOffers,
      }, entryFor("tidal")),
      /downloader provisioning is incomplete/,
    );

    // Only track 1 was downloaded; track 2 failed hard, so track 3 was never attempted
    assert.deepEqual(downloadedTracks, ["tidal-track-601"]);
    // Must NOT complete with warning
    const warningState = progressEmissions.find((p) => p.outcome === "completedWithWarning");
    assert.equal(warningState, undefined, "Hard failure must not result in completedWithWarning");
  } finally {
    clearInterval(processor.progressFlushTimer);
    processor.progressBuffer?.clear();
  }
});
