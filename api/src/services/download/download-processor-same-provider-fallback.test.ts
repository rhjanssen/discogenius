import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProviderUnavailableError } from "./provider-unavailable-error.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-same-provider-fallback-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.same-provider-fallback.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.DISCOGENIUS_DOWNLOAD_SAME_OFFER_ATTEMPTS = "1";
process.env.DISCOGENIUS_DOWNLOAD_SAME_OFFER_BACKOFF_MS = "0";

const databaseModule = await import("../../database.js");
databaseModule.initDatabase();
const { db } = databaseModule;
const { DownloadProcessor } = await import("./download-processor.js");
const { downloadBackendRegistry } = await import("./download-backend.js");
const { streamingProviderManager } = await import("../../providers/index.js");

function registerProvider(id: string): void {
  if ([...streamingProviderManager.getAllStreamingProviders()].some((provider) => provider.id === id)) return;
  streamingProviderManager.registerStreamingProvider({
    id,
    name: id,
    capabilities: {},
  } as never);
}

function seedOffer(input: {
  recordingId: number;
  recordingMbid: string;
  trackId: number;
  trackMbid: string;
  itemId: number;
  provider: string;
  providerTrackId: string;
  qualityClass: string;
}): void {
  db.prepare(`
    INSERT INTO ProviderItems (id, provider, entity_type, provider_id, title, availability)
    VALUES (?, ?, 'track', ?, ?, 'available')
  `).run(input.itemId, input.provider, input.providerTrackId, input.providerTrackId);
  db.prepare(`
    INSERT INTO ProviderTrackMatches (
      id, provider_track_item_id, recording_id, track_id, match_state,
      decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, ?, ?, 'accepted', 'automatic', 1, 'fixture', 5)
  `).run(input.itemId, input.itemId, input.recordingId, input.trackId);
  db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      id, provider_item_id, variant_key, quality_class, availability
    ) VALUES (?, ?, ?, ?, 'available')
  `).run(input.itemId, input.itemId, input.qualityClass, input.qualityClass);
}

function entryFor(provider: string) {
  return {
    provider,
    type: "album" as const,
    providerId: "album-1",
    workerId: "same-provider-test",
    abortController: new AbortController(),
    cancelRequested: false,
  };
}

test("a per-track album fallback stays on the command provider", async () => {
  registerProvider("label-a");
  registerProvider("label-b");
  db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-fb', 'Fallback')").run();
  db.prepare("INSERT INTO Albums (id, mbid, title, artist_mbid, primary_type) VALUES (1, 'group-fb', 'Album', 'artist-fb', 'Album')").run();
  db.prepare(`
    INSERT INTO AlbumEditions (id, mbid, release_group_id, title, release_group_mbid, artist_mbid)
    VALUES (1, 'release-fb', 1, 'Album', 'group-fb', 'artist-fb')
  `).run();
  db.prepare("INSERT INTO Recordings (id, mbid, title, length_ms, is_video) VALUES (1, 'rec-fb', 'Song', 180000, 0)").run();
  db.prepare("INSERT INTO Recordings (id, mbid, title, length_ms, is_video) VALUES (2, 'rec-fb-2', 'Other', 180000, 0)").run();
  db.prepare(`
    INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title, release_mbid, recording_mbid)
    VALUES (1, 'track-fb', 1, 1, 1, 1, 'Song', 'release-fb', 'rec-fb')
  `).run();
  db.prepare(`
    INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title, release_mbid, recording_mbid)
    VALUES (2, 'track-fb-2', 1, 2, 1, 2, 'Other', 'release-fb', 'rec-fb-2')
  `).run();
  seedOffer({
    recordingId: 1, recordingMbid: "rec-fb", trackId: 1, trackMbid: "track-fb",
    itemId: 11, provider: "label-a", providerTrackId: "track-a", qualityClass: "lossless",
  });
  seedOffer({
    recordingId: 1, recordingMbid: "rec-fb", trackId: 1, trackMbid: "track-fb",
    itemId: 12, provider: "label-b", providerTrackId: "track-b", qualityClass: "hires-lossless",
  });
  seedOffer({
    recordingId: 2, recordingMbid: "rec-fb-2", trackId: 2, trackMbid: "track-fb-2",
    itemId: 21, provider: "label-a", providerTrackId: "track-a-primary", qualityClass: "lossless",
  });
  seedOffer({
    recordingId: 2, recordingMbid: "rec-fb-2", trackId: 2, trackMbid: "track-fb-2",
    itemId: 22, provider: "label-a", providerTrackId: "track-a-alt", qualityClass: "lossless",
  });
  seedOffer({
    recordingId: 2, recordingMbid: "rec-fb-2", trackId: 2, trackMbid: "track-fb-2",
    itemId: 23, provider: "label-b", providerTrackId: "track-b-hires", qualityClass: "hires-lossless",
  });

  let foreignCalls = 0;
  downloadBackendRegistry.register({
    id: "label-a-same-provider-test",
    supportedProviders: ["label-a"],
    capabilities: ["stereo"],
    async preflight(request) {
      if (request.providerId === "track-a-alt") throw new Error("same-provider-selected");
      throw new ProviderUnavailableError("label-a", "track", request.providerId, "gone");
    },
    async download() {
      throw new Error("label-a download must not run");
    },
  });
  downloadBackendRegistry.register({
    id: "label-b-same-provider-test",
    supportedProviders: ["label-b"],
    capabilities: ["stereo"],
    async preflight() { foreignCalls += 1; },
    async download() { foreignCalls += 1; },
  });

  const processor = new DownloadProcessor() as any;
  try {
    await assert.rejects(
      () => processor.downloadAlbumTrackOffers(91001, {
        provider: "label-a",
        providerId: "album-1",
        type: "album",
        acquisitionMode: "trackOffers",
        title: "Album",
        artist: "Fallback",
        trackOffers: [{
          provider: "label-a",
          providerTrackId: "track-a",
          canonicalTrackMbid: "track-fb",
          canonicalRecordingMbid: "rec-fb",
          title: "Song",
        }],
      }, entryFor("label-a")),
      (error: unknown) => error instanceof ProviderUnavailableError,
    );
    assert.equal(foreignCalls, 0);

    db.prepare(`
      INSERT INTO commands (id, name, payload, status, worker_id)
      VALUES (91002, 'DownloadAlbum', ?, 'started', 'same-provider-test')
    `).run(JSON.stringify({
      provider: "label-a",
      providerId: "album-1",
      type: "album",
      acquisitionMode: "trackOffers",
      title: "Album",
      artist: "Fallback",
      trackOffers: [{
        provider: "label-a",
        providerTrackId: "track-a-primary",
        canonicalTrackMbid: "track-fb-2",
        canonicalRecordingMbid: "rec-fb-2",
        title: "Other",
      }],
    }));
    await assert.rejects(
      () => processor.downloadAlbumTrackOffers(91002, {
        provider: "label-a",
        providerId: "album-1",
        type: "album",
        acquisitionMode: "trackOffers",
        title: "Album",
        artist: "Fallback",
        trackOffers: [{
          provider: "label-a",
          providerTrackId: "track-a-primary",
          canonicalTrackMbid: "track-fb-2",
          canonicalRecordingMbid: "rec-fb-2",
          title: "Other",
        }],
      }, entryFor("label-a")),
      /same-provider-selected/,
    );
    assert.equal(foreignCalls, 0);
  } finally {
    clearInterval(processor.progressFlushTimer);
    processor.progressBuffer?.clear();
  }
});

test("downloadAlbumTrackOffers downloads available tracks and completes with warning when a track fails with shorter Failed to dl aac-lc: Unavailable (#98)", async () => {
  registerProvider("apple-music");
  db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (2, 'artist-apple', 'Massive Attack')").run();
  db.prepare("INSERT INTO Albums (id, mbid, title, artist_mbid, primary_type) VALUES (2, 'group-apple', 'Collected', 'artist-apple', 'Album')").run();
  db.prepare(`
    INSERT INTO AlbumEditions (id, mbid, release_group_id, title, release_group_mbid, artist_mbid)
    VALUES (2, 'release-apple', 2, 'Collected', 'group-apple', 'artist-apple')
  `).run();
  db.prepare("INSERT INTO Recordings (id, mbid, title, length_ms, is_video) VALUES (3, 'rec-apple-1', 'Safe from Harm', 180000, 0)").run();
  db.prepare("INSERT INTO Recordings (id, mbid, title, length_ms, is_video) VALUES (4, 'rec-apple-2', 'Karmacoma', 180000, 0)").run();
  db.prepare(`
    INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title, release_mbid, recording_mbid)
    VALUES (3, 'track-apple-1', 2, 3, 1, 1, 'Safe from Harm', 'release-apple', 'rec-apple-1')
  `).run();
  db.prepare(`
    INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title, release_mbid, recording_mbid)
    VALUES (4, 'track-apple-2', 2, 4, 1, 2, 'Karmacoma', 'release-apple', 'rec-apple-2')
  `).run();
  seedOffer({
    recordingId: 3, recordingMbid: "rec-apple-1", trackId: 3, trackMbid: "track-apple-1",
    itemId: 31, provider: "apple-music", providerTrackId: "apple-track-1", qualityClass: "lossless",
  });
  seedOffer({
    recordingId: 4, recordingMbid: "rec-apple-2", trackId: 4, trackMbid: "track-apple-2",
    itemId: 32, provider: "apple-music", providerTrackId: "apple-track-2", qualityClass: "lossless",
  });

  const downloadedTracks: string[] = [];
  downloadBackendRegistry.register({
    id: "apple-music-downloader",
    supportedProviders: ["apple-music"],
    capabilities: ["stereo"],
    async preflight() {},
    async download(request) {
      if (request.providerId === "apple-track-1") {
        throw new ProviderUnavailableError("apple-music", "track", "apple-track-1", "Failed to dl aac-lc: Unavailable");
      }
      downloadedTracks.push(request.providerId);
      fs.writeFileSync(path.join(request.downloadPath, `${request.providerId}.m4a`), "mock-audio-data");
    },
  });

  const processor = new DownloadProcessor() as any;
  const progressEmissions: any[] = [];
  processor.persistDownloadState = (commandId: number, state: any) => {
    progressEmissions.push(state);
  };

  db.prepare(`
    INSERT INTO commands (id, name, payload, status, worker_id)
    VALUES (92001, 'DownloadAlbum', ?, 'started', 'same-provider-test')
  `).run(JSON.stringify({
    provider: "apple-music",
    providerId: "apple-album-1",
    type: "album",
    acquisitionMode: "trackOffers",
    title: "Collected",
    artist: "Massive Attack",
    trackOffers: [
      {
        provider: "apple-music",
        providerTrackId: "apple-track-1",
        canonicalTrackMbid: "track-apple-1",
        canonicalRecordingMbid: "rec-apple-1",
        title: "Safe from Harm",
      },
      {
        provider: "apple-music",
        providerTrackId: "apple-track-2",
        canonicalTrackMbid: "track-apple-2",
        canonicalRecordingMbid: "rec-apple-2",
        title: "Karmacoma",
      },
    ],
  }));

  try {
    await processor.downloadAlbumTrackOffers(92001, {
      provider: "apple-music",
      providerId: "apple-album-1",
      type: "album",
      acquisitionMode: "trackOffers",
      title: "Collected",
      artist: "Massive Attack",
      trackOffers: [
        {
          provider: "apple-music",
          providerTrackId: "apple-track-1",
          canonicalTrackMbid: "track-apple-1",
          canonicalRecordingMbid: "rec-apple-1",
          title: "Safe from Harm",
        },
        {
          provider: "apple-music",
          providerTrackId: "apple-track-2",
          canonicalTrackMbid: "track-apple-2",
          canonicalRecordingMbid: "rec-apple-2",
          title: "Karmacoma",
        },
      ],
    }, entryFor("apple-music"));

    // Track 2 was downloaded despite Track 1 being unavailable
    assert.deepEqual(downloadedTracks, ["apple-track-2"]);

    // Track 1 recorded as unavailable in ProviderItems
    const row = db.prepare(`
      SELECT availability, availability_reason FROM ProviderItems
      WHERE provider = 'apple-music' AND entity_type = 'track' AND provider_id = 'apple-track-1'
    `).get() as { availability: string; availability_reason: string };
    assert.equal(row.availability, "unavailable");
    assert.equal(row.availability_reason, "Failed to dl aac-lc: Unavailable");

    // Finished with outcome completedWithWarning
    const finishState = progressEmissions.find((p) => p.outcome === "completedWithWarning");
    assert.ok(finishState, "Expected finished state to have outcome completedWithWarning");
    assert.match(finishState.warningMessage, /Completed with 1 unavailable track\(s\)/);
    assert.match(finishState.warningMessage, /apple-track-1: Failed to dl aac-lc: Unavailable/);
  } finally {
    clearInterval(processor.progressFlushTimer);
    processor.progressBuffer?.clear();
  }
});

test("downloadAlbumTrackOffers fails clearly when all tracks are unavailable (#98)", async () => {
  const processor = new DownloadProcessor() as any;

  db.prepare(`
    INSERT INTO commands (id, name, payload, status, worker_id)
    VALUES (92002, 'DownloadAlbum', ?, 'started', 'same-provider-test')
  `).run(JSON.stringify({
    provider: "apple-music",
    providerId: "apple-album-2",
    type: "album",
    acquisitionMode: "trackOffers",
    title: "Collected",
    artist: "Massive Attack",
    trackOffers: [
      {
        provider: "apple-music",
        providerTrackId: "apple-track-1",
        canonicalTrackMbid: "track-apple-1",
        canonicalRecordingMbid: "rec-apple-1",
        title: "Safe from Harm",
      },
    ],
  }));

  try {
    await assert.rejects(
      () => processor.downloadAlbumTrackOffers(92002, {
        provider: "apple-music",
        providerId: "apple-album-2",
        type: "album",
        acquisitionMode: "trackOffers",
        title: "Collected",
        artist: "Massive Attack",
        trackOffers: [
          {
            provider: "apple-music",
            providerTrackId: "apple-track-1",
            canonicalTrackMbid: "track-apple-1",
            canonicalRecordingMbid: "rec-apple-1",
            title: "Safe from Harm",
          },
        ],
      }, entryFor("apple-music")),
      (err: any) => {
        assert.ok(err instanceof ProviderUnavailableError);
        assert.match(err.message, /All tracks unavailable: Failed to dl aac-lc: Unavailable/);
        return true;
      },
    );
  } finally {
    clearInterval(processor.progressFlushTimer);
    processor.progressBuffer?.clear();
  }
});

test("downloadAlbumTrackOffers leaves ProviderItems.availability unchanged when track download fails with transient error (#98)", async () => {
  db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (4, 'artist-transient', 'Transient Artist')").run();
  db.prepare("INSERT INTO Albums (id, mbid, title, artist_mbid, primary_type) VALUES (4, 'group-transient', 'Transient Album', 'artist-transient', 'Album')").run();
  db.prepare(`
    INSERT INTO AlbumEditions (id, mbid, release_group_id, title, release_group_mbid, artist_mbid)
    VALUES (4, 'release-transient', 4, 'Transient Album', 'group-transient', 'artist-transient')
  `).run();
  db.prepare("INSERT INTO Recordings (id, mbid, title, length_ms, is_video) VALUES (7, 'rec-transient-1', 'Track 1', 180000, 0)").run();
  db.prepare("INSERT INTO Recordings (id, mbid, title, length_ms, is_video) VALUES (8, 'rec-transient-2', 'Track 2', 180000, 0)").run();
  db.prepare(`
    INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title, release_mbid, recording_mbid)
    VALUES (7, 'track-transient-1', 4, 7, 1, 1, 'Track 1', 'release-transient', 'rec-transient-1')
  `).run();
  db.prepare(`
    INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title, release_mbid, recording_mbid)
    VALUES (8, 'track-transient-2', 4, 8, 1, 2, 'Track 2', 'release-transient', 'rec-transient-2')
  `).run();
  seedOffer({
    recordingId: 7, recordingMbid: "rec-transient-1", trackId: 7, trackMbid: "track-transient-1",
    itemId: 41, provider: "apple-music", providerTrackId: "apple-track-transient-1", qualityClass: "lossless",
  });
  seedOffer({
    recordingId: 8, recordingMbid: "rec-transient-2", trackId: 8, trackMbid: "track-transient-2",
    itemId: 42, provider: "apple-music", providerTrackId: "apple-track-transient-2-primary", qualityClass: "lossless",
  });
  seedOffer({
    recordingId: 8, recordingMbid: "rec-transient-2", trackId: 8, trackMbid: "track-transient-2",
    itemId: 43, provider: "apple-music", providerTrackId: "apple-track-transient-2-fallback", qualityClass: "lossless",
  });

  const downloadedTracks: string[] = [];
  downloadBackendRegistry.register({
    id: "apple-music-downloader",
    supportedProviders: ["apple-music"],
    capabilities: ["stereo"],
    async preflight() {},
    async download(request) {
      if (request.providerId === "apple-track-transient-1" || request.providerId === "apple-track-transient-2-primary") {
        throw new Error("ETIMEDOUT");
      }
      downloadedTracks.push(request.providerId);
      fs.writeFileSync(path.join(request.downloadPath, `${request.providerId}.m4a`), "mock-audio-data");
    },
  });

  const processor = new DownloadProcessor() as any;

  // 1. Without fallback: fails the job and leaves ProviderItems.availability unchanged
  db.prepare(`
    INSERT INTO commands (id, name, payload, status, worker_id)
    VALUES (94001, 'DownloadAlbum', ?, 'started', 'same-provider-test')
  `).run(JSON.stringify({
    provider: "apple-music",
    providerId: "apple-album-transient-1",
    type: "album",
    acquisitionMode: "trackOffers",
    title: "Transient Album",
    artist: "Transient Artist",
    trackOffers: [
      {
        provider: "apple-music",
        providerTrackId: "apple-track-transient-1",
        canonicalTrackMbid: "track-transient-1",
        canonicalRecordingMbid: "rec-transient-1",
        title: "Track 1",
      },
    ],
  }));

  try {
    await assert.rejects(
      () => processor.downloadAlbumTrackOffers(94001, {
        provider: "apple-music",
        providerId: "apple-album-transient-1",
        type: "album",
        acquisitionMode: "trackOffers",
        title: "Transient Album",
        artist: "Transient Artist",
        trackOffers: [
          {
            provider: "apple-music",
            providerTrackId: "apple-track-transient-1",
            canonicalTrackMbid: "track-transient-1",
            canonicalRecordingMbid: "rec-transient-1",
            title: "Track 1",
          },
        ],
      }, entryFor("apple-music")),
      /ETIMEDOUT/,
    );

    const row1 = db.prepare(`
      SELECT availability, availability_reason FROM ProviderItems
      WHERE provider = 'apple-music' AND entity_type = 'track' AND provider_id = 'apple-track-transient-1'
    `).get() as { availability: string; availability_reason: string | null };
    assert.equal(row1.availability, "available", "Transient error must not mark track unavailable in DB");
    assert.equal(row1.availability_reason, null);

    // 2. With fallback: primary fails with ETIMEDOUT, falls back to alternate offer, succeeds,
    // and leaves primary ProviderItems.availability unchanged
    db.prepare(`
      INSERT INTO commands (id, name, payload, status, worker_id)
      VALUES (94002, 'DownloadAlbum', ?, 'started', 'same-provider-test')
    `).run(JSON.stringify({
      provider: "apple-music",
      providerId: "apple-album-transient-2",
      type: "album",
      acquisitionMode: "trackOffers",
      title: "Transient Album",
      artist: "Transient Artist",
      trackOffers: [
        {
          provider: "apple-music",
          providerTrackId: "apple-track-transient-2-primary",
          canonicalTrackMbid: "track-transient-2",
          canonicalRecordingMbid: "rec-transient-2",
          title: "Track 2",
        },
      ],
    }));

    await processor.downloadAlbumTrackOffers(94002, {
      provider: "apple-music",
      providerId: "apple-album-transient-2",
      type: "album",
      acquisitionMode: "trackOffers",
      title: "Transient Album",
      artist: "Transient Artist",
      trackOffers: [
        {
          provider: "apple-music",
          providerTrackId: "apple-track-transient-2-primary",
          canonicalTrackMbid: "track-transient-2",
          canonicalRecordingMbid: "rec-transient-2",
          title: "Track 2",
        },
      ],
    }, entryFor("apple-music"));

    assert.ok(downloadedTracks.includes("apple-track-transient-2-fallback"), "Fallback track must be downloaded");

    const row2Primary = db.prepare(`
      SELECT availability, availability_reason FROM ProviderItems
      WHERE provider = 'apple-music' AND entity_type = 'track' AND provider_id = 'apple-track-transient-2-primary'
    `).get() as { availability: string; availability_reason: string | null };
    assert.equal(row2Primary.availability, "available", "Primary track failing with transient error must stay available");
    assert.equal(row2Primary.availability_reason, null);
  } finally {
    clearInterval(processor.progressFlushTimer);
    processor.progressBuffer?.clear();
  }
});
