import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-database-baseline-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("./database.js");
const CURRENT_SCHEMA_VERSION = 31;

before(async () => {
  dbModule = await import("./database.js");
  dbModule.initDatabase();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function tableColumns(tableName: string): string[] {
  return (dbModule.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>)
    .map((column) => column.name);
}

test("fresh database initializes the current development baseline", () => {
  const userVersion = dbModule.db.pragma("user_version", { simple: true }) as number;
  assert.equal(userVersion, CURRENT_SCHEMA_VERSION);

  const coreTables = [
    "Artists", "ArtistMetadata", "Albums", "AlbumReleases", "AlbumReleaseMedia",
    "AlbumArtists", "ArtistReleaseGroups", "ArtistReleaseGroupCuration",
    "Tracks", "Recordings", "ProviderItems", "ReleaseGroupSlots",
    "TrackFiles", "MetadataFiles", "LyricFiles", "ExtraFiles", "UnmappedFiles",
    "commands", "scheduled_tasks", "quality_profiles",
    "history_events", "MediaCoverProxyCache",
    "ArtistStatistics",
  ];

  for (const tableName of coreTables) {
    const row = dbModule.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(tableName) as { name: string } | undefined;
    assert.ok(row, `Expected table '${tableName}' to exist`);
  }
});

test("upgrade queue table is absent from the fresh schema", () => {
  const row = dbModule.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='upgrade_queue'")
    .get() as { name: string } | undefined;
  assert.equal(row, undefined);
});

test("catalog tables expose integer foreign-key links as the authoritative join path", () => {
  const expectedColumnsByTable = new Map<string, string[]>([
    ["Albums", ["id", "artist_metadata_id", "mbid", "artist_mbid"]],
    ["AlbumReleases", ["id", "release_group_id", "artist_metadata_id", "mbid", "release_group_mbid", "artist_mbid"]],
    ["AlbumReleaseMedia", ["id", "album_release_id", "release_mbid"]],
    ["AlbumArtists", ["release_group_id", "artist_metadata_id", "release_group_mbid", "artist_mbid"]],
    ["ArtistReleaseGroups", ["artist_metadata_id", "release_group_id", "artist_mbid", "release_group_mbid"]],
    ["ArtistReleaseGroupCuration", ["source_artist_metadata_id", "release_group_id", "redundant_to_release_group_id", "source_artist_mbid", "release_group_mbid"]],
    ["Tracks", ["id", "album_release_id", "recording_id", "release_mbid", "recording_mbid"]],
    ["ReleaseGroupSlots", ["id", "artist_metadata_id", "release_group_id", "selected_album_release_id", "artist_mbid", "release_group_mbid", "selected_release_mbid"]],
    ["TrackFiles", ["release_group_id", "album_release_id", "track_id", "recording_id", "canonical_release_group_mbid", "canonical_release_mbid", "canonical_track_mbid", "canonical_recording_mbid"]],
  ]);

  for (const [tableName, expectedColumns] of expectedColumnsByTable) {
    const columns = tableColumns(tableName);
    for (const columnName of expectedColumns) {
      assert.ok(columns.includes(columnName), `Expected ${tableName}.${columnName}`);
    }
  }
});

test("retired provider catalog tables are absent from the baseline", () => {
  const retiredTables = [
    "ProviderAlbums", "ProviderMedia", "ProviderAlbumArtists", "ProviderMediaArtists",
    "local_entities", "provider_entity_ids", "artist_metadata", "artwork_cache",
    "provider_video_identity", "provider_video_items", "provider_ids", "upgrade_queue",
  ];

  for (const tableName of retiredTables) {
    const row = dbModule.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(tableName) as { name: string } | undefined;
    assert.equal(row, undefined, `Expected retired table '${tableName}' to be absent`);
  }
});
