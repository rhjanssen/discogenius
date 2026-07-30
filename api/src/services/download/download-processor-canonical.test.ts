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
  db.prepare("DELETE FROM AcquisitionPlans").run();
  db.prepare("DELETE FROM LibraryEditions").run();
  db.prepare("DELETE FROM LibraryAlbums").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumEditions").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
  db.prepare("DELETE FROM Artists").run();
}

function seedTypedRelease(input: {
  suffix: string;
  provider: string;
  providerEditionId: string;
  providerTrackId: string;
  artistName: string;
  albumTitle: string;
  trackTitle: string;
  quality?: "lossy" | "lossless" | "hires-lossless" | "spatial";
}) {
  const artistMbid = `artist-${input.suffix}`;
  const releaseGroupMbid = `rg-${input.suffix}`;
  const editionMbid = `release-${input.suffix}`;
  const recordingMbid = `recording-${input.suffix}`;
  const trackMbid = `track-${input.suffix}`;
  db.prepare(`
    INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)
  `).run(artistMbid, input.artistName, artistMbid);
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get(artistMbid, input.artistName) as { id: number };
  const releaseGroup = db.prepare(`
    INSERT INTO Albums (
      mbid, artist_metadata_id, artist_mbid, title, primary_type
    ) VALUES (?, ?, ?, ?, 'album')
    RETURNING id
  `).get(
    releaseGroupMbid,
    artist.id,
    artistMbid,
    input.albumTitle,
  ) as { id: number };
  const release = db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_id, release_group_mbid, artist_metadata_id,
      artist_mbid, title, track_count, media_count
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 1)
    RETURNING id
  `).get(
    editionMbid,
    releaseGroup.id,
    releaseGroupMbid,
    artist.id,
    artistMbid,
    input.albumTitle,
  ) as { id: number };
  const recording = db.prepare(`
    INSERT INTO Recordings (
      mbid, artist_metadata_id, artist_mbid, title, is_video
    ) VALUES (?, ?, ?, ?, 0)
    RETURNING id
  `).get(
    recordingMbid,
    artist.id,
    artistMbid,
    input.trackTitle,
  ) as { id: number };
  const track = db.prepare(`
    INSERT INTO Tracks (
      mbid, album_edition_id, edition_mbid, recording_id, recording_mbid,
      title, position, medium_position
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 1)
    RETURNING id
  `).get(
    trackMbid,
    release.id,
    editionMbid,
    recording.id,
    recordingMbid,
    input.trackTitle,
  ) as { id: number };
  const providerRelease = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES (?, 'release', ?, ?)
    RETURNING id
  `).get(input.provider, input.providerEditionId, input.albumTitle) as { id: number };
  const providerTrack = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES (?, 'track', ?, ?)
    RETURNING id
  `).get(input.provider, input.providerTrackId, input.trackTitle) as { id: number };
  const member = db.prepare(`
    INSERT INTO ProviderEditionMembers (
      provider_edition_item_id, member_item_id, medium_position, position
    ) VALUES (?, ?, 1, 1)
    RETURNING id
  `).get(providerRelease.id, providerTrack.id) as { id: number };
  const releaseMatch = db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 1, 'test', 1)
    RETURNING id
  `).get(providerRelease.id, release.id) as { id: number };
  const trackMatch = db.prepare(`
    INSERT INTO ProviderTrackMatches (
      provider_edition_member_id, provider_edition_match_id, track_id,
      recording_id, match_state, decision_source, confidence, method,
      matcher_version
    ) VALUES (?, ?, ?, ?, 'accepted', 'automatic', 1, 'test', 1)
    RETURNING id
  `).get(member.id, releaseMatch.id, track.id, recording.id) as { id: number };
  const quality = input.quality ?? "lossless";
  const variant = db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label,
      availability
    ) VALUES (?, ?, ?, ?, 'available')
    RETURNING id
  `).get(
    providerTrack.id,
    quality,
    quality,
    quality === "hires-lossless" ? "HIRES_LOSSLESS" : quality.toUpperCase(),
  ) as { id: number };
  const library = db.prepare(`
    SELECT id, root_path FROM Libraries WHERE name = ?
  `).get(quality === "spatial" ? "Spatial" : "Stereo") as {
    id: number;
    root_path: string;
  };
  db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, monitored, selection_mode, locked,
      reason, curation_version
    ) VALUES (?, ?, 1, 'auto', 0, 'test', 1)
  `).run(library.id, releaseGroup.id);
  const libraryRelease = db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'auto', 0, 'test', 1)
    RETURNING id
  `).get(library.id, release.id) as { id: number };
  const plan = db.prepare(`
    INSERT INTO AcquisitionPlans (
      library_edition_id, provider, composition, download_mode, state,
      planner_version, policy_hash, computed_at
    ) VALUES (?, ?, 'single_source', 'album', 'current', 1, 'test', CURRENT_TIMESTAMP)
    RETURNING id
  `).get(libraryRelease.id, input.provider) as { id: number };
  const source = db.prepare(`
    INSERT INTO AcquisitionPlanSources (
      plan_id, provider_edition_match_id, role, sort_order
    ) VALUES (?, ?, 'primary', 0)
    RETURNING id
  `).get(plan.id, releaseMatch.id) as { id: number };
  db.prepare(`
    INSERT INTO AcquisitionPlanTracks (
      plan_id, track_id, source_id, provider_track_match_id,
      provider_audio_variant_id
    ) VALUES (?, ?, ?, ?, ?)
  `).run(plan.id, track.id, source.id, trackMatch.id, variant.id);

  return {
    artistMbid,
    releaseGroupMbid,
    editionMbid,
    recordingMbid,
    trackMbid,
    releaseGroupId: releaseGroup.id,
    editionId: release.id,
    recordingId: recording.id,
    trackId: track.id,
    libraryId: library.id,
    libraryRoot: library.root_path,
    planId: plan.id,
  };
}

function seedTypedVideo(input: {
  suffix: string;
  provider: string;
  providerVideoId: string;
  artistName: string;
  title: string;
}) {
  const artistMbid = `video-artist-${input.suffix}`;
  db.prepare(`
    INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)
  `).run(artistMbid, input.artistName, artistMbid);
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get(artistMbid, input.artistName) as { id: number };
  const recording = db.prepare(`
    INSERT INTO Recordings (
      mbid, artist_metadata_id, artist_mbid, title, is_video
    ) VALUES (?, ?, ?, ?, 1)
    RETURNING id
  `).get(
    `video-recording-${input.suffix}`,
    artist.id,
    artistMbid,
    input.title,
  ) as { id: number };
  const providerVideo = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES (?, 'video', ?, ?)
    RETURNING id
  `).get(input.provider, input.providerVideoId, input.title) as { id: number };
  db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'accepted', 'automatic', 1, 'test', 1)
  `).run(providerVideo.id, recording.id);
  return {
    artistMbid,
    recordingMbid: `video-recording-${input.suffix}`,
    recordingId: recording.id,
  };
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
  const graph = seedTypedRelease({
    suffix: "gmtf",
    provider: "tidal",
    providerEditionId: "tidal-gmtf-expanded",
    providerTrackId: "tidal-gmtf-track",
    artistName: "Bastille",
    albumTitle: "Give Me the Future",
    trackTitle: "Give Me the Future",
    quality: "hires-lossless",
  });

  const payload = {
    type: "album",
    provider: "tidal",
    providerId: "tidal-gmtf-expanded",
    releaseGroupMbid: graph.releaseGroupMbid,
    editionMbid: graph.editionMbid,
    acquisitionPlanId: graph.planId,
    libraryId: graph.libraryId,
    slot: "stereo",
  };

  assert.equal(processor.hasAlbumMetadataReady("tidal-gmtf-expanded", payload), true);
  const albumMeta = processor.resolveDownloadMetadata("tidal-gmtf-expanded", "album", payload);
  assert.equal(albumMeta.title, "Give Me the Future");
  assert.equal(albumMeta.artist, "Bastille");
  assert.ok(
    String(albumMeta.cover || "").startsWith(
      `/media-cover/Albums/${graph.releaseGroupMbid}/cover.jpg?source=canonical`,
    ),
  );
  assert.equal(processor.resolveDownloadQuality("tidal-gmtf-expanded", "album", payload), "HIRES_LOSSLESS");
});

test("download processor detects canonical track and video files without ProviderMedia rows", () => {
  const processor = new DownloadProcessor() as any;
  const graph = seedTypedRelease({
    suffix: "media",
    provider: "tidal",
    providerEditionId: "tidal-album",
    providerTrackId: "tidal-track",
    artistName: "Media Artist",
    albumTitle: "Media Album",
    trackTitle: "Canonical Track",
  });
  const video = seedTypedVideo({
    suffix: "media",
    provider: "tidal",
    providerVideoId: "tidal-video",
    artistName: "Media Artist",
    title: "Canonical Video",
  });
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, release_group_id, album_edition_id, track_id, recording_id,
      library_id, file_path, relative_path, library_root, filename, extension,
      file_type, file_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'track', 'audio')
  `).run(
    graph.artistMbid,
    graph.releaseGroupId,
    graph.editionId,
    graph.trackId,
    graph.recordingId,
    graph.libraryId,
    "C:/Music/Media Artist/track.flac",
    "Media Artist/track.flac",
    graph.libraryRoot,
    "track.flac",
    "flac",
  );
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, recording_id, file_path, relative_path, library_root, filename,
      extension, file_type, file_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'video', 'video')
  `).run(
    video.artistMbid,
    video.recordingId,
    "C:/Music/Media Artist/video.mp4",
    "Media Artist/video.mp4",
    "C:/Music",
    "video.mp4",
    "mp4",
  );

  const trackPayload = {
    type: "track",
    provider: "tidal",
    providerId: "tidal-track",
    acquisitionPlanId: graph.planId,
    libraryId: graph.libraryId,
  };
  assert.equal(processor.hasTrackMetadataReady("tidal-track", trackPayload), true);
  const trackMeta = processor.resolveDownloadMetadata("tidal-track", "track", trackPayload);
  assert.equal(trackMeta.title, "Canonical Track");
  assert.equal(trackMeta.artist, "Media Artist");
  assert.ok(
    String(trackMeta.cover || "").startsWith(
      `/media-cover/Albums/${graph.releaseGroupMbid}/cover.jpg?source=canonical`,
    ),
  );
  assert.equal(
    processor.isCanonicalProviderItemDownloaded("tidal-track", "track", trackPayload),
    true,
  );

  const videoPayload = { type: "video", provider: "tidal", providerId: "tidal-video" };
  assert.equal(processor.hasVideoMetadataReady("tidal-video", videoPayload), true);
  assert.deepEqual(processor.resolveDownloadMetadata("tidal-video", "video", videoPayload), {
    title: "Canonical Video",
    artist: "Media Artist",
    cover: `/media-cover/Videos/${video.recordingId}/cover.jpg`,
  });
  assert.equal(
    processor.isCanonicalProviderItemDownloaded("tidal-video", "video", videoPayload),
    true,
  );
});

test("download processor scopes provider offers when services reuse the same resource id", () => {
  const processor = new DownloadProcessor() as any;
  const apple = seedTypedRelease({
    suffix: "apple",
    provider: "apple-music",
    providerEditionId: "42",
    providerTrackId: "7",
    artistName: "Apple Artist",
    albumTitle: "Apple Album",
    trackTitle: "Apple Track",
    quality: "hires-lossless",
  });
  const tidal = seedTypedRelease({
    suffix: "tidal",
    provider: "tidal",
    providerEditionId: "42",
    providerTrackId: "7",
    artistName: "TIDAL Artist",
    albumTitle: "TIDAL Album",
    trackTitle: "TIDAL Track",
    quality: "lossless",
  });
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, release_group_id, album_edition_id, track_id, recording_id,
      library_id, file_path, relative_path, library_root, filename, extension,
      file_type, file_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'tidal.flac', ?, 'tidal.flac', 'flac', 'track', 'audio')
  `).run(
    tidal.artistMbid,
    tidal.releaseGroupId,
    tidal.editionId,
    tidal.trackId,
    tidal.recordingId,
    tidal.libraryId,
    "C:/Music/tidal.flac",
    tidal.libraryRoot,
  );

  const appleAlbumPayload = {
    type: "album",
    provider: "apple-music",
    providerId: "42",
    acquisitionPlanId: apple.planId,
    libraryId: apple.libraryId,
  };
  const appleTrackPayload = {
    type: "track",
    provider: "apple-music",
    providerId: "7",
    acquisitionPlanId: apple.planId,
    libraryId: apple.libraryId,
  };
  const tidalTrackPayload = {
    type: "track",
    provider: "tidal",
    providerId: "7",
    acquisitionPlanId: tidal.planId,
    libraryId: tidal.libraryId,
  };

  assert.equal(processor.resolveCanonicalProviderOffer("42", "album", appleAlbumPayload)?.provider, "apple-music");
  assert.equal(processor.resolveCanonicalProviderOffer("7", "track", appleTrackPayload)?.provider, "apple-music");
  const appleTrackMeta = processor.resolveDownloadMetadata("7", "track", appleTrackPayload);
  assert.equal(appleTrackMeta.title, "Apple Track");
  assert.equal(appleTrackMeta.artist, "Apple Artist");
  assert.ok(
    String(appleTrackMeta.cover || "").startsWith(
      `/media-cover/Albums/${apple.releaseGroupMbid}/cover.jpg?source=canonical`,
    ),
  );
  assert.equal(processor.resolveDownloadQuality("7", "track", appleTrackPayload), "HIRES_LOSSLESS");
  assert.equal(processor.isCanonicalProviderItemDownloaded("7", "track", appleTrackPayload), false);
  assert.equal(processor.isCanonicalProviderItemDownloaded("7", "track", tidalTrackPayload), true);
});

test("resolveDownloadMetadata uses recording_id join when recording_mbid is null", () => {
  const processor = new DownloadProcessor() as any;
  const video = seedTypedVideo({
    suffix: "rid",
    provider: "tidal",
    providerVideoId: "tidal-video-rid",
    artistName: "Recording Id Artist",
    title: "Canonical Via Recording Id",
  });

  const resolved = processor.resolveDownloadMetadata(
    "tidal-video-rid",
    "video",
    { type: "video", providerId: "tidal-video-rid", provider: "tidal" },
  );

  assert.notEqual(resolved.title, "Unknown");
  assert.equal(resolved.title, "Canonical Via Recording Id");
  assert.equal(resolved.artist, "Recording Id Artist");
  assert.equal(resolved.cover, `/media-cover/Videos/${video.recordingId}/cover.jpg`);
});

