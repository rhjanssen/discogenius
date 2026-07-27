import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-database-baseline-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("./database.js");
const CURRENT_SCHEMA_VERSION = 40;

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

function tableIndexes(tableName: string): string[] {
  return (dbModule.db.prepare(`PRAGMA index_list(${tableName})`).all() as Array<{ name: string }>)
    .map((index) => index.name);
}

test("fresh database initializes the current development baseline", () => {
  const userVersion = dbModule.db.pragma("user_version", { simple: true }) as number;
  assert.equal(userVersion, CURRENT_SCHEMA_VERSION);

  const coreTables = [
    "Artists", "ArtistMetadata", "Albums", "AlbumReleases",
    "AlbumArtists", "ArtistReleaseGroups", "ArtistReleaseGroupCuration",
    "Tracks", "Recordings", "ProviderItems", "ProviderItemMatches",
    "RecordingRelations", "ReleaseGroupSlots",
    "ReleaseGroupSlotTargets", "ReleaseGroupSlotSources", "ReleaseGroupSlotTrackAssignments",
    "TrackFiles", "MetadataFiles", "LyricFiles", "ExtraFiles", "UnmappedFiles",
    "commands", "scheduled_tasks", "quality_profiles",
    "history_events", "MediaCoverProxyCache",
    "metadata_identity_status",
    "ArtistStatistics",
    "ArtistTopTracks", "ArtistTopTrackProjectionState",
    "AlbumLibraryIndex", "AlbumLibraryProjectionState",
    "TrackLibraryIndex", "TrackLibraryProjectionState",
    // FTS5 virtual tables register in sqlite_master with type='table'.
    "TrackSearch", "CatalogSearch",
  ];

  for (const tableName of coreTables) {
    const row = dbModule.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(tableName) as { name: string } | undefined;
    assert.ok(row, `Expected table '${tableName}' to exist`);
  }
});

test("re-initializing an existing schema-40 database opens it without a wipe", () => {
  // Seed a row so we can prove the open-only path never drops/recreates tables.
  dbModule.db
    .prepare("INSERT INTO config (key, value, description) VALUES (?, ?, ?)")
    .run("baseline.open_only_probe", "kept", "sentinel for the open-only path");

  assert.doesNotThrow(() => dbModule.initDatabase());

  const userVersion = dbModule.db.pragma("user_version", { simple: true }) as number;
  assert.equal(userVersion, CURRENT_SCHEMA_VERSION);

  const probe = dbModule.db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get("baseline.open_only_probe") as { value?: string } | undefined;
  assert.equal(probe?.value, "kept", "Re-init must not wipe existing data");

  for (const tableName of ["TrackSearch", "CatalogSearch", "ProviderItemMatches", "RecordingRelations", "metadata_identity_status", "ReleaseGroupSlotTargets"]) {
    const row = dbModule.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(tableName) as { name: string } | undefined;
    assert.ok(row, `Expected table '${tableName}' to survive re-initialization`);
  }
});

test("fresh schema-39 TrackFiles baseline includes video_codec and frame size columns", () => {
  const columns = tableColumns("TrackFiles");
  assert.ok(columns.includes("video_codec"), "Expected TrackFiles.video_codec on CREATE TABLE baseline");
  assert.ok(columns.includes("width"), "Expected TrackFiles.width on CREATE TABLE baseline");
  assert.ok(columns.includes("height"), "Expected TrackFiles.height on CREATE TABLE baseline");
});

test("upgrade queue table is absent from the fresh schema", () => {
  const row = dbModule.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='upgrade_queue'")
    .get() as { name: string } | undefined;
  assert.equal(row, undefined);
});

test("catalog tables expose integer foreign-key links as the authoritative join path", () => {
  const expectedColumnsByTable = new Map<string, string[]>([
    ["Albums", ["id", "artist_metadata_id", "mbid", "artist_mbid", "content_hash", "links", "genres", "ratings", "old_foreign_ids"]],
    ["AlbumReleases", ["id", "release_group_id", "artist_metadata_id", "mbid", "release_group_mbid", "artist_mbid", "label", "media", "old_foreign_ids"]],
    ["ArtistMetadata", ["id", "mbid", "content_hash", "links", "genres", "ratings", "aliases", "old_foreign_ids", "overview", "status"]],
    ["AlbumArtists", ["release_group_id", "artist_metadata_id", "release_group_mbid", "artist_mbid"]],
    ["ArtistReleaseGroups", ["artist_metadata_id", "release_group_id", "artist_mbid", "release_group_mbid"]],
    ["ArtistReleaseGroupCuration", ["source_artist_metadata_id", "release_group_id", "redundant_to_release_group_id", "source_artist_mbid", "release_group_mbid"]],
    ["Tracks", ["id", "album_release_id", "recording_id", "release_mbid", "recording_mbid"]],
    ["ReleaseGroupSlots", ["id", "artist_metadata_id", "release_group_id", "selected_album_release_id", "artist_mbid", "release_group_mbid", "selected_release_mbid", "plan_status", "plan_matcher_version"]],
    ["ReleaseGroupSlotTargets", ["id", "slot_id", "target_track_id", "target_recording_id", "target_track_mbid", "target_recording_mbid", "recording_equivalence_key", "is_wanted", "is_attainable", "status", "wanted_reason", "created_at", "updated_at"]],
    ["ReleaseGroupSlotSources", ["id", "slot_id", "provider", "provider_album_id", "quality", "role", "release_relation", "explicit", "sort_order", "matcher_version", "created_at", "updated_at"]],
    ["ReleaseGroupSlotTrackAssignments", ["id", "slot_id", "target_id", "slot_source_id", "target_track_id", "target_recording_id", "target_track_mbid", "target_recording_mbid", "provider", "provider_track_id", "provider_album_id", "status", "match_score", "match_method", "matcher_version", "match_evidence", "created_at", "updated_at"]],
    ["TrackFiles", ["release_group_id", "album_release_id", "track_id", "recording_id", "canonical_release_group_mbid", "canonical_release_mbid", "canonical_track_mbid", "canonical_recording_mbid", "provider", "provider_entity_type", "provider_id", "codec", "video_codec", "width", "height"]],
    ["MetadataFiles", ["track_file_id", "canonical_artist_mbid", "canonical_release_group_mbid", "canonical_release_mbid", "canonical_track_mbid", "canonical_recording_mbid", "provider", "provider_entity_type", "provider_id"]],
    ["LyricFiles", ["track_file_id", "canonical_artist_mbid", "canonical_release_group_mbid", "canonical_release_mbid", "canonical_track_mbid", "canonical_recording_mbid", "provider", "provider_entity_type", "provider_id"]],
    ["ExtraFiles", ["track_file_id", "canonical_artist_mbid", "canonical_release_group_mbid", "canonical_release_mbid", "canonical_track_mbid", "canonical_recording_mbid", "provider", "provider_entity_type", "provider_id"]],
  ]);

  for (const [tableName, expectedColumns] of expectedColumnsByTable) {
    const columns = tableColumns(tableName);
    for (const columnName of expectedColumns) {
      assert.ok(columns.includes(columnName), `Expected ${tableName}.${columnName}`);
    }
  }
});

test("catalog tables do not retain raw metadata data blobs", () => {
  for (const tableName of ["ArtistMetadata", "Albums", "AlbumReleases", "Recordings", "Tracks"]) {
    const columns = tableColumns(tableName);
    assert.equal(columns.includes("data"), false, `Expected ${tableName}.data to be absent`);
  }
});

test("canonical catalog tables do not store provider resource evidence", () => {
  const providerEvidenceColumns = [
    "provider",
    "provider_id",
    "provider_url",

    "asset_id",
    "upc",
    "isrc",
  ];

  for (const tableName of ["ArtistMetadata", "Albums", "AlbumReleases", "Recordings", "Tracks"]) {
    const columns = tableColumns(tableName);
    for (const columnName of providerEvidenceColumns) {
      assert.equal(
        columns.includes(columnName),
        false,
        `Expected ${tableName}.${columnName} to stay out of the canonical catalog`,
      );
    }
  }

  assert.ok(
    tableColumns("AlbumReleases").includes("barcode"),
    "Expected AlbumReleases.barcode to remain available for canonical MusicBrainz release barcodes",
  );
});

test("provider evidence schema is provider-agnostic and match edges target MusicBrainz ids", () => {
  const providerItemColumns = tableColumns("ProviderItems");
  const providerMatchColumns = tableColumns("ProviderItemMatches");

  for (const columnName of [
    "provider",
    "entity_type",
    "provider_id",
    "artist_mbid",
    "release_group_mbid",
    "release_mbid",
    "track_mbid",
    "recording_mbid",
    "type",
    "upc",
    "isrc",
    "volume_count",
    "track_number",
    "volume_number",
    "replay_gain",
    "peak",
    "bpm",
    "musical_key",
    "provider_album_id",
    "provider_url",
    "asset_id",
    "match_evidence"
  ]) {
    assert.ok(providerItemColumns.includes(columnName), `Expected ProviderItems.${columnName}`);
  }

  for (const columnName of [
    "provider",
    "provider_item_type",
    "provider_item_id",
    "provider_album_id",
    "musicbrainz_artist_mbid",
    "musicbrainz_release_mbid",
    "musicbrainz_track_mbid",
    "musicbrainz_recording_mbid",
    "evidence",
  ]) {
    assert.ok(providerMatchColumns.includes(columnName), `Expected ProviderItemMatches.${columnName}`);
  }

  for (const tableName of ["ProviderItems", "ProviderItemMatches"]) {
    for (const columnName of tableColumns(tableName)) {
      assert.equal(/^tidal_|^apple_|^spotify_/i.test(columnName), false, `Expected ${tableName}.${columnName} to be provider-agnostic`);
    }
  }
});

test("sidecar tables do not retain legacy album or media identity shadows", () => {
  for (const tableName of ["MetadataFiles", "LyricFiles", "ExtraFiles"]) {
    const columns = tableColumns(tableName);
    assert.equal(columns.includes("album_id"), false, `Expected ${tableName}.album_id to be absent`);
    assert.equal(columns.includes("media_id"), false, `Expected ${tableName}.media_id to be absent`);
  }
});

test("retired provider catalog tables are absent from the baseline", () => {
  const retiredTables = [
    "ProviderAlbums", "ProviderMedia", "ProviderAlbumArtists", "ProviderMediaArtists",
    "local_entities", "provider_entity_ids", "artist_metadata", "artwork_cache",
    "provider_video_identity", "provider_video_items", "provider_ids", "upgrade_queue",
    "AlbumReleaseMedia",
  ];

  for (const tableName of retiredTables) {
    const row = dbModule.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(tableName) as { name: string } | undefined;
    assert.equal(row, undefined, `Expected retired table '${tableName}' to be absent`);
  }
});

test("fresh TrackFiles schema keeps covering canonical indexes without redundant singles", () => {
  const indexes = tableIndexes("TrackFiles");

  assert.ok(indexes.includes("idx_track_files_canonical_track_type"));
  assert.ok(indexes.includes("idx_track_files_canonical_recording_type"));
  assert.equal(indexes.includes("idx_track_files_canonical_track"), false);
  assert.equal(indexes.includes("idx_track_files_canonical_recording"), false);
});

test("fresh Tracks schema avoids indexes covered by canonical composite keys", () => {
  const indexes = tableIndexes("Tracks");

  assert.ok(indexes.includes("idx_tracks_album_release_mbid"));
  assert.ok(indexes.includes("idx_tracks_album_release_position"));
  assert.ok(indexes.includes("idx_tracks_recording_release"));
  assert.equal(indexes.includes("idx_tracks_recording_id"), false);
  assert.equal(indexes.includes("idx_tracks_album_release_id"), false);
  assert.equal(indexes.includes("idx_mb_tracks_release_position"), false);
});
