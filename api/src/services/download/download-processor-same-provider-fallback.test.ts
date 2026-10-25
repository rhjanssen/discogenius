import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProviderUnavailableError } from "./provider-unavailable-error.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-same-provider-fallback-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.same-provider-fallback.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

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
