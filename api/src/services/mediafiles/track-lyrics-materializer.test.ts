import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { seedTestLibrary } from "../../test-support/library-fixtures.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-track-lyrics-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.track-lyrics.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let materializerModule: typeof import("./track-lyrics-materializer.js");
let lyricsLibraryId: number;

before(async () => {
  dbModule = await import("../../database.js");
  materializerModule = await import("./track-lyrics-materializer.js");
  dbModule.initDatabase();
  lyricsLibraryId = seedTestLibrary(dbModule.db, { name: "Lyrics Test", rootPath: tempDir });
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("import lyric materializer discovers, tracks, and reuses an adjacent sidecar", async () => {
  const artist100 = dbModule.db.prepare("INSERT INTO ArtistMetadata(id, mbid, name) VALUES(?, ?, ?) RETURNING id")
    .get(100, "artist-mbid-100", "Bastille") as { id: number };

  const albumDir = path.join(tempDir, "Bastille", "Give Me The Future");
  fs.mkdirSync(albumDir, { recursive: true });
  const trackPath = path.join(albumDir, "01 - Distorted Light Beam.flac");
  const lyricPath = path.join(albumDir, "01 - Distorted Light Beam.lrc");
  fs.writeFileSync(trackPath, "fixture audio", "utf8");
  fs.writeFileSync(lyricPath, "[00:01.20]It isn't enough\n", "utf8");

  const inserted = dbModule.db.prepare(`
    INSERT INTO TrackFiles(
      artist_metadata_id, library_id,
      canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension,
      file_type, quality
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'track', ?, 'stereo', ?, ?, ?, ?, 'flac', 'track', 'LOSSLESS')
  `).run(
    artist100.id,
    lyricsLibraryId,
    "artist-mbid-100",
    "release-group-mbid-200",
    "release-mbid-200",
    "track-mbid-300",
    "recording-mbid-300",
    "tidal",
    "provider-track-300",
    trackPath,
    path.relative(tempDir, trackPath),
    tempDir,
    path.basename(trackPath),
  );

  const result = await materializerModule.TrackLyricsMaterializer.materializeForMediaIds(
    ["provider-track-300"],
    "tidal",
  );
  const key = materializerModule.providerMediaLyricsKey("tidal", "provider-track-300");
  assert.equal(result.discovered, 1);
  assert.equal(result.saved, 0);
  assert.equal(result.missing, 0);
  assert.equal(result.lyricsByProviderMedia.get(key)?.subtitles, "[00:01.20]It isn't enough");

  const lyricRow = dbModule.db.prepare(`
    SELECT track_file_id, provider, provider_id, canonical_recording_mbid, file_path
    FROM LyricFiles
    WHERE file_path = ?
  `).get(lyricPath) as {
    track_file_id: number;
    provider: string;
    provider_id: string;
    canonical_recording_mbid: string;
    file_path: string;
  } | undefined;
  assert.equal(lyricRow?.track_file_id, Number(inserted.lastInsertRowid));
  assert.equal(lyricRow?.provider, "tidal");
  assert.equal(lyricRow?.provider_id, "provider-track-300");
  assert.equal(lyricRow?.canonical_recording_mbid, "recording-mbid-300");
});

test("import lyric materializer saves provider plain lyrics as txt and reuses them for tags", async () => {
  const artist101 = dbModule.db.prepare("INSERT INTO ArtistMetadata(id, mbid, name) VALUES(?, ?, ?) RETURNING id")
    .get(101, "artist-mbid-101", "Bakermat") as { id: number };

  const albumDir = path.join(tempDir, "Bakermat", "The Spirit");
  fs.mkdirSync(albumDir, { recursive: true });
  const trackPath = path.join(albumDir, "01 - Baiana.flac");
  const lrcPath = path.join(albumDir, "01 - Baiana.lrc");
  const textPath = path.join(albumDir, "01 - Baiana.txt");
  fs.writeFileSync(trackPath, "fixture audio", "utf8");

  const inserted = dbModule.db.prepare(`
    INSERT INTO TrackFiles(
      artist_metadata_id, library_id,
      canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension,
      file_type, quality
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'track', ?, 'stereo', ?, ?, ?, ?, 'flac', 'track', 'LOSSLESS')
  `).run(
    artist101.id,
    lyricsLibraryId,
    "artist-mbid-101",
    "release-group-mbid-201",
    "release-mbid-201",
    "track-mbid-301",
    "recording-mbid-301",
    "tidal",
    "provider-track-301",
    trackPath,
    path.relative(tempDir, trackPath),
    tempDir,
    path.basename(trackPath),
  );
  dbModule.db.prepare(`
    INSERT INTO ProviderItems(
      provider, entity_type, provider_id, title, duration_ms
    ) VALUES ('tidal', 'track', ?, ?, 180)
  `).run( "provider-track-301", "Baiana" );

  const providersModule = await import("../providers/index.js");
  const tidal = providersModule.streamingProviderManager.getStreamingProvider("tidal") as any;
  const originalGetLyrics = tidal.getLyrics;
  tidal.getLyrics = async () => ({
    text: "Provider plain lyric without timestamps",
    subtitles: "",
    provider: "TIDAL fixture",
  });

  try {
    const result = await materializerModule.TrackLyricsMaterializer.materializeForMediaIds(
      ["provider-track-301"],
      "tidal",
    );
    const key = materializerModule.providerMediaLyricsKey("tidal", "provider-track-301");

    assert.equal(result.discovered, 1);
    assert.equal(result.saved, 1);
    assert.equal(result.missing, 0);
    assert.equal(result.lyricsByProviderMedia.get(key)?.text, "Provider plain lyric without timestamps");
    assert.equal(result.lyricsByProviderMedia.get(key)?.subtitles, "");
    assert.equal(fs.existsSync(lrcPath), false);
    assert.equal(fs.readFileSync(textPath, "utf8"), "Provider plain lyric without timestamps\n");

    const lyricRow = dbModule.db.prepare(`
      SELECT track_file_id, extension, file_path
      FROM LyricFiles
      WHERE track_file_id = ?
    `).get(Number(inserted.lastInsertRowid)) as {
      track_file_id: number;
      extension: string;
      file_path: string;
    } | undefined;
    assert.equal(lyricRow?.extension, "txt");
    assert.equal(lyricRow?.file_path, textPath);
  } finally {
    tidal.getLyrics = originalGetLyrics;
  }
});

test("an unsynced tiddl sidecar does not hide catalogue timed lyrics", async () => {
  const artist102 = dbModule.db.prepare("INSERT INTO ArtistMetadata(id, mbid, name) VALUES(?, ?, ?) RETURNING id")
    .get(102, "artist-mbid-102", "Bastille") as { id: number };

  const albumDir = path.join(tempDir, "Bastille", "Wild World");
  fs.mkdirSync(albumDir, { recursive: true });
  const trackPath = path.join(albumDir, "01 - Good Grief.flac");
  const textPath = path.join(albumDir, "01 - Good Grief.txt");
  const lrcPath = path.join(albumDir, "01 - Good Grief.lrc");
  fs.writeFileSync(trackPath, "fixture audio", "utf8");
  fs.writeFileSync(textPath, "Unsynced tiddl lyric dump without timestamps\n", "utf8");

  const inserted = dbModule.db.prepare(`
    INSERT INTO TrackFiles(
      artist_metadata_id, library_id,
      canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension,
      file_type, quality
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'track', ?, 'stereo', ?, ?, ?, ?, 'flac', 'track', 'LOSSLESS')
  `).run(
    artist102.id,
    lyricsLibraryId,
    "artist-mbid-102",
    "release-group-mbid-202",
    "release-mbid-202",
    "track-mbid-302",
    "recording-mbid-302",
    "tidal",
    "provider-track-302",
    trackPath,
    path.relative(tempDir, trackPath),
    tempDir,
    path.basename(trackPath),
  );
  dbModule.db.prepare(`
    INSERT INTO ProviderItems(
      provider, entity_type, provider_id, title, duration_ms
    ) VALUES ('tidal', 'track', ?, ?, 180)
  `).run("provider-track-302", "Good Grief");

  const providersModule = await import("../providers/index.js");
  const tidal = providersModule.streamingProviderManager.getStreamingProvider("tidal") as any;
  const originalGetLyrics = tidal.getLyrics;
  tidal.getLyrics = async () => ({
    text: "Good Grief",
    subtitles: "[00:04.10]Good Grief\n",
    provider: "TIDAL fixture",
  });

  try {
    const result = await materializerModule.TrackLyricsMaterializer.materializeForFileIds(
      [Number(inserted.lastInsertRowid)],
    );
    const key = materializerModule.providerMediaLyricsKey("tidal", "provider-track-302");
    assert.equal(result.discovered, 1);
    assert.equal(result.lyricsByProviderMedia.get(key)?.subtitles, "[00:04.10]Good Grief");
    assert.equal(fs.existsSync(lrcPath), true);
    assert.match(fs.readFileSync(lrcPath, "utf8"), /\[00:04\.10\]Good Grief/);
    assert.equal(fs.existsSync(textPath), false, "the unsynced tiddl sidecar must be replaced, not left beside the .lrc");

    const lyricRows = dbModule.db.prepare(`
      SELECT file_path, extension FROM LyricFiles WHERE track_file_id = ?
    `).all(Number(inserted.lastInsertRowid)) as Array<{ file_path: string; extension: string }>;
    assert.equal(lyricRows.length, 1);
    assert.equal(lyricRows[0]?.file_path, lrcPath);
    assert.equal(lyricRows[0]?.extension, "lrc");
  } finally {
    tidal.getLyrics = originalGetLyrics;
  }
});

// #135: a lyrics backend that never answers must not hold an album import.
test("prefetch gives up on a lyrics service that never answers and records no lyrics", { timeout: 10_000 }, async () => {
  for (const id of ["hang-track-1", "hang-track-2", "hang-track-3"]) {
    dbModule.db.prepare(`
      INSERT INTO ProviderItems(provider, entity_type, provider_id, title, duration_ms)
      VALUES ('tidal', 'track', ?, ?, 180)
    `).run(id, `Hanging ${id}`);
  }
  const providersModule = await import("../providers/index.js");
  const tidal = providersModule.streamingProviderManager.getStreamingProvider("tidal") as any;
  const originalGetLyrics = tidal.getLyrics;
  let calls = 0;
  tidal.getLyrics = () => {
    calls += 1;
    return new Promise(() => undefined);
  };
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const startedAt = Date.now();
    const prefetched = await materializerModule.prefetchProviderLyrics(
      "tidal",
      ["hang-track-1", "hang-track-2", "hang-track-3"],
      2,
      null,
      { lookupTimeoutMs: 50, budgetMs: 1_000 },
    );
    assert.ok(Date.now() - startedAt < 2_000, "prefetch must finish within its budget");
    assert.ok(calls >= 1);
    for (const id of ["hang-track-1", "hang-track-2", "hang-track-3"]) {
      const key = materializerModule.providerMediaLyricsKey("tidal", id);
      assert.ok(Object.hasOwn(prefetched, key), `${id} is recorded so the import does not look it up again`);
      assert.equal(prefetched[key], null);
    }
  } finally {
    tidal.getLyrics = originalGetLyrics;
    console.warn = warn;
  }
});

test("prefetch stops starting lookups once the album budget is spent", { timeout: 10_000 }, async () => {
  const ids = Array.from({ length: 20 }, (_, index) => `budget-track-${index}`);
  for (const id of ids) {
    dbModule.db.prepare(`
      INSERT INTO ProviderItems(provider, entity_type, provider_id, title, duration_ms)
      VALUES ('tidal', 'track', ?, ?, 180)
    `).run(id, `Budget ${id}`);
  }
  const providersModule = await import("../providers/index.js");
  const tidal = providersModule.streamingProviderManager.getStreamingProvider("tidal") as any;
  const originalGetLyrics = tidal.getLyrics;
  let calls = 0;
  tidal.getLyrics = () => {
    calls += 1;
    return new Promise(() => undefined);
  };
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const startedAt = Date.now();
    const prefetched = await materializerModule.prefetchProviderLyrics("tidal", ids, 1, null, {
      lookupTimeoutMs: 100,
      budgetMs: 250,
    });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 1_000, `20 hanging lookups must be cut off by the 250 ms budget (took ${elapsed} ms)`);
    assert.ok(calls < ids.length, "lookups after the budget is spent are not started");
    assert.equal(Object.keys(prefetched).length, ids.length);
  } finally {
    tidal.getLyrics = originalGetLyrics;
    console.warn = warn;
  }
});

test("import keeps the sidecar on disk when the lyrics lookup never answers", { timeout: 10_000 }, async () => {
  const artist = dbModule.db.prepare("INSERT INTO ArtistMetadata(id, mbid, name) VALUES(?, ?, ?) RETURNING id")
    .get(103, "artist-mbid-103", "Bakermat") as { id: number };
  const albumDir = path.join(tempDir, "Bakermat", "Vandaag");
  fs.mkdirSync(albumDir, { recursive: true });
  const trackPath = path.join(albumDir, "01 - Vandaag.flac");
  const textPath = path.join(albumDir, "01 - Vandaag.txt");
  fs.writeFileSync(trackPath, "fixture audio", "utf8");
  fs.writeFileSync(textPath, "Unsynced lyric already on disk\n", "utf8");
  const inserted = dbModule.db.prepare(`
    INSERT INTO TrackFiles(
      artist_metadata_id, library_id,
      canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension,
      file_type, quality
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'track', ?, 'stereo', ?, ?, ?, ?, 'flac', 'track', 'LOSSLESS')
  `).run(
    artist.id, lyricsLibraryId, "artist-mbid-103", "release-group-mbid-203", "release-mbid-203",
    "track-mbid-303", "recording-mbid-303", "tidal", "provider-track-303",
    trackPath, path.relative(tempDir, trackPath), tempDir, path.basename(trackPath),
  );
  dbModule.db.prepare(`
    INSERT INTO ProviderItems(provider, entity_type, provider_id, title, duration_ms)
    VALUES ('tidal', 'track', ?, ?, 180)
  `).run("provider-track-303", "Vandaag");

  const providersModule = await import("../providers/index.js");
  const tidal = providersModule.streamingProviderManager.getStreamingProvider("tidal") as any;
  const originalGetLyrics = tidal.getLyrics;
  tidal.getLyrics = () => new Promise(() => undefined);
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const result = await materializerModule.TrackLyricsMaterializer.materializeForFileIds(
      [Number(inserted.lastInsertRowid)],
      null,
      undefined,
      undefined,
      { lookupTimeoutMs: 50, budgetMs: 1_000 },
    );
    const key = materializerModule.providerMediaLyricsKey("tidal", "provider-track-303");
    assert.equal(result.discovered, 1);
    assert.equal(result.lyricsByProviderMedia.get(key)?.text, "Unsynced lyric already on disk");
  } finally {
    tidal.getLyrics = originalGetLyrics;
    console.warn = warn;
  }
});
