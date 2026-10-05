import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-orphan-cleanup-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();
const { db } = dbModule;
const downloadState = await import("../download/download-state.js");
const { DiskScanService } = await import("./library-scan.js");
const { Config } = await import("../config/config.js");
const { mediaRewritePath } = await import("./media-file-rewrite.js");

test("new-file scan awaits a competing writer and excludes abandoned rewrite audio", async () => {
  seedCanonicalArtistGraph();
  const artist = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number };
  const root = fs.mkdtempSync(path.join(tempDir, "index-under-contention-"));
  const folder = path.join(root, "Canonical Artist {mbid-artist-mbid}");
  fs.mkdirSync(folder);
  const audio = path.join(folder, "Unknown Song.wav");
  writePcmWav(audio);
  for (const kind of ["tags", "rewrite"] as const) fs.copyFileSync(audio, mediaRewritePath(audio, kind));
  const musicPath = Config.getMusicPath;
  const filtering = Config.getFilteringConfig;
  const naming = await import("../config/naming.js");
  const actualFolder = naming.resolveArtistFolderFromRecord({ name: "Canonical Artist", mbid: "artist-mbid", path: null });
  if (path.basename(folder) !== actualFolder) fs.renameSync(folder, path.join(root, actualFolder));
  Config.getMusicPath = () => root;
  Config.getFilteringConfig = () => ({ ...filtering(), include_videos: false, include_spatial: false });
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const blocker = dbModule.withSqliteWriteGate(() => {
    acquired();
    return new Promise<void>(resolve => { release = resolve; });
  }, "test:index-competing-writer");
  await ready;
  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; release(); }, 30);
  try {
    await (DiskScanService as any).indexNewFiles(String(artist.id), { promoteOnMatch: false });
    assert.equal(timerFired, true, "scan must leave the event loop available for writer release");
    const rows = db.prepare("SELECT filename FROM UnmappedFiles WHERE file_path LIKE ?").all(root + "%") as Array<{ filename: string }>;
    assert.deepEqual(rows.map(row => row.filename), ["Unknown Song.wav"]);
  } finally {
    clearTimeout(timer); release(); await blocker;
    Config.getMusicPath = musicPath; Config.getFilteringConfig = filtering;
    db.prepare("DELETE FROM UnmappedFiles WHERE file_path LIKE ?").run(root + "%");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("routine artist scan records unknown music in a plain-name sibling for review", async () => {
  seedCanonicalArtistGraph();
  const artist = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number };
  const root = fs.mkdtempSync(path.join(tempDir, "plain-artist-scan-"));
  const folder = path.join(root, "Canonical Artist", "Unidentified Album");
  fs.mkdirSync(folder, { recursive: true });
  const audio = path.join(folder, "Unknown Song.wav");
  writePcmWav(audio);
  const musicPath = Config.getMusicPath;
  const filtering = Config.getFilteringConfig;
  Config.getMusicPath = () => root;
  Config.getFilteringConfig = () => ({ ...filtering(), include_videos: false, include_spatial: false });
  try {
    await (DiskScanService as any).indexNewFiles(String(artist.id), { promoteOnMatch: false });
    const row = db.prepare("SELECT file_path FROM UnmappedFiles WHERE file_path = ?").get(audio);
    assert.ok(row, "unidentified media in the old artist folder must be registered for review");
    assert.equal(fs.existsSync(audio), true, "unmapped music must remain on disk");
  } finally {
    Config.getMusicPath = musicPath;
    Config.getFilteringConfig = filtering;
    db.prepare("DELETE FROM UnmappedFiles WHERE file_path LIKE ?").run(root + "%");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function resetRows() {
  db.prepare("DELETE FROM UnmappedFiles").run();
  db.prepare("DELETE FROM ExtraFiles").run();
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumEditions").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM LibraryArtists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
  downloadState.invalidateAllDownloadState();
}

beforeEach(resetRows);
afterEach(resetRows);

function seedCanonicalArtistGraph() {
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run("artist-mbid", "Canonical Artist");
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)
  `).run("release-group-1", "artist-mbid", "Canonical Album", "album", "2024-01-01");
  db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("release-1", "release-group-1", "artist-mbid", "Canonical Album", 2, 1);
  db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)")
    .run("recording-1", "Track One", "artist-mbid", 0);
  db.prepare("INSERT INTO Recordings (mbid, title, artist_mbid, is_video) VALUES (?, ?, ?, ?)")
    .run("recording-2", "Track Two", "artist-mbid", 0);
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("track-1", "release-1", "recording-1", "Track One", 1, 1);
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, medium_position, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("track-2", "release-1", "recording-2", "Track Two", 1, 2);
  db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) SELECT library.id, (SELECT id FROM Albums WHERE mbid = 'release-group-1'), 'manual', 0, 'orphan_cleanup_test', 1
    FROM Libraries library
    JOIN quality_profiles profile ON profile.id = library.quality_profile_id
    WHERE library.enabled = 1
      AND NOT EXISTS (
        SELECT 1 FROM json_each(COALESCE(profile.allowed_source_formats, '[]')) allowed
        WHERE allowed.value = 'spatial'
      )
    ORDER BY library.id
    LIMIT 1
  `).run();
  db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, reason, curation_version
    )
    SELECT library_group.library_id, release.id, 'manual', 'orphan_cleanup_test', 1
    FROM LibraryAlbums library_group
    JOIN AlbumEditions release ON release.mbid = 'release-1'
    WHERE library_group.release_group_id = release.release_group_id
  `).run();
}

/**
 * Insert a canonical-linked TrackFiles row whose file does NOT exist on disk, so
 * a scan treats it as an orphan. providerId is optional: a provider-free
 * (canonical-only) row has a null provider_id, the exact case the old
 * NULL-AS-album_id bug never invalidated.
 */
function insertMissingTrackFile(
  trackMbid: string,
  recordingMbid: string,
  filename: string,
  providerId: string | null,
) {
  db.prepare(`
    INSERT INTO TrackFiles (
      library_id,
      artist_metadata_id, canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid, provider, provider_entity_type, provider_id,
      library_slot, file_path, relative_path, library_root, filename, extension, file_type, file_class
    ) VALUES (
      (SELECT library_id FROM LibraryAlbums WHERE release_group_id = (SELECT id FROM Albums WHERE mbid = 'release-group-1') ORDER BY library_id LIMIT 1),
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'audio'
    )
  `).run(
    (db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number }).id,
    "artist-mbid",
    "release-group-1",
    "release-1",
    trackMbid,
    recordingMbid,
    providerId ? "tidal" : null,
    providerId ? "track" : null,
    providerId,
    "stereo",
    path.join(tempDir, filename),
    filename,
    tempDir,
    filename,
    "flac",
    "track",
  );
}

function writePcmWav(filePath: string): void {
  const sampleRate = 44_100;
  const channels = 2;
  const bitsPerSample = 16;
  const dataSize = sampleRate * channels * (bitsPerSample / 8);
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  wav.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(filePath, wav);
}

test("audio-fact backfill waits for the writer gate and does not count unchanged unknown quality", async () => {
  seedCanonicalArtistGraph();
  const file = path.join(tempDir, "backfill.xyz");
  writePcmWav(file);
  insertMissingTrackFile("track-1", "recording-1", "backfill.xyz", null);
  const artist = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid='artist-mbid'").get() as { id: number };
  const scan = DiskScanService as unknown as { backfillMissingAudioFacts(id: string): Promise<{ updated: number }> };
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const blocker = dbModule.withSqliteWriteGate(() => {
    acquired();
    return new Promise<void>(resolve => { release = resolve; });
  }, "test:backfill-competing-writer");
  await ready;
  let settled = false;
  const work = scan.backfillMissingAudioFacts(String(artist.id)).then(result => { settled = true; return result; });
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(settled, false);
    release(); await blocker;
    assert.equal((await work).updated, 1);
    db.prepare("UPDATE TrackFiles SET verified_at='2000-01-01' WHERE file_path=?").run(file);
    assert.equal((await scan.backfillMissingAudioFacts(String(artist.id))).updated, 0);
    assert.equal((db.prepare("SELECT verified_at FROM TrackFiles WHERE file_path=?").get(file) as { verified_at: string }).verified_at, "2000-01-01");
  } finally { release(); await blocker; fs.rmSync(file, { force: true }); }
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0;

for (const competingChange of ["none", "path", "canonical", "edition"] as const) {
    test(`canonical backfill waits for the writer gate and respects competing ${competingChange} changes`, { skip: !hasFfmpeg }, async () => {
        seedCanonicalArtistGraph();
        const filename = `canonical-${competingChange}.flac`;
        const file = path.join(tempDir, filename);
        const generated = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "0.1",
            "-c:a", "flac", "-metadata", "MUSICBRAINZ_RELEASETRACKID=track-1",
            "-metadata", "MUSICBRAINZ_TRACKID=recording-1", "-metadata", "MUSICBRAINZ_ALBUMID=release-1", file],
            { encoding: "utf8", windowsHide: true });
        assert.equal(generated.status, 0, generated.stderr);
        insertMissingTrackFile("track-1", "recording-1", filename, null);
        db.prepare("UPDATE TrackFiles SET canonical_track_mbid=NULL, canonical_recording_mbid=NULL, verified_at='2000-01-01' WHERE file_path=?").run(file);
        const artist = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid='artist-mbid'").get() as { id: number };
        const scan = DiskScanService as unknown as { backfillCanonicalLinksFromTags(id: string): Promise<{ healed: number }> };
        let release!: () => void;
        let acquired!: () => void;
        const ready = new Promise<void>(resolve => { acquired = resolve; });
        const blocker = dbModule.withSqliteWriteGate(async () => {
            acquired(); await new Promise<void>(resolve => { release = resolve; });
            // These mutations model the writer that already owns admission.
            if (competingChange === "path") db.prepare("UPDATE TrackFiles SET file_path=? WHERE file_path=?").run(file + ".moved", file);
            if (competingChange === "canonical") db.prepare("UPDATE TrackFiles SET canonical_track_mbid='track-2', canonical_recording_mbid='recording-2' WHERE file_path=?").run(file);
            if (competingChange === "edition") db.prepare("UPDATE TrackFiles SET canonical_release_mbid='another-release' WHERE file_path=?").run(file);
        }, "test:canonical-competing-writer");
        await ready;
        let settled = false;
        const work = scan.backfillCanonicalLinksFromTags(String(artist.id)).then(result => { settled = true; return result; });
        try {
            await new Promise(resolve => setTimeout(resolve, 100));
            assert.equal(settled, false, "backfill must not write through another owner's gate");
            assert.equal((db.prepare("SELECT verified_at FROM TrackFiles WHERE file_path=?").get(file) as { verified_at: string }).verified_at, "2000-01-01");
            release(); await blocker;
            assert.equal((await work).healed, competingChange === "none" ? 1 : 0);
            const row = db.prepare("SELECT canonical_track_mbid, canonical_recording_mbid, canonical_release_mbid, verified_at FROM TrackFiles WHERE filename=?").get(filename) as {
                canonical_track_mbid: string | null; canonical_recording_mbid: string | null; canonical_release_mbid: string; verified_at: string;
            };
            assert.equal(row.canonical_track_mbid, competingChange === "none" ? "track-1" : competingChange === "canonical" ? "track-2" : null);
            assert.equal(row.canonical_recording_mbid, competingChange === "none" ? "recording-1" : competingChange === "canonical" ? "recording-2" : null);
            assert.equal(row.canonical_release_mbid, competingChange === "edition" ? "another-release" : "release-1");
            if (competingChange !== "none") assert.equal(row.verified_at, "2000-01-01");
            assert.equal((await scan.backfillCanonicalLinksFromTags(String(artist.id))).healed, 0);
        } finally { release(); await blocker; await work; fs.rmSync(file, { force: true }); }
    });
}

test("repeat duplicate discovery preserves ownership without reporting another addition", async () => {
  seedCanonicalArtistGraph();
  const artist = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid='artist-mbid'").get() as { id: number };
  const root = fs.mkdtempSync(path.join(tempDir, "duplicate-repeat-"));
  const naming = await import("../config/naming.js");
  const folder = path.join(root, naming.resolveArtistFolderFromRecord({ name: "Canonical Artist", mbid: "artist-mbid", path: null }), "Canonical Album");
  fs.mkdirSync(folder, { recursive: true });
  const original = path.join(folder, "01 - Track One.wav");
  const duplicate = path.join(folder, "Track One.wav");
  writePcmWav(original); writePcmWav(duplicate);
  const info = Object.entries({ INAM: "Track One", IART: "Canonical Artist", IPRD: "Canonical Album" }).map(([key, value]) => {
    const bytes = Buffer.from(value + "\0");
    const chunk = Buffer.alloc(8 + bytes.length + bytes.length % 2);
    chunk.write(key); chunk.writeUInt32LE(bytes.length, 4); bytes.copy(chunk, 8);
    return chunk;
  });
  const list = Buffer.concat([Buffer.from("INFO"), ...info]);
  const header = Buffer.alloc(8); header.write("LIST"); header.writeUInt32LE(list.length, 4);
  const tagged = Buffer.concat([fs.readFileSync(duplicate), header, list]);
  tagged.writeUInt32LE(tagged.length - 8, 4); fs.writeFileSync(duplicate, tagged);
  insertMissingTrackFile("track-1", "recording-1", "existing.wav", "duplicate-offer");
  const trackItem = Number(db.prepare("INSERT INTO ProviderItems(provider,entity_type,provider_id,title,duration_ms) VALUES('tidal','track','duplicate-offer','Track One',1000)").run().lastInsertRowid);
  const editionItem = Number(db.prepare("INSERT INTO ProviderItems(provider,entity_type,provider_id,title) VALUES('tidal','release','duplicate-edition','Canonical Album')").run().lastInsertRowid);
  const artistItem = Number(db.prepare("INSERT INTO ProviderItems(provider,entity_type,provider_id,title) VALUES('tidal','artist','duplicate-artist','Canonical Artist')").run().lastInsertRowid);
  db.prepare("INSERT INTO ProviderEditionMembers(provider_edition_item_id,member_item_id,medium_position,position) VALUES(?,?,1,1)").run(editionItem,trackItem);
  db.prepare("INSERT INTO ProviderArtistMatches(provider_artist_item_id,artist_id,match_state,decision_source,confidence,method,matcher_version) VALUES(?,?,'accepted','automatic',1,'test',1)").run(artistItem,artist.id);
  db.prepare("INSERT INTO ProviderItemCredits(item_id,artist_item_id,ordinal,credited_name) VALUES(?,?,0,'Canonical Artist')").run(trackItem,artistItem);
  db.prepare("INSERT INTO ProviderItemCredits(item_id,artist_item_id,ordinal,credited_name) VALUES(?,?,0,'Canonical Artist')").run(editionItem,artistItem);
  db.prepare("UPDATE TrackFiles SET file_path=?,library_root=?,extension='wav' WHERE filename='existing.wav'").run(original, root);
  const music = Config.getMusicPath, filtering = Config.getFilteringConfig;
  Config.getMusicPath = () => root;
  Config.getFilteringConfig = () => ({ ...filtering(), include_videos: false, include_spatial: false });
  const scan = DiskScanService as unknown as { indexNewFiles(id: string): Promise<{ indexed: number }> };
  try {
    assert.equal((await scan.indexNewFiles(String(artist.id))).indexed, 1);
    const owned = db.prepare("SELECT id FROM ExtraFiles WHERE file_path=?").get(duplicate) as { id: number };
    assert.ok(owned);
    assert.equal((await scan.indexNewFiles(String(artist.id))).indexed, 0);
    assert.equal((db.prepare("SELECT id FROM ExtraFiles WHERE file_path=?").get(duplicate) as { id: number }).id, owned.id);
    const replacement = DiskScanService as unknown as { upsertLibraryFile(params: { artistId: string; filePath: string; libraryRoot: string; fileType: string }): Promise<void> };
    await assert.rejects(replacement.upsertLibraryFile({ artistId: "missing-artist", filePath: duplicate, libraryRoot: root, fileType: "track" }));
    assert.equal((db.prepare("SELECT id FROM ExtraFiles WHERE file_path=?").get(duplicate) as { id: number }).id, owned.id, "failed promotion must roll back the old ownership row");
    assert.ok(fs.existsSync(original)); assert.ok(fs.existsSync(duplicate));
  } finally { Config.getMusicPath = music; Config.getFilteringConfig = filtering; fs.rmSync(root, { recursive: true, force: true }); }
});

test("an unavailable root preserves tracked and unmapped inventory", async () => {
  seedCanonicalArtistGraph();
  insertMissingTrackFile("track-1", "recording-1", "offline.flac", null);
  const offline = path.join(tempDir, "disconnected-root");
  db.prepare("UPDATE TrackFiles SET library_root=?, file_path=? WHERE filename='offline.flac'")
    .run(offline, path.join(offline, "offline.flac"));
  const artist = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid='artist-mbid'").get() as { id: number };
  await assert.rejects(DiskScanService.scan({ artistIds: [String(artist.id)] }), /Library root unavailable/);
  assert.equal((db.prepare("SELECT count(*) n FROM TrackFiles").get() as { n: number }).n, 1);
  db.prepare(`INSERT INTO UnmappedFiles (file_path,relative_path,library_root,filename,extension,file_size)
      VALUES (?, 'review.flac', ?, 'review.flac', 'flac', 1)`).run(path.join(offline, "review.flac"), offline);
  try {
    await assert.rejects(DiskScanService.pruneUnmappedFiles(), /Library root unavailable/);
    assert.ok(db.prepare("SELECT 1 FROM UnmappedFiles WHERE library_root=?").get(offline));
  } finally { db.prepare("DELETE FROM UnmappedFiles WHERE library_root=?").run(offline); }
});

test("scan waits for an active database writer before updating changed and verified file facts", async () => {
  seedCanonicalArtistGraph();
  const artist = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number };
  const files = ["changed.wav", "unchanged.wav"].map(name => path.join(tempDir, name));
  for (const [index, filePath] of files.entries()) {
    writePcmWav(filePath);
    insertMissingTrackFile(`track-${index + 1}`, `recording-${index + 1}`, path.basename(filePath), null);
    const stat = fs.statSync(filePath);
    db.prepare(`UPDATE TrackFiles SET file_path = ?, library_root = ?, file_size = ?, modified_at = ?, verified_at = NULL WHERE filename = ?`)
      .run(filePath, tempDir, index === 0 ? 1 : stat.size, stat.mtime.toISOString(), path.basename(filePath));
  }
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const blocker = dbModule.withSqliteWriteGate(() => {
    acquired();
    return new Promise<void>(resolve => { release = resolve; });
  }, "test:import-writer");
  await ready;
  const timer = setTimeout(() => release(), 30);
  try {
    const result = await (DiskScanService as any).updateChangedFiles(String(artist.id));
    assert.equal(result.updated, 1);
  } finally {
    clearTimeout(timer);
    release();
    await blocker;
  }
  for (const filePath of files) {
    const row = db.prepare("SELECT file_size, verified_at FROM TrackFiles WHERE file_path = ?").get(filePath) as { file_size: number; verified_at: string | null };
    assert.equal(row.file_size, fs.statSync(filePath).size);
    assert.ok(row.verified_at);
  }
});

test("scan backfills file-derived quality and technical facts on relinked library files", async () => {
  seedCanonicalArtistGraph();
  const artist = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'")
    .get() as { id: number };
  const filePath = path.join(tempDir, "existing-library-track.wav");
  writePcmWav(filePath);
  const library = db.prepare(`
    SELECT library_id AS id FROM LibraryAlbums
    WHERE release_group_id = (SELECT id FROM Albums WHERE mbid = 'release-group-1')
    LIMIT 1
  `).get() as { id: number };
  const release = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'release-1'").get() as { id: number };
  const track = db.prepare("SELECT id, recording_id FROM Tracks WHERE mbid = 'track-1'")
    .get() as { id: number; recording_id: number };
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, library_id, album_edition_id, track_id, recording_id,
      file_path, relative_path, library_root, filename, extension, file_type, file_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'wav', 'track', 'audio')
  `).run(
    artist.id,
    library.id,
    release.id,
    track.id,
    track.recording_id,
    filePath,
    path.basename(filePath),
    tempDir,
    path.basename(filePath),
  );

  const result = await (DiskScanService as any).backfillMissingAudioFacts(String(artist.id));
  assert.equal(result.updated, 1);
  const row = db.prepare(`
    SELECT quality, imported_quality, sample_rate, bit_depth, channels, duration
    FROM TrackFiles WHERE file_path = ?
  `).get(filePath) as Record<string, unknown>;
  assert.equal(row.quality, "LOSSLESS");
  assert.equal(row.imported_quality, "LOSSLESS");
  assert.equal(row.sample_rate, 44_100);
  assert.equal(row.bit_depth, 16);
  assert.equal(row.channels, 2);
  assert.equal(row.duration, 1);
});

test("orphan reconciliation awaits writer admission without blocking its release", async () => {
  seedCanonicalArtistGraph();
  insertMissingTrackFile("track-1", "recording-1", "missing-under-contention.flac", null);
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const blocker = dbModule.withSqliteWriteGate(() => {
    acquired();
    return new Promise<void>(resolve => { release = resolve; });
  }, "test:competing-writer");
  await ready;
  const timer = setTimeout(() => release(), 30);
  try {
    const artist = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number };
    const result = await DiskScanService.scan({ artistIds: [String(artist.id)], trackUnmappedFiles: false });
    assert.equal(result.orphansRemoved, 1);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM TrackFiles").get() as { n: number }).n, 0);
  } finally {
    clearTimeout(timer);
    release();
    await blocker;
  }
});

test("orphan removal invalidates the cached album download status (provider-linked row)", async () => {
  seedCanonicalArtistGraph();
  insertMissingTrackFile("track-1", "recording-1", "track-one.flac", "provider-track-1");

  // Prime the album-stats cache: one of two tracks present.
  const primed = downloadState.getAlbumDownloadStats("release-group-1");
  assert.equal(primed.downloadedTracks, 1);

  await DiskScanService.scan({
    artistIds: [
      String((db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number }).id),
    ],
  });

  // Row is gone from the file table.
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM TrackFiles").get() as { n: number }).n, 0);

  // Without invalidation this returns the stale cached "1"; the fix must flip it
  // to 0 with NO manual invalidateAllDownloadState() call.
  const afterScan = downloadState.getAlbumDownloadStats("release-group-1");
  assert.equal(afterScan.downloadedTracks, 0);
});

test("orphan removal invalidates status for a provider-free canonical-only row", async () => {
  seedCanonicalArtistGraph();
  // provider_id null — the case the old NULL-as-album_id code never invalidated.
  insertMissingTrackFile("track-1", "recording-1", "track-one.flac", null);

  const primed = downloadState.getAlbumDownloadStats("release-group-1");
  assert.equal(primed.downloadedTracks, 1);

  await DiskScanService.scan({
    artistIds: [
      String((db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'").get() as { id: number }).id),
    ],
  });

  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM TrackFiles").get() as { n: number }).n, 0);

  const afterScan = downloadState.getAlbumDownloadStats("release-group-1");
  assert.equal(afterScan.downloadedTracks, 0);
});

test("fresh active-schema full scan uses LibraryArtists paths and reconciles TrackFiles by numeric identity", async () => {
  seedCanonicalArtistGraph();
  const artist = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid'")
    .get() as { id: number };
  db.prepare(`
    INSERT INTO LibraryArtists (library_id, artist_metadata_id, policy, credited_scope, path)
    SELECT id, ?, 'all', 'release_and_track_credit', 'Canonical/Artist'
    FROM Libraries
    WHERE enabled = 1
    ORDER BY id
    LIMIT 1
  `).run(artist.id);
  insertMissingTrackFile("track-1", "recording-1", "full-scan.flac", null);

  const result = await DiskScanService.scan({ filter: "known" });

  assert.equal(result.artists, 1);
  assert.equal(result.orphansRemoved, 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM TrackFiles").get() as { n: number }).n,
    0,
    "the full scan must not bind the artist MBID to TrackFiles.artist_metadata_id",
  );
});
