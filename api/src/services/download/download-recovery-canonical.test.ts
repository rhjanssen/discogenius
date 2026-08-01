import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-download-recovery-canonical-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();
const { db } = dbModule;
const { getExistingLibraryMediaIds, shouldQueueRedownloadForFailedImport } = await import("./download-recovery.js");

function resetRows() {
  db.prepare("DELETE FROM TrackFiles").run();
  // Release the deferred plan reference before its rows go.
  db.prepare("UPDATE LibraryEditions SET preferred_plan_key = NULL").run();
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
  fs.rmSync(path.join(tempDir, "library"), { recursive: true, force: true });
}

beforeEach(resetRows);
afterEach(resetRows);

test("download recovery resolves existing album files through canonical provider offers", () => {
  const filePath = path.join(tempDir, "library", "music", "Artist", "Album", "01 - Track.flac");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "audio");

  db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-local", "Artist", "artist-mbid");
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-mbid", "Artist") as { id: number };
  const releaseGroup = db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
    RETURNING id
  `).get("rg-mbid", "artist-mbid", "Album", "album") as { id: number };
  const release = db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_id, release_group_mbid, artist_metadata_id,
      artist_mbid, title, track_count, media_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    "release-mbid",
    releaseGroup.id,
    "rg-mbid",
    artist.id,
    "artist-mbid",
    "Album",
    1,
    1,
  ) as { id: number };
  const recording = db.prepare(`
    INSERT INTO Recordings (
      mbid, artist_metadata_id, artist_mbid, title, is_video
    ) VALUES (?, ?, ?, ?, ?)
    RETURNING id
  `).get("recording-mbid", artist.id, "artist-mbid", "Track", 0) as { id: number };
  const track = db.prepare(`
    INSERT INTO Tracks (
      mbid, album_edition_id, release_mbid, recording_id, recording_mbid,
      title, medium_position, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    "track-mbid",
    release.id,
    "release-mbid",
    recording.id,
    "recording-mbid",
    "Track",
    1,
    1,
  ) as { id: number };
  const providerRelease = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES (?, ?, ?, ?)
    RETURNING id
  `).get("tidal", "release", "provider-album", "Album") as { id: number };
  db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 1, 'test', 1)
  `).run(providerRelease.id, release.id);
  const library = db.prepare(`
    SELECT id, root_path FROM Libraries WHERE name = 'Stereo'
  `).get() as { id: number; root_path: string };
  db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'auto', 0, 'test', 1)
  `).run(library.id, releaseGroup.id);
  db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, reason, curation_version
    ) VALUES (?, ?, 'auto', 'test', 1)
  `).run(library.id, release.id);
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid, provider, provider_entity_type,
      provider_id, release_group_id, album_edition_id, track_id, recording_id,
      library_slot, library_id, file_path, relative_path, library_root, filename,
      extension, file_type, file_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "artist-local",
    "artist-mbid",
    "rg-mbid",
    "release-mbid",
    "track-mbid",
    "recording-mbid",
    "tidal",
    "track",
    "provider-track",
    releaseGroup.id,
    release.id,
    track.id,
    recording.id,
    "stereo",
    library.id,
    filePath,
    path.relative(library.root_path, filePath),
    library.root_path,
    "01 - Track.flac",
    "flac",
    "track",
    "audio",
  );

  const recovered = getExistingLibraryMediaIds("album", "provider-album", "tidal");

  assert.deepEqual(recovered, [String(track.id)]);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderMedia'").get(), undefined);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderAlbums'").get(), undefined);
});

test("failed imports with re-download hint queue a fresh download even when workspace exists", () => {
  const downloadPath = path.join(tempDir, "downloads", "albums", "provider-album", "job_1");
  fs.mkdirSync(downloadPath, { recursive: true });

  const shouldRedownload = shouldQueueRedownloadForFailedImport({
    id: 1,
    name: "ImportDownload",
    status: "failed",
    error: "Import files for album provider-album are no longer available. Re-download the item to retry import.",
    payload: {
      type: "album",
      providerId: "provider-album",
      path: downloadPath,
    },
  } as any);

  assert.equal(shouldRedownload, true);
});

test("download recovery scopes equal video IDs to the command provider", () => {
  const tidalPath = path.join(tempDir, "library", "videos", "tidal.mp4");
  const applePath = path.join(tempDir, "library", "videos", "apple.mp4");
  fs.mkdirSync(path.dirname(tidalPath), { recursive: true });
  fs.writeFileSync(tidalPath, "tidal-video");
  fs.writeFileSync(applePath, "apple-video");

  db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run("artist-local", "Artist", "artist-mbid");
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-mbid", "Artist") as { id: number };
  const recordings = db.prepare(`
    INSERT INTO Recordings (mbid, artist_metadata_id, artist_mbid, title, is_video)
    VALUES
      ('tidal-recording', ?, 'artist-mbid', 'Tidal video', 1),
      ('apple-recording', ?, 'artist-mbid', 'Apple video', 1)
    RETURNING id, mbid
  `).all(artist.id, artist.id) as Array<{ id: number; mbid: string }>;
  const recordingByMbid = new Map(recordings.map((recording) => [recording.mbid, recording.id]));
  const providerVideos = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'video', '99', 'Tidal video'),
    ('apple-music', 'video', '99', 'Apple video')
    RETURNING id, provider
  `).all() as Array<{ id: number; provider: string }>;
  const providerVideoByProvider = new Map(
    providerVideos.map((item) => [item.provider, item.id]),
  );
  db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES
      (?, ?, 'accepted', 'automatic', 1, 'test', 1),
      (?, ?, 'accepted', 'automatic', 1, 'test', 1)
  `).run(
    providerVideoByProvider.get("tidal"),
    recordingByMbid.get("tidal-recording"),
    providerVideoByProvider.get("apple-music"),
    recordingByMbid.get("apple-recording"),
  );
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_id, canonical_artist_mbid, canonical_recording_mbid, recording_id,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension, file_type,
      file_class
    ) VALUES
      ('artist-local', 'artist-mbid', 'tidal-recording', ?, 'tidal', 'video', '99', 'video', ?, 'tidal.mp4', ?, 'tidal.mp4', 'mp4', 'video', 'video'),
      ('artist-local', 'artist-mbid', 'apple-recording', ?, 'apple-music', 'video', '99', 'video', ?, 'apple.mp4', ?, 'apple.mp4', 'mp4', 'video', 'video')
  `).run(
    recordingByMbid.get("tidal-recording"),
    tidalPath,
    path.dirname(tidalPath),
    recordingByMbid.get("apple-recording"),
    applePath,
    path.dirname(applePath),
  );

  assert.deepEqual(
    getExistingLibraryMediaIds("video", "99", "tidal"),
    [String(recordingByMbid.get("tidal-recording"))],
  );
  assert.deepEqual(
    getExistingLibraryMediaIds("video", "99", "apple-music"),
    [String(recordingByMbid.get("apple-recording"))],
  );
});
