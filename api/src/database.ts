import Database from "better-sqlite3";
import { DB_PATH } from "./services/config.js";
import { getCurrentAppReleaseInfo } from "./services/app-release.js";
import { resolveArtistFolderForPersistence } from "./services/artist-paths.js";

let _db: Database.Database | null = null;

function getDbInstance(): Database.Database {
  if (_db) return _db;

  try {
    console.log(`📁 Database path: ${DB_PATH}`);
    _db = new Database(DB_PATH);
  } catch (error: any) {
    if (process.platform === "win32" || error.code === "ERR_DLOPEN_FAILED") {
      throw new Error(
        `❌ Database execution is unavailable on Windows host because better-sqlite3 was compiled for WSL/Linux.\n` +
        `Please run tests/commands inside WSL (e.g. wsl yarn test) to run database operations.\n` +
        `Original error: ${error.message}`
      );
    }
    throw error;
  }

  const journalMode = "WAL";
  _db.pragma(`journal_mode = ${journalMode}`);
  _db.pragma("busy_timeout = 5000");
  _db.pragma("synchronous = NORMAL");
  _db.pragma("cache_size = -512000");
  _db.pragma("foreign_keys = ON");

  return _db;
}

export const db = new Proxy({} as any, {
  get(target, prop, receiver) {
    const instance = getDbInstance();
    const value = Reflect.get(instance, prop, receiver);
    if (typeof value === "function") {
      return value.bind(instance);
    }
    return value;
  },
  set(target, prop, value, receiver) {
    const instance = getDbInstance();
    return Reflect.set(instance, prop, value, receiver);
  },
}) as unknown as Database.Database;

export function flushDatabase(checkpointMode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "TRUNCATE") {
  try {
    db.pragma(`wal_checkpoint(${checkpointMode})`);
  } catch (error) {
    console.warn(`⚠️  Failed to checkpoint SQLite WAL (${checkpointMode}):`, error);
  }
}

export function closeDatabase() {
  flushDatabase();
  try {
    db.close();
  } catch (error) {
    console.warn("⚠️  Failed to close SQLite database cleanly:", error);
  }
}

/**
 * Run multiple prepared-statement executions inside a single SQLite transaction.
 * Equivalent to Lidarr's InsertMany/UpdateMany pattern — one commit instead of N.
 */
export function batchRun(sql: string, argsList: unknown[][]): number {
  if (argsList.length === 0) return 0;
  const stmt = db.prepare(sql);
  const run = db.transaction(() => {
    let total = 0;
    for (const args of argsList) {
      total += stmt.run(...args).changes;
    }
    return total;
  });
  return run();
}

/**
 * Delete rows by ID list in a single transaction.
 */
export function batchDelete(table: string, ids: Array<string | number>): number {
  if (ids.length === 0) return 0;
  const stmt = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
  const run = db.transaction(() => {
    let total = 0;
    for (const id of ids) {
      total += stmt.run(id).changes;
    }
    return total;
  });
  return run();
}

export function backfillArtistPaths(): number {
  const artists = db.prepare(`
    SELECT Artists.id, Artists.name, Artists.mbid, ArtistMetadata.disambiguation
    FROM Artists
    LEFT JOIN ArtistMetadata ON ArtistMetadata.mbid = Artists.mbid
    WHERE Artists.path IS NULL
  `).all() as Array<{ id: number; name: string; mbid: string | null; disambiguation: string | null }>;
  if (artists.length === 0) return 0;

  const update = db.prepare("UPDATE Artists SET path = ? WHERE id = ? AND path IS NULL");
  const tx = db.transaction(() => {
    for (const artist of artists) {
      update.run(resolveArtistFolderForPersistence({
        artistId: artist.id,
        artistName: artist.name,
        artistMbId: artist.mbid,
        artistDisambiguation: artist.disambiguation,
      }), artist.id);
    }
  });
  tx();
  return artists.length;
}

const BASE_SCHEMA_VERSION = 20;
const LEGACY_SEMVER_BASELINE_VERSION = 10000;
const SCHEMA_VERSION_FORMAT_KEY = "runtime.schema_version_format";
const INTEGER_SCHEMA_VERSION_FORMAT = "integer";

// ====================================================================
// SCHEMA MIGRATIONS
// Discogenius 2.0 resets the fresh-install schema baseline so SQLite
// `user_version` starts at the current MusicBrainz/Lidarr-aligned schema.
//
// The legacy numbered migrations remain so older local databases can still
// be lifted to the current schema before the baseline is normalized.
// Future schema migrations should increment the integer schema version above 20.
// ====================================================================
export function hasTable(tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined;
  return Boolean(row?.name);
}

export function hasColumn(tableName: string, columnName: string): boolean {
  if (!hasTable(tableName)) {
    return false;
  }

  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return columns.some((column) => column.name === columnName);
}

export function hasColumns(tableName: string, requiredColumns: string[]): boolean {
  if (!hasTable(tableName)) {
    return false;
  }

  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  const columnSet = new Set(columns.map((column) => column.name));
  return requiredColumns.every((columnName) => columnSet.has(columnName));
}

function tableExists(tableName: string): boolean {
  return hasTable(tableName);
}

function exactTableExists(tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined;
  return Boolean(row?.name);
}

function findTableNameCaseInsensitive(tableName: string): string | undefined {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND lower(name) = lower(?)
    ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(tableName, tableName) as { name?: string } | undefined;
  return row?.name;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function getTableColumns(tableName: string): string[] {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name: string }>;
  return columns.map((column) => column.name);
}

function columnExists(tableName: string, columnName: string): boolean {
  return hasColumn(tableName, columnName);
}

function tableHasRows(tableName: string): boolean {
  if (!tableExists(tableName)) {
    return false;
  }

  const row = db.prepare(`SELECT 1 as present FROM ${tableName} LIMIT 1`).get() as { present?: number } | undefined;
  return row?.present === 1;
}

const LEGACY_LIBRARY_FILE_INDEXES = [
  "idx_library_files_artist_album_media",
  "idx_library_files_artist_id",
  "idx_library_files_album_id",
  "idx_library_files_media_id",
  "idx_library_files_file_type",
  "idx_library_files_library_root",
  "idx_library_files_needs_rename",
  "idx_library_files_quality",
  "idx_library_files_path",
  "idx_library_files_fingerprint",
  "idx_library_files_acoustid_id",
  "idx_library_files_media_id_file_type",
  "idx_library_files_canonical_artist",
  "idx_library_files_canonical_release_group",
  "idx_library_files_canonical_release",
  "idx_library_files_canonical_track",
  "idx_library_files_canonical_recording",
  "idx_library_files_provider_resource",
  "idx_library_files_slot_type",
  "idx_library_files_media_identity",
  "idx_library_files_media_sidecar_identity",
  "idx_library_files_album_sidecar_identity",
  "idx_library_files_artist_sidecar_identity",
];

function dropLegacyLibraryFileIndexes(): void {
  for (const indexName of LEGACY_LIBRARY_FILE_INDEXES) {
    db.exec(`DROP INDEX IF EXISTS ${indexName}`);
  }
}

function ensureTrackFilesTableName(): void {
  if (tableExists("LibraryFiles") && !tableExists("TrackFiles")) {
    db.exec("ALTER TABLE LibraryFiles RENAME TO TrackFiles");
  }

  dropLegacyLibraryFileIndexes();
}

function withForeignKeysDisabled(action: () => void): void {
  db.pragma("foreign_keys = OFF");
  try {
    action();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function copyCommonColumns(sourceTable: string, targetTable: string, whereClause = ""): void {
  if (!exactTableExists(sourceTable) || !exactTableExists(targetTable)) {
    return;
  }

  const targetColumns = new Set(getTableColumns(targetTable));
  const commonColumns = getTableColumns(sourceTable).filter((column) => targetColumns.has(column));
  if (commonColumns.length === 0) {
    return;
  }

  const columnSql = commonColumns.map(quoteIdentifier).join(", ");
  db.exec(`
    INSERT OR IGNORE INTO ${quoteIdentifier(targetTable)} (${columnSql})
    SELECT ${columnSql}
    FROM ${quoteIdentifier(sourceTable)}
    ${whereClause}
  `);
}

function mergeAndDropLegacyTable(sourceTable: string, targetTable: string, whereClause = ""): void {
  if (!exactTableExists(sourceTable)) {
    return;
  }

  if (exactTableExists(targetTable)) {
    copyCommonColumns(sourceTable, targetTable, whereClause);
    db.exec(`DROP TABLE ${quoteIdentifier(sourceTable)}`);
    return;
  }

  db.exec(`ALTER TABLE ${quoteIdentifier(sourceTable)} RENAME TO ${quoteIdentifier(targetTable)}`);
}

function normalizeTableNameCase(tableName: string): void {
  const actualTableName = findTableNameCaseInsensitive(tableName);
  if (!actualTableName || actualTableName === tableName) {
    return;
  }

  const temporaryName = `__discogenius_rename_${tableName}`;
  if (exactTableExists(temporaryName)) {
    db.exec(`DROP TABLE ${quoteIdentifier(temporaryName)}`);
  }

  db.exec(`ALTER TABLE ${quoteIdentifier(actualTableName)} RENAME TO ${quoteIdentifier(temporaryName)}`);
  db.exec(`ALTER TABLE ${quoteIdentifier(temporaryName)} RENAME TO ${quoteIdentifier(tableName)}`);
}

function rebuildUpgradeQueueWithProviderReferences(): void {
  if (!exactTableExists("upgrade_queue")) {
    return;
  }

  const foreignKeys = db.prepare("PRAGMA foreign_key_list(upgrade_queue)").all() as Array<{ table: string }>;
  const hasCurrentReferences = foreignKeys.some((foreignKey) => foreignKey.table === "ProviderMedia")
    && foreignKeys.some((foreignKey) => foreignKey.table === "ProviderAlbums");
  if (hasCurrentReferences) {
    return;
  }

  db.exec(`
    ALTER TABLE upgrade_queue RENAME TO upgrade_queue_legacy;

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
      FOREIGN KEY(media_id) REFERENCES ProviderMedia(id) ON DELETE CASCADE,
      FOREIGN KEY(album_id) REFERENCES ProviderAlbums(id) ON DELETE CASCADE
    );

    INSERT OR IGNORE INTO upgrade_queue (
      id, media_id, album_id, current_quality, target_quality,
      reason, status, created_at, processed_at
    )
    SELECT
      id, media_id, NULLIF(album_id, 0), current_quality, target_quality,
      reason, status, created_at, processed_at
    FROM upgrade_queue_legacy
    WHERE EXISTS (
      SELECT 1 FROM ProviderMedia
      WHERE CAST(ProviderMedia.id AS TEXT) = CAST(upgrade_queue_legacy.media_id AS TEXT)
    )
      AND (
        album_id IS NULL
        OR album_id = 0
        OR EXISTS (
          SELECT 1 FROM ProviderAlbums
          WHERE CAST(ProviderAlbums.id AS TEXT) = CAST(upgrade_queue_legacy.album_id AS TEXT)
        )
      );

    DROP TABLE upgrade_queue_legacy;
  `);
}

function ensureProviderCompatibilityTablesUseCurrentNames(): void {
  withForeignKeysDisabled(() => {
    normalizeTableNameCase("Artists");
    mergeAndDropLegacyTable("albums", "ProviderAlbums");
    mergeAndDropLegacyTable("media", "ProviderMedia");
    mergeAndDropLegacyTable("album_artists", "ProviderAlbumArtists");
    mergeAndDropLegacyTable("media_artists", "ProviderMediaArtists");
    mergeAndDropLegacyTable("similar_albums", "ProviderSimilarAlbums");
    mergeAndDropLegacyTable("similar_artists", "ProviderSimilarArtists");
    mergeAndDropLegacyTable("library_files", "TrackFiles");
    rebuildUpgradeQueueWithProviderReferences();
  });
}

function ensureProviderIdentityTablesUseCurrentNames(): void {
  withForeignKeysDisabled(() => {
    mergeAndDropLegacyTable("provider_items", "ProviderItems");
    mergeAndDropLegacyTable("release_group_slots", "ReleaseGroupSlots");
  });
}

function hasCanonicalAlbumsShape(): boolean {
  const tableName = findTableNameCaseInsensitive("Albums");
  return tableName
    ? hasColumns(tableName, ["mbid", "artist_mbid", "title", "primary_type", "first_release_date"])
    : false;
}

function ensureCanonicalMusicBrainzTableShapes(): void {
  const existingAlbumsTable = findTableNameCaseInsensitive("Albums");
  if (existingAlbumsTable && !hasCanonicalAlbumsShape()) {
    withForeignKeysDisabled(() => {
      if (!tableExists("ProviderAlbums")) {
        db.exec(`ALTER TABLE ${quoteIdentifier(existingAlbumsTable)} RENAME TO ProviderAlbums`);
      } else {
        copyCommonColumns(existingAlbumsTable, "ProviderAlbums");
        db.exec(`DROP TABLE ${quoteIdentifier(existingAlbumsTable)}`);
      }
    });
  }
}

function backfillCanonicalMusicBrainzTablesFromLegacy(): void {
  if (tableExists("mb_artists") && hasColumns("mb_artists", ["mbid", "name"])) {
    db.exec(`
      INSERT OR IGNORE INTO ArtistMetadata (
        mbid, name, sort_name, disambiguation, type, country, begin_date, end_date, data, updated_at
      )
      SELECT
        mbid,
        COALESCE(NULLIF(name, ''), mbid),
        sort_name,
        disambiguation,
        type,
        country,
        begin_date,
        end_date,
        data,
        COALESCE(updated_at, CURRENT_TIMESTAMP)
      FROM mb_artists
      WHERE mbid IS NOT NULL AND mbid != ''
    `);
  }

  if (tableExists("mb_release_groups") && hasColumns("mb_release_groups", ["mbid", "artist_mbid", "title"])) {
    db.exec(`
      INSERT OR IGNORE INTO ArtistMetadata (mbid, name, updated_at)
      SELECT DISTINCT artist_mbid, artist_mbid, CURRENT_TIMESTAMP
      FROM mb_release_groups
      WHERE artist_mbid IS NOT NULL AND artist_mbid != ''
    `);

    db.exec(`
      INSERT OR IGNORE INTO Albums (
        mbid, artist_mbid, title, primary_type, secondary_types, first_release_date, disambiguation, data, updated_at
      )
      SELECT
        mbid,
        artist_mbid,
        COALESCE(NULLIF(title, ''), mbid),
        primary_type,
        secondary_types,
        first_release_date,
        disambiguation,
        data,
        COALESCE(updated_at, CURRENT_TIMESTAMP)
      FROM mb_release_groups
      WHERE mbid IS NOT NULL
        AND mbid != ''
        AND artist_mbid IS NOT NULL
        AND artist_mbid != ''
    `);
  }

  if (tableExists("mb_releases") && hasColumns("mb_releases", ["mbid", "release_group_mbid", "artist_mbid", "title"])) {
    db.exec(`
      INSERT OR IGNORE INTO ArtistMetadata (mbid, name, updated_at)
      SELECT DISTINCT artist_mbid, artist_mbid, CURRENT_TIMESTAMP
      FROM mb_releases
      WHERE artist_mbid IS NOT NULL AND artist_mbid != ''
    `);

    db.exec(`
      INSERT OR IGNORE INTO Albums (mbid, artist_mbid, title, updated_at)
      SELECT DISTINCT
        release_group_mbid,
        artist_mbid,
        COALESCE(NULLIF(title, ''), release_group_mbid),
        CURRENT_TIMESTAMP
      FROM mb_releases
      WHERE release_group_mbid IS NOT NULL
        AND release_group_mbid != ''
        AND artist_mbid IS NOT NULL
        AND artist_mbid != ''
    `);

    db.exec(`
      INSERT OR IGNORE INTO AlbumReleases (
        mbid, release_group_mbid, artist_mbid, title, status, country, date,
        barcode, disambiguation, media_count, track_count, data, updated_at
      )
      SELECT
        mbid,
        release_group_mbid,
        artist_mbid,
        COALESCE(NULLIF(title, ''), mbid),
        status,
        country,
        date,
        barcode,
        disambiguation,
        media_count,
        track_count,
        data,
        COALESCE(updated_at, CURRENT_TIMESTAMP)
      FROM mb_releases
      WHERE mbid IS NOT NULL
        AND mbid != ''
        AND release_group_mbid IS NOT NULL
        AND release_group_mbid != ''
        AND artist_mbid IS NOT NULL
        AND artist_mbid != ''
    `);
  }

  if (tableExists("mb_mediums") && hasColumns("mb_mediums", ["release_mbid", "position"])) {
    db.exec(`
      INSERT OR IGNORE INTO AlbumReleaseMedia (
        id, release_mbid, position, format, title, track_count, data, updated_at
      )
      SELECT
        id,
        release_mbid,
        position,
        format,
        title,
        track_count,
        data,
        COALESCE(updated_at, CURRENT_TIMESTAMP)
      FROM mb_mediums
      WHERE EXISTS (
        SELECT 1 FROM AlbumReleases
        WHERE AlbumReleases.mbid = mb_mediums.release_mbid
      )
    `);
  }

  if (tableExists("mb_recordings") && hasColumns("mb_recordings", ["mbid", "title"])) {
    db.exec(`
      INSERT OR IGNORE INTO Recordings (
        mbid, title, artist_credit, length_ms, isrcs, data, updated_at
      )
      SELECT
        mbid,
        COALESCE(NULLIF(title, ''), mbid),
        artist_credit,
        length_ms,
        isrcs,
        data,
        COALESCE(updated_at, CURRENT_TIMESTAMP)
      FROM mb_recordings
      WHERE mbid IS NOT NULL AND mbid != ''
    `);
  }

  if (tableExists("mb_tracks") && hasColumns("mb_tracks", ["mbid", "release_mbid", "recording_mbid"])) {
    db.exec(`
      INSERT OR IGNORE INTO Tracks (
        mbid, release_mbid, recording_mbid, medium_position, position, number,
        title, length_ms, data, updated_at
      )
      SELECT
        mbid,
        release_mbid,
        recording_mbid,
        medium_position,
        position,
        number,
        COALESCE(NULLIF(title, ''), mbid),
        length_ms,
        data,
        COALESCE(updated_at, CURRENT_TIMESTAMP)
      FROM mb_tracks
      WHERE mbid IS NOT NULL
        AND mbid != ''
        AND EXISTS (
          SELECT 1 FROM AlbumReleases
          WHERE AlbumReleases.mbid = mb_tracks.release_mbid
        )
        AND EXISTS (
          SELECT 1 FROM Recordings
          WHERE Recordings.mbid = mb_tracks.recording_mbid
        )
    `);
  }
}

function providerLibrarySlotSql(qualityColumn: string, fallback = "'stereo'"): string {
  return `
    CASE
      WHEN UPPER(COALESCE(${qualityColumn}, '')) IN ('DOLBY_ATMOS', 'ATMOS', 'SONY_360RA', '360RA')
        OR UPPER(COALESCE(${qualityColumn}, '')) LIKE '%SPATIAL%'
        OR UPPER(COALESCE(${qualityColumn}, '')) LIKE '%SURROUND%'
        OR UPPER(COALESCE(${qualityColumn}, '')) LIKE '%IMMERSIVE%'
        OR UPPER(COALESCE(${qualityColumn}, '')) LIKE '%ATMOS%'
      THEN 'spatial'
      ELSE ${fallback}
    END
  `;
}

function backfillProviderItemsFromCompatibilityTables(): void {
  if (!tableExists("ProviderItems")) {
    return;
  }

  if (tableExists("ProviderAlbums")) {
    db.exec(`
      INSERT OR IGNORE INTO ProviderItems (
        provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
        title, version, explicit, quality, upc, duration, release_date, availability,
        library_slot, artist_metadata_id, album_id, album_release_id, provider_url, asset_id,
        match_status, match_method, updated_at
      )
      SELECT
        'tidal',
        'album',
        CAST(provider_album.id AS TEXT),
        NULLIF(artist.mbid, ''),
        NULLIF(provider_album.mb_release_group_id, ''),
        NULLIF(provider_album.mbid, ''),
        provider_album.title,
        provider_album.version,
        provider_album.explicit,
        provider_album.quality,
        provider_album.upc,
        provider_album.duration,
        provider_album.release_date,
        'available',
        ${providerLibrarySlotSql("provider_album.quality")},
        artist_metadata.Id,
        release_group.Id,
        album_release.Id,
        NULL,
        provider_album.cover,
        COALESCE(provider_album.musicbrainz_status, 'provider_only'),
        provider_album.musicbrainz_match_method,
        COALESCE(provider_album.last_scanned, provider_album.user_date_added, CURRENT_TIMESTAMP)
      FROM ProviderAlbums provider_album
      LEFT JOIN Artists artist ON CAST(artist.id AS TEXT) = CAST(provider_album.artist_id AS TEXT)
      LEFT JOIN ArtistMetadata artist_metadata ON artist_metadata.mbid = artist.mbid
      LEFT JOIN Albums release_group ON release_group.mbid = provider_album.mb_release_group_id
      LEFT JOIN AlbumReleases album_release ON album_release.mbid = provider_album.mbid
      WHERE provider_album.id IS NOT NULL
        AND TRIM(CAST(provider_album.id AS TEXT)) != ''
    `);
  }

  if (tableExists("ProviderMedia")) {
    db.exec(`
      INSERT OR IGNORE INTO ProviderItems (
        provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
        track_mbid, recording_mbid, title, version, explicit, quality, isrc, duration,
        release_date, availability, library_slot, artist_metadata_id, album_id,
        album_release_id, track_id, recording_id, provider_url, asset_id,
        match_status, match_method, updated_at
      )
      SELECT
        'tidal',
        CASE WHEN provider_media.type = 'Music Video' THEN 'video' ELSE 'track' END,
        CAST(provider_media.id AS TEXT),
        NULLIF(artist.mbid, ''),
        COALESCE(NULLIF(provider_album.mb_release_group_id, ''), album_release.release_group_mbid),
        album_release.mbid,
        CASE WHEN provider_media.type = 'Music Video' THEN NULL ELSE COALESCE(track.mbid, NULLIF(provider_media.mbid, '')) END,
        COALESCE(track.recording_mbid, CASE WHEN provider_media.type = 'Music Video' THEN NULLIF(provider_media.mbid, '') ELSE NULL END),
        provider_media.title,
        provider_media.version,
        provider_media.explicit,
        provider_media.quality,
        provider_media.isrc,
        provider_media.duration,
        provider_media.release_date,
        'available',
        CASE
          WHEN provider_media.type = 'Music Video' THEN 'video'
          ELSE ${providerLibrarySlotSql("provider_media.quality")}
        END,
        artist_metadata.Id,
        release_group.Id,
        album_release.Id,
        track.Id,
        recording.Id,
        NULL,
        provider_media.cover,
        COALESCE(provider_media.musicbrainz_status, 'provider_only'),
        provider_media.musicbrainz_match_method,
        COALESCE(provider_media.last_scanned, provider_media.user_date_added, CURRENT_TIMESTAMP)
      FROM ProviderMedia provider_media
      LEFT JOIN ProviderAlbums provider_album ON CAST(provider_album.id AS TEXT) = CAST(provider_media.album_id AS TEXT)
      LEFT JOIN Artists artist ON CAST(artist.id AS TEXT) = CAST(provider_media.artist_id AS TEXT)
      LEFT JOIN ArtistMetadata artist_metadata ON artist_metadata.mbid = artist.mbid
      LEFT JOIN Tracks track ON track.mbid = provider_media.mbid
      LEFT JOIN AlbumReleases album_release ON album_release.mbid = COALESCE(track.release_mbid, provider_album.mbid)
      LEFT JOIN Albums release_group ON release_group.mbid = COALESCE(provider_album.mb_release_group_id, album_release.release_group_mbid)
      LEFT JOIN Recordings recording ON recording.mbid = COALESCE(
        track.recording_mbid,
        CASE WHEN provider_media.type = 'Music Video' THEN provider_media.mbid ELSE NULL END
      )
      WHERE provider_media.id IS NOT NULL
        AND TRIM(CAST(provider_media.id AS TEXT)) != ''
    `);
  }
}

function getConfigValue(key: string): string | undefined {
  if (!tableExists("config")) {
    return undefined;
  }

  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as { value?: string } | undefined;
  return row?.value;
}

function ensureUnmappedFilesAudioMetadataColumns() {
  if (!tableExists("UnmappedFiles")) {
    return;
  }

  const cols = db.prepare("PRAGMA table_info(UnmappedFiles)").all() as Array<{ name: string }>;
  const existing = new Set(cols.map((c) => c.name));
  const toAdd = [
    { name: "bitrate", sql: "ALTER TABLE UnmappedFiles ADD COLUMN bitrate INT" },
    { name: "sample_rate", sql: "ALTER TABLE UnmappedFiles ADD COLUMN sample_rate INT" },
    { name: "bit_depth", sql: "ALTER TABLE UnmappedFiles ADD COLUMN bit_depth INT" },
    { name: "channels", sql: "ALTER TABLE UnmappedFiles ADD COLUMN channels INT" },
    { name: "codec", sql: "ALTER TABLE UnmappedFiles ADD COLUMN codec TEXT" },
  ].filter((col) => !existing.has(col.name));

  for (const col of toAdd) {
    db.exec(col.sql);
  }
}

const LEGACY_MIGRATIONS: Array<{ description: string; up: () => void }> = [
  {
    // 1
    description: "make upgrade_queue.album_id nullable for video upgrade support",
    up: () => {
      const cols = db.prepare("PRAGMA table_info(upgrade_queue)").all() as Array<{ name: string; notnull: number }>;
      const albumIdCol = cols.find((c) => c.name === "album_id");
      if (!albumIdCol || albumIdCol.notnull === 0) return;

      db.pragma("foreign_keys = OFF");
      try {
        db.exec("BEGIN");
        db.exec(`
          ALTER TABLE upgrade_queue RENAME TO upgrade_queue_legacy;

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
            FOREIGN KEY(media_id) REFERENCES ProviderMedia(id) ON DELETE CASCADE,
            FOREIGN KEY(album_id) REFERENCES ProviderAlbums(id) ON DELETE CASCADE
          );

          INSERT INTO upgrade_queue (
            id, media_id, album_id, current_quality, target_quality,
            reason, status, created_at, processed_at
          )
          SELECT
            id, media_id, NULLIF(album_id, 0), current_quality, target_quality,
            reason, status, created_at, processed_at
          FROM upgrade_queue_legacy;

          DROP TABLE upgrade_queue_legacy;
        `);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        db.pragma("foreign_keys = ON");
      }
    },
  },
  {
    // 2
    description: "add audio metadata columns to unmapped_files",
    up: () => {
      ensureUnmappedFilesAudioMetadataColumns();
    },
  },
  {
    // 3
    description: "add mb_release_group_id to albums for cross-provider linking",
    up: () => {
      if (!tableExists("ProviderAlbums")) {
        return;
      }

      const cols = db.prepare("PRAGMA table_info(ProviderAlbums)").all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === "mb_release_group_id")) return;
      db.exec("ALTER TABLE ProviderAlbums ADD COLUMN mb_release_group_id TEXT");
    },
  },
  {
    // 4
    description: "collapse RootFolderScan jobs into RescanFolders with addNewArtists flag",
    up: () => {
      if (!tableExists("job_queue")) {
        return;
      }

      db.exec(`
        UPDATE job_queue
        SET type = 'RescanFolders',
            payload = json_set(COALESCE(payload, '{}'), '$.addNewArtists', 1)
        WHERE type = 'RootFolderScan'
      `);
    },
  },
  {
    // 5
    description: "create persistent history_events table",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS history_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          artist_id TEXT,
          album_id TEXT,
          media_id TEXT,
          library_file_id TEXT,
          event_type TEXT NOT NULL,
          quality TEXT,
          source_title TEXT,
          data TEXT,
          date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      db.exec("CREATE INDEX IF NOT EXISTS idx_history_events_date ON history_events(date DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_history_events_artist ON history_events(artist_id, date DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_history_events_album ON history_events(album_id, date DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_history_events_media ON history_events(media_id, date DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_history_events_event_type ON history_events(event_type, date DESC)");
    },
  },
  {
    // 6
    description: "reserved for removed pre-2.0 provider collection migration",
    up: () => {},
  },
  {
    // 7
    description: "normalize legacy HI_RES_LOSSLESS quality values to HIRES_LOSSLESS",
    up: () => {
      const qualityColumns: Array<{ table: string; column: string }> = [
        { table: "ProviderAlbums", column: "quality" },
        { table: "ProviderMedia", column: "quality" },
        { table: "TrackFiles", column: "quality" },
        { table: "upgrade_queue", column: "current_quality" },
        { table: "upgrade_queue", column: "target_quality" },
        { table: "quality_profiles", column: "cutoff" },
        { table: "history_events", column: "quality" },
      ];

      for (const { table, column } of qualityColumns) {
        if (!columnExists(table, column)) {
          continue;
        }

        db.prepare(`UPDATE ${table} SET ${column} = 'HIRES_LOSSLESS' WHERE ${column} = 'HI_RES_LOSSLESS'`).run();
      }

      if (columnExists("quality_profiles", "items")) {
        db.prepare(`
          UPDATE quality_profiles
          SET items = REPLACE(items, 'HI_RES_LOSSLESS', 'HIRES_LOSSLESS')
          WHERE items LIKE '%HI_RES_LOSSLESS%'
        `).run();
      }

      if (columnExists("job_queue", "payload")) {
        db.prepare(`
          UPDATE job_queue
          SET payload = REPLACE(payload, 'HI_RES_LOSSLESS', 'HIRES_LOSSLESS')
          WHERE payload LIKE '%HI_RES_LOSSLESS%'
        `).run();
      }
    },
  },
  {
    // 8
    description: "create database_version_history table for app/schema provenance",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS database_version_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          app_version TEXT NOT NULL,
          api_version TEXT NOT NULL,
          schema_from INT NOT NULL,
          schema_to INT NOT NULL,
          migration_notes TEXT,
          applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_database_version_history_applied_at ON database_version_history(applied_at DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_database_version_history_app_version ON database_version_history(app_version, applied_at DESC)");
    },
  },
];

const LEGACY_SCHEMA_VERSION = LEGACY_MIGRATIONS.length;
const SCHEMA_MIGRATIONS: Array<{ version: number; description: string; up: () => void }> = [
  {
    version: 2,
    description: "add reverse media_artists lookup index for artist page top tracks",
    up: () => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_media_artists_artist_type_media
        ON ProviderMediaArtists(artist_id, type, media_id)
      `);
    },
  },
  {
    version: 3,
    description: "add explicit queue ordering column for persisted job execution order",
    up: () => {
      if (!tableExists("job_queue")) {
        return;
      }

      if (!columnExists("job_queue", "queue_order")) {
        db.exec("ALTER TABLE job_queue ADD COLUMN queue_order INT");
      }

      const jobs = db.prepare(`
        SELECT id
        FROM job_queue
        ORDER BY priority DESC, trigger DESC, created_at ASC, id ASC
      `).all() as Array<{ id: number }>;

      if (jobs.length > 0) {
        const updateQueueOrder = db.prepare(`
          UPDATE job_queue
          SET queue_order = ?
          WHERE id = ?
            AND (queue_order IS NULL OR queue_order != ?)
        `);

        const tx = db.transaction(() => {
          jobs.forEach((job, index) => {
            const queueOrder = index + 1;
            updateQueueOrder.run(queueOrder, job.id, queueOrder);
          });
        });

        tx();
      }

      db.exec("DROP INDEX IF EXISTS idx_jobs_poll");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_jobs_poll
        ON job_queue(status, priority DESC, trigger DESC, queue_order ASC, created_at ASC)
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_queue_order ON job_queue(queue_order)");
    },
  },
  {
    version: 4,
    description: "add artist path column for stored folder resolution",
    up: () => {
      if (!columnExists("Artists", "path")) {
        db.exec("ALTER TABLE Artists ADD COLUMN path TEXT");
      }
    },
  },
  {
    version: 5,
    description: "rename legacy job_queue command types to Lidarr-aligned names",
    up: () => {
      if (!tableExists("job_queue")) {
        return;
      }

      db.exec(`
        UPDATE job_queue
        SET type = 'RefreshAlbum'
        WHERE type = 'ScanAlbum';

        UPDATE job_queue
        SET type = 'BulkRefreshArtist'
        WHERE type = 'RefreshAllMonitored';

        UPDATE job_queue
        SET type = 'CheckHealth'
        WHERE type = 'HealthCheck';

        UPDATE job_queue
        SET type = CASE
          WHEN COALESCE(json_array_length(payload, '$.ids'), 0) > 0
            OR json_extract(COALESCE(payload, '{}'), '$.albumId') IS NOT NULL
            OR json_extract(COALESCE(payload, '{}'), '$.libraryRoot') IS NOT NULL
            OR COALESCE(json_array_length(payload, '$.fileTypes'), 0) > 0
          THEN 'RenameFiles'
          ELSE 'RenameArtist'
        END
        WHERE type = 'ApplyRenames';

        UPDATE job_queue
        SET type = CASE
          WHEN COALESCE(json_array_length(payload, '$.ids'), 0) > 0
            OR json_extract(COALESCE(payload, '{}'), '$.albumId') IS NOT NULL
          THEN 'RetagFiles'
          ELSE 'RetagArtist'
        END
        WHERE type = 'ApplyRetags';
      `);
    },
  },
  {
    version: 6,
    description: "add MusicBrainz identity status and AcoustID import metadata",
    up: () => {
      ensureMetadataIdentitySchema();
    },
  },
  {
    version: 7,
    description: "add artist cover image and MusicBrainz provider mapping scaffold",
    up: () => {
      ensureMusicBrainzProviderSchema();
    },
  },
  {
    version: 8,
    description: "add MusicBrainz release group library slot selections",
    up: () => {
      ensureMusicBrainzProviderSchema();
    },
  },
  {
    version: 9,
    description: "skip superseded provider-neutral identity scaffold",
    up: () => {
      db.exec("CREATE INDEX IF NOT EXISTS idx_albums_artist_monitor_date ON ProviderAlbums(artist_id, monitor, release_date DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_media_artist_type_date ON ProviderMedia(artist_id, type, release_date DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_track_files_artist_album_media ON TrackFiles(artist_id, album_id, media_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_mb_release_groups_artist_type_date ON Albums(artist_mbid, primary_type, first_release_date DESC)");
    },
  },
  {
    version: 10,
    description: "add canonical MusicBrainz and provider identity columns to track files",
    up: () => {
      ensureTrackFileCanonicalIdentitySchema();
    },
  },
  {
    version: 11,
    description: "add missing foreign key and path indexes for cascade deletes and lookup performance",
    up: () => {
      db.exec("CREATE INDEX IF NOT EXISTS idx_mb_releases_artist_mbid ON AlbumReleases(artist_mbid)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_mb_tracks_recording_mbid ON Tracks(recording_mbid)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_album_artists_album_id ON ProviderAlbumArtists(album_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_release_group_slots_selected_release ON ReleaseGroupSlots(selected_release_mbid)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_artists_path ON Artists(path)");
    },
  },
  {
    version: 12,
    description: "drop superseded provider identity tables in favor of provider_items cache",
    up: () => {
      dropSupersededProviderIdentityTables();
    },
  },
  {
    version: 13,
    description: "rename library file inventory table to Lidarr-aligned TrackFiles",
    up: () => {
      ensureTrackFilesTableName();
      ensureTrackFileCanonicalIdentitySchema();
    },
  },
  {
    version: 14,
    description: "repair canonical MusicBrainz tables after legacy provider table collisions",
    up: () => {
      ensureMusicBrainzProviderSchema();
    },
  },
  {
    version: 15,
    description: "add Lidarr-style extra file tables for metadata and lyrics sidecars",
    up: () => {
      ensureExtraFileSchema();
    },
  },
  {
    version: 16,
    description: "retire sidecar projection from TrackFiles and drop obsolete triggers",
    up: () => {
      // 1. Delete all sidecar files from TrackFiles
      db.prepare(`
        DELETE FROM TrackFiles
        WHERE file_type IN ('cover', 'video_cover', 'video_thumbnail', 'nfo', 'lyrics')
      `).run();

      // 2. Drop obsolete triggers
      db.exec(`
        DROP TRIGGER IF EXISTS trg_track_files_delete_metadata_projection;
        DROP TRIGGER IF EXISTS trg_track_files_delete_lyric_projection;
        DROP TRIGGER IF EXISTS trg_track_files_delete_extra_projection;
        DROP TRIGGER IF EXISTS trg_track_files_update_metadata_projection;
        DROP TRIGGER IF EXISTS trg_track_files_update_lyric_projection;
        DROP TRIGGER IF EXISTS trg_track_files_update_extra_projection;
      `);
    },
  },
  {
    version: 17,
    description: "normalize legacy metadata source labels",
    up: () => {
      normalizeLegacyMetadataSourceLabels();
    },
  },
  {
    version: 18,
    description: "redirect guest and similar artists foreign keys to ArtistMetadata",
    up: () => {
      addColumnIfMissing("ArtistMetadata", "picture", "TEXT");
      addColumnIfMissing("ArtistMetadata", "cover_image_url", "TEXT");
      addColumnIfMissing("ArtistMetadata", "popularity", "INT");

      db.exec(`
        INSERT OR IGNORE INTO ArtistMetadata (mbid, name, picture, cover_image_url, popularity)
        SELECT mbid, name, picture, cover_image_url, popularity FROM Artists WHERE mbid IS NOT NULL AND mbid != '';
      `);

      db.pragma("foreign_keys = OFF");
      try {
        db.exec("BEGIN TRANSACTION");

        if (tableExists("ProviderMediaArtists")) {
          db.exec(`
            ALTER TABLE ProviderMediaArtists RENAME TO ProviderMediaArtists_old;

            CREATE TABLE ProviderMediaArtists (
              media_id TEXT NOT NULL,
              artist_id TEXT NOT NULL,
              type TEXT NOT NULL,
              PRIMARY KEY (media_id, artist_id),
              FOREIGN KEY (media_id) REFERENCES ProviderMedia(id) ON DELETE CASCADE,
              FOREIGN KEY (artist_id) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE
            );

            INSERT OR IGNORE INTO ProviderMediaArtists (media_id, artist_id, type)
            SELECT media_id, artist_id, type FROM ProviderMediaArtists_old
            WHERE artist_id IN (SELECT mbid FROM ArtistMetadata);

            DROP TABLE ProviderMediaArtists_old;
          `);
        }

        if (tableExists("ProviderAlbumArtists")) {
          db.exec(`
            ALTER TABLE ProviderAlbumArtists RENAME TO ProviderAlbumArtists_old;

            CREATE TABLE ProviderAlbumArtists (
              album_id TEXT NOT NULL,
              artist_id TEXT NOT NULL,
              artist_name TEXT,
              ord INT,
              type TEXT NOT NULL,
              group_type TEXT,
              version_group_id INT,
              version_group_name TEXT,
              module TEXT,
              PRIMARY KEY (artist_id, album_id),
              FOREIGN KEY (artist_id) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE,
              FOREIGN KEY (album_id) REFERENCES ProviderAlbums(id) ON DELETE CASCADE
            );

            INSERT OR IGNORE INTO ProviderAlbumArtists (
              album_id, artist_id, artist_name, ord, type, group_type,
              version_group_id, version_group_name, module
            )
            SELECT
              album_id, artist_id, artist_name, ord, type, group_type,
              version_group_id, version_group_name, module
            FROM ProviderAlbumArtists_old
            WHERE artist_id IN (SELECT mbid FROM ArtistMetadata);

            DROP TABLE ProviderAlbumArtists_old;
          `);
        }

        if (tableExists("ProviderSimilarArtists")) {
          db.exec(`
            ALTER TABLE ProviderSimilarArtists RENAME TO ProviderSimilarArtists_old;

            CREATE TABLE ProviderSimilarArtists (
              artist_id TEXT NOT NULL,
              similar_artist_id TEXT NOT NULL,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (artist_id, similar_artist_id),
              FOREIGN KEY (artist_id) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE,
              FOREIGN KEY (similar_artist_id) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE
            );

            INSERT OR IGNORE INTO ProviderSimilarArtists (artist_id, similar_artist_id, created_at)
            SELECT CAST(artist_id AS TEXT), CAST(similar_artist_id AS TEXT), created_at FROM ProviderSimilarArtists_old
            WHERE CAST(artist_id AS TEXT) IN (SELECT mbid FROM ArtistMetadata)
              AND CAST(similar_artist_id AS TEXT) IN (SELECT mbid FROM ArtistMetadata);

            DROP TABLE ProviderSimilarArtists_old;
          `);
        }

        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        db.pragma("foreign_keys = ON");
      }
    },
  },
  {
    version: 19,
    description: "create persistent MediaCoverProxyCache table for remote artwork proxy",
    up: () => {
      ensureMediaCoverProxyCacheSchema();
    },
  },
  {
    version: 20,
    description: "add serialized images columns to ArtistMetadata and Albums tables aligned with Lidarr schema",
    up: () => {
      addColumnIfMissing("ArtistMetadata", "images", "TEXT");
      addColumnIfMissing("Albums", "images", "TEXT");
    },
  },
];

function addColumnIfMissing(tableName: string, columnName: string, columnDefinition: string): void {
  if (!tableExists(tableName) || columnExists(tableName, columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}

function normalizeLegacyMetadataSourceLabels(): void {
  if (tableExists("Artists")) {
    if (columnExists("Artists", "musicbrainz_match_method")) {
      db.prepare(`
        UPDATE Artists
        SET musicbrainz_match_method = 'musicbrainz-metadata'
        WHERE musicbrainz_match_method = 'lidarr-metadata'
      `).run();
    }

    if (columnExists("Artists", "bio_source")) {
      db.prepare(`
        UPDATE Artists
        SET bio_source = 'musicbrainz'
        WHERE bio_source = 'lidarr'
      `).run();
    }
  }

  if (tableExists("ProviderAlbums") && columnExists("ProviderAlbums", "musicbrainz_match_method")) {
    db.prepare(`
      UPDATE ProviderAlbums
      SET musicbrainz_match_method = CASE
        WHEN musicbrainz_match_method = 'lidarr-metadata' THEN 'musicbrainz-metadata'
        WHEN musicbrainz_match_method = 'lidarr-release-group-title-year-type' THEN 'musicbrainz-release-group-title-year-type'
        ELSE musicbrainz_match_method
      END
      WHERE musicbrainz_match_method IN ('lidarr-metadata', 'lidarr-release-group-title-year-type')
    `).run();
  }

  const normalizeMatchMethod = (tableName: string, columnName: string) => {
    if (!tableExists(tableName) || !columnExists(tableName, columnName)) {
      return;
    }

    db.prepare(`
      UPDATE ${tableName}
      SET ${columnName} = CASE
        WHEN ${columnName} = 'lidarr-artist-name-exact' THEN 'musicbrainz-artist-name-exact'
        WHEN ${columnName} = 'lidarr-artist-name-discography-weight' THEN 'musicbrainz-artist-name-discography-weight'
        WHEN ${columnName} = 'lidarr-artist-name-ambiguous' THEN 'musicbrainz-artist-name-ambiguous'
        WHEN ${columnName} = 'lidarr-release-group-title' THEN 'musicbrainz-release-group-title'
        WHEN ${columnName} = 'lidarr-release-group-title-year-type' THEN 'musicbrainz-release-group-title-year-type'
        WHEN ${columnName} = 'lidarr-release-group-title-year-type-track-count' THEN 'musicbrainz-release-group-title-year-type-track-count'
        ELSE ${columnName}
      END
      WHERE ${columnName} IN (
        'lidarr-artist-name-exact',
        'lidarr-artist-name-discography-weight',
        'lidarr-artist-name-ambiguous',
        'lidarr-release-group-title',
        'lidarr-release-group-title-year-type',
        'lidarr-release-group-title-year-type-track-count'
      )
    `).run();
  };

  normalizeMatchMethod("ProviderItems", "match_method");
  normalizeMatchMethod("ReleaseGroupSlots", "match_method");
}

function ensureLidarrStyleCanonicalIdentityColumns(): void {
  const canonicalColumns: Array<{
    tableName: string;
    foreignColumns: Array<{ name: string; source: string }>;
  }> = [
    {
      tableName: "ArtistMetadata",
      foreignColumns: [{ name: "ForeignArtistId", source: "mbid" }],
    },
    {
      tableName: "Albums",
      foreignColumns: [{ name: "ForeignAlbumId", source: "mbid" }],
    },
    {
      tableName: "AlbumReleases",
      foreignColumns: [{ name: "ForeignReleaseId", source: "mbid" }],
    },
    {
      tableName: "Recordings",
      foreignColumns: [{ name: "ForeignRecordingId", source: "mbid" }],
    },
    {
      tableName: "Tracks",
      foreignColumns: [
        { name: "ForeignTrackId", source: "mbid" },
        { name: "ForeignRecordingId", source: "recording_mbid" },
      ],
    },
  ];

  for (const table of canonicalColumns) {
    addColumnIfMissing(table.tableName, "Id", "INTEGER");
    for (const foreignColumn of table.foreignColumns) {
      addColumnIfMissing(table.tableName, foreignColumn.name, "TEXT");
    }
  }

  addColumnIfMissing("Recordings", "ArtistMetadataId", "INTEGER");
  addColumnIfMissing("Recordings", "artist_mbid", "TEXT");
  addColumnIfMissing("Recordings", "IsVideo", "BOOLEAN NOT NULL DEFAULT 0");
  addColumnIfMissing("Recordings", "MetadataStatus", "TEXT NOT NULL DEFAULT 'musicbrainz'");

  db.exec(`
    UPDATE ArtistMetadata SET Id = rowid WHERE Id IS NULL;
    UPDATE Albums SET Id = rowid WHERE Id IS NULL;
    UPDATE AlbumReleases SET Id = rowid WHERE Id IS NULL;
    UPDATE Recordings SET Id = rowid WHERE Id IS NULL;
    UPDATE Tracks SET Id = rowid WHERE Id IS NULL;

    UPDATE ArtistMetadata SET ForeignArtistId = COALESCE(ForeignArtistId, mbid) WHERE mbid IS NOT NULL AND TRIM(mbid) != '';
    UPDATE Albums SET ForeignAlbumId = COALESCE(ForeignAlbumId, mbid) WHERE mbid IS NOT NULL AND TRIM(mbid) != '';
    UPDATE AlbumReleases SET ForeignReleaseId = COALESCE(ForeignReleaseId, mbid) WHERE mbid IS NOT NULL AND TRIM(mbid) != '';
    UPDATE Recordings SET ForeignRecordingId = COALESCE(ForeignRecordingId, mbid) WHERE mbid IS NOT NULL AND TRIM(mbid) != '';
    UPDATE Tracks SET
      ForeignTrackId = COALESCE(ForeignTrackId, mbid),
      ForeignRecordingId = COALESCE(ForeignRecordingId, recording_mbid)
    WHERE mbid IS NOT NULL AND TRIM(mbid) != '';

    UPDATE Recordings
    SET ArtistMetadataId = (
      SELECT ArtistMetadata.Id
      FROM ArtistMetadata
      WHERE ArtistMetadata.mbid = Recordings.artist_mbid
      LIMIT 1
    )
    WHERE ArtistMetadataId IS NULL
      AND artist_mbid IS NOT NULL
      AND TRIM(artist_mbid) != '';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_artist_metadata_lidarr_id ON ArtistMetadata(Id) WHERE Id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_artist_metadata_foreign_artist_id ON ArtistMetadata(ForeignArtistId) WHERE ForeignArtistId IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_lidarr_id ON Albums(Id) WHERE Id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_foreign_album_id ON Albums(ForeignAlbumId) WHERE ForeignAlbumId IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_album_releases_lidarr_id ON AlbumReleases(Id) WHERE Id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_album_releases_foreign_release_id ON AlbumReleases(ForeignReleaseId) WHERE ForeignReleaseId IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_recordings_lidarr_id ON Recordings(Id) WHERE Id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_recordings_foreign_recording_id ON Recordings(ForeignRecordingId) WHERE ForeignRecordingId IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_recordings_artist_metadata_id ON Recordings(ArtistMetadataId);
    CREATE INDEX IF NOT EXISTS idx_recordings_artist_mbid ON Recordings(artist_mbid);
    CREATE INDEX IF NOT EXISTS idx_recordings_is_video ON Recordings(IsVideo);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_lidarr_id ON Tracks(Id) WHERE Id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_foreign_track_id ON Tracks(ForeignTrackId) WHERE ForeignTrackId IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tracks_foreign_recording_id ON Tracks(ForeignRecordingId);

    CREATE TRIGGER IF NOT EXISTS trg_artist_metadata_lidarr_identity_insert
    AFTER INSERT ON ArtistMetadata
    WHEN NEW.Id IS NULL OR (NEW.ForeignArtistId IS NULL AND NEW.mbid IS NOT NULL)
    BEGIN
      UPDATE ArtistMetadata
      SET
        Id = COALESCE(Id, NEW.rowid),
        ForeignArtistId = COALESCE(ForeignArtistId, NEW.mbid)
      WHERE rowid = NEW.rowid;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_albums_lidarr_identity_insert
    AFTER INSERT ON Albums
    WHEN NEW.Id IS NULL OR (NEW.ForeignAlbumId IS NULL AND NEW.mbid IS NOT NULL)
    BEGIN
      UPDATE Albums
      SET
        Id = COALESCE(Id, NEW.rowid),
        ForeignAlbumId = COALESCE(ForeignAlbumId, NEW.mbid)
      WHERE rowid = NEW.rowid;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_album_releases_lidarr_identity_insert
    AFTER INSERT ON AlbumReleases
    WHEN NEW.Id IS NULL OR (NEW.ForeignReleaseId IS NULL AND NEW.mbid IS NOT NULL)
    BEGIN
      UPDATE AlbumReleases
      SET
        Id = COALESCE(Id, NEW.rowid),
        ForeignReleaseId = COALESCE(ForeignReleaseId, NEW.mbid)
      WHERE rowid = NEW.rowid;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_recordings_lidarr_identity_insert
    AFTER INSERT ON Recordings
    WHEN NEW.Id IS NULL OR (NEW.ForeignRecordingId IS NULL AND NEW.mbid IS NOT NULL)
    BEGIN
      UPDATE Recordings
      SET
        Id = COALESCE(Id, NEW.rowid),
        ForeignRecordingId = COALESCE(ForeignRecordingId, NEW.mbid)
      WHERE rowid = NEW.rowid;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_tracks_lidarr_identity_insert
    AFTER INSERT ON Tracks
    WHEN NEW.Id IS NULL OR (NEW.ForeignTrackId IS NULL AND NEW.mbid IS NOT NULL) OR (NEW.ForeignRecordingId IS NULL AND NEW.recording_mbid IS NOT NULL)
    BEGIN
      UPDATE Tracks
      SET
        Id = COALESCE(Id, NEW.rowid),
        ForeignTrackId = COALESCE(ForeignTrackId, NEW.mbid),
        ForeignRecordingId = COALESCE(ForeignRecordingId, NEW.recording_mbid)
      WHERE rowid = NEW.rowid;
    END;
  `);
}

function ensureMetadataIdentitySchema(): void {
  addColumnIfMissing("Artists", "musicbrainz_status", "TEXT");
  addColumnIfMissing("Artists", "musicbrainz_last_checked", "DATETIME");
  addColumnIfMissing("Artists", "musicbrainz_match_method", "TEXT");

  addColumnIfMissing("ProviderAlbums", "musicbrainz_status", "TEXT");
  addColumnIfMissing("ProviderAlbums", "musicbrainz_last_checked", "DATETIME");
  addColumnIfMissing("ProviderAlbums", "musicbrainz_match_method", "TEXT");

  addColumnIfMissing("ProviderMedia", "musicbrainz_status", "TEXT");
  addColumnIfMissing("ProviderMedia", "musicbrainz_last_checked", "DATETIME");
  addColumnIfMissing("ProviderMedia", "musicbrainz_match_method", "TEXT");
  addColumnIfMissing("ProviderMedia", "acoustid_id", "TEXT");
  addColumnIfMissing("ProviderMedia", "acoustid_fingerprint", "TEXT");
  addColumnIfMissing("ProviderMedia", "fingerprint_duration", "INT");

  addColumnIfMissing("TrackFiles", "acoustid_id", "TEXT");
  addColumnIfMissing("TrackFiles", "fingerprint_duration", "INT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata_identity_status (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL,
      method TEXT,
      message TEXT,
      data TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (entity_type, entity_id)
    )
  `);
}

function ensureExtraFileSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS MetadataFiles (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      ArtistId TEXT NOT NULL,
      AlbumId TEXT,
      TrackFileId INTEGER,
      MediaId TEXT,
      RelativePath TEXT NOT NULL,
      FilePath TEXT NOT NULL UNIQUE,
      LibraryRoot TEXT NOT NULL,
      Extension TEXT NOT NULL,
      Added DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      LastUpdated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      Hash TEXT,
      Consumer TEXT NOT NULL DEFAULT 'Discogenius',
      Type TEXT NOT NULL,
      FileType TEXT NOT NULL,
      Provider TEXT,
      ProviderEntityType TEXT,
      ProviderId TEXT,
      LibrarySlot TEXT NOT NULL DEFAULT 'stereo',
      ExpectedPath TEXT,
      NeedsRename BOOLEAN NOT NULL DEFAULT 0,
      FOREIGN KEY(TrackFileId) REFERENCES TrackFiles(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS LyricFiles (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      ArtistId TEXT NOT NULL,
      AlbumId TEXT,
      TrackFileId INTEGER,
      MediaId TEXT,
      RelativePath TEXT NOT NULL,
      FilePath TEXT NOT NULL UNIQUE,
      LibraryRoot TEXT NOT NULL,
      Extension TEXT NOT NULL,
      Added DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      LastUpdated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      Provider TEXT,
      ProviderEntityType TEXT,
      ProviderId TEXT,
      LibrarySlot TEXT NOT NULL DEFAULT 'stereo',
      Quality TEXT,
      CanonicalArtistMbid TEXT,
      CanonicalReleaseGroupMbid TEXT,
      CanonicalReleaseMbid TEXT,
      CanonicalTrackMbid TEXT,
      CanonicalRecordingMbid TEXT,
      ExpectedPath TEXT,
      NeedsRename BOOLEAN NOT NULL DEFAULT 0,
      FOREIGN KEY(TrackFileId) REFERENCES TrackFiles(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS ExtraFiles (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      ArtistId TEXT NOT NULL,
      AlbumId TEXT,
      TrackFileId INTEGER,
      MediaId TEXT,
      RelativePath TEXT NOT NULL,
      FilePath TEXT NOT NULL UNIQUE,
      LibraryRoot TEXT NOT NULL,
      Extension TEXT NOT NULL,
      Added DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      LastUpdated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FileType TEXT NOT NULL,
      Provider TEXT,
      ProviderEntityType TEXT,
      ProviderId TEXT,
      LibrarySlot TEXT NOT NULL DEFAULT 'stereo',
      ExpectedPath TEXT,
      NeedsRename BOOLEAN NOT NULL DEFAULT 0,
      FOREIGN KEY(TrackFileId) REFERENCES TrackFiles(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_metadata_files_artist ON MetadataFiles(ArtistId, Type);
    CREATE INDEX IF NOT EXISTS idx_metadata_files_album ON MetadataFiles(AlbumId, Type);
    CREATE INDEX IF NOT EXISTS idx_metadata_files_file_type ON MetadataFiles(FileType);
    CREATE INDEX IF NOT EXISTS idx_metadata_files_track_file ON MetadataFiles(TrackFileId);
    CREATE INDEX IF NOT EXISTS idx_metadata_files_media ON MetadataFiles(MediaId, Type);
    CREATE INDEX IF NOT EXISTS idx_metadata_files_provider ON MetadataFiles(Provider, ProviderEntityType, ProviderId);
    CREATE INDEX IF NOT EXISTS idx_lyric_files_artist ON LyricFiles(ArtistId);
    CREATE INDEX IF NOT EXISTS idx_lyric_files_track_file ON LyricFiles(TrackFileId);
    CREATE INDEX IF NOT EXISTS idx_lyric_files_media ON LyricFiles(MediaId, LibrarySlot);
    CREATE INDEX IF NOT EXISTS idx_lyric_files_provider ON LyricFiles(Provider, ProviderEntityType, ProviderId);
    CREATE INDEX IF NOT EXISTS idx_lyric_files_recording ON LyricFiles(CanonicalRecordingMbid);
    CREATE INDEX IF NOT EXISTS idx_extra_files_artist ON ExtraFiles(ArtistId, FileType);
    CREATE INDEX IF NOT EXISTS idx_extra_files_track_file ON ExtraFiles(TrackFileId);
    CREATE INDEX IF NOT EXISTS idx_extra_files_media ON ExtraFiles(MediaId, FileType);
  `);
}

function ensureMediaCoverProxyCacheSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS MediaCoverProxyCache (
      hash TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_media_cover_proxy_expires ON MediaCoverProxyCache(expires_at)");
}

function ensureMusicBrainzProviderSchema(): void {
  ensureProviderCompatibilityTablesUseCurrentNames();
  ensureProviderIdentityTablesUseCurrentNames();
  ensureCanonicalMusicBrainzTableShapes();
  addColumnIfMissing("Artists", "cover_image_url", "TEXT");
  addColumnIfMissing("Artists", "library_origin", "TEXT NOT NULL DEFAULT 'user'");

  db.exec(`
    CREATE TABLE IF NOT EXISTS ArtistMetadata (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      ForeignArtistId TEXT UNIQUE,
      mbid TEXT UNIQUE,
      name TEXT NOT NULL,
      sort_name TEXT,
      disambiguation TEXT,
      type TEXT,
      country TEXT,
      begin_date TEXT,
      end_date TEXT,
      picture TEXT,
      cover_image_url TEXT,
      popularity INT,
      data TEXT,
      images TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS Albums (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      ForeignAlbumId TEXT UNIQUE,
      mbid TEXT UNIQUE,
      artist_mbid TEXT NOT NULL,
      title TEXT NOT NULL,
      primary_type TEXT,
      secondary_types TEXT,
      first_release_date TEXT,
      disambiguation TEXT,
      data TEXT,
      images TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS AlbumReleases (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      ForeignReleaseId TEXT UNIQUE,
      mbid TEXT UNIQUE,
      release_group_mbid TEXT NOT NULL,
      artist_mbid TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT,
      country TEXT,
      date TEXT,
      barcode TEXT,
      disambiguation TEXT,
      media_count INT,
      track_count INT,
      data TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(release_group_mbid) REFERENCES Albums(mbid) ON DELETE CASCADE,
      FOREIGN KEY(artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS AlbumArtists (
      release_group_mbid TEXT NOT NULL,
      artist_mbid TEXT NOT NULL,
      ord INT NOT NULL,
      credited_name TEXT NOT NULL,
      join_phrase TEXT NOT NULL DEFAULT '',
      is_primary BOOLEAN NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(release_group_mbid, ord),
      FOREIGN KEY(release_group_mbid) REFERENCES Albums(mbid) ON DELETE CASCADE,
      FOREIGN KEY(artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ArtistReleaseGroups (
      artist_mbid TEXT NOT NULL,
      release_group_mbid TEXT NOT NULL,
      relationship TEXT NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(artist_mbid, release_group_mbid, relationship),
      FOREIGN KEY(artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE,
      FOREIGN KEY(release_group_mbid) REFERENCES Albums(mbid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ArtistReleaseGroupCuration (
      source_artist_mbid TEXT NOT NULL,
      release_group_mbid TEXT NOT NULL,
      included BOOLEAN NOT NULL DEFAULT 0,
      reason TEXT,
      redundant_to_release_group_mbid TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(source_artist_mbid, release_group_mbid),
      FOREIGN KEY(source_artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE,
      FOREIGN KEY(release_group_mbid) REFERENCES Albums(mbid) ON DELETE CASCADE,
      FOREIGN KEY(redundant_to_release_group_mbid) REFERENCES Albums(mbid) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS AlbumReleaseMedia (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      release_mbid TEXT NOT NULL,
      position INT NOT NULL,
      format TEXT,
      title TEXT,
      track_count INT,
      data TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(release_mbid, position),
      FOREIGN KEY(release_mbid) REFERENCES AlbumReleases(mbid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS Recordings (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      ForeignRecordingId TEXT UNIQUE,
      mbid TEXT UNIQUE,
      ArtistMetadataId INTEGER,
      artist_mbid TEXT,
      title TEXT NOT NULL,
      artist_credit TEXT,
      length_ms INT,
      IsVideo BOOLEAN NOT NULL DEFAULT 0,
      MetadataStatus TEXT NOT NULL DEFAULT 'musicbrainz',
      isrcs TEXT,
      data TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(ArtistMetadataId) REFERENCES ArtistMetadata(Id) ON DELETE SET NULL,
      FOREIGN KEY(artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS Tracks (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      ForeignTrackId TEXT UNIQUE,
      ForeignRecordingId TEXT,
      mbid TEXT UNIQUE,
      release_mbid TEXT NOT NULL,
      recording_mbid TEXT NOT NULL,
      medium_position INT NOT NULL,
      position INT NOT NULL,
      number TEXT,
      title TEXT NOT NULL,
      length_ms INT,
      data TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(release_mbid, medium_position, position),
      FOREIGN KEY(release_mbid) REFERENCES AlbumReleases(mbid) ON DELETE CASCADE,
      FOREIGN KEY(recording_mbid) REFERENCES Recordings(mbid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ProviderItems (
      provider TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      artist_mbid TEXT,
      release_group_mbid TEXT,
      release_mbid TEXT,
      track_mbid TEXT,
      recording_mbid TEXT,
      title TEXT,
      version TEXT,
      explicit BOOLEAN,
      quality TEXT,
      upc TEXT,
      isrc TEXT,
      duration INT,
      release_date TEXT,
      availability TEXT,
      library_slot TEXT NOT NULL DEFAULT 'stereo',
      artist_metadata_id INTEGER,
      album_id INTEGER,
      album_release_id INTEGER,
      track_id INTEGER,
      recording_id INTEGER,
      provider_url TEXT,
      asset_id TEXT,
      match_status TEXT,
      match_confidence REAL,
      match_method TEXT,
      match_evidence TEXT,
      data TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(provider, entity_type, provider_id)
    );

    CREATE TABLE IF NOT EXISTS RecordingRelations (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      SourceRecordingId INTEGER,
      TargetRecordingId INTEGER,
      SourceForeignRecordingId TEXT,
      TargetForeignRecordingId TEXT,
      RelationType TEXT NOT NULL,
      ForeignRelationTypeId TEXT,
      Source TEXT NOT NULL DEFAULT 'discogenius',
      Confidence REAL,
      Data TEXT,
      CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(SourceRecordingId, TargetRecordingId, RelationType),
      UNIQUE(SourceForeignRecordingId, TargetForeignRecordingId, RelationType),
      FOREIGN KEY(SourceRecordingId) REFERENCES Recordings(Id) ON DELETE CASCADE,
      FOREIGN KEY(TargetRecordingId) REFERENCES Recordings(Id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ReleaseGroupSlots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_mbid TEXT NOT NULL,
      release_group_mbid TEXT NOT NULL,
      slot TEXT NOT NULL,
      wanted BOOLEAN NOT NULL DEFAULT 0,
      selected_provider TEXT,
      selected_provider_id TEXT,
      selected_release_mbid TEXT,
      quality TEXT,
      match_status TEXT,
      match_confidence REAL,
      match_method TEXT,
      match_evidence TEXT,
      provider_data TEXT,
      checked_at DATETIME,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(release_group_mbid, slot),
      FOREIGN KEY(artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE,
      FOREIGN KEY(release_group_mbid) REFERENCES Albums(mbid) ON DELETE CASCADE,
      FOREIGN KEY(selected_release_mbid) REFERENCES AlbumReleases(mbid) ON DELETE SET NULL
    );
  `);

  ensureLidarrStyleCanonicalIdentityColumns();

  addColumnIfMissing("ProviderItems", "library_slot", "TEXT NOT NULL DEFAULT 'stereo'");
  addColumnIfMissing("ProviderItems", "artist_metadata_id", "INTEGER");
  addColumnIfMissing("ProviderItems", "album_id", "INTEGER");
  addColumnIfMissing("ProviderItems", "album_release_id", "INTEGER");
  addColumnIfMissing("ProviderItems", "track_id", "INTEGER");
  addColumnIfMissing("ProviderItems", "recording_id", "INTEGER");
  addColumnIfMissing("ProviderItems", "provider_url", "TEXT");
  addColumnIfMissing("ProviderItems", "asset_id", "TEXT");
  addColumnIfMissing("ProviderItems", "match_status", "TEXT");
  addColumnIfMissing("ProviderItems", "match_confidence", "REAL");
  addColumnIfMissing("ProviderItems", "match_method", "TEXT");
  addColumnIfMissing("ProviderItems", "match_evidence", "TEXT");

  db.exec(`
    DROP TABLE IF EXISTS RecordingLyrics;
    DROP TABLE IF EXISTS Lyrics;
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_mb_release_groups_artist ON Albums(artist_mbid, first_release_date)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_album_artists_artist ON AlbumArtists(artist_mbid, release_group_mbid)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_artist_release_groups_group ON ArtistReleaseGroups(release_group_mbid, artist_mbid)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_artist_release_group_curation_group ON ArtistReleaseGroupCuration(release_group_mbid, included)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_mb_releases_group ON AlbumReleases(release_group_mbid, date)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_mb_tracks_release_position ON Tracks(release_mbid, medium_position, position)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_items_mb_artist ON ProviderItems(provider, artist_mbid, entity_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_items_mb_release_group ON ProviderItems(provider, release_group_mbid, entity_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_items_mb_release ON ProviderItems(provider, release_mbid, entity_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_items_recording ON ProviderItems(provider, recording_mbid, entity_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_items_upc ON ProviderItems(provider, upc)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_items_isrc ON ProviderItems(provider, isrc)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_items_match ON ProviderItems(provider, entity_type, match_status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_items_recording_id ON ProviderItems(recording_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_recording_relations_source ON RecordingRelations(SourceRecordingId, RelationType)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_recording_relations_target ON RecordingRelations(TargetRecordingId, RelationType)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_recording_relations_foreign_source ON RecordingRelations(SourceForeignRecordingId, RelationType)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_recording_relations_foreign_target ON RecordingRelations(TargetForeignRecordingId, RelationType)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_release_group_slots_artist ON ReleaseGroupSlots(artist_mbid, slot)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_release_group_slots_provider ON ReleaseGroupSlots(selected_provider, selected_provider_id)");

  backfillCanonicalMusicBrainzTablesFromLegacy();
  backfillProviderItemsFromCompatibilityTables();
}

function dropSupersededProviderIdentityTables(): void {
  db.exec(`
    DROP TABLE IF EXISTS provider_entity_ids;
    DROP TABLE IF EXISTS artist_metadata;
    DROP TABLE IF EXISTS provider_video_items;
    DROP TABLE IF EXISTS provider_video_identity;
    DROP TABLE IF EXISTS artwork_cache;
    DROP TABLE IF EXISTS provider_ids;
    DROP TABLE IF EXISTS local_entities;
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_albums_artist_monitor_date ON ProviderAlbums(artist_id, monitor, release_date DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_media_artist_type_date ON ProviderMedia(artist_id, type, release_date DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_track_files_artist_album_media ON TrackFiles(artist_id, album_id, media_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_mb_release_groups_artist_type_date ON Albums(artist_mbid, primary_type, first_release_date DESC)");
}

function ensureTrackFileCanonicalIdentitySchema(): void {
  addColumnIfMissing("TrackFiles", "canonical_artist_mbid", "TEXT");
  addColumnIfMissing("TrackFiles", "canonical_release_group_mbid", "TEXT");
  addColumnIfMissing("TrackFiles", "canonical_release_mbid", "TEXT");
  addColumnIfMissing("TrackFiles", "canonical_track_mbid", "TEXT");
  addColumnIfMissing("TrackFiles", "canonical_recording_mbid", "TEXT");
  addColumnIfMissing("TrackFiles", "provider", "TEXT");
  addColumnIfMissing("TrackFiles", "provider_entity_type", "TEXT");
  addColumnIfMissing("TrackFiles", "provider_id", "TEXT");
  addColumnIfMissing("TrackFiles", "library_slot", "TEXT NOT NULL DEFAULT 'stereo'");

  db.exec(`
    UPDATE TrackFiles
    SET
      canonical_artist_mbid = COALESCE(
        canonical_artist_mbid,
        (SELECT a.mbid FROM Artists a WHERE CAST(a.id AS TEXT) = CAST(TrackFiles.artist_id AS TEXT) LIMIT 1)
      ),
      canonical_release_group_mbid = COALESCE(
        canonical_release_group_mbid,
        (SELECT a.mb_release_group_id FROM ProviderAlbums a WHERE CAST(a.id AS TEXT) = CAST(TrackFiles.album_id AS TEXT) LIMIT 1),
        (
          SELECT r.release_group_mbid
          FROM ProviderAlbums a
          JOIN AlbumReleases r ON r.mbid = a.mbid
          WHERE CAST(a.id AS TEXT) = CAST(TrackFiles.album_id AS TEXT)
          LIMIT 1
        ),
        (
          SELECT a.mb_release_group_id
          FROM ProviderMedia m
          JOIN ProviderAlbums a ON CAST(a.id AS TEXT) = CAST(m.album_id AS TEXT)
          WHERE CAST(m.id AS TEXT) = CAST(TrackFiles.media_id AS TEXT)
          LIMIT 1
        ),
        (
          SELECT r.release_group_mbid
          FROM ProviderMedia m
          JOIN Tracks t ON t.mbid = m.mbid
          JOIN AlbumReleases r ON r.mbid = t.release_mbid
          WHERE CAST(m.id AS TEXT) = CAST(TrackFiles.media_id AS TEXT)
          LIMIT 1
        )
      ),
      canonical_release_mbid = COALESCE(
        canonical_release_mbid,
        (
          SELECT r.mbid
          FROM ProviderAlbums a
          JOIN AlbumReleases r ON r.mbid = a.mbid
          WHERE CAST(a.id AS TEXT) = CAST(TrackFiles.album_id AS TEXT)
          LIMIT 1
        ),
        (
          SELECT t.release_mbid
          FROM ProviderMedia m
          JOIN Tracks t ON t.mbid = m.mbid
          WHERE CAST(m.id AS TEXT) = CAST(TrackFiles.media_id AS TEXT)
          LIMIT 1
        )
      ),
      canonical_track_mbid = COALESCE(
        canonical_track_mbid,
        (
          SELECT t.mbid
          FROM ProviderMedia m
          JOIN Tracks t ON t.mbid = m.mbid
          WHERE CAST(m.id AS TEXT) = CAST(TrackFiles.media_id AS TEXT)
          LIMIT 1
        )
      ),
      canonical_recording_mbid = COALESCE(
        canonical_recording_mbid,
        (
          SELECT t.recording_mbid
          FROM ProviderMedia m
          JOIN Tracks t ON t.mbid = m.mbid
          WHERE CAST(m.id AS TEXT) = CAST(TrackFiles.media_id AS TEXT)
          LIMIT 1
        ),
        (
          SELECT r.mbid
          FROM ProviderMedia m
          JOIN Recordings r ON r.mbid = m.mbid
          WHERE CAST(m.id AS TEXT) = CAST(TrackFiles.media_id AS TEXT)
          LIMIT 1
        )
      ),
      provider = COALESCE(provider, CASE
        WHEN artist_id IS NOT NULL OR album_id IS NOT NULL OR media_id IS NOT NULL THEN 'tidal'
        ELSE NULL
      END),
      provider_entity_type = COALESCE(provider_entity_type, CASE
        WHEN LOWER(COALESCE(file_type, '')) LIKE '%video%' THEN 'video'
        WHEN media_id IS NOT NULL THEN 'track'
        WHEN album_id IS NOT NULL THEN 'album'
        WHEN artist_id IS NOT NULL THEN 'artist'
        ELSE NULL
      END),
      provider_id = COALESCE(provider_id, CASE
        WHEN LOWER(COALESCE(file_type, '')) LIKE '%video%' AND media_id IS NOT NULL THEN CAST(media_id AS TEXT)
        WHEN media_id IS NOT NULL THEN CAST(media_id AS TEXT)
        WHEN album_id IS NOT NULL THEN CAST(album_id AS TEXT)
        WHEN artist_id IS NOT NULL THEN CAST(artist_id AS TEXT)
        ELSE NULL
      END),
      library_slot = COALESCE(library_slot, CASE
        WHEN LOWER(COALESCE(file_type, '')) LIKE '%video%'
          OR LOWER(COALESCE(library_root, '')) LIKE '%video%' THEN 'video'
        WHEN UPPER(COALESCE(quality, '')) IN ('DOLBY_ATMOS', 'ATMOS', 'SONY_360RA', '360RA')
          OR UPPER(COALESCE(quality, '')) LIKE '%SPATIAL%'
          OR UPPER(COALESCE(quality, '')) LIKE '%SURROUND%'
          OR UPPER(COALESCE(quality, '')) LIKE '%IMMERSIVE%'
          OR UPPER(COALESCE(quality, '')) LIKE '%ATMOS%'
          OR LOWER(COALESCE(library_root, '')) LIKE '%spatial%'
          OR LOWER(COALESCE(library_root, '')) LIKE '%atmos%' THEN 'spatial'
        WHEN file_type IN ('track', 'cover', 'nfo', 'lyrics', 'bio', 'review') THEN 'stereo'
        ELSE 'stereo'
      END)
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_track_files_canonical_artist ON TrackFiles(canonical_artist_mbid)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_track_files_canonical_release_group ON TrackFiles(canonical_release_group_mbid, library_slot)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_track_files_canonical_release ON TrackFiles(canonical_release_mbid)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_track_files_canonical_track ON TrackFiles(canonical_track_mbid)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_track_files_canonical_recording ON TrackFiles(canonical_recording_mbid)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_track_files_provider_resource ON TrackFiles(provider, provider_entity_type, provider_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_track_files_slot_type ON TrackFiles(library_slot, file_type)");
}

type MigrationRunSummary = {
  fromVersion: number;
  toVersion: number;
  appliedDescriptions: string[];
};

function runMigrations(): MigrationRunSummary {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  const appliedDescriptions: string[] = [];
  const schemaVersionFormat = getConfigValue(SCHEMA_VERSION_FORMAT_KEY);
  const isCurrentIntegerSeries = schemaVersionFormat === INTEGER_SCHEMA_VERSION_FORMAT;

  const runLegacyPending = (fromVersion: number) => {
    const pending = LEGACY_MIGRATIONS.slice(fromVersion);
    if (pending.length === 0) {
      return;
    }

    console.log(`🛠️  Running ${pending.length} legacy schema migration(s) (${fromVersion} → ${LEGACY_SCHEMA_VERSION})...`);
    for (let i = 0; i < pending.length; i++) {
      const version = fromVersion + i + 1;
      console.log(`  [legacy ${version}] ${pending[i].description}`);
      pending[i].up();
      appliedDescriptions.push(pending[i].description);
      db.pragma(`user_version = ${version}`);
    }
  };

  if (!isCurrentIntegerSeries && currentVersion > 0 && currentVersion <= LEGACY_SCHEMA_VERSION) {
    const legacyVersion = Math.min(currentVersion, LEGACY_SCHEMA_VERSION);
    if (legacyVersion < LEGACY_SCHEMA_VERSION) {
      runLegacyPending(legacyVersion);
    }
  }

  let normalizedVersion = db.pragma("user_version", { simple: true }) as number;
  const shouldBackfillLegacyUnversionedSchema =
    normalizedVersion === 0
    && (tableHasRows("Artists") || tableHasRows("ProviderAlbums") || tableHasRows("ProviderMedia") || tableHasRows("TrackFiles"));

  if (shouldBackfillLegacyUnversionedSchema) {
    runLegacyPending(0);
    normalizedVersion = db.pragma("user_version", { simple: true }) as number;
  }

  const shouldNormalizeToBaseline =
    normalizedVersion === 0
    || (!isCurrentIntegerSeries && normalizedVersion <= LEGACY_SCHEMA_VERSION)
    || normalizedVersion === LEGACY_SEMVER_BASELINE_VERSION;

  if (shouldNormalizeToBaseline) {
    console.log(`🛠️  Baseline current schema to ${BASE_SCHEMA_VERSION} (PRAGMA user_version=${BASE_SCHEMA_VERSION})...`);
    db.pragma(`user_version = ${BASE_SCHEMA_VERSION}`);
    appliedDescriptions.push(`baseline current schema as ${BASE_SCHEMA_VERSION} (PRAGMA user_version=${BASE_SCHEMA_VERSION})`);
    normalizedVersion = BASE_SCHEMA_VERSION;
  }

  const pending = SCHEMA_MIGRATIONS
    .filter((migration) => migration.version > normalizedVersion)
    .sort((left, right) => left.version - right.version);

  if (pending.length > 0) {
    console.log(
      `🛠️  Running ${pending.length} schema migration(s) (${normalizedVersion} → ${pending[pending.length - 1].version})...`
    );
    for (const migration of pending) {
      console.log(`  [${migration.version}] ${migration.description}`);
      migration.up();
      appliedDescriptions.push(migration.description);
      db.pragma(`user_version = ${migration.version}`);
    }
  }

  return {
    fromVersion: currentVersion,
    toVersion: db.pragma("user_version", { simple: true }) as number,
    appliedDescriptions,
  };
}

export function initDatabase() {
  console.log("🗄️  Initializing database schema...");

  // ====================================================================
  // ARTISTS TABLE
  // ====================================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS Artists (
      id TEXT PRIMARY KEY,             -- Local managed artist id; MusicBrainz MBID for canonical artists
      name TEXT NOT NULL,              -- Artist name
      picture TEXT,                    -- Resolved or provider-native artist image reference
      cover_image_url TEXT,            -- Resolved artist image URL used by UI pages
      popularity INT,                  -- Optional provider popularity score
      artist_types TEXT,               -- JSON array: ["ARTIST", "CONTRIBUTOR", ...ETC]
      artist_roles TEXT,               -- JSON array: [{"categoryId": -1, "category": "Artist"}, {"categoryId": 2, "category": "Songwriter"}, ...ETC]
      user_date_added DATETIME,        -- When imported from a provider's followed/favorite artists
      mbid TEXT,                       -- MusicBrainz artist ID
      path TEXT,                       -- Resolved library folder path (set at add/import time)
      musicbrainz_status TEXT,         -- pending/verified/ambiguous/unmatched/error
      musicbrainz_last_checked DATETIME,
      musicbrainz_match_method TEXT,
      
      -- Biography
      bio_text TEXT,                   -- Full biography text
      bio_source TEXT,                 -- Source of biography
      bio_last_updated DATETIME,       -- When biography was last updated

      -- Monitoring & Lock Mechanism
      monitor BOOLEAN DEFAULT 0,       -- whether to scan, filter, and download releases from this artist, and monitor them for new releases
      monitored_at DATETIME,           -- when monitoring was enabled
      last_scanned DATETIME,           -- last time this artist was scanned for new releases
      downloaded INT DEFAULT 0         -- number between 0 and 100 representing percentage of artist's monitored media downloaded
    )
  `);

  // ====================================================================
  // ALBUMS TABLE
  // ====================================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS ProviderAlbums (
      id TEXT PRIMARY KEY,               -- Temporary provider offer id until albums move fully to MB release groups
      artist_id TEXT NOT NULL,           -- Managed artist id
      title TEXT NOT NULL,               -- Album title
      version TEXT,                      -- Album version (Deluxe, Remastered, etc)
      release_date DATETIME,             -- Original release date
      type TEXT NOT NULL,                -- Main release type: ALBUM/EP/SINGLE
      explicit BOOLEAN NOT NULL,         -- Whether album is explicit or clean
      quality TEXT NOT NULL,             -- Provider quality label, e.g. LOSSLESS, HIRES_LOSSLESS, DOLBY_ATMOS
      user_date_added DATETIME,          -- When imported from provider favorites

      -- Media
      cover TEXT,                        -- Resolved or provider-native album cover reference
      vibrant_color TEXT,                -- Hex color code of dominant cover color
      video_cover TEXT,                  -- animated cover UUID
      
      -- Counts
      num_tracks INT NOT NULL,           -- Number of tracks
      num_volumes INT NOT NULL,          -- Number of volumes
      num_videos INT NOT NULL,           -- Number of videos
      duration INT NOT NULL,             -- Total duration in seconds
      popularity INT,                    -- Optional provider popularity score
      
      -- Review
      review_text TEXT,                  -- Full review text
      review_source TEXT,                -- Source of review
      review_last_updated DATETIME,      -- When review was last updated

      -- Metadata
      credits TEXT,                      -- JSON object of album credits
      copyright TEXT,                    -- Album copyright info
      upc TEXT,                          -- Universal Product Code (identifies specific pressing/edition)
      mbid TEXT,                         -- MusicBrainz Release ID (specific pressing/edition; matches UPC)
      mb_release_group_id TEXT,          -- MusicBrainz Release Group ID — cross-provider join key for the abstract
                                         -- album concept. NOTE: MB groups Standard + Deluxe editions into the same
                                         -- Release Group. Do NOT use this for dedup; use ISRC-set matching instead.
      musicbrainz_status TEXT,           -- pending/verified/ambiguous/unmatched/error
      musicbrainz_last_checked DATETIME,
      musicbrainz_match_method TEXT,
      
      -- Categorization (for Plex compatibility)
      mb_primary TEXT,                  -- MusicBrainz primary release type: album/ep/single
      mb_secondary TEXT,                -- MusicBrainz secondary release type: live/compilation/remix (only with primary type album)
      
      -- Monitoring & Filtering
      monitor BOOLEAN DEFAULT 0,        -- whether to scan and download tracks from this album, and monitor it for changes
      monitored_at DATETIME,            -- when monitoring was enabled
      monitor_lock BOOLEAN DEFAULT 0,   -- whether monitoring is locked (allowed to be changed during automated scanning/filtering)
      locked_at DATETIME,               -- when lock was enabled
      last_scanned DATETIME,            -- last time this album was scanned for changes
      downloaded INT,                   -- number between 0 and 100 representing percentage of album's tracks downloaded
      redundant TEXT,                   -- If redundant, points to the id of the better version

      FOREIGN KEY(artist_id) REFERENCES Artists(id) ON DELETE CASCADE
    )
  `);

  // ====================================================================
  // MEDIA TABLE  
  // ====================================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS ProviderMedia (
      id TEXT PRIMARY KEY,              -- Temporary provider media id until tracks/videos move fully to canonical identities
      artist_id TEXT NOT NULL,          -- Managed artist id
      album_id TEXT,                    -- Provider offer id for album tracks while compatibility table remains
      title TEXT NOT NULL,              -- Track or video title
      version TEXT,                     -- version specifier (Remastered, etc)
      release_date DATETIME,            -- Original release date
      type TEXT NOT NULL,               -- Main release type: ALBUM/EP/SINGLE/Music Video
      explicit BOOLEAN NOT NULL,        -- Whether track is explicit or clean
      quality TEXT NOT NULL,            -- Provider quality label, e.g. LOSSLESS, HIRES_LOSSLESS, DOLBY_ATMOS
      user_date_added DATETIME,         -- When imported from provider favorites

      -- Media
      cover TEXT,                       -- Cover UUID (video thumbnail; optional for tracks)

      -- Positioning
      track_number INT,                 -- Track number on album
      volume_number INT,                -- Volume number on album
      duration INT,                     -- Duration in seconds
      popularity INT,                   -- Optional provider popularity score
      
      -- Music Theory
      bpm INT,                          -- Beats per minute
      key TEXT,                         -- Musical key (C, D, etc)
      key_scale TEXT,                   -- Major/minor
      
      -- Audio Engineering
      peak REAL,                        -- Peak amplitude
      replay_gain REAL,                 -- For normalization
      
      -- Audio Quality Details (for replacement logic)
      bit_depth INT,
      sample_rate INT,
      bitrate INT,
      codec TEXT,

      -- Metadata
      credits TEXT,                     -- JSON object of track credits
      copyright TEXT,
      isrc TEXT,
      mbid TEXT,                        -- MusicBrainz ID
      musicbrainz_status TEXT,          -- pending/verified/ambiguous/unmatched/error
      musicbrainz_last_checked DATETIME,
      musicbrainz_match_method TEXT,
      acoustid_id TEXT,                 -- AcoustID result ID
      acoustid_fingerprint TEXT,        -- Chromaprint fingerprint written/imported for this media
      fingerprint_duration INT,         -- Duration returned by fpcalc
      
      -- Monitoring & Filtering
      monitor BOOLEAN DEFAULT 0,        -- whether to scan and download this track, and monitor it for changes
      monitored_at DATETIME,            -- when monitoring was enabled
      monitor_lock BOOLEAN DEFAULT 0,   -- whether monitoring is locked (allowed to be changed during automated scanning/filtering)
      locked_at DATETIME,               -- when lock was enabled
      last_scanned DATETIME,            -- last time this track was scanned for changes
      downloaded BOOLEAN,               -- whether this track has been downloaded
      redundant TEXT,                   -- If redundant, points to the id of the better version
      
      FOREIGN KEY(artist_id) REFERENCES Artists(id) ON DELETE CASCADE,
      FOREIGN KEY(album_id) REFERENCES ProviderAlbums(id) ON DELETE CASCADE
    )
  `);

  // ====================================================================
  // NORMALIZED METADATA TABLES
  // ====================================================================

  // Album artists relationship
  db.exec(`
    CREATE TABLE IF NOT EXISTS ProviderAlbumArtists (
      album_id TEXT NOT NULL,            -- Provider offer id while compatibility table remains
      artist_id TEXT NOT NULL,           -- Managed artist id
      artist_name TEXT,                  -- Cached artist name (for fast UI rendering)
      ord INT,                           -- Ordering of artists on the release
      type TEXT NOT NULL,                -- contribution type
      group_type TEXT,                   -- retrieved from endpoint ALBUMS, EPSANDSINGLES, or COMPILATIONS
      version_group_id INT,              -- Group id for related album versions (explicit/clean, qualities)
      version_group_name TEXT,           -- Group name for related album versions ("Album Name")
      module TEXT,                       -- derived from release type and page module ALBUM, EP, SINGLE, COMPILATIONS, LIVE, REMIX, APPEARS_ON
      PRIMARY KEY (artist_id, album_id),
      FOREIGN KEY (artist_id) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE,
      FOREIGN KEY (album_id) REFERENCES ProviderAlbums(id) ON DELETE CASCADE
    )
  `);

  // Media artist relationship
  db.exec(`
    CREATE TABLE IF NOT EXISTS ProviderMediaArtists (
      media_id TEXT NOT NULL,            -- Provider media id while compatibility table remains
      artist_id TEXT NOT NULL,           -- Managed artist id
      type TEXT NOT NULL,                -- contribution type
      PRIMARY KEY (media_id, artist_id),
      FOREIGN KEY (media_id) REFERENCES ProviderMedia(id) ON DELETE CASCADE,
      FOREIGN KEY (artist_id) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE
    )
  `);

  // ====================================================================
  // SIMILAR ENTITIES JUNCTION TABLES
  // ====================================================================

  // Similar artists relationship (junction table)
  db.exec(`
    CREATE TABLE IF NOT EXISTS ProviderSimilarArtists (
      artist_id TEXT NOT NULL,              -- Source artist
      similar_artist_id TEXT NOT NULL,      -- Similar artist
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (artist_id, similar_artist_id),
      FOREIGN KEY (artist_id) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE,
      FOREIGN KEY (similar_artist_id) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE
    )
  `);

  // Similar albums relationship (junction table)
  db.exec(`
    CREATE TABLE IF NOT EXISTS ProviderSimilarAlbums (
      album_id INT NOT NULL,               -- Source album
      similar_album_id INT NOT NULL,       -- Similar album
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (album_id, similar_album_id),
      FOREIGN KEY (album_id) REFERENCES ProviderAlbums(id) ON DELETE CASCADE,
      FOREIGN KEY (similar_album_id) REFERENCES ProviderAlbums(id) ON DELETE CASCADE
    )
  `);


  // ====================================================================
  // TRACKFILES TABLE (Local file tracking; Lidarr-aligned file inventory)
  // ====================================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS TrackFiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, -- Internal file ID
      
      -- Linkage (at least artist_id required, then either media_id for tracks/videos)
      artist_id TEXT NOT NULL,           -- Managed artist id
      album_id TEXT,                     -- Provider offer id while compatibility table remains
      media_id TEXT,                     -- Provider media id while compatibility table remains

      -- Canonical identity (MusicBrainz/Lidarr-style managed graph)
      canonical_artist_mbid TEXT,
      canonical_release_group_mbid TEXT,
      canonical_release_mbid TEXT,
      canonical_track_mbid TEXT,
      canonical_recording_mbid TEXT,

      -- Provider resource that produced or owns this file
      provider TEXT,
      provider_entity_type TEXT,
      provider_id TEXT,
      library_slot TEXT NOT NULL DEFAULT 'stereo',                 -- stereo, spatial, video
      
      -- File Location
      file_path TEXT NOT NULL UNIQUE,    -- Absolute path to the file in library
      relative_path TEXT NOT NULL,       -- Path relative to library root (for portability)
      library_root TEXT NOT NULL,        -- Which library root: stereo, spatial, video
      
      -- File Metadata
      filename TEXT NOT NULL,            -- Just the filename with extension
      extension TEXT NOT NULL,           -- File extension (flac, mp3, mp4, etc)
      file_size INT,                     -- File size in bytes
      file_hash TEXT,                    -- MD5/SHA hash for integrity checking
      duration INT,                      -- Duration in seconds (from file metadata)
      bitrate INT,                       -- Bitrate in kbps
      sample_rate INT,                   -- Sample rate in Hz (e.g. 44100, 96000)
      bit_depth INT,                     -- Bit depth (16, 24, etc)
      channels INT,                      -- Number of audio channels
      codec TEXT,                        -- Audio codec (FLAC, AAC, etc)
      
      -- Content Type
      file_type TEXT NOT NULL,           -- track, video, cover, video_cover, video_thumbnail, bio, review, lyrics
      quality TEXT,                      -- LOSSLESS, HIRES_LOSSLESS, DOLBY_ATMOS, etc
      
      -- Naming & Organization
      naming_template TEXT,              -- Template used when file was created
      expected_path TEXT,                -- Path the file should have based on current naming template
      needs_rename BOOLEAN DEFAULT 0,    -- Flag if file_path != expected_path
      
      -- Import & Source Data
      original_filename TEXT,            -- Original filename before rename/import (Scene Name)
      release_group TEXT,                -- Release group extracted from original filename
      fingerprint TEXT,                  -- AcoustID/Chromaprint fingerprint for audio matching
      acoustid_id TEXT,                  -- AcoustID result ID for imported audio
      fingerprint_duration INT,          -- Duration returned by fpcalc

      
      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,               -- When file record was created
      modified_at DATETIME,              -- File system modified time
      verified_at DATETIME,              -- Last time file existence was verified
      
      FOREIGN KEY(artist_id) REFERENCES Artists(id) ON DELETE CASCADE,
      FOREIGN KEY(album_id) REFERENCES ProviderAlbums(id) ON DELETE SET NULL,
      FOREIGN KEY(media_id) REFERENCES ProviderMedia(id) ON DELETE SET NULL
    )
  `);

  db.exec(`DROP TRIGGER IF EXISTS trg_track_files_download_state_insert`);
  db.exec(`DROP TRIGGER IF EXISTS trg_track_files_download_state_delete`);
  db.exec(`DROP TRIGGER IF EXISTS trg_track_files_download_state_update`);

  ensureMetadataIdentitySchema();
  ensureMusicBrainzProviderSchema();
  ensureTrackFileCanonicalIdentitySchema();
  ensureExtraFileSchema();
  ensureMediaCoverProxyCacheSchema();

  // ====================================================================
  // UNMAPPED FILES TABLE (local files not mapped to canonical metadata/provider evidence)
  // ====================================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS UnmappedFiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      
      file_path TEXT NOT NULL UNIQUE,    -- Absolute path to the file
      relative_path TEXT NOT NULL,       -- Path relative to library root
      library_root TEXT NOT NULL,        -- Which library: music, spatial, videos
      
      filename TEXT NOT NULL,
      extension TEXT NOT NULL,
      file_size INT,
      duration INT,
      bitrate INT,
      sample_rate INT,
      bit_depth INT,
      channels INT,
      codec TEXT,
      
      -- Discovery Data
      detected_artist TEXT,              -- Guessed artist name from folder structure
      detected_album TEXT,               -- Guessed album name from folder structure
      detected_track TEXT,               -- Guessed track title or ID3 tag
      audio_quality TEXT,                -- Audio quality (e.g. 24-BIT 44.1KHZ FLAC)
      reason TEXT,                       -- "No matching provider track", "Ignored by user", etc.
      
      ignored BOOLEAN DEFAULT 0,         -- If 1, hide from UI and don't try to map
      
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  ensureUnmappedFilesAudioMetadataColumns();

  // ====================================================================
  // JOBS TABLE (Unified Queue)
  // ====================================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, -- Internal job ID
      type TEXT NOT NULL,               -- SCAN, DOWNLOAD, PROCESS, etc.
      ref_id TEXT,                      -- Optional reference id (Tidal ID, file id, etc)
      payload TEXT NOT NULL,            -- JSON data necessary for execution
      status TEXT DEFAULT 'pending',    -- pending, processing, completed, failed, cancelled
      progress INT DEFAULT 0,           -- 0-100
      priority INT DEFAULT 0,           -- higher = processed first
      trigger INT DEFAULT 0,            -- 0=Unspecified, 1=Manual, 2=Scheduled
      queue_order INT,
      attempts INT DEFAULT 0,
      error TEXT,
      
      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ====================================================================
  // SCHEDULED TASKS
  // ====================================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      task_key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      interval_minutes INT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT 1,
      last_queued_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS monitoring_runtime_state (
      state_key TEXT PRIMARY KEY,
      last_check_timestamp DATETIME,
      check_in_progress BOOLEAN NOT NULL DEFAULT 0,
      progress_artist_index INT NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ====================================================================
  // QUALITY PROFILES
  // ====================================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS quality_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      upgrade_allowed BOOLEAN DEFAULT 1,
      cutoff TEXT NOT NULL,          -- 'LOSSLESS', 'HIRES_LOSSLESS', etc.
      items TEXT NOT NULL,           -- JSON array of allowed qualities (ordered by preference)
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ====================================================================
  // UPGRADE QUEUE (Track quality upgrade candidates)
  // ====================================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS upgrade_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id INT NOT NULL,
      album_id INT,
      current_quality TEXT NOT NULL,
      target_quality TEXT NOT NULL,
      reason TEXT,
      status TEXT DEFAULT 'pending',  -- pending, completed, skipped
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME,
      UNIQUE(media_id),
      FOREIGN KEY(media_id) REFERENCES ProviderMedia(id) ON DELETE CASCADE,
      FOREIGN KEY(album_id) REFERENCES ProviderAlbums(id) ON DELETE CASCADE
    )
  `);
  // ====================================================================
  // CONFIG TABLE (Application settings)
  // ====================================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS history_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_id TEXT,
      album_id TEXT,
      media_id TEXT,
      library_file_id TEXT,
      event_type TEXT NOT NULL,
      quality TEXT,
      source_title TEXT,
      data TEXT,
      date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS database_version_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_version TEXT NOT NULL,
      api_version TEXT NOT NULL,
      schema_from INT NOT NULL,
      schema_to INT NOT NULL,
      migration_notes TEXT,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ====================================================================
  // MIGRATIONS — must run before indexes so migration-added columns exist
  // ====================================================================
  // Integrity check
  const integrityResult = db.pragma("integrity_check", { simple: true }) as string;
  if (integrityResult !== "ok") {
    console.error(`🚨 Database integrity check failed: ${integrityResult}`);
    console.error("   The database may be corrupted. Consider restoring from a backup.");
  }

  const migrationSummary = runMigrations();

  // ====================================================================
  // INDEXES
  // ====================================================================
  // Artist indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_monitor ON Artists(monitor)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_name ON Artists(name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_popularity ON Artists(popularity)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_last_scanned ON Artists(last_scanned)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_user_date_added ON Artists(user_date_added)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_mbid ON Artists(mbid)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_musicbrainz_status ON Artists(musicbrainz_status)`);

  // Album indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_albums_artist_id ON ProviderAlbums(artist_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_albums_monitor ON ProviderAlbums(monitor)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_albums_monitor_lock ON ProviderAlbums(monitor_lock)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_albums_type ON ProviderAlbums(type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_albums_quality ON ProviderAlbums(quality)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_albums_release_date ON ProviderAlbums(release_date)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_albums_title ON ProviderAlbums(title)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_albums_mbid ON ProviderAlbums(mbid)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_albums_mb_release_group ON ProviderAlbums(mb_release_group_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_albums_musicbrainz_status ON ProviderAlbums(musicbrainz_status)`);
  db.exec(`DROP INDEX IF EXISTS idx_albums_downloaded`);

  // Album artists indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_album_artists_version_group ON ProviderAlbumArtists(version_group_id)`);

  // Similar entities indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_similar_artists_source ON ProviderSimilarArtists(artist_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_similar_artists_target ON ProviderSimilarArtists(similar_artist_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_similar_albums_source ON ProviderSimilarAlbums(album_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_similar_albums_target ON ProviderSimilarAlbums(similar_album_id)`);

  // Media indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_artist_id ON ProviderMedia(artist_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_album_id ON ProviderMedia(album_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_isrc ON ProviderMedia(isrc)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_mbid ON ProviderMedia(mbid)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_acoustid_id ON ProviderMedia(acoustid_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_musicbrainz_status ON ProviderMedia(musicbrainz_status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_monitor ON ProviderMedia(monitor)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_monitor_lock ON ProviderMedia(monitor_lock)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_quality ON ProviderMedia(quality)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_type ON ProviderMedia(type)`);
  db.exec(`DROP INDEX IF EXISTS idx_media_downloaded`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_title ON ProviderMedia(title)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_release_date ON ProviderMedia(release_date)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_last_scanned ON ProviderMedia(last_scanned)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_artists_artist_type_media ON ProviderMediaArtists(artist_id, type, media_id)`);

  // Job indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON job_queue(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_type ON job_queue(type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_ref_id ON job_queue(ref_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_priority ON job_queue(priority)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_queue_order ON job_queue(queue_order)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_status_priority ON job_queue(status, priority)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_type_status_ref_id ON job_queue(type, status, ref_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_status_type_created ON job_queue(status, type, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_status_type_started ON job_queue(status, type, started_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_status_type_completed ON job_queue(status, type, completed_at DESC, id DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_poll ON job_queue(status, priority DESC, trigger DESC, queue_order ASC, created_at ASC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(enabled)`);

  // Library file indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_artist_id ON TrackFiles(artist_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_album_id ON TrackFiles(album_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_media_id ON TrackFiles(media_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_file_type ON TrackFiles(file_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_library_root ON TrackFiles(library_root)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_needs_rename ON TrackFiles(needs_rename)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_quality ON TrackFiles(quality)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_track_files_path ON TrackFiles(file_path)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_fingerprint ON TrackFiles(fingerprint)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_acoustid_id ON TrackFiles(acoustid_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_media_id_file_type ON TrackFiles(media_id, file_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_canonical_artist ON TrackFiles(canonical_artist_mbid)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_canonical_release_group ON TrackFiles(canonical_release_group_mbid, library_slot)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_canonical_release ON TrackFiles(canonical_release_mbid)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_canonical_track ON TrackFiles(canonical_track_mbid)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_canonical_recording ON TrackFiles(canonical_recording_mbid)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_provider_resource ON TrackFiles(provider, provider_entity_type, provider_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_slot_type ON TrackFiles(library_slot, file_type)`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_metadata_identity_status_status ON metadata_identity_status(status, updated_at DESC)`);

  // Quality profiles indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_quality_profiles_name ON quality_profiles(name)`);

  // History / schema provenance indexes
  db.exec("CREATE INDEX IF NOT EXISTS idx_history_events_date ON history_events(date DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_history_events_artist ON history_events(artist_id, date DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_history_events_album ON history_events(album_id, date DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_history_events_media ON history_events(media_id, date DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_history_events_event_type ON history_events(event_type, date DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_database_version_history_applied_at ON database_version_history(applied_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_database_version_history_app_version ON database_version_history(app_version, applied_at DESC)");

  // Upgrade queue indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_upgrade_queue_media_id ON upgrade_queue(media_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_upgrade_queue_album_id ON upgrade_queue(album_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_upgrade_queue_status ON upgrade_queue(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_upgrade_queue_target_quality ON upgrade_queue(target_quality)`);

  // Foreign key and lookup performance indexes
  db.exec("CREATE INDEX IF NOT EXISTS idx_mb_releases_artist_mbid ON AlbumReleases(artist_mbid)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_mb_tracks_recording_mbid ON Tracks(recording_mbid)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_album_artists_album_id ON ProviderAlbumArtists(album_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_release_group_slots_selected_release ON ReleaseGroupSlots(selected_release_mbid)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_artists_path ON Artists(path)");

  console.log("✅ Database schema initialized");

  // ====================================================================
  // DEFAULT DATA
  // ====================================================================
  initializeDefaultData(migrationSummary);
}

function recordDatabaseVersionState(migrationSummary: MigrationRunSummary) {
  const releaseInfo = getCurrentAppReleaseInfo();
  const appVersion = releaseInfo.version;
  const apiVersion = releaseInfo.apiVersion;
  const schemaUserVersion = db.pragma("user_version", { simple: true }) as number;
  const schemaVersion = String(schemaUserVersion);

  const previousVersionRow = db.prepare(`SELECT value FROM config WHERE key = 'runtime.current_app_version'`).get() as
    | { value: string }
    | undefined;

  const insertConfig = db.prepare(`
    INSERT OR IGNORE INTO config (key, value, description)
    VALUES (?, ?, ?)
  `);

  const upsertConfig = db.prepare(`
    INSERT INTO config (key, value, description)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      description = excluded.description,
      updated_at = CURRENT_TIMESTAMP
  `);

  const insertHistory = db.prepare(`
    INSERT INTO database_version_history (app_version, api_version, schema_from, schema_to, migration_notes)
    VALUES (?, ?, ?, ?, ?)
  `);

  const shouldRecordHistory = migrationSummary.toVersion !== migrationSummary.fromVersion
    || previousVersionRow?.value !== appVersion;

  db.exec("BEGIN");
  try {
    insertConfig.run(
      "runtime.first_seen_app_version",
      appVersion,
      "First Discogenius app version that initialized this database"
    );

    upsertConfig.run(
      "runtime.current_app_version",
      appVersion,
      "Most recent Discogenius app version that started against this database"
    );

    upsertConfig.run(
      "runtime.current_api_version",
      apiVersion,
      "Most recent Discogenius API package version that started against this database"
    );

    upsertConfig.run(
      "runtime.current_schema_version",
      schemaVersion,
      "Current Discogenius schema version"
    );

    upsertConfig.run(
      SCHEMA_VERSION_FORMAT_KEY,
      INTEGER_SCHEMA_VERSION_FORMAT,
      "Schema versioning format used by SQLite PRAGMA user_version"
    );

    db.prepare("DELETE FROM config WHERE key = 'runtime.current_schema_user_version'").run();

    if (shouldRecordHistory) {
      const notes = migrationSummary.appliedDescriptions.length > 0
        ? migrationSummary.appliedDescriptions.join(" | ")
        : "startup version change";

      insertHistory.run(
        appVersion,
        apiVersion,
        migrationSummary.fromVersion,
        migrationSummary.toVersion,
        notes
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function initializeDefaultData(migrationSummary: MigrationRunSummary) {
  // Check if quality profiles exist
  const profileCount = db.prepare("SELECT COUNT(*) as count FROM quality_profiles").get() as { count: number };

  if (profileCount.count === 0) {
    console.log("📋 Creating default quality profiles...");

    // Quality profiles define what to MONITOR, not what tidal-dl-ng downloads.
    // TIDAL only reports LOSSLESS and HIRES_LOSSLESS as quality metadata.
    // When user wants LOW/HIGH AAC, we still monitor LOSSLESS and let tidal-dl-ng convert.

    // Max Quality - monitors HIRES_LOSSLESS, upgrades from LOSSLESS to HIRES_LOSSLESS
    // Use with tidal-dl-ng quality_audio=HIRES_LOSSLESS to get 24-bit Hi-Res files
    db.prepare(`
      INSERT INTO quality_profiles (name, upgrade_allowed, cutoff, items)
      VALUES (?, ?, ?, ?)
    `).run(
      "Max Quality",
      1,
      "HIRES_LOSSLESS",
      JSON.stringify(["HIRES_LOSSLESS", "LOSSLESS"])
    );

    // High Quality - monitors LOSSLESS, no upgrades needed
    // Use with tidal-dl-ng quality_audio=LOSSLESS to get 16-bit FLAC files
    db.prepare(`
      INSERT INTO quality_profiles (name, upgrade_allowed, cutoff, items)
      VALUES (?, ?, ?, ?)
    `).run(
      "High Quality",
      1,
      "LOSSLESS",
      JSON.stringify(["LOSSLESS"])
    );

    // Normal Quality - monitors LOSSLESS, tidal-dl-ng converts to 320kbps AAC on download
    // Use with tidal-dl-ng quality_audio=HIGH setting
    db.prepare(`
      INSERT INTO quality_profiles (name, upgrade_allowed, cutoff, items)
      VALUES (?, ?, ?, ?)
    `).run(
      "Normal Quality",
      0,
      "LOSSLESS",
      JSON.stringify(["LOSSLESS"])
    );

    // Any Quality - monitors anything available, no upgrades
    db.prepare(`
      INSERT INTO quality_profiles (name, upgrade_allowed, cutoff, items)
      VALUES (?, ?, ?, ?)
    `).run(
      "Any",
      0,
      "LOSSLESS",
      JSON.stringify(["HIRES_LOSSLESS", "LOSSLESS"])
    );

    console.log("✅ Created 4 default quality profiles");
  }

  // Initialize default config
  const configDefaults = [
    { key: "import.allow_fingerprinting", value: "always", description: "When to use fingerprinting: never, new_files, always" },
    { key: "import.fingerprint_cache_minutes", value: "30", description: "Minutes to cache fingerprints" },
    { key: "quality.upgrade_automatically", value: "true", description: "Automatically download better quality versions" },
    { key: "quality.min_bitrate", value: "320", description: "Minimum bitrate for lossy formats (kbps)" },
    { key: "quality.min_sample_rate", value: "44100", description: "Minimum sample rate (Hz)" },
    { key: "quality.prefer_24bit", value: "true", description: "Prefer 24-bit over 16-bit" },
    { key: "sidecars.download_artist_images", value: "true", description: "Download artist images" },
    { key: "sidecars.download_album_covers", value: "true", description: "Download album covers" },
    { key: "sidecars.replace_low_res_covers", value: "true", description: "Replace low resolution covers" },
    { key: "sidecars.min_cover_resolution", value: "1000", description: "Minimum cover resolution (px)" },
    { key: "sidecars.download_lyrics", value: "true", description: "Download lyrics files" },
    { key: "sidecars.download_bios", value: "true", description: "Download artist biographies" },
    { key: "sidecars.download_reviews", value: "true", description: "Download album reviews" }
  ];

  const insertConfig = db.prepare(`
    INSERT OR IGNORE INTO config (key, value, description)
    VALUES (?, ?, ?)
  `);

  for (const { key, value, description } of configDefaults) {
    insertConfig.run(key, value, description);
  }

  recordDatabaseVersionState(migrationSummary);

  console.log("✅ Default configuration initialized");
}
