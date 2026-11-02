import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { seedCanonicalAlbum } from "../../test-support/normalized-provider-fixtures.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-retag-cover-"));
const musicRoot = path.join(tempDir, "stereo");
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.MUSIC_PATH = musicRoot;
process.env.SPATIAL_PATH = path.join(tempDir, "spatial");
process.env.VIDEO_PATH = path.join(tempDir, "video");
process.env.DOWNLOAD_PATH = path.join(tempDir, "downloads");

const ARTIST = "artist-andrew-bird";
const GROUP = "rg-music-of-hair";
const RELEASE = "rel-music-of-hair-2014";
const ffmpeg = spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0;

let dbModule: typeof import("../../database.js");
let configModule: typeof import("../config/config.js");
let queue: typeof import("../commands/command-queue-manager.js");
let context: typeof import("../commands/command-context.js");
let handlers: typeof import("../commands/handlers/library-handlers.js");
let workRepo: typeof import("../commands/command-file-work-repository.js");
let tags: typeof import("./audio-tag-service.js");
let failure: typeof import("./tag-write-failure.js");
let dimensions: typeof import("./audioUtils.js");

before(async () => {
  fs.mkdirSync(musicRoot, { recursive: true });
  fs.mkdirSync(process.env.SPATIAL_PATH!, { recursive: true });
  fs.mkdirSync(process.env.VIDEO_PATH!, { recursive: true });
  fs.mkdirSync(process.env.DOWNLOAD_PATH!, { recursive: true });
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  configModule = await import("../config/config.js");
  queue = await import("../commands/command-queue-manager.js");
  context = await import("../commands/command-context.js");
  handlers = await import("../commands/handlers/library-handlers.js");
  workRepo = await import("../commands/command-file-work-repository.js");
  tags = await import("./audio-tag-service.js");
  failure = await import("./tag-write-failure.js");
  dimensions = await import("./audioUtils.js");
  configModule.updateConfig("metadata", {
    ...configModule.getConfigSection("metadata"),
    write_audio_tags_policy: "all_files",
    scrub_audio_tags: false,
    album_cover_resolution: 600,
    save_lyrics: false,
  });
  configModule.updateConfig("quality", {
    ...configModule.getConfigSection("quality"),
    embed_cover: true,
    embed_lyrics: false,
  });
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function corruptJpeg(): Buffer {
  const buffer = Buffer.alloc(32, 0);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xc0;
  buffer.writeUInt16BE(0x000b, 4);
  buffer[6] = 0xf7;
  buffer.writeUInt16BE(2000, 7);
  buffer.writeUInt16BE(2000, 9);
  buffer[11] = 1;
  return buffer;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function stereoLibrary(): { id: number; root_path: string } {
  return dbModule.db.prepare("SELECT id, root_path FROM Libraries WHERE name = 'Stereo'").get() as {
    id: number;
    root_path: string;
  };
}

function artistId(): number {
  return (dbModule.db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = ?").get(ARTIST) as { id: number }).id;
}

function writeFlac(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const generated = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "0.2", "-c:a", "flac", filePath,
  ], { windowsHide: true, encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
}

function insertTrack(filePath: string, trackMbid: string, recordingMbid: string): number {
  const library = stereoLibrary();
  return (dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, library_id, track_id, recording_id,
      canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid,
      file_path, relative_path, library_root, filename, extension, file_type, library_slot, quality
    ) VALUES (
      ?, ?, (SELECT id FROM Tracks WHERE mbid = ?), (SELECT id FROM Recordings WHERE mbid = ?),
      ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?, 'flac', 'track', 'stereo', 'LOSSLESS'
    ) RETURNING id
  `).get(
    artistId(),
    library.id,
    trackMbid,
    recordingMbid,
    ARTIST,
    GROUP,
    RELEASE,
    trackMbid,
    recordingMbid,
    filePath,
    path.relative(library.root_path, filePath),
    library.root_path,
    path.basename(filePath),
  ) as { id: number }).id;
}

test("field read-back is a warning and layout or permission failure stays an error", () => {
  const informational = [
    "TagLib verification failed for ALBUM",
    "Multi-value verification failed for ARTIST",
    "Artist ID verification failed for MUSICBRAINZ_ARTISTID",
    "ISRC verification failed for ISRC",
    "TagLib removal verification failed for COMMENT",
    "TagLib cover verification failed",
  ];
  for (const message of informational) assert.equal(failure.metadataWriteFailureKind(message), "warning", message);
  const damage = [
    "MP4 layout became unreadable",
    "MP4 ftyp changed",
    "MP4 mdat payload length changed",
    "MP4 audio sample entry changed",
    "MP4 mdat moved",
    "MP4 chunk offsets changed",
    "TagLib clear verification failed",
    "EACCES: permission denied, open '/music/track.flac'",
    "EROFS: read-only file system",
    "EPERM: operation not permitted",
    "permission denied",
    "EBUSY: resource busy",
    "Metadata write failed",
    "MP4 mdat moved; TagLib verification failed for TITLE",
  ];
  for (const message of damage) assert.equal(failure.metadataWriteFailureKind(message), "error", message);
});

test("a corrupt album cover does not fail the retag and is not left as the canonical cover", { skip: !ffmpeg }, async () => {
  seedCanonicalAlbum(dbModule.db, {
    artistMbid: ARTIST,
    artistName: "Andrew Bird",
    releaseGroupMbid: GROUP,
    releaseMbid: RELEASE,
    title: "Music of Hair",
    tracks: [
      { trackMbid: "track-hair-1", recordingMbid: "rec-hair-1", title: "Nyatiti", position: 1 },
      { trackMbid: "track-hair-2", recordingMbid: "rec-hair-2", title: "Respiration", position: 2 },
    ],
  });
  const albumDir = path.join(musicRoot, "Andrew Bird", "Music of Hair (2014)");
  const first = path.join(albumDir, "01 Nyatiti.flac");
  const second = path.join(albumDir, "02 Respiration.flac");
  writeFlac(first);
  writeFlac(second);
  const ids = [
    insertTrack(first, "track-hair-1", "rec-hair-1"),
    insertTrack(second, "track-hair-2", "rec-hair-2"),
  ];
  const bytes = corruptJpeg();
  const corruptHash = sha256(bytes);
  const coverPath = path.join(albumDir, "cover.jpg");
  fs.writeFileSync(coverPath, bytes);
  dbModule.db.prepare(`
    INSERT INTO ArtworkSources (cover_entity, entity_id, cover_type, source_url, preference, fulfilled_by, content_hash)
    VALUES ('Album', ?, 'cover', 'http://127.0.0.1:9/cover.jpg', 'canonical', 'canonical', ?)
  `).run(GROUP, corruptHash);
  dbModule.db.prepare(`
    INSERT INTO ArtworkLibraryLinks (cover_entity, entity_id, cover_type, file_path, content_hash)
    VALUES ('Album', ?, 'cover', ?, ?)
  `).run(GROUP, coverPath, corruptHash);

  const commandId = queue.CommandQueueManager.push(queue.CommandNames.RetagFiles, { ids });
  const job = queue.CommandQueueManager.claimForExecution(commandId, "cover-repair", 60_000);
  if (!job || job.name !== "RetagFiles") throw new Error("RetagFiles was not claimed");
  const descriptions: string[] = [];
  const ctx = context.buildHandlerContext();
  const update = ctx.updateCommandDescription.bind(ctx);
  ctx.updateCommandDescription = (current, options) => {
    if (options.description) descriptions.push(options.description);
    update(current, options);
  };
  let handlerError: unknown = null;
  try {
    await handlers.handleRetagFiles(job, ctx);
  } catch (error) {
    handlerError = error;
  }
  assert.equal(handlerError, null, handlerError instanceof Error ? handlerError.message : String(handlerError));
  assert.equal(await context.persistCommandOutcome(job, null), "completed");
  const stored = dbModule.db.prepare("SELECT status FROM commands WHERE id = ?").get(commandId) as { status: string };
  assert.equal(stored.status, "completed");
  const summary = descriptions.at(-1) || "";
  assert.match(summary, /Retagged 2 file\(s\), 0 missing, 0 error\(s\), 1 warning\(s\):/);
  assert.match(summary, /unreadable/i);
  assert.equal(workRepo.CommandFileWorkRepository.errors(commandId).length, 0);
  assert.equal((dbModule.db.prepare("SELECT COUNT(*) AS n FROM TrackFiles WHERE id IN (SELECT value FROM json_each(?))").get(JSON.stringify(ids)) as { n: number }).n, 2);
  if (fs.existsSync(coverPath)) {
    const kept = fs.readFileSync(coverPath);
    assert.notEqual(sha256(kept), corruptHash);
    assert.ok(dimensions.readImageDimensionsFromBuffer(kept));
  }
  for (const filePath of [first, second]) {
    const probed = spawnSync("ffprobe", [
      "-v", "error", "-show_entries", "format_tags=title", "-of", "default=nw=1:nk=1", filePath,
    ], { windowsHide: true, encoding: "utf8" });
    assert.equal(probed.status, 0, probed.stderr);
    assert.ok(probed.stdout.trim().length > 0, probed.stdout);
  }
});

test("an informational verification notice completes the command", async (t) => {
  const folder = path.join(musicRoot, "Notices");
  fs.mkdirSync(folder, { recursive: true });
  const filePath = path.join(folder, "notice.flac");
  fs.writeFileSync(filePath, "not-audio");
  const artist = dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES ('notice-artist', 'Notice Artist')").run().lastInsertRowid;
  const id = Number(dbModule.db.prepare(`
    INSERT INTO TrackFiles (artist_metadata_id, file_path, filename, relative_path, library_root, extension, file_type, library_slot)
    VALUES (?, ?, 'notice.flac', 'notice.flac', ?, 'flac', 'track', 'stereo')
  `).run(artist, filePath, musicRoot).lastInsertRowid);
  t.mock.method(tags.AudioTagService, "createRetagSession", () => ({
    apply: async () => ({ retagged: 0, skipped: 1, missing: 0, errors: [] }),
    warmAlbumCovers: async () => {},
    warnings: () => ["TagLib verification failed for ALBUM"],
    close: () => {},
  }));
  const commandId = queue.CommandQueueManager.push(queue.CommandNames.RetagFiles, { ids: [id] });
  const job = queue.CommandQueueManager.claimForExecution(commandId, "verification-notice", 60_000);
  if (!job || job.name !== "RetagFiles") throw new Error("RetagFiles was not claimed");
  const descriptions: string[] = [];
  const ctx = context.buildHandlerContext();
  const update = ctx.updateCommandDescription.bind(ctx);
  ctx.updateCommandDescription = (current, options) => {
    if (options.description) descriptions.push(options.description);
    update(current, options);
  };
  await handlers.handleRetagFiles(job, ctx);
  assert.equal(await context.persistCommandOutcome(job, null), "completed");
  assert.match(descriptions.at(-1) || "", /0 error\(s\), 1 warning\(s\): TagLib verification failed for ALBUM/);
  assert.equal(workRepo.CommandFileWorkRepository.errors(commandId).length, 0);
});

test("a read-only album directory reports the permission cause", { skip: !ffmpeg }, async () => {
  const release = "rel-readonly";
  const group = "rg-readonly";
  seedCanonicalAlbum(dbModule.db, {
    artistMbid: "artist-readonly",
    artistName: "Read Only",
    releaseGroupMbid: group,
    releaseMbid: release,
    title: "Locked",
    tracks: [{ trackMbid: "track-locked", recordingMbid: "rec-locked", title: "Locked Song", position: 1 }],
  });
  const albumDir = path.join(musicRoot, "Read Only", "Locked");
  const filePath = path.join(albumDir, "01 Locked Song.flac");
  writeFlac(filePath);
  const library = stereoLibrary();
  const owner = (dbModule.db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-readonly'").get() as { id: number }).id;
  const id = (dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, library_id, track_id, recording_id,
      canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid,
      file_path, relative_path, library_root, filename, extension, file_type, library_slot, quality
    ) VALUES (
      ?, ?, (SELECT id FROM Tracks WHERE mbid = 'track-locked'), (SELECT id FROM Recordings WHERE mbid = 'rec-locked'),
      'artist-readonly', ?, ?,
      'track-locked', 'rec-locked',
      ?, ?, ?, ?, 'flac', 'track', 'stereo', 'LOSSLESS'
    ) RETURNING id
  `).get(
    owner, library.id, group, release, filePath,
    path.relative(library.root_path, filePath), library.root_path, path.basename(filePath),
  ) as { id: number }).id;
  fs.chmodSync(albumDir, 0o555);
  try {
    const result = await tags.AudioTagService.apply([id]);
    assert.equal(result.errors.length, 1);
    assert.equal(result.retagged, 0);
    const message = result.errors[0]?.error || "";
    assert.notEqual(message, "Metadata write failed");
    assert.match(message, /EACCES|EPERM|EROFS|permission denied|read-only/i);
  } finally {
    fs.chmodSync(albumDir, 0o755);
  }
});
