import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-database-versioning-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("./database.js");
const CURRENT_SCHEMA_VERSION = 29;

before(async () => {
  dbModule = await import("./database.js");
  dbModule.initDatabase();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test.skip("initDatabase normalizes legacy semver schema baseline to integer versioning", () => {
  dbModule.db.pragma("user_version = 10000");
  dbModule.db.prepare(`
    INSERT INTO config (key, value, description)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      description = excluded.description,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    "runtime.current_schema_version",
    "1.0.0",
    "Legacy semver-encoded schema baseline"
  );
  dbModule.db.prepare(`
    INSERT INTO config (key, value, description)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      description = excluded.description,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    "runtime.current_schema_user_version",
    "10000",
    "Legacy semver-encoded PRAGMA user_version"
  );
  dbModule.db.prepare("DELETE FROM config WHERE key = 'runtime.schema_version_format'").run();

  dbModule.initDatabase();

  const userVersion = dbModule.db.pragma("user_version", { simple: true }) as number;
  const runtimeRows = dbModule.db.prepare(`
    SELECT key, value
    FROM config
    WHERE key IN (
      'runtime.current_schema_version',
      'runtime.current_schema_user_version',
      'runtime.schema_version_format'
    )
    ORDER BY key
  `).all() as Array<{ key: string; value: string }>;
  const latestHistory = dbModule.db.prepare(`
    SELECT schema_from as schemaFrom, schema_to as schemaTo, migration_notes as migrationNotes
    FROM database_version_history
    ORDER BY id DESC
    LIMIT 1
  `).get() as { schemaFrom: number; schemaTo: number; migrationNotes: string } | undefined;

  assert.equal(userVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(runtimeRows, [
    { key: "runtime.current_schema_version", value: String(CURRENT_SCHEMA_VERSION) },
    { key: "runtime.schema_version_format", value: "integer" },
  ]);
  assert.ok(latestHistory);
  assert.equal(latestHistory?.schemaFrom, 10000);
  assert.equal(latestHistory?.schemaTo, CURRENT_SCHEMA_VERSION);
  assert.equal(
    latestHistory?.migrationNotes,
    `baseline current schema as ${CURRENT_SCHEMA_VERSION} (PRAGMA user_version=${CURRENT_SCHEMA_VERSION})`,
  );
});

// ====================================================================
// MIGRATION SMOKE TESTS
// ====================================================================

test("fresh database initializes with correct schema version", () => {
  const userVersion = dbModule.db.pragma("user_version", { simple: true }) as number;
  assert.equal(userVersion, CURRENT_SCHEMA_VERSION);

  const coreTables = [
    "Artists", "TrackFiles",
    "MetadataFiles", "LyricFiles", "ExtraFiles",
    "UnmappedFiles", "config", "commands", "quality_profiles",
    "upgrade_queue", "history_events",
    "database_version_history", "MediaCoverProxyCache",
    "ArtistMetadata", "Albums", "AlbumReleases", "AlbumReleaseMedia",
    "Tracks", "Recordings", "ProviderItems", "ReleaseGroupSlots",
  ];
  for (const tableName of coreTables) {
    const row = dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName) as { name: string } | undefined;
    assert.ok(row, `Expected table '${tableName}' to exist`);
  }

  const supersededTables = [
    "local_entities",
    "provider_entity_ids",
    "artist_metadata",
    "artwork_cache",
    "provider_video_identity",
    "provider_video_items",
    "provider_ids",
    "ProviderAlbums",
    "ProviderMedia",
    "ProviderAlbumArtists",
    "ProviderMediaArtists",
  ];
  for (const tableName of supersededTables) {
    const row = dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName) as { name: string } | undefined;
    assert.equal(row, undefined, `Expected superseded table '${tableName}' to be absent`);
  }

  const libraryFileCols = dbModule.db.prepare("PRAGMA table_info(TrackFiles)").all() as Array<{ name: string }>;
  for (const columnName of [
    "canonical_artist_mbid",
    "canonical_release_group_mbid",
    "canonical_release_mbid",
    "canonical_track_mbid",
    "canonical_recording_mbid",
    "release_group_id",
    "album_release_id",
    "track_id",
    "recording_id",
    "provider",
    "provider_entity_type",
    "provider_id",
    "library_slot",
  ]) {
    assert.ok(libraryFileCols.some((column) => column.name === columnName), `Expected TrackFiles.${columnName}`);
  }

  const metadataFileCols = dbModule.db.prepare("PRAGMA table_info(MetadataFiles)").all() as Array<{ name: string }>;
  for (const columnName of ["id", "artist_id", "album_id", "track_file_id", "relative_path", "file_path", "consumer", "type", "file_type"]) {
    assert.ok(metadataFileCols.some((column) => column.name === columnName), `Expected MetadataFiles.${columnName}`);
  }

  const lyricFileCols = dbModule.db.prepare("PRAGMA table_info(LyricFiles)").all() as Array<{ name: string }>;
  for (const columnName of ["id", "artist_id", "album_id", "track_file_id", "relative_path", "file_path", "canonical_recording_mbid"]) {
    assert.ok(lyricFileCols.some((column) => column.name === columnName), `Expected LyricFiles.${columnName}`);
  }

  const upgradeQueueCols = dbModule.db.prepare("PRAGMA table_info(upgrade_queue)").all() as Array<{ name: string; notnull: number }>;
  for (const columnName of ["media_id", "album_id", "provider", "entity_type", "provider_id", "album_provider_id", "track_file_id"]) {
    assert.ok(upgradeQueueCols.some((column) => column.name === columnName), `Expected upgrade_queue.${columnName}`);
  }
  const mediaIdColumn = upgradeQueueCols.find((column) => column.name === "media_id");
  assert.equal(mediaIdColumn?.notnull, 0, "Expected upgrade_queue.media_id to allow canonical-only rows without legacy media ids");
});

test.skip("migration from integer schema v1 runs pending migrations", () => {
  dbModule.db.pragma("user_version = 1");
  dbModule.db.prepare(`
    INSERT INTO config (key, value, description)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run("runtime.schema_version_format", "integer", "Schema versioning format");

  dbModule.initDatabase();

  const userVersion = dbModule.db.pragma("user_version", { simple: true }) as number;
  assert.equal(userVersion, CURRENT_SCHEMA_VERSION);

  // v4 migration adds Artists.path
  const artistCols = dbModule.db.prepare("PRAGMA table_info(Artists)").all() as Array<{ name: string }>;
  assert.ok(artistCols.some((c) => c.name === "path"), "Expected Artists table to have 'path' column");
  assert.ok(artistCols.some((c) => c.name === "cover_image_url"), "Expected Artists table to have 'cover_image_url' column");

  // v3 migration adds commands.queue_order
  const jobCols = dbModule.db.prepare("PRAGMA table_info(commands)").all() as Array<{ name: string }>;
  assert.ok(jobCols.some((c) => c.name === "queue_order"), "Expected commands table to have 'queue_order' column");
});

test.skip("provider compatibility rows are mirrored into ProviderItems", () => {
  const artistId = "provider-backfill-artist";
  const artistMbid = "provider-backfill-artist-mbid";
  const releaseGroupMbid = "provider-backfill-rg";
  const releaseMbid = "provider-backfill-release";
  const trackMbid = "provider-backfill-track";
  const recordingMbid = "provider-backfill-recording";
  const albumProviderId = "provider-backfill-album";
  const trackProviderId = "provider-backfill-track-provider";

  dbModule.db.prepare("DELETE FROM ProviderItems WHERE provider_id IN (?, ?)").run(albumProviderId, trackProviderId);
  dbModule.db.prepare("DELETE FROM ProviderMedia WHERE id = ?").run(trackProviderId);
  dbModule.db.prepare("DELETE FROM ProviderAlbums WHERE id = ?").run(albumProviderId);
  dbModule.db.prepare("DELETE FROM Tracks WHERE mbid = ?").run(trackMbid);
  dbModule.db.prepare("DELETE FROM Recordings WHERE mbid = ?").run(recordingMbid);
  dbModule.db.prepare("DELETE FROM AlbumReleases WHERE mbid = ?").run(releaseMbid);
  dbModule.db.prepare("DELETE FROM Albums WHERE mbid = ?").run(releaseGroupMbid);
  dbModule.db.prepare("DELETE FROM Artists WHERE id = ?").run(artistId);
  dbModule.db.prepare("DELETE FROM ArtistMetadata WHERE mbid = ?").run(artistMbid);

  dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run(artistMbid, "provider Backfill Artist");
  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid)
    VALUES (?, ?, ?)
  `).run(artistId, "provider Backfill Artist", artistMbid);
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title)
    VALUES (?, ?, ?)
  `).run(releaseGroupMbid, artistMbid, "provider Backfill Release Group");
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title)
    VALUES (?, ?, ?, ?)
  `).run(releaseMbid, releaseGroupMbid, artistMbid, "provider Backfill Release");
  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, title)
    VALUES (?, ?)
  `).run(recordingMbid, "provider Backfill Recording");
  dbModule.db.prepare(`
    INSERT INTO Tracks (
      mbid, release_mbid, recording_mbid, medium_position, position, number, title
    ) VALUES (?, ?, ?, 1, 1, '1', ?)
  `).run(trackMbid, releaseMbid, recordingMbid, "provider Backfill Track");
  dbModule.db.prepare(`
    INSERT INTO ProviderAlbums (
      id, artist_id, title, release_date, type, explicit, quality,
      num_tracks, num_volumes, num_videos, duration, upc, mbid, mb_release_group_id
    ) VALUES (?, ?, ?, '2026-01-01', 'ALBUM', 0, 'LOSSLESS', 1, 1, 0, 180, '123456789012', ?, ?)
  `).run(albumProviderId, artistId, "provider Backfill Album", releaseMbid, releaseGroupMbid);
  dbModule.db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, album_id, title, type, explicit, quality,
      track_number, volume_number, duration, isrc, mbid
    ) VALUES (?, ?, ?, ?, 'Track', 0, 'LOSSLESS', 1, 1, 180, 'USRC17607839', ?)
  `).run(trackProviderId, artistId, albumProviderId, "provider Backfill Track", trackMbid);

  dbModule.initDatabase();

  const rows = dbModule.db.prepare(`
    SELECT entity_type as entityType, provider_id as providerId, release_group_mbid as releaseGroupMbid,
           release_mbid as releaseMbid, track_mbid as trackMbid, recording_mbid as recordingMbid,
           library_slot as librarySlot
    FROM ProviderItems
    WHERE provider = 'tidal' AND provider_id IN (?, ?)
    ORDER BY entity_type
  `).all(albumProviderId, trackProviderId) as Array<{
    entityType: string;
    providerId: string;
    releaseGroupMbid: string | null;
    releaseMbid: string | null;
    trackMbid: string | null;
    recordingMbid: string | null;
    librarySlot: string;
  }>;

  assert.deepEqual(rows, [
    {
      entityType: "album",
      providerId: albumProviderId,
      releaseGroupMbid,
      releaseMbid,
      trackMbid: null,
      recordingMbid: null,
      librarySlot: "stereo",
    },
    {
      entityType: "track",
      providerId: trackProviderId,
      releaseGroupMbid,
      releaseMbid,
      trackMbid,
      recordingMbid,
      librarySlot: "stereo",
    },
  ]);
});

test.skip("migration from integer schema v3 runs the v4-v5 tail migrations", () => {
  dbModule.db.pragma("user_version = 3");
  dbModule.db.prepare(`
    INSERT INTO config (key, value, description)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run("runtime.schema_version_format", "integer", "Schema versioning format");

  dbModule.initDatabase();

  const userVersion = dbModule.db.pragma("user_version", { simple: true }) as number;
  assert.equal(userVersion, CURRENT_SCHEMA_VERSION);

  const latestHistory = dbModule.db.prepare(`
    SELECT schema_from as schemaFrom, schema_to as schemaTo, migration_notes as migrationNotes
    FROM database_version_history
    ORDER BY id DESC
    LIMIT 1
  `).get() as { schemaFrom: number; schemaTo: number; migrationNotes: string } | undefined;

  assert.ok(latestHistory);
  assert.equal(latestHistory?.schemaFrom, 3);
  assert.equal(latestHistory?.schemaTo, CURRENT_SCHEMA_VERSION);
  assert.match(latestHistory?.migrationNotes ?? "", /artist path column/i);
  assert.match(latestHistory?.migrationNotes ?? "", /lidarr-aligned names/i);
  assert.match(latestHistory?.migrationNotes ?? "", /provider mapping scaffold/i);
  assert.match(latestHistory?.migrationNotes ?? "", /library slot selections/i);
  assert.match(latestHistory?.migrationNotes ?? "", /canonical MusicBrainz and provider identity/i);
  assert.match(latestHistory?.migrationNotes ?? "", /drop superseded provider identity tables/i);
  assert.match(latestHistory?.migrationNotes ?? "", /Lidarr-aligned TrackFiles/i);
  assert.match(latestHistory?.migrationNotes ?? "", /legacy provider table collisions/i);
  assert.match(latestHistory?.migrationNotes ?? "", /extra file tables/i);
  assert.match(latestHistory?.migrationNotes ?? "", /retire sidecar projection/i);
  assert.match(latestHistory?.migrationNotes ?? "", /normalize legacy metadata source labels/i);
  assert.match(latestHistory?.migrationNotes ?? "", /redirect guest and similar artists/i);
  assert.match(latestHistory?.migrationNotes ?? "", /MediaCoverProxyCache/i);
  assert.match(latestHistory?.migrationNotes ?? "", /serialized images columns/i);
});

test("unversioned database with existing data runs full migration chain", () => {
  dbModule.db.pragma("user_version = 0");
  dbModule.db.prepare("DELETE FROM config WHERE key = 'runtime.schema_version_format'").run();
  dbModule.db.prepare("INSERT OR IGNORE INTO Artists (id, name) VALUES (1, 'Test Artist')").run();

  dbModule.initDatabase();

  const userVersion = dbModule.db.pragma("user_version", { simple: true }) as number;
  assert.equal(userVersion, CURRENT_SCHEMA_VERSION);

  const latestHistory = dbModule.db.prepare(`
    SELECT schema_from as schemaFrom, schema_to as schemaTo
    FROM database_version_history
    ORDER BY id DESC
    LIMIT 1
  `).get() as { schemaFrom: number; schemaTo: number } | undefined;

  assert.ok(latestHistory);
  assert.equal(latestHistory?.schemaFrom, 0);
  assert.equal(latestHistory?.schemaTo, CURRENT_SCHEMA_VERSION);
});

test.skip("schema v13 repairs legacy provider-shaped Albums table collision", () => {
  dbModule.db.pragma("foreign_keys = OFF");
  try {
    dbModule.db.exec(`
      DROP TABLE IF EXISTS Albums;
      DROP TABLE IF EXISTS albums;
      DROP TABLE IF EXISTS media;
      DROP TABLE IF EXISTS upgrade_queue;
      CREATE TABLE albums (
        id TEXT PRIMARY KEY,
        artist_id TEXT NOT NULL,
        title TEXT NOT NULL,
        release_date DATETIME,
        type TEXT NOT NULL,
        explicit BOOLEAN NOT NULL,
        quality TEXT NOT NULL,
        num_tracks INT NOT NULL,
        num_volumes INT NOT NULL,
        num_videos INT NOT NULL,
        duration INT NOT NULL
      );

      CREATE TABLE media (
        id TEXT PRIMARY KEY,
        artist_id TEXT NOT NULL,
        album_id TEXT,
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        explicit BOOLEAN NOT NULL,
        quality TEXT NOT NULL,
        FOREIGN KEY(album_id) REFERENCES albums(id) ON DELETE CASCADE
      );

      CREATE TABLE upgrade_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_id INT NOT NULL,
        album_id INT,
        current_quality TEXT NOT NULL,
        target_quality TEXT NOT NULL,
        reason TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed_at DATETIME,
        UNIQUE(media_id),
        FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE,
        FOREIGN KEY(album_id) REFERENCES albums(id) ON DELETE CASCADE
      );

      DROP TABLE IF EXISTS mb_release_groups;
      CREATE TABLE mb_release_groups (
        mbid TEXT PRIMARY KEY,
        artist_mbid TEXT NOT NULL,
        title TEXT NOT NULL,
        primary_type TEXT,
        secondary_types TEXT,
        first_release_date TEXT,
        disambiguation TEXT,
        data TEXT,
        updated_at DATETIME
      );

      INSERT INTO mb_release_groups (
        mbid, artist_mbid, title, primary_type, first_release_date
      ) VALUES (
        'legacy-rg-mbid',
        'legacy-artist-mbid',
        'Legacy Release Group',
        'album',
        '1977-01-01'
      );
    `);
  } finally {
    dbModule.db.pragma("foreign_keys = ON");
  }

  dbModule.db.pragma("user_version = 13");
  dbModule.db.prepare(`
    INSERT INTO config (key, value, description)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run("runtime.schema_version_format", "integer", "Schema versioning format");

  dbModule.initDatabase();

  const userVersion = dbModule.db.pragma("user_version", { simple: true }) as number;
  assert.equal(userVersion, CURRENT_SCHEMA_VERSION);

  const albumCols = dbModule.db.prepare("PRAGMA table_info(Albums)").all() as Array<{ name: string }>;
  assert.ok(albumCols.some((column) => column.name === "artist_mbid"), "Expected canonical Albums.artist_mbid");
  assert.ok(albumCols.some((column) => column.name === "first_release_date"), "Expected canonical Albums.first_release_date");

  const legacyMedia = dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='media'").get();
  assert.equal(legacyMedia, undefined, "Expected legacy lowercase media table to be removed");

  const upgradeQueueFks = dbModule.db.prepare("PRAGMA foreign_key_list(upgrade_queue)").all() as Array<{ table: string }>;
  assert.equal(upgradeQueueFks.some((foreignKey) => foreignKey.table === "ProviderMedia"), false);
  assert.equal(upgradeQueueFks.some((foreignKey) => foreignKey.table === "ProviderAlbums"), false);

  const releaseGroup = dbModule.db.prepare(`
    SELECT mbid, artist_mbid as artistMbid, title
    FROM Albums
    WHERE mbid = ?
  `).get("legacy-rg-mbid") as { mbid: string; artistMbid: string; title: string } | undefined;
  assert.deepEqual(releaseGroup, {
    mbid: "legacy-rg-mbid",
    artistMbid: "legacy-artist-mbid",
    title: "Legacy Release Group",
  });
});
