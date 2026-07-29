import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-track-lyrics-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.track-lyrics.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let materializerModule: typeof import("./track-lyrics-materializer.js");

before(async () => {
  dbModule = await import("../../database.js");
  materializerModule = await import("./track-lyrics-materializer.js");
  dbModule.initDatabase();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("import lyric materializer discovers, tracks, and reuses an adjacent sidecar", async () => {
  dbModule.db.prepare("INSERT INTO Artists(id, name, mbid) VALUES(?, ?, ?)")
    .run("100", "Bastille", "artist-mbid-100");

  const albumDir = path.join(tempDir, "Bastille", "Give Me The Future");
  fs.mkdirSync(albumDir, { recursive: true });
  const trackPath = path.join(albumDir, "01 - Distorted Light Beam.flac");
  const lyricPath = path.join(albumDir, "01 - Distorted Light Beam.lrc");
  fs.writeFileSync(trackPath, "fixture audio", "utf8");
  fs.writeFileSync(lyricPath, "[00:01.20]It isn't enough\n", "utf8");

  const inserted = dbModule.db.prepare(`
    INSERT INTO TrackFiles(
      artist_id,
      canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension,
      file_type, quality
    ) VALUES(?, ?, ?, ?, ?, ?, ?, 'track', ?, 'stereo', ?, ?, ?, ?, 'flac', 'track', 'LOSSLESS')
  `).run(
    "100",
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
  dbModule.db.prepare("INSERT INTO Artists(id, name, mbid) VALUES(?, ?, ?)")
    .run("101", "Bakermat", "artist-mbid-101");

  const albumDir = path.join(tempDir, "Bakermat", "The Spirit");
  fs.mkdirSync(albumDir, { recursive: true });
  const trackPath = path.join(albumDir, "01 - Baiana.flac");
  const lrcPath = path.join(albumDir, "01 - Baiana.lrc");
  const textPath = path.join(albumDir, "01 - Baiana.txt");
  fs.writeFileSync(trackPath, "fixture audio", "utf8");

  const inserted = dbModule.db.prepare(`
    INSERT INTO TrackFiles(
      artist_id,
      canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension,
      file_type, quality
    ) VALUES(?, ?, ?, ?, ?, ?, ?, 'track', ?, 'stereo', ?, ?, ?, ?, 'flac', 'track', 'LOSSLESS')
  `).run(
    "101",
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
