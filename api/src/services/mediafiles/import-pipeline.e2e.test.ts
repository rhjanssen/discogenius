/**
 * End-to-end import through the real pipeline on a temporary library:
 * staged download -> disk admission (album-folder lock + HDD permit) ->
 * organize -> SQLite write -> tag write -> embedded cover -> TrackFiles rows.
 *
 * The import is started the way the download processor starts it in
 * production: from a queue wake scheduled by a command-status event that was
 * emitted inside a SQLite write section. Deploy d2ae132a failed every import
 * on that path ("album folder lock requested while the SQLite write gate is
 * held") because the gate's async context leaked into the wake.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { seedAcceptedProviderTrackMatch, seedCanonicalAlbum } from "../../test-support/normalized-provider-fixtures.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-import-pipeline-"));
const musicRoot = path.join(tempDir, "stereo");
const downloadRoot = path.join(tempDir, "downloads");
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.MUSIC_PATH = musicRoot;
process.env.SPATIAL_PATH = path.join(tempDir, "spatial");
process.env.VIDEO_PATH = path.join(tempDir, "video");
process.env.DOWNLOAD_PATH = downloadRoot;
// Offline: catalogue refresh, artwork and lyric lookups must fail fast.
process.env.HTTP_PROXY = "http://127.0.0.1:9";
process.env.HTTPS_PROXY = "http://127.0.0.1:9";
process.env.NO_PROXY = "";

const ARTIST_MBID = "artist-pipeline";

let dbModule: typeof import("../../database.js");
let importModule: typeof import("./downloaded-tracks-import-service.js");
let queueModule: typeof import("../commands/command-queue-manager.js");
let configModule: typeof import("../config/config.js");
let coversModule: typeof import("../metadata/media-cover-service.js");
let eventsModule: typeof import("../commands/app-events.js");
let mm: typeof import("music-metadata");

type AlbumFixture = {
  providerId: string;
  releaseGroupMbid: string;
  releaseMbid: string;
  title: string;
  tracks: Array<{ providerTrackId: string; trackMbid: string; recordingMbid: string; title: string; position: number }>;
};

function album(key: string, title: string): AlbumFixture {
  return {
    providerId: `${key}-release`,
    releaseGroupMbid: `rg-${key}`,
    releaseMbid: `rel-${key}`,
    title,
    tracks: [1, 2].map((position) => ({
      providerTrackId: `${key}track${position}`,
      trackMbid: `track-${key}-${position}`,
      recordingMbid: `recording-${key}-${position}`,
      title: `${title} Song ${position}`,
      position,
    })),
  };
}

const FIRST = album("first", "First Album");
const SECOND = album("second", "Second Album");
const THIRD = album("third", "Third Album");

before(async () => {
  for (const dir of [musicRoot, process.env.SPATIAL_PATH!, process.env.VIDEO_PATH!, downloadRoot]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  importModule = await import("./downloaded-tracks-import-service.js");
  queueModule = await import("../commands/command-queue-manager.js");
  configModule = await import("../config/config.js");
  coversModule = await import("../metadata/media-cover-service.js");
  eventsModule = await import("../commands/app-events.js");
  mm = await import("music-metadata");
  const config = configModule.readConfig();
  config.metadata.save_album_cover = false;
  config.metadata.save_artist_picture = false;
  config.metadata.save_video_thumbnail = false;
  config.metadata.embed_video_thumbnail = false;
  config.metadata.save_nfo = false;
  config.metadata.save_lyrics = false;
  config.metadata.write_audio_tags_policy = "all_files";
  config.quality.embed_cover = true;
  configModule.writeConfig(config);
  const refresh = await import("../music/refresh-album-service.js");
  refresh.RefreshAlbumService.refreshMetadata = async () => {};
  refresh.RefreshAlbumService.refreshTracks = async () => {};
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || `${command} failed`);
}

function seed(fixture: AlbumFixture): void {
  seedCanonicalAlbum(dbModule.db, {
    artistMbid: ARTIST_MBID,
    artistName: "Pipeline Artist",
    releaseGroupMbid: fixture.releaseGroupMbid,
    releaseMbid: fixture.releaseMbid,
    title: fixture.title,
    tracks: fixture.tracks.map(({ trackMbid, recordingMbid, title, position }) => ({ trackMbid, recordingMbid, title, position })),
  });
  dbModule.db.prepare(`
    UPDATE AlbumEditions SET release_group_id = (SELECT id FROM Albums WHERE mbid = AlbumEditions.release_group_mbid)
  `).run();
  dbModule.db.prepare(`
    UPDATE Tracks SET album_edition_id = (SELECT id FROM AlbumEditions WHERE mbid = Tracks.release_mbid)
  `).run();
  for (const track of fixture.tracks) {
    seedAcceptedProviderTrackMatch(dbModule.db, {
      provider: "tidal",
      providerEditionId: fixture.providerId,
      providerTrackId: track.providerTrackId,
      releaseMbid: fixture.releaseMbid,
      trackMbid: track.trackMbid,
      quality: "LOSSLESS",
    });
  }
  // Cached album art: the import embeds it without a network fetch.
  const cover = coversModule.getMediaCoverPath(fixture.releaseGroupMbid, "Album", "cover", ".jpg");
  fs.mkdirSync(path.dirname(cover), { recursive: true });
  run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=600x600", "-frames:v", "1", cover]);
}

/** A finished provider download: real FLAC files carrying provider-style tags. */
function stage(fixture: AlbumFixture): string {
  const staging = path.join(downloadRoot, "albums", "tidal", fixture.providerId);
  fs.mkdirSync(staging, { recursive: true });
  for (const track of fixture.tracks) {
    run("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", `sine=frequency=${400 + track.position * 40}:sample_rate=44100:duration=0.3`,
      "-metadata", `title=provider title ${track.position}`,
      "-metadata", "album=provider album (Deluxe)",
      "-c:a", "flac",
      path.join(staging, `${track.providerTrackId}.flac`),
    ]);
  }
  return staging;
}

function stereoLibraryId(): number {
  return (dbModule.db.prepare("SELECT id FROM Libraries WHERE name = 'Stereo'").get() as { id: number }).id;
}

function importJob(fixture: AlbumFixture, staging: string) {
  const id = queueModule.CommandQueueManager.push(queueModule.CommandNames.DownloadAlbum, {
    providerId: fixture.providerId, provider: "tidal", type: "album",
  } as any);
  return {
    id,
    name: queueModule.CommandNames.ImportDownload,
    payload: {
      type: "album",
      providerId: fixture.providerId,
      provider: "tidal",
      path: staging,
      libraryId: stereoLibraryId(),
      releaseGroupMbid: fixture.releaseGroupMbid,
      releaseMbid: fixture.releaseMbid,
      slot: "stereo",
    },
    status: "started",
    progress: 0,
    priority: 0,
    attempts: 0,
    created_at: new Date().toISOString(),
  } as any;
}

/**
 * Start `work` the way DownloadProcessor.scheduleNext does after a
 * command-status event emitted inside a SQLite write section: a setImmediate
 * created while the gate is held, run after the gate is released.
 */
async function startFromQueueWake<T>(work: () => Promise<T>): Promise<T> {
  let woken!: Promise<T>;
  const wake = () => {
    woken = new Promise<T>((resolve, reject) => setImmediate(() => work().then(resolve, reject)));
  };
  eventsModule.appEvents.once(eventsModule.AppEvent.COMMAND_UPDATED, wake);
  await dbModule.withSqliteWriteGate(() => {
    eventsModule.appEvents.emit(eventsModule.AppEvent.COMMAND_UPDATED, { id: 0, type: "DownloadAlbum", status: "completed", progress: 100 } as any);
  }, "test:status-event");
  assert.ok(woken, "the status event did not schedule the wake");
  return woken;
}

async function importAlbum(fixture: AlbumFixture): Promise<void> {
  const staging = stage(fixture);
  const job = importJob(fixture, staging);
  const states: Array<{ state?: string; description?: string }> = [];
  await importModule.DownloadedTracksImportService.process(job, { updateState: (state) => states.push(state) });
  assert.equal(states.some((state) => state.state === "failed" || state.state === "importFailed"), false,
    JSON.stringify(states.filter((state) => state.state === "failed" || state.state === "importFailed")));
}

type FileRow = { id: number; file_path: string; canonical_track_mbid: string | null; canonical_release_mbid: string | null };

function trackFiles(fixture: AlbumFixture): FileRow[] {
  return dbModule.db.prepare(`
    SELECT id, file_path, canonical_track_mbid, canonical_release_mbid
    FROM TrackFiles
    WHERE file_type = 'track' AND canonical_release_mbid = ?
    ORDER BY canonical_track_mbid
  `).all(fixture.releaseMbid) as FileRow[];
}

async function assertImported(fixture: AlbumFixture, albumTitle = fixture.title): Promise<FileRow[]> {
  const rows = trackFiles(fixture);
  assert.deepEqual(rows.map((row) => row.canonical_track_mbid), fixture.tracks.map((track) => track.trackMbid).sort());
  for (const row of rows) {
    assert.ok(row.file_path.startsWith(musicRoot), `${row.file_path} is outside the library`);
    assert.equal(fs.existsSync(row.file_path), true, `${row.file_path} is missing`);
    const metadata = await mm.parseFile(row.file_path);
    const vorbis = Object.fromEntries((metadata.native.vorbis ?? []).map((tag) => [tag.id.toUpperCase(), String(tag.value)]));
    const track = fixture.tracks.find((candidate) => candidate.trackMbid === row.canonical_track_mbid)!;
    // Picard convention: TRACKID is the recording, RELEASETRACKID the release track.
    assert.equal(vorbis.MUSICBRAINZ_TRACKID, track.recordingMbid, "recording MBID was not written");
    assert.equal(vorbis.MUSICBRAINZ_RELEASETRACKID, track.trackMbid, "release track MBID was not written");
    assert.equal(vorbis.MUSICBRAINZ_ALBUMID, fixture.releaseMbid, "release MBID was not written");
    assert.equal(metadata.common.album, albumTitle, "provider album tag survived the import");
    assert.ok((metadata.common.picture?.length ?? 0) > 0, "album cover was not embedded");
  }
  const staged = path.join(downloadRoot, "albums", "tidal", fixture.providerId);
  const leftovers = fs.existsSync(staged) ? fs.readdirSync(staged).filter((name) => name.endsWith(".flac")) : [];
  assert.deepEqual(leftovers, [], "staged media was not moved into the library");
  return rows;
}

test("a download import started from a queue wake completes the whole pipeline", async () => {
  seed(FIRST);
  await startFromQueueWake(() => importAlbum(FIRST));
  await assertImported(FIRST);
});

test("an import completes while a retag of another album runs", async () => {
  seed(SECOND);
  seed(THIRD);
  await importAlbum(SECOND);
  const second = await assertImported(SECOND);
  // Give the retag real writes: the catalogue title changed since import.
  dbModule.db.prepare("UPDATE Albums SET title = 'Second Album (Retitled)' WHERE mbid = ?").run(SECOND.releaseGroupMbid);
  dbModule.db.prepare("UPDATE AlbumEditions SET title = 'Second Album (Retitled)' WHERE mbid = ?").run(SECOND.releaseMbid);

  const work = await import("../commands/retag-work.js");
  const context = await import("../commands/command-context.js");
  const ids = second.map((row) => row.id);
  const retagId = queueModule.CommandQueueManager.push(queueModule.CommandNames.RetagFiles, { ids });
  const retagJob = queueModule.CommandQueueManager.claimForExecution(retagId, "pipeline-retag", 60_000)!;
  assert.ok(retagJob);

  const [retag] = await Promise.all([
    work.runRetagWorkUnit(retagJob, context.buildHandlerContext(), () => ids),
    startFromQueueWake(() => importAlbum(THIRD)),
  ]);
  assert.deepEqual(retag.errors, []);
  assert.equal(retag.retagged, ids.length);
  await assertImported(SECOND, "Second Album (Retitled)");
  await assertImported(THIRD);
});
