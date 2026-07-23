import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-acquisition-plan-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let acquisitionModule: typeof import("./release-group-acquisition-plan.js");
let queueModule: typeof import("../commands/command-names.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  acquisitionModule = await import("./release-group-acquisition-plan.js");
  queueModule = await import("../commands/command-names.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM commands").run();
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumReleases").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM Artists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedCatalogAlbum(opts: {
  releaseGroupMbid: string;
  releaseMbid: string;
  tracks: Array<{ trackMbid: string; recordingMbid: string; title: string; position: number }>;
}) {
  const { db } = dbModule;
  db.prepare(`
    INSERT OR IGNORE INTO ArtistMetadata (mbid, name) VALUES ('artist-mbid', 'Bastille')
  `).run();
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, 'artist-mbid', 'Hybrid Album', 'Album')
  `).run(opts.releaseGroupMbid);
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, date, track_count, media_count)
    VALUES (?, ?, 'artist-mbid', 'Hybrid Album', '2020-01-01', ?, 1)
  `).run(opts.releaseMbid, opts.releaseGroupMbid, opts.tracks.length);
  for (const track of opts.tracks) {
    db.prepare(`
      INSERT OR IGNORE INTO Recordings (mbid, title) VALUES (?, ?)
    `).run(track.recordingMbid, track.title);
    db.prepare(`
      INSERT INTO Tracks (mbid, recording_mbid, release_mbid, title, position, medium_position, number)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(
      track.trackMbid,
      track.recordingMbid,
      opts.releaseMbid,
      track.title,
      track.position,
      String(track.position),
    );
  }
}

test("queueTrackAcquisitionPlan queues one DownloadAlbum with trackOffers for quality-optimized composites", () => {
  const releaseGroupMbid = "b1b81699-4273-492e-a8ce-7fa98fac7a93";
  const releaseMbid = "fab7ff68-52e8-45e4-9218-c4eb369c4bc2";
  seedCatalogAlbum({
    releaseGroupMbid,
    releaseMbid,
    tracks: [
      { trackMbid: "t-softly", recordingMbid: "rec-softly", title: "Killing Me Softly", position: 1 },
      { trackMbid: "t-pompeii", recordingMbid: "rec-pompeii", title: "Pompeii", position: 2 },
      { trackMbid: "t-nirvana", recordingMbid: "rec-nirvana", title: "Come as You Are", position: 3 },
    ],
  });

  const evidence = JSON.stringify({
    matchKind: "composite",
    trackSources: [
      {
        canonicalTrackMbid: "t-softly",
        canonicalRecordingMbid: "rec-softly",
        providerTrackId: "trk-softly",
        providerAlbumId: "290132977",
        quality: "HIRES_LOSSLESS",
        title: "Killing Me Softly",
        trackNum: 1,
        volumeNum: 1,
      },
      {
        canonicalTrackMbid: "t-pompeii",
        canonicalRecordingMbid: "rec-pompeii",
        providerTrackId: "trk-pompeii",
        providerAlbumId: "287367980",
        quality: "HIRES_LOSSLESS",
        title: "Pompeii",
        trackNum: 2,
        volumeNum: 1,
      },
      {
        canonicalTrackMbid: "t-nirvana",
        canonicalRecordingMbid: "rec-nirvana",
        providerTrackId: "trk-nirvana",
        providerAlbumId: "287367980",
        quality: "HIRES_LOSSLESS",
        title: "Come as You Are",
        trackNum: 3,
        volumeNum: 1,
      },
    ],
  });

  const result = acquisitionModule.queueTrackAcquisitionPlan({
    slot: "stereo",
    selected_provider: "tidal",
    selected_provider_id: "290132977;287367980",
    selected_release_mbid: releaseMbid,
    release_group_mbid: releaseGroupMbid,
    match_method: "quality_optimized_composite_track_coverage",
    match_evidence: evidence,
    title: "Killing Me Softly With His Song (MTV Unplugged)",
    artist_name: "Bastille",
  });

  assert.equal(result.recognized, true);
  assert.equal(result.commandIds.length, 1);

  const { db } = dbModule;
  const albumJobs = db.prepare(`
    SELECT payload FROM commands WHERE name = ?
  `).all(queueModule.CommandNames.DownloadAlbum) as Array<{ payload: string }>;
  assert.equal(albumJobs.length, 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM commands WHERE name = ?")
      .get(queueModule.CommandNames.DownloadTrack) as { count: number }).count,
    0,
  );

  const payload = JSON.parse(albumJobs[0].payload);
  assert.equal(payload.acquisitionMode, "trackOffers");
  assert.equal(payload.providerId, "290132977;287367980");
  assert.equal(payload.trackOffers.length, 3);
  assert.deepEqual(
    payload.trackOffers.map((offer: { providerTrackId: string }) => offer.providerTrackId).sort(),
    ["trk-nirvana", "trk-pompeii", "trk-softly"],
  );
  assert.deepEqual(
    payload.trackOffers
      .map((offer: { providerTrackId: string; providerAlbumId?: string }) => [
        offer.providerTrackId,
        offer.providerAlbumId,
      ])
      .sort((a: string[], b: string[]) => a[0].localeCompare(b[0])),
    [
      ["trk-nirvana", "287367980"],
      ["trk-pompeii", "287367980"],
      ["trk-softly", "290132977"],
    ],
  );
  assert.equal(payload.downloadState.tracks.length, 3);
});

test("queueCatalogAlbumDownload skips present tracks and only offers missing ones", () => {
  const releaseGroupMbid = "rg-partial";
  const releaseMbid = "rel-partial";
  seedCatalogAlbum({
    releaseGroupMbid,
    releaseMbid,
    tracks: [
      { trackMbid: "t-1", recordingMbid: "rec-1", title: "One", position: 1 },
      { trackMbid: "t-2", recordingMbid: "rec-2", title: "Two", position: 2 },
    ],
  });

  const { db } = dbModule;
  db.prepare(`
    INSERT OR IGNORE INTO ArtistMetadata (mbid, name) VALUES ('artist-mbid', 'Artist')
  `).run();
  db.prepare(`
    INSERT INTO Artists (id, mbid, name, monitored) VALUES (1, 'artist-mbid', 'Artist', 1)
  `).run();
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, file_type, library_slot, library_root, file_path, relative_path, filename, extension,
      canonical_track_mbid, canonical_recording_mbid
    ) VALUES (1, 'track', 'stereo', 'music', '/tmp/one.flac', 'Artist/Album/01 One.flac', '01 One.flac', 'flac', 't-1', 'rec-1')
  `).run();
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, provider_id, entity_type, provider_album_id, recording_mbid, title, quality
    ) VALUES
      ('tidal', 'trk-1', 'track', 'album-1', 'rec-1', 'One', 'HIGH'),
      ('tidal', 'trk-2', 'track', 'album-1', 'rec-2', 'Two', 'HIGH')
  `).run();

  const result = acquisitionModule.queueCatalogAlbumDownload({
    slot: "stereo",
    selected_provider: "tidal",
    selected_provider_id: "album-1",
    selected_release_mbid: releaseMbid,
    release_group_mbid: releaseGroupMbid,
    title: "Partial",
    artist_name: "Artist",
    quality: "HIGH",
  });

  assert.equal(result.queued, true);
  assert.ok(result.commandId);

  const payload = JSON.parse(
    (db.prepare("SELECT payload FROM commands WHERE id = ?").get(result.commandId) as { payload: string }).payload,
  );
  assert.equal(payload.acquisitionMode, "trackOffers");
  assert.equal(payload.trackOffers.length, 1);
  assert.equal(payload.trackOffers[0].providerTrackId, "trk-2");
  assert.equal(payload.downloadState.tracks[0].status, "skipped");
  assert.equal(payload.downloadState.tracks[1].status, "queued");
});

test("queueCatalogAlbumDownload uses album mode when everything is missing for a normal match", () => {
  const releaseGroupMbid = "rg-full";
  const releaseMbid = "rel-full";
  seedCatalogAlbum({
    releaseGroupMbid,
    releaseMbid,
    tracks: [
      { trackMbid: "t-a", recordingMbid: "rec-a", title: "A", position: 1 },
    ],
  });

  const result = acquisitionModule.queueCatalogAlbumDownload({
    slot: "stereo",
    selected_provider: "tidal",
    selected_provider_id: "album-full",
    selected_release_mbid: releaseMbid,
    release_group_mbid: releaseGroupMbid,
    title: "Full",
    artist_name: "Artist",
    quality: "LOSSLESS",
  });

  assert.equal(result.queued, true);
  const { db } = dbModule;
  const payload = JSON.parse(
    (db.prepare("SELECT payload FROM commands WHERE id = ?").get(result.commandId) as { payload: string }).payload,
  );
  assert.equal(payload.acquisitionMode, "album");
  assert.equal(payload.providerId, "album-full");
  assert.equal(payload.trackOffers, undefined);
});

test("SoundCloud playlist coverage acquires the exact matched tracks, not the mutable set", () => {
  const releaseGroupMbid = "rg-soundcloud-mixtape";
  const releaseMbid = "rel-soundcloud-mixtape";
  seedCatalogAlbum({
    releaseGroupMbid,
    releaseMbid,
    tracks: [
      { trackMbid: "t-sc-a", recordingMbid: "rec-sc-a", title: "A", position: 1 },
      { trackMbid: "t-sc-b", recordingMbid: "rec-sc-b", title: "B", position: 2 },
    ],
  });
  const evidence = JSON.stringify({
    matchKind: "direct",
    trackSources: [
      {
        canonicalTrackMbid: "t-sc-a",
        canonicalRecordingMbid: "rec-sc-a",
        providerTrackId: "1001",
        providerAlbumId: "220003151",
        title: "A",
        trackNum: 1,
        volumeNum: 1,
      },
      {
        canonicalTrackMbid: "t-sc-b",
        canonicalRecordingMbid: "rec-sc-b",
        providerTrackId: "1002",
        providerAlbumId: "220003151",
        title: "B",
        trackNum: 2,
        volumeNum: 1,
      },
    ],
  });

  const result = acquisitionModule.queueCatalogAlbumDownload({
    slot: "stereo",
    selected_provider: "soundcloud",
    selected_provider_id: "220003151",
    selected_release_mbid: releaseMbid,
    release_group_mbid: releaseGroupMbid,
    match_method: "playlist-tracklist-coverage",
    match_evidence: evidence,
    title: "Other People's Heartache",
    artist_name: "Bastille",
    quality: "SOUNDCLOUD_LOSSY",
  });

  assert.equal(result.queued, true);
  const payload = JSON.parse(
    (dbModule.db.prepare("SELECT payload FROM commands WHERE id = ?")
      .get(result.commandId) as { payload: string }).payload,
  );
  assert.equal(payload.acquisitionMode, "trackOffers");
  assert.equal(payload.url, null);
  assert.deepEqual(
    payload.trackOffers.map((offer: { providerTrackId: string }) => offer.providerTrackId),
    ["1001", "1002"],
  );
});

test("queueCatalogAlbumDownload uses match_evidence trackSources when ProviderItems lack MBIDs for missing discs", () => {
  const releaseGroupMbid = "rg-gmtf-stereo";
  const releaseMbid = "rel-gmtf-3vol";
  seedCatalogAlbum({
    releaseGroupMbid,
    releaseMbid,
    tracks: [
      { trackMbid: "t-v1", recordingMbid: "rec-v1", title: "Distorted Light Beam", position: 1 },
      { trackMbid: "t-v3", recordingMbid: "rec-v3", title: "Running Away", position: 2 },
    ],
  });

  const { db } = dbModule;
  db.prepare(`
    INSERT OR IGNORE INTO ArtistMetadata (mbid, name) VALUES ('artist-mbid', 'Bastille')
  `).run();
  db.prepare(`
    INSERT INTO Artists (id, mbid, name, monitored) VALUES (1, 'artist-mbid', 'Bastille', 1)
  `).run();
  // Only disc 1 is on disk; disc/volume trailing tracks are missing.
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, file_type, library_slot, library_root, file_path, relative_path, filename, extension,
      canonical_track_mbid, canonical_recording_mbid
    ) VALUES (1, 'track', 'stereo', 'music', '/tmp/v1.flac', 'Bastille/Album/101.flac', '101.flac', 'flac', 't-v1', 'rec-v1')
  `).run();
  // ProviderItems exist but trailing disc has no track/recording MBIDs (ISRC-only).
  db.prepare(`
    INSERT INTO ProviderItems (
      provider, provider_id, entity_type, provider_album_id, recording_mbid, track_mbid, isrc, title, quality
    ) VALUES
      ('tidal', 'trk-v1', 'track', '243864035', 'rec-v1', 't-v1', 'ISRC1', 'Distorted Light Beam', 'HIRES_LOSSLESS'),
      ('tidal', 'trk-v3', 'track', '243864035', NULL, NULL, 'ISRC3', 'Running Away', 'HIRES_LOSSLESS')
  `).run();
  // Seed recording ISRC so album-offer ISRC fallback also works — but wipe
  // recording ISRCs to force evidence trackSources path.
  db.prepare(`UPDATE Recordings SET isrcs = NULL WHERE mbid = 'rec-v3'`).run();

  const evidence = JSON.stringify({
    matchKind: "direct",
    trackSources: [
      {
        canonicalTrackMbid: "t-v1",
        canonicalRecordingMbid: "rec-v1",
        providerTrackId: "trk-v1",
        providerAlbumId: "243864035",
        title: "Distorted Light Beam",
        trackNum: 1,
        volumeNum: 1,
      },
      {
        canonicalTrackMbid: "t-v3",
        canonicalRecordingMbid: "rec-v3",
        providerTrackId: "trk-v3",
        providerAlbumId: "243864035",
        title: "Running Away",
        trackNum: 6,
        volumeNum: 3,
      },
    ],
  });

  const result = acquisitionModule.queueCatalogAlbumDownload({
    slot: "stereo",
    selected_provider: "tidal",
    selected_provider_id: "243864035",
    selected_release_mbid: releaseMbid,
    release_group_mbid: releaseGroupMbid,
    match_method: "musicbrainz-recording-isrc",
    match_evidence: evidence,
    title: "Give Me the Future",
    artist_name: "Bastille",
    quality: "HIRES_LOSSLESS",
  });

  assert.equal(result.queued, true);
  assert.equal(result.recognizedHybrid, false);
  const payload = JSON.parse(
    (db.prepare("SELECT payload FROM commands WHERE id = ?").get(result.commandId) as { payload: string }).payload,
  );
  assert.equal(payload.acquisitionMode, "trackOffers");
  assert.equal(payload.trackOffers.length, 1);
  assert.equal(payload.trackOffers[0].providerTrackId, "trk-v3");
  assert.equal(payload.trackOffers[0].canonicalTrackMbid, "t-v3");
  assert.equal(payload.downloadState.tracks[0].status, "skipped");
  assert.equal(payload.downloadState.tracks[1].status, "queued");
});

test("queueTrackAcquisitionPlan recognizes strict_composite_track_coverage with trackSources", () => {
  const evidence = JSON.stringify({
    matchKind: "composite",
    trackSources: [
      {
        canonicalTrackMbid: "t-a",
        canonicalRecordingMbid: "rec-a",
        providerTrackId: "trk-a",
        providerAlbumId: "album-a",
        title: "A",
      },
      {
        canonicalTrackMbid: "t-b",
        canonicalRecordingMbid: "rec-b",
        providerTrackId: "trk-b",
        providerAlbumId: "album-b",
        title: "B",
      },
    ],
  });

  const result = acquisitionModule.queueTrackAcquisitionPlan({
    slot: "stereo",
    selected_provider: "tidal",
    selected_provider_id: "album-a;album-b",
    match_method: "strict_composite_track_coverage",
    match_evidence: evidence,
    release_group_mbid: "rg-hybrid-2",
    title: "Hybrid",
    artist_name: "Artist",
  });

  assert.equal(result.recognized, true);
  assert.equal(result.commandIds.length, 1);

  const { db } = dbModule;
  const payload = JSON.parse(
    (db.prepare("SELECT payload FROM commands WHERE id = ?").get(result.commandIds[0]) as { payload: string }).payload,
  );
  assert.equal(payload.providerId, "album-a;album-b");
  assert.equal(payload.acquisitionMode, "trackOffers");
  assert.deepEqual(
    payload.trackOffers
      .map((offer: { providerTrackId: string; providerAlbumId?: string }) => [
        offer.providerTrackId,
        offer.providerAlbumId,
      ])
      .sort((a: string[], b: string[]) => a[0].localeCompare(b[0])),
    [
      ["trk-a", "album-a"],
      ["trk-b", "album-b"],
    ],
  );
});
