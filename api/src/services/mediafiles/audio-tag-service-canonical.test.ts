import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-audio-tag-canonical-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let configModule: typeof import("../config/config.js");
let audioTagServiceModule: typeof import("./audio-tag-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  configModule = await import("../config/config.js");
  audioTagServiceModule = await import("./audio-tag-service.js");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("audio tag context derives canonical MusicBrainz tags without provider catalog rows", () => {
  const audioPath = path.join(tempDir, "library", "Artist One", "Canonical Album", "01 - Canonical Song.flac");
  fs.mkdirSync(path.dirname(audioPath), { recursive: true });
  fs.writeFileSync(audioPath, "not-a-real-audio-file");

  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)`).run("artist-mbid-1", "Artist One");
  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)`).run("album-artist-mbid-1", "Album Artist One");


dbModule.db.prepare(`
    INSERT INTO Albums (foreign_album_id, mbid, artist_mbid, title, primary_type, secondary_types, first_release_date, review_text, genres)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "release-group-mbid-1",
    "release-group-mbid-1",
    "artist-mbid-1",
    "Canonical Album",
    "Album",
    "[\"Compilation\"]",
    "2024-03-01",
    '[wimpLink artistId="1"]Canonical[/wimpLink] review<br/>text',
    JSON.stringify(["Indie Rock", "Alternative"]),
  );

  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (foreign_release_id, mbid, release_group_mbid, artist_mbid, title, status, country, date, barcode, copyright, media_count, track_count, label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-mbid-1", "release-mbid-1", "release-group-mbid-1", "artist-mbid-1", "Canonical Album", "Official", "[\"[Worldwide]\"]", "2024-03-01", null, "(P) 2024 Canonical Release", 1, 1, JSON.stringify(["Canonical Label"]));

  dbModule.db.prepare(`
    INSERT INTO AlbumArtists (release_group_mbid, artist_mbid, ord, credited_name, is_primary)
    VALUES (?, ?, ?, ?, ?)
  `).run("release-group-mbid-1", "album-artist-mbid-1", 0, "Album Artist One", 1);

  const releaseGroupId = (dbModule.db.prepare("SELECT id FROM Albums WHERE mbid = ?")
    .get("release-group-mbid-1") as { id: number }).id;
  const albumArtistId = (dbModule.db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = ?")
    .get("album-artist-mbid-1") as { id: number }).id;
  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupArtistCredits (release_group_id, artist_id, ordinal, credited_name, join_phrase)
    VALUES (?, ?, ?, ?, ?)
  `).run(releaseGroupId, albumArtistId, 0, "Album Artist One", "");

  dbModule.db.prepare(`
    INSERT INTO Recordings (foreign_recording_id, mbid, artist_mbid, title, artist_credit, length_ms, copyright, credits)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "recording-mbid-1",
    "recording-mbid-1",
    "artist-mbid-1",
    "Canonical Song",
    "Artist One",
    181000,
    "(P) 2024 Canonical Recording",
    JSON.stringify({
      "artist-credit": [
        { name: "Artist One", artist: { id: "artist-mbid-1", name: "Artist One" } },
        { name: "Guest One", artist: { id: "guest-mbid-1", name: "Guest One" } },
      ],
    }),
  );

  dbModule.db.prepare(`
    INSERT INTO Tracks (foreign_track_id, mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("track-mbid-1", "track-mbid-1", "release-mbid-1", "recording-mbid-1", 1, 1, "1", "Canonical Song", 181000);

  const providerRelease = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, upc, release_date
    ) VALUES (?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    "tidal",
    "release",
    "provider-album-1",
    "Soundtrack Album From Wrong Provider",
    "987654321000",
    "2024-03-01",
  ) as { id: number };

  const providerTrack = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, explicit, isrc, duration_ms, replay_gain, peak
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    "tidal",
    "track",
    "provider-track-1",
    "Canonical Song",
    1,
    "TESTISRC1234",
    181,
    -7.31,
    0.967717,
  ) as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderEditionMembers (
      provider_edition_item_id, member_item_id, medium_position, position
    ) VALUES (?, ?, 1, 1)
  `).run(providerRelease.id, providerTrack.id);
  dbModule.db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version
    )
    SELECT ?, id, 'exact', 'accepted', 'automatic', 1, 'test', 1
    FROM AlbumEditions
    WHERE mbid = 'release-mbid-1'
  `).run(providerRelease.id);

  const inserted = dbModule.db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id,
      canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
      canonical_track_mbid, canonical_recording_mbid,
      provider_item_id,
      provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension,
      file_type, quality
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'tidal', 'track', 'provider-track-1', 'stereo', ?, ?, ?, ?, ?, 'track', ?)
  `).run(
    (dbModule.db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid-1'").get() as { id: number }).id,
    "artist-mbid-1",
    "release-group-mbid-1",
    "release-mbid-1",
    "track-mbid-1",
    "recording-mbid-1",
    providerTrack.id,
    audioPath,
    path.relative(tempDir, audioPath),
    tempDir,
    path.basename(audioPath),
    "flac",
    "LOSSLESS",
  );

  const tags = audioTagServiceModule.AudioTagService.buildDesiredTagsForTrackFileIdsForTest(
    [Number(inserted.lastInsertRowid)],
    { write_tidal_url: true, embed_album_review: true, embed_replaygain: true },
  );
  const byKey = new Map(tags.map((tag) => [tag.key, tag.targetValue]));

  assert.equal(byKey.get("title"), "Canonical Song");
  assert.equal(byKey.get("artist"), "Artist One, Guest One");
  assert.equal(byKey.get("album_artist"), "Album Artist One");
  assert.equal(byKey.get("album"), "Canonical Album");
  // Provider album title must not leak into tags when canonical release is set
  // (hybrid downloads can source audio from a differently named provider album).
  assert.notEqual(byKey.get("album"), "Soundtrack Album From Wrong Provider");
  assert.equal(byKey.get("track"), "1/1");
  assert.equal(byKey.get("disc"), "1/1");
  assert.equal(byKey.get("date"), "2024-03-01");
  assert.equal(byKey.get("genre"), "Indie Rock / Alternative");
  assert.equal(byKey.get("label"), "Canonical Label");
  assert.equal(byKey.get("barcode"), "987654321000");
  assert.equal(byKey.get("isrc"), "TESTISRC1234");
  assert.equal(byKey.get("copyright"), "(P) 2024 Canonical Recording");
  assert.equal(byKey.get("comment"), "Canonical review\ntext");
  assert.equal(byKey.get("provider_url"), "https://tidal.com/browse/track/provider-track-1");
  assert.equal(byKey.get("musicbrainz_recordingid"), "recording-mbid-1");
  assert.equal(byKey.get("musicbrainz_albumid"), "release-mbid-1");
  assert.equal(byKey.get("musicbrainz_releasegroupid"), "release-group-mbid-1");
  assert.equal(byKey.get("musicbrainz_releasetrackid"), "track-mbid-1");
  assert.equal(byKey.get("release_status"), "official");
  assert.equal(byKey.get("release_type"), "album; compilation");
  assert.equal(byKey.get("itunesadvisory"), "1");
  assert.equal(byKey.get("replaygain_track_gain"), "-7.31 dB");
  assert.equal(byKey.get("replaygain_track_peak"), "0.967717");

  assert.equal(dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderAlbums'").get(), undefined);
  assert.equal(dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderMedia'").get(), undefined);
});

test("retag apply writes a real file, verifies it, and produces an idempotent second preview", {
  skip: spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status !== 0,
}, async () => {
  const row = dbModule.db.prepare(`
    SELECT id, file_path
    FROM TrackFiles
    WHERE canonical_recording_mbid = ?
  `).get("recording-mbid-1") as { id: number; file_path: string };

  const generated = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "1", "-c:a", "flac",
    "-metadata", "TITLE=Wrong title",
    "-metadata", "ARTIST=Wrong artist",
    row.file_path,
  ], { windowsHide: true, encoding: "utf-8" });
  assert.equal(generated.status, 0, generated.stderr);

  configModule.updateConfig("metadata", {
    ...configModule.getConfigSection("metadata"),
    write_audio_tags_policy: "all_files",
    scrub_audio_tags: false,
  });
  configModule.updateConfig("quality", {
    ...configModule.getConfigSection("quality"),
    embed_cover: false,
    embed_lyrics: false,
  });

  const before = await audioTagServiceModule.AudioTagService.preview({ limit: 20 });
  const preview = before.find((item) => item.id === row.id);
  assert.ok(preview);
  assert.equal(preview.missing, false);
  const album = dbModule.db.prepare(`SELECT id FROM Albums WHERE mbid = ?`).get("release-group-mbid-1") as { id: number };
  assert.equal(preview.albumId, album.id);
  assert.ok(preview.changes.some((change) => change.field === "Title"));
  assert.ok(preview.changes.some((change) => change.field === "Artist"));

  const applied = await audioTagServiceModule.AudioTagService.apply(
    [row.id],
    { includeExternalLyrics: false },
  );
  assert.deepEqual(applied, {
    retagged: 1,
    skipped: 0,
    missing: 0,
    errors: [],
  });

  const after = await audioTagServiceModule.AudioTagService.preview({ limit: 20 });
  assert.equal(after.some((item) => item.id === row.id), false);
});
