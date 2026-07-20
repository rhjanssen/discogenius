import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-download-processor-canonical-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();
const { db } = dbModule;
const { DownloadProcessor } = await import("./download-processor.js");
const queueModule = await import("../commands/command-queue-manager.js");
const importServiceModule = await import("../mediafiles/downloaded-tracks-import-service.js");
const downloadRoutingModule = await import("./download-routing.js");

function resetRows() {
  db.prepare("DELETE FROM commands").run();
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM ReleaseGroupSlots").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumReleases").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
  db.prepare("DELETE FROM Artists").run();
}

beforeEach(resetRows);
afterEach(resetRows);

test("cancelling the active item aborts its provider signal without pausing the queue", async () => {
  const commandId = queueModule.CommandQueueManager.push(
    queueModule.CommandNames.DownloadTrack,
    { providerId: "cancel-active", type: "track" },
    "cancel-active",
  );
  queueModule.CommandQueueManager.markProcessing(commandId);

  const processor = new DownloadProcessor() as any;
  const controller = new AbortController();
  processor.activeDownloads.set(commandId, {
    provider: "tidal",
    type: "track",
    providerId: "cancel-active",
    abortController: controller,
    cancelRequested: false,
  });

  await processor.cancelJob(commandId);

  assert.equal(controller.signal.aborted, true);
  assert.equal(processor.isPaused, false);
  assert.equal(queueModule.CommandQueueManager.get(commandId)?.status, "cancelled");
  assert.equal(processor.explicitlyCancelledDownloads.has(commandId), true);
});

test("cancelling an active import waits for a safe boundary before releasing its duplicate barrier", async () => {
  const providerId = "cancel-active-import";
  const commandId = queueModule.CommandQueueManager.push(
    queueModule.CommandNames.DownloadTrack,
    { providerId, provider: "tidal", type: "track" },
    providerId,
  );
  queueModule.CommandQueueManager.markProcessing(commandId);

  const downloadPath = downloadRoutingModule.getDownloadWorkspacePath("track", providerId, "tidal");
  fs.mkdirSync(downloadPath, { recursive: true });
  fs.writeFileSync(path.join(downloadPath, `${providerId}.flac`), "staged");

  let signalImportStarted!: () => void;
  const importStarted = new Promise<void>((resolve) => { signalImportStarted = resolve; });
  let signalCancellationObserved!: () => void;
  const cancellationObserved = new Promise<void>((resolve) => { signalCancellationObserved = resolve; });
  let releaseSafeBoundary!: () => void;
  const safeBoundary = new Promise<void>((resolve) => { releaseSafeBoundary = resolve; });
  const originalProcess = importServiceModule.DownloadedTracksImportService.process;

  (importServiceModule.DownloadedTracksImportService as any).process = async (_job: unknown, options: {
    isCancelled?: () => boolean;
  }) => {
    signalImportStarted();
    while (!options.isCancelled?.()) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    signalCancellationObserved();
    await safeBoundary;
    throw new importServiceModule.ImportDownloadCancelledError("test boundary");
  };

  try {
    const processor = new DownloadProcessor() as any;
    processor.dispatchImportPhase({
      commandId,
      providerId,
      type: "track",
      importPayload: {
        type: "track",
        providerId,
        provider: "tidal",
        path: downloadPath,
      },
      resolved: { title: "Cancellation Test", artist: "Test Artist", cover: null },
    });
    await importStarted;

    let cancellationSettled = false;
    const cancellation = processor.cancelJob(commandId).then(() => {
      cancellationSettled = true;
    });
    await cancellationObserved;

    const drainingCommand = queueModule.CommandQueueManager.get(commandId);
    assert.equal(cancellationSettled, false);
    assert.equal(drainingCommand?.status, "started");
    assert.equal(drainingCommand?.payload.importCancellationRequested, true);

    releaseSafeBoundary();
    await cancellation;

    assert.equal(cancellationSettled, true);
    assert.equal(queueModule.CommandQueueManager.get(commandId)?.status, "cancelled");
    assert.equal(processor.activeImports.has(commandId), false);
    assert.equal(fs.existsSync(downloadPath), false);
  } finally {
    releaseSafeBoundary();
    (importServiceModule.DownloadedTracksImportService as any).process = originalProcess;
  }
});

test("download processor resolves canonical album provider offers without legacy provider catalog rows", () => {
  const processor = new DownloadProcessor() as any;

  db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-bastille", "Bastille", "artist-bastille");
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-bastille", "Bastille");
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date, images)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("rg-gmtf", "artist-bastille", "Give Me the Future", "album", "2022-02-04", JSON.stringify([
    { coverType: "Cover", url: "https://coverartarchive.org/release/release-gmtf/front.jpg" },
  ]));
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-gmtf", "rg-gmtf", "artist-bastille", "Give Me the Future", 1, 1);
  db.prepare("INSERT INTO Recordings (mbid, title, is_video) VALUES (?, ?, ?)")
    .run("recording-gmtf", "Give Me the Future", 0);
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("track-gmtf", "release-gmtf", "recording-gmtf", "Give Me the Future", 1, 1);
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
      title, quality, asset_id, match_status, match_confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "album",
    "tidal-gmtf-expanded",
    "artist-bastille",
    "rg-gmtf",
    "release-gmtf",
    "Give Me The Future + Dreams Of The Past",
    "HIRES_LOSSLESS",
    "provider-cover",
    "probable",
    0.91,
  );
  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored,
      selected_provider, selected_provider_id, selected_release_mbid, quality, cover
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-bastille",
    "rg-gmtf",
    "stereo",
    1,
    "tidal",
    "tidal-gmtf-expanded",
    "release-gmtf",
    "HIRES_LOSSLESS",
    "slot-cover"
  );

  const payload = {
    type: "album",
    provider: "tidal",
    providerId: "tidal-gmtf-expanded",
    releaseGroupMbid: "rg-gmtf",
    slot: "stereo",
  };

  assert.equal(processor.hasAlbumMetadataReady("tidal-gmtf-expanded", payload), true);
  assert.deepEqual(processor.resolveDownloadMetadata("tidal-gmtf-expanded", "album", payload), {
    title: "Give Me the Future",
    artist: "Bastille",
    cover: "/media-cover/Albums/rg-gmtf/cover.jpg?source=canonical",
  });
  assert.equal(processor.resolveDownloadQuality("tidal-gmtf-expanded", "album", payload), "HIRES_LOSSLESS");
});

test("download processor detects canonical track and video files without ProviderMedia rows", () => {
  const processor = new DownloadProcessor() as any;

  db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-media", "Media Artist", "artist-media");
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-media", "Media Artist");
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, images)
    VALUES (?, ?, ?, ?, ?)
  `).run("rg-media", "artist-media", "Media Album", "album", JSON.stringify([
    { coverType: "Cover", url: "https://coverartarchive.org/release/release-media/front.jpg" },
  ]));
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-media", "rg-media", "artist-media", "Media Album", 1, 1);
  db.prepare("INSERT INTO Recordings (mbid, title, is_video) VALUES (?, ?, ?)")
    .run("recording-track", "Canonical Track", 0);
  db.prepare("INSERT INTO Recordings (mbid, title, is_video) VALUES (?, ?, ?)")
    .run("recording-video", "Canonical Video", 1);
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("track-media", "release-media", "recording-track", "Canonical Track", 1, 1);
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
      track_mbid, recording_mbid, title, quality, asset_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "track",
    "tidal-track",
    "artist-media",
    "rg-media",
    "release-media",
    "track-media",
    "recording-track",
    "provider Track",
    "LOSSLESS",
    "track-cover",
  );
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, recording_mbid, title, quality, asset_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "video",
    "tidal-video",
    "artist-media",
    "recording-video",
    "provider Video",
    "1080p",
    "video-cover",
  );
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, canonical_track_mbid, canonical_recording_mbid, provider, provider_entity_type,
      provider_id, library_slot, file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-media",
    "track-media",
    "recording-track",
    "tidal",
    "track",
    "tidal-track",
    "stereo",
    "C:/Music/Media Artist/track.flac",
    "Media Artist/track.flac",
    "C:/Music",
    "track.flac",
    "flac",
    "track",
  );
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, canonical_recording_mbid, provider, provider_entity_type,
      provider_id, library_slot, file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-media",
    "recording-video",
    "tidal",
    "video",
    "tidal-video",
    "video",
    "C:/Music/Media Artist/video.mp4",
    "Media Artist/video.mp4",
    "C:/Music",
    "video.mp4",
    "mp4",
    "video",
  );

  assert.equal(processor.hasTrackMetadataReady("tidal-track", { type: "track", providerId: "tidal-track" }), true);
  assert.deepEqual(processor.resolveDownloadMetadata("tidal-track", "track", { type: "track", providerId: "tidal-track" }), {
    title: "Canonical Track",
    artist: "Media Artist",
    cover: "/media-cover/Albums/rg-media/cover.jpg?source=canonical",
  });
  assert.equal(processor.isCanonicalProviderItemDownloaded("tidal-track", "track", { type: "track", providerId: "tidal-track" }), true);

  assert.equal(processor.hasVideoMetadataReady("tidal-video", { type: "video", providerId: "tidal-video" }), true);
  const videoRecordingId = (db.prepare("SELECT id FROM Recordings WHERE mbid = ?").get("recording-video") as { id: number }).id;
  assert.deepEqual(processor.resolveDownloadMetadata("tidal-video", "video", { type: "video", providerId: "tidal-video" }), {
    title: "Canonical Video",
    artist: "Media Artist",
    cover: `/media-cover/Videos/${videoRecordingId}/cover.jpg`,
  });
  assert.equal(processor.isCanonicalProviderItemDownloaded("tidal-video", "video", { type: "video", providerId: "tidal-video" }), true);
});

test("download processor scopes provider offers when services reuse the same resource id", () => {
  const processor = new DownloadProcessor() as any;

  db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES ('artist-apple', 'Apple Artist'), ('artist-tidal', 'TIDAL Artist')
  `).run();
  db.prepare(`
    INSERT INTO Artists (id, mbid, name)
    VALUES
      ('artist-apple', 'artist-apple', 'Apple Artist'),
      ('artist-tidal', 'artist-tidal', 'TIDAL Artist')
  `).run();
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES
      ('rg-apple', 'artist-apple', 'Apple Album', 'album'),
      ('rg-tidal', 'artist-tidal', 'TIDAL Album', 'album')
  `).run();
  db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, is_video)
    VALUES
      ('recording-apple', 'artist-apple', 'Apple Track', 0),
      ('recording-tidal', 'artist-tidal', 'TIDAL Track', 0)
  `).run();

  // Provider IDs are not globally unique. Make the TIDAL rows newer so the
  // former provider-less ORDER BY deterministically picked the wrong service.
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, artist_mbid, release_group_mbid,
      recording_mbid, title, quality, updated_at
    ) VALUES
      ('apple-music', 'album', '42', 'artist-apple', 'rg-apple', NULL, 'Apple Album', 'HIRES_LOSSLESS', '2000-01-01 00:00:00'),
      ('tidal', 'album', '42', 'artist-tidal', 'rg-tidal', NULL, 'TIDAL Album', 'LOSSLESS', '2099-01-01 00:00:00'),
      ('apple-music', 'track', '7', 'artist-apple', 'rg-apple', 'recording-apple', 'Apple provider track', 'HIRES_LOSSLESS', '2000-01-01 00:00:00'),
      ('tidal', 'track', '7', 'artist-tidal', 'rg-tidal', 'recording-tidal', 'TIDAL provider track', 'LOSSLESS', '2099-01-01 00:00:00')
  `).run();
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, canonical_recording_mbid, provider, provider_entity_type,
      provider_id, library_slot, file_path, relative_path, library_root,
      filename, extension, file_type
    ) VALUES (
      'artist-tidal', 'recording-tidal', 'tidal', 'track',
      '7', 'stereo', 'C:/Music/tidal.flac', 'tidal.flac', 'C:/Music',
      'tidal.flac', 'flac', 'track'
    )
  `).run();

  const appleAlbumPayload = { type: "album", provider: "apple-music", providerId: "42" };
  const appleTrackPayload = { type: "track", provider: "apple-music", providerId: "7" };
  const tidalTrackPayload = { type: "track", provider: "tidal", providerId: "7" };

  assert.equal(processor.resolveCanonicalProviderOffer("42", "album", appleAlbumPayload)?.provider, "apple-music");
  assert.equal(processor.resolveCanonicalProviderOffer("7", "track", appleTrackPayload)?.provider, "apple-music");
  assert.deepEqual(processor.resolveDownloadMetadata("7", "track", appleTrackPayload), {
    title: "Apple Track",
    artist: "Apple Artist",
    cover: null,
  });
  assert.equal(processor.resolveDownloadQuality("7", "track", appleTrackPayload), "HIRES_LOSSLESS");
  assert.equal(processor.isCanonicalProviderItemDownloaded("7", "track", appleTrackPayload), false);
  assert.equal(processor.isCanonicalProviderItemDownloaded("7", "track", tidalTrackPayload), true);
});

