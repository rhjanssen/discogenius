import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import * as jpeg from "jpeg-js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-audio-tag-canonical-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let configModule: typeof import("../config/config.js");
let audioTagServiceModule: typeof import("./audio-tag-service.js");
let compareEmbeddedAudioCover: typeof import("./audioUtils.js").compareEmbeddedAudioCover;

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  configModule = await import("../config/config.js");
  audioTagServiceModule = await import("./audio-tag-service.js");
  ({ compareEmbeddedAudioCover } = await import("./audioUtils.js"));
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

test("tag supplements use the file edition and omit ambiguous provider edition context", () => {
  const file = dbModule.db.prepare("SELECT id FROM TrackFiles WHERE provider_id = 'provider-track-1'").get() as { id: number };
  const track = dbModule.db.prepare("SELECT id FROM ProviderItems WHERE provider = 'tidal' AND entity_type = 'track' AND provider_id = 'provider-track-1'").get() as { id: number };
  const edition = dbModule.db.prepare(`INSERT INTO ProviderItems (provider, entity_type, provider_id, title, upc)
    VALUES ('tidal', 'release', 'other-edition', 'Other edition', '111111111111') RETURNING id`).get() as { id: number };
  dbModule.db.prepare(`INSERT INTO ProviderEditionMembers (provider_edition_item_id, member_item_id, medium_position, position)
    VALUES (?, ?, 1, 1)`).run(edition.id, track.id);
  const barcode = () => audioTagServiceModule.AudioTagService.buildDesiredTagsForTrackFileIdsForTest([file.id])
    .find(tag => tag.key === "barcode")?.targetValue;
  try {
    assert.equal(barcode(), "987654321000", "an unmatched membership cannot change the file's edition context");
    dbModule.db.prepare(`INSERT INTO ProviderEditionMatches
      (provider_edition_item_id, edition_id, relation, match_state, decision_source, confidence, method, matcher_version)
      SELECT ?, id, 'exact', 'accepted', 'automatic', 1, 'test', 1 FROM AlbumEditions WHERE mbid = 'release-mbid-1'`)
      .run(edition.id);
    assert.equal(barcode(), undefined, "two plausible provider editions cannot supply an arbitrary barcode");
  } finally {
    dbModule.db.prepare("DELETE FROM ProviderItems WHERE id = ?").run(edition.id);
  }
});

test("retag reads the canonical medium format from active catalog payload casing", () => {
  const file = dbModule.db.prepare("SELECT id FROM TrackFiles WHERE provider_id = 'provider-track-1'").get() as { id: number };
  try {
    for (const media of [[{ Position: 1, Format: "Cassette" }], [{ position: 1, format: "CD" }]]) {
      dbModule.db.prepare("UPDATE AlbumEditions SET media = ? WHERE mbid = 'release-mbid-1'").run(JSON.stringify(media));
      const format = audioTagServiceModule.AudioTagService.buildDesiredTagsForTrackFileIdsForTest([file.id])
        .find(tag => tag.key === "media_format")?.targetValue;
      assert.equal(format, "Format" in media[0] ? media[0].Format : media[0].format);
    }
    dbModule.db.prepare("UPDATE AlbumEditions SET media = ? WHERE mbid = 'release-mbid-1'")
      .run(JSON.stringify([{ Position: 2, Format: "CD" }, { Position: 1, Format: "Cassette" }]));
    const formatForFile = () => audioTagServiceModule.AudioTagService.buildDesiredTagsForTrackFileIdsForTest([file.id])
      .find(tag => tag.key === "media_format")?.targetValue;
    assert.equal(formatForFile(), "Cassette", "medium number, rather than array order, determines the format");
    dbModule.db.prepare("UPDATE Tracks SET medium_position = 2 WHERE mbid = 'track-mbid-1'").run();
    assert.equal(formatForFile(), "CD");
  } finally {
    dbModule.db.prepare("UPDATE Tracks SET medium_position = 1 WHERE mbid = 'track-mbid-1'").run();
    dbModule.db.prepare("UPDATE AlbumEditions SET media = NULL WHERE mbid = 'release-mbid-1'").run();
  }
});

test("artist retag scope resolves both public MBIDs and internal metadata ids", async () => {
  const file = dbModule.db.prepare(`
    SELECT id, artist_metadata_id
    FROM TrackFiles
    WHERE canonical_recording_mbid = ?
  `).get("recording-mbid-1") as { id: number; artist_metadata_id: number };

  const byMbid = await audioTagServiceModule.AudioTagService.preview({
    artistId: "artist-mbid-1",
    limit: 20,
  });
  const byInternalId = await audioTagServiceModule.AudioTagService.preview({
    artistId: String(file.artist_metadata_id),
    limit: 20,
  });
  const byBulkMbid = await audioTagServiceModule.AudioTagService.preview({
    artistIds: ["artist-mbid-1"],
    limit: 20,
  });

  assert.deepEqual(byMbid.map((item) => item.id), [file.id]);
  assert.deepEqual(byInternalId.map((item) => item.id), [file.id]);
  assert.deepEqual(byBulkMbid.map((item) => item.id), [file.id]);
});

test("embedded cover resolution reads the exact edition cache", async () => {
  const firstCover = Buffer.from("edition-one-cover");
  const secondCover = Buffer.from("edition-two-cover");
  const firstCache = path.join(tempDir, "media-cover", "AlbumEditions", "release-mbid-1");
  const secondCache = path.join(tempDir, "media-cover", "AlbumEditions", "release-mbid-2");
  fs.mkdirSync(firstCache, { recursive: true });
  fs.mkdirSync(secondCache, { recursive: true });
  fs.writeFileSync(path.join(firstCache, "cover.jpg"), firstCover);
  fs.writeFileSync(path.join(secondCache, "cover.jpg"), secondCover);

  assert.deepEqual(
    await audioTagServiceModule.AudioTagService.readPreferredEmbeddedCoverForTest("release-mbid-1"),
    firstCover,
  );
  assert.deepEqual(
    await audioTagServiceModule.AudioTagService.readPreferredEmbeddedCoverForTest("release-mbid-2"),
    secondCover,
  );
});

test("embedded cover resolution preserves the full-resolution original above 1200 pixels", async () => {
  const bytes = Buffer.from(jpeg.encode({ width: 1500, height: 1500, data: Buffer.alloc(1500 * 1500 * 4, 160) }, 95).data);
  const folder = path.join(tempDir, "media-cover", "AlbumEditions", "full-res-edition");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "cover.jpg"), bytes);
  assert.deepEqual(await audioTagServiceModule.AudioTagService.readPreferredEmbeddedCoverForTest("full-res-edition"), bytes);
});

test("bulk artist retag waits for a catalog writer, verifies tags and cover, and is idempotent", {
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

  const coverPath = path.join(
    tempDir,
    "media-cover",
    "AlbumEditions",
    "release-mbid-1",
    "cover.jpg",
  );
  const generatedCover = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=blue:s=64x64",
    "-frames:v", "1", coverPath,
  ], { windowsHide: true, encoding: "utf-8" });
  assert.equal(generatedCover.status, 0, generatedCover.stderr);

  configModule.updateConfig("metadata", {
    ...configModule.getConfigSection("metadata"),
    write_audio_tags_policy: "all_files",
    scrub_audio_tags: false,
  });
  configModule.updateConfig("quality", {
    ...configModule.getConfigSection("quality"),
    embed_cover: true,
    embed_lyrics: false,
  });

  const before = await audioTagServiceModule.AudioTagService.preview({
    artistIds: ["artist-mbid-1"],
    limit: 20,
  });
  const preview = before.find((item) => item.id === row.id);
  assert.ok(preview);
  assert.equal(preview.missing, false);
  const album = dbModule.db.prepare(`SELECT id FROM Albums WHERE mbid = ?`).get("release-group-mbid-1") as { id: number };
  assert.equal(preview.albumId, album.id);
  assert.ok(preview.changes.some((change) => change.field === "Title"));
  assert.ok(preview.changes.some((change) => change.field === "Artist"));
  assert.ok(preview.changes.some((change) => change.field === "Cover Art"));

  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const blocker = dbModule.withSqliteWriteGate(() => {
    acquired();
    return new Promise<void>(resolve => { release = resolve; });
  }, "test:catalog-writer");
  await ready;
  let applied;
  try {
    applied = await audioTagServiceModule.AudioTagService.applyByQuery({
      artistIds: ["artist-mbid-1"],
      onProgress: (completed) => {
        if (completed === 1) setTimeout(release, 30);
      },
    });
  } finally {
    release();
    await blocker;
  }
  assert.deepEqual(applied, {
    retagged: 1,
    skipped: 0,
    missing: 0,
    errors: [],
  });

  assert.equal((await compareEmbeddedAudioCover(row.file_path, coverPath)).matches, true);

  const after = await audioTagServiceModule.AudioTagService.preview({
    artistIds: ["artist-mbid-1"],
    limit: 20,
  });
  assert.equal(after.some((item) => item.id === row.id), false);
});

for (const extension of ["flac", "m4a", "mp3"]) {
  test(`local ${extension} retag embeds sidecar lyrics without a provider and remains idempotent after scrubbing`, {
    skip: spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status !== 0,
  }, async () => {
    const row = dbModule.db.prepare("SELECT id FROM TrackFiles WHERE canonical_recording_mbid = ?")
      .get("recording-mbid-1") as { id: number };
    const mediaPath = path.join(tempDir, `local-lyrics.${extension}`);
    dbModule.db.prepare("UPDATE Recordings SET isrcs = ? WHERE mbid = ?")
      .run(JSON.stringify(["USUM70722793", "USUM70809583"]), "recording-mbid-1");
    const generated = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440",
      "-t", "0.1", "-c:a", extension === "flac" ? "flac" : extension === "mp3" ? "libmp3lame" : "aac", mediaPath,
    ], { windowsHide: true, encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    if (extension === "mp3") {
      const { writeMediaTagsWithTagLib } = await import("./media-tag-io.js");
      assert.equal((await writeMediaTagsWithTagLib(mediaPath, {
        "TXXX:MusicBrainz Track Id": "recording-mbid-1",
      })).success, true);
    }
    dbModule.db.prepare(`UPDATE TrackFiles SET file_path = ?, relative_path = ?, extension = ?,
      provider_item_id = NULL, provider = NULL, provider_id = NULL WHERE id = ?`)
      .run(mediaPath, path.basename(mediaPath), extension, row.id);
    configModule.updateConfig("metadata", {
      ...configModule.getConfigSection("metadata"), write_audio_tags_policy: "all_files", scrub_audio_tags: true,
    });
    configModule.updateConfig("quality", {
      ...configModule.getConfigSection("quality"), embed_cover: false, embed_lyrics: true,
    });
    const sidecarPath = path.join(tempDir, "local-lyrics.lrc");
    const lyrics = "[00:00.00] A test melody\n[00:00.05] Another test line";
    fs.writeFileSync(sidecarPath, lyrics);
    const preview = await audioTagServiceModule.AudioTagService.preview({ artistId: "artist-mbid-1" });
    assert.ok(preview.find(item => item.id === row.id)?.changes.some(change => change.field === "Lyrics"));
    assert.equal(fs.readFileSync(sidecarPath, "utf8"), lyrics);
    const applied = await audioTagServiceModule.AudioTagService.apply([row.id]);
    assert.deepEqual(applied, {
      retagged: 1, skipped: 0, missing: 0, errors: [],
    });
    const { parseFile } = await import("music-metadata");
    const metadata = await parseFile(mediaPath);
    assert.deepEqual(metadata.common.musicbrainz_artistid, ["artist-mbid-1", "guest-mbid-1"]);
    assert.deepEqual(metadata.common.musicbrainz_albumartistid, ["album-artist-mbid-1"]);
    if (extension === "mp3") {
      assert.equal(metadata.common.musicbrainz_recordingid, "recording-mbid-1");
      assert.ok(Object.values(metadata.native).flat().some(tag => tag.id === "UFID"));
      assert.equal(Object.values(metadata.native).flat().some(tag => tag.id === "TXXX:MusicBrainz Track Id"), false);
    }
    assert.deepEqual(metadata.common.isrc?.flatMap(value => value.split(/\s*\/\s*|;\s*/)).sort(),
      ["USUM70722793", "USUM70809583"]);
    const embedded = Object.values(metadata.native).flat().find(tag => ["LYRICS", "©lyr", "USLT"].includes(tag.id));
    assert.equal(extension === "mp3" ? (embedded?.value as { text?: string } | undefined)?.text : embedded?.value, lyrics);
    assert.deepEqual(await audioTagServiceModule.AudioTagService.apply([row.id]), {
      retagged: 0, skipped: 1, missing: 0, errors: [],
    });
    assert.equal((await audioTagServiceModule.AudioTagService.preview({ artistId: "artist-mbid-1" })).length, 0);
    const { writeMediaTagsWithTagLib } = await import("./media-tag-io.js");
    const customKey = extension === "flac" ? "MY_CUSTOM_TAG" : extension === "mp3" ? "TXXX:MY_CUSTOM_TAG" : "----:com.apple.iTunes:MY_CUSTOM_TAG";
    assert.equal((await writeMediaTagsWithTagLib(mediaPath, { [customKey]: "Keep my note" })).success, true);
    configModule.updateConfig("metadata", { ...configModule.getConfigSection("metadata"), scrub_audio_tags: false });
    assert.deepEqual(await audioTagServiceModule.AudioTagService.apply([row.id]), { retagged: 0, skipped: 1, missing: 0, errors: [] });
    assert.ok(Object.values((await parseFile(mediaPath)).native).flat().some(tag => tag.id.includes("MY_CUSTOM_TAG")));
    configModule.updateConfig("metadata", { ...configModule.getConfigSection("metadata"), scrub_audio_tags: true });
    assert.ok((await audioTagServiceModule.AudioTagService.preview({ artistId: "artist-mbid-1" }))[0].changes.some(change => change.field === "Unmanaged tags"));
    assert.deepEqual(await audioTagServiceModule.AudioTagService.apply([row.id]), { retagged: 1, skipped: 0, missing: 0, errors: [] });
    assert.equal(Object.values((await parseFile(mediaPath)).native).flat().some(tag => tag.id.includes("MY_CUSTOM_TAG")), false);
    assert.equal((await audioTagServiceModule.AudioTagService.preview({ artistId: "artist-mbid-1" })).length, 0);
  });
}

test("retag verifies its written track-count snapshot while catalogue hydration changes the edition", {
  skip: spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status !== 0,
}, async () => {
  const row = dbModule.db.prepare("SELECT id FROM TrackFiles WHERE canonical_recording_mbid = ?")
    .get("recording-mbid-1") as { id: number };
  const mediaPath = path.join(tempDir, "concurrent-catalog.flac");
  const generated = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "0.1", mediaPath], { windowsHide: true, encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  dbModule.db.prepare("UPDATE TrackFiles SET file_path = ?, relative_path = ?, extension = 'flac' WHERE id = ?")
    .run(mediaPath, path.basename(mediaPath), row.id);
  configModule.updateConfig("metadata", { ...configModule.getConfigSection("metadata"), write_audio_tags_policy: "all_files" });
  configModule.updateConfig("quality", { ...configModule.getConfigSection("quality"), embed_cover: false, embed_lyrics: false });
  const service = audioTagServiceModule.AudioTagService;
  const evaluate = service.evaluateFileTags;
  let hydrated = false;
  service.evaluateFileTags = async (...args) => {
    const result = await evaluate.apply(service, args);
    if (!hydrated) {
      hydrated = true;
      dbModule.db.prepare(`INSERT INTO Tracks (foreign_track_id, mbid, release_mbid, recording_mbid, medium_position, position, number, title)
        VALUES ('concurrent-track', 'concurrent-track', 'release-mbid-1', 'recording-mbid-1', 1, 2, '2', 'Added during hydration')`).run();
    }
    return result;
  };
  try {
    assert.deepEqual(await service.apply([row.id]), { retagged: 1, skipped: 0, missing: 0, errors: [] });
    const { parseFile } = await import("music-metadata");
    assert.equal((await parseFile(mediaPath)).common.track.of, 1, "the completed write verified the original snapshot");
    const next = await service.preview({ artistId: "artist-mbid-1" });
    assert.ok(next.some(item => item.changes.some(change => change.field === "Track")), "the next pass sees the new catalogue count");
  } finally {
    service.evaluateFileTags = evaluate;
    dbModule.db.prepare("DELETE FROM Tracks WHERE mbid = 'concurrent-track'").run();
  }
});
