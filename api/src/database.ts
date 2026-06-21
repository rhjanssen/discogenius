import Database from "better-sqlite3";
import { DB_PATH } from "./services/config/config.js";
import { getCurrentAppReleaseInfo } from "./services/config/app-release.js";
import { resolveArtistFolderForPersistence } from "./services/music/artist-paths.js";

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

const BASE_SCHEMA_VERSION = 29;
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



const LEGACY_MIGRATIONS: Array<{ description: string; up: () => void }> = [];

const LEGACY_SCHEMA_VERSION = LEGACY_MIGRATIONS.length;
const SCHEMA_MIGRATIONS: Array<{ version: number; description: string; up: () => void }> = [
  {
    version: 21,
    description: "Rename extra file tables and RecordingRelations column casing to snake_case",
    up: () => {
      const metadataFilesRenames = [
        ["ArtistId", "artist_id"],
        ["AlbumId", "album_id"],
        ["MediaId", "media_id"],
        ["Added", "added"],
        ["Hash", "hash"],
        ["Type", "type"]
      ];
      for (const [oldCol, newCol] of metadataFilesRenames) {
        if (hasTable("MetadataFiles") && hasColumn("MetadataFiles", oldCol) && !hasColumn("MetadataFiles", newCol)) {
          db.exec(`ALTER TABLE MetadataFiles RENAME COLUMN ${oldCol} TO ${newCol}`);
        }
      }

      const lyricFilesRenames = [
        ["ArtistId", "artist_id"],
        ["AlbumId", "album_id"],
        ["MediaId", "media_id"],
        ["Added", "added"],
        ["Quality", "quality"]
      ];
      for (const [oldCol, newCol] of lyricFilesRenames) {
        if (hasTable("LyricFiles") && hasColumn("LyricFiles", oldCol) && !hasColumn("LyricFiles", newCol)) {
          db.exec(`ALTER TABLE LyricFiles RENAME COLUMN ${oldCol} TO ${newCol}`);
        }
      }

      const extraFilesRenames = [
        ["ArtistId", "artist_id"],
        ["AlbumId", "album_id"],
        ["MediaId", "media_id"],
        ["Added", "added"]
      ];
      for (const [oldCol, newCol] of extraFilesRenames) {
        if (hasTable("ExtraFiles") && hasColumn("ExtraFiles", oldCol) && !hasColumn("ExtraFiles", newCol)) {
          db.exec(`ALTER TABLE ExtraFiles RENAME COLUMN ${oldCol} TO ${newCol}`);
        }
      }

      const recordingRelationsRenames = [
        ["SourceRecordingId", "source_recording_id"],
        ["TargetRecordingId", "target_recording_id"],
        ["SourceForeignRecordingId", "source_foreign_recording_id"],
        ["TargetForeignRecordingId", "target_foreign_recording_id"],
        ["RelationType", "relation_type"],
        ["ForeignRelationTypeId", "foreign_relation_type_id"],
        ["Source", "source"],
        ["Confidence", "confidence"],
        ["Data", "data"],
        ["CreatedAt", "created_at"],
        ["UpdatedAt", "updated_at"]
      ];
      for (const [oldCol, newCol] of recordingRelationsRenames) {
        if (hasTable("RecordingRelations") && hasColumn("RecordingRelations", oldCol) && !hasColumn("RecordingRelations", newCol)) {
          db.exec(`ALTER TABLE RecordingRelations RENAME COLUMN ${oldCol} TO ${newCol}`);
        }
      }
    }
  },
  {
    version: 22,
    description: "Rename core MusicBrainz tables columns to snake_case",
    up: () => {
      // ArtistMetadata
      const artistMetadataRenames = [
        ["Id", "id"],
        ["ForeignArtistId", "foreign_artist_id"]
      ];
      for (const [oldCol, newCol] of artistMetadataRenames) {
        if (hasTable("ArtistMetadata") && hasColumn("ArtistMetadata", oldCol) && !hasColumn("ArtistMetadata", newCol)) {
          db.exec(`ALTER TABLE ArtistMetadata RENAME COLUMN ${oldCol} TO ${newCol}`);
        }
      }

      // Albums
      const albumsRenames = [
        ["Id", "id"],
        ["ForeignAlbumId", "foreign_album_id"],
        ["Monitored", "monitored"]
      ];
      for (const [oldCol, newCol] of albumsRenames) {
        if (hasTable("Albums") && hasColumn("Albums", oldCol) && !hasColumn("Albums", newCol)) {
          db.exec(`ALTER TABLE Albums RENAME COLUMN ${oldCol} TO ${newCol}`);
        }
      }

      // AlbumReleases
      const albumReleasesRenames = [
        ["Id", "id"],
        ["ForeignReleaseId", "foreign_release_id"],
        ["Monitored", "monitored"]
      ];
      for (const [oldCol, newCol] of albumReleasesRenames) {
        if (hasTable("AlbumReleases") && hasColumn("AlbumReleases", oldCol) && !hasColumn("AlbumReleases", newCol)) {
          db.exec(`ALTER TABLE AlbumReleases RENAME COLUMN ${oldCol} TO ${newCol}`);
        }
      }

      // Recordings
      const recordingsRenames = [
        ["Id", "id"],
        ["ForeignRecordingId", "foreign_recording_id"],
        ["ArtistMetadataId", "artist_metadata_id"],
        ["IsVideo", "is_video"],
        ["MetadataStatus", "metadata_status"],
        ["ReleaseDate", "release_date"],
        ["CoverImageId", "cover_image_id"],
        ["CoverImageUrl", "cover_image_url"],
        ["Monitored", "monitored"],
        ["MonitoredLock", "monitored_lock"],
        ["MonitoredAt", "monitored_at"],
        ["LockedAt", "locked_at"]
      ];
      for (const [oldCol, newCol] of recordingsRenames) {
        if (hasTable("Recordings") && hasColumn("Recordings", oldCol) && !hasColumn("Recordings", newCol)) {
          db.exec(`ALTER TABLE Recordings RENAME COLUMN ${oldCol} TO ${newCol}`);
        }
      }

      // Tracks
      const tracksRenames = [
        ["Id", "id"],
        ["ForeignTrackId", "foreign_track_id"],
        ["ForeignRecordingId", "foreign_recording_id"],
        ["Monitored", "monitored"]
      ];
      for (const [oldCol, newCol] of tracksRenames) {
        if (hasTable("Tracks") && hasColumn("Tracks", oldCol) && !hasColumn("Tracks", newCol)) {
          db.exec(`ALTER TABLE Tracks RENAME COLUMN ${oldCol} TO ${newCol}`);
        }
      }
    }
  },
  {
    version: 23,
    description: "TrackFiles canonical integer FKs (Lidarr-style: link files to Albums/AlbumReleases/Tracks/Recordings)",
    up: () => {
      // Additive step of the integer-FK linkage migration: add canonical integer
      // FK columns and backfill them from the canonical mbids + ProviderItems
      // (videos). Legacy media_id/album_id stay until the code is fully converted
      // off them (dropped in a later numbered migration).
      if (!hasTable("TrackFiles")) {
        return;
      }
      const addColumn = (name: string, ddl: string) => {
        if (!hasColumn("TrackFiles", name)) {
          db.exec(`ALTER TABLE TrackFiles ADD COLUMN ${ddl}`);
        }
      };
      addColumn("recording_id", "recording_id INTEGER REFERENCES Recordings(id) ON DELETE SET NULL");
      addColumn("track_id", "track_id INTEGER REFERENCES Tracks(id) ON DELETE SET NULL");
      addColumn("release_group_id", "release_group_id INTEGER REFERENCES Albums(id) ON DELETE SET NULL");
      addColumn("album_release_id", "album_release_id INTEGER REFERENCES AlbumReleases(id) ON DELETE SET NULL");

      // Backfill from the already-populated canonical mbids.
      db.exec(`
        UPDATE TrackFiles SET
          release_group_id = (SELECT id FROM Albums WHERE mbid = TrackFiles.canonical_release_group_mbid),
          album_release_id = (SELECT id FROM AlbumReleases WHERE mbid = TrackFiles.canonical_release_mbid),
          track_id = (SELECT id FROM Tracks WHERE mbid = TrackFiles.canonical_track_mbid),
          recording_id = (SELECT id FROM Recordings WHERE mbid = TrackFiles.canonical_recording_mbid)
        WHERE canonical_release_group_mbid IS NOT NULL
           OR canonical_release_mbid IS NOT NULL
           OR canonical_track_mbid IS NOT NULL
           OR canonical_recording_mbid IS NOT NULL
      `);

      // mbid-less provider videos: link recording_id via the video ProviderItems offer.
      if (hasTable("ProviderItems")) {
        db.exec(`
          UPDATE TrackFiles SET recording_id = (
            SELECT pi.recording_id FROM ProviderItems pi
            WHERE pi.entity_type = 'video'
              AND CAST(pi.provider_id AS TEXT) = CAST(TrackFiles.provider_id AS TEXT)
              AND pi.recording_id IS NOT NULL
            LIMIT 1
          )
          WHERE file_type = 'video' AND recording_id IS NULL AND provider_id IS NOT NULL
        `);
      }

      db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_recording_id ON TrackFiles(recording_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_track_id ON TrackFiles(track_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_release_group_id ON TrackFiles(release_group_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_album_release_id ON TrackFiles(album_release_id)`);
    }
  },
  {
    version: 24,
    description: "Canonical provider supplement fields for albums, releases, and recordings",
    up: () => {
      const addColumn = (table: string, name: string, ddl: string) => {
        if (hasTable(table) && !hasColumn(table, name)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
        }
      };

      addColumn("Albums", "cover_image_id", "cover_image_id TEXT");
      addColumn("Albums", "vibrant_color", "vibrant_color TEXT");
      addColumn("Albums", "video_cover", "video_cover TEXT");
      addColumn("Albums", "popularity", "popularity INT");
      addColumn("Albums", "review_text", "review_text TEXT");
      addColumn("Albums", "review_source", "review_source TEXT");
      addColumn("Albums", "review_last_updated", "review_last_updated DATETIME");

      addColumn("AlbumReleases", "copyright", "copyright TEXT");

      addColumn("Recordings", "copyright", "copyright TEXT");
      addColumn("Recordings", "popularity", "popularity INT");
      addColumn("Recordings", "credits", "credits TEXT");
    }
  },
  {
    version: 25,
    description: "TrackFiles canonical-FK populate-on-write triggers (derive integer FKs from mbids / video offer)",
    up: () => {
      ensureTrackFileForeignKeyTriggers();
    }
  },
  {
    version: 26,
    description: "Recordings replay_gain/peak supplement columns (provider-sourced audio normalization)",
    up: () => {
      if (hasTable("Recordings")) {
        if (!hasColumn("Recordings", "replay_gain")) {
          db.exec("ALTER TABLE Recordings ADD COLUMN replay_gain REAL");
        }
        if (!hasColumn("Recordings", "peak")) {
          db.exec("ALTER TABLE Recordings ADD COLUMN peak REAL");
        }
      }
    }
  },
  {
    version: 27,
    description: "Re-key upgrade_queue to provider resource identity",
    up: () => {
      ensureUpgradeQueueProviderIdentitySchema();
    }
  },
  {
    version: 28,
    description: "ProviderItems.provider_album_id (owning provider album link for track/video offers)",
    up: () => {
      // The column + index are created by ensureMusicBrainzProviderSchema (which
      // runs before migrations); this migration only backfills it. The backfill is
      // idempotent (fills NULLs from the scan's match_evidence.albumProviderId), so
      // it must run unconditionally — guarding on column-absence would skip it,
      // since ensure already added the column.
      if (hasTable("ProviderItems") && hasColumn("ProviderItems", "provider_album_id")) {
        db.exec(`
          UPDATE ProviderItems
          SET provider_album_id = json_extract(match_evidence, '$.albumProviderId')
          WHERE entity_type IN ('track', 'video')
            AND provider_album_id IS NULL
            AND json_valid(match_evidence)
            AND json_extract(match_evidence, '$.albumProviderId') IS NOT NULL
        `);
      }
    }
  },
  {
    version: 29,
    description: "Drop retired legacy provider catalog tables",
    up: () => {
      db.pragma("foreign_keys = OFF");
      try {
        db.exec(`
          DROP TABLE IF EXISTS ProviderMediaArtists;
          DROP TABLE IF EXISTS ProviderAlbumArtists;
          DROP TABLE IF EXISTS ProviderMedia;
          DROP TABLE IF EXISTS ProviderAlbums;
        `);
      } finally {
        db.pragma("foreign_keys = ON");
      }
    }
  }
];

/**
 * Production triggers that keep the TrackFiles catalog integer FKs
 * (release_group_id/album_release_id/track_id/recording_id) in sync with the
 * transitional MBID columns on every write — so newly imported/renamed files link
 * straight to the catalog graph without waiting for the housekeeping backfill. COALESCE
 * preserves any explicitly-set FK, and recording_id falls back to the video
 * ProviderItems offer for mbid-less provider videos. The trigger bodies update
 * only the FK columns (never the mbid/provider_id columns the AFTER UPDATE trigger
 * watches), so they cannot recurse even if recursive_triggers is ON.
 */
function ensureTrackFileForeignKeyTriggers(): void {
  if (!hasTable("TrackFiles") || !hasColumn("TrackFiles", "recording_id")) {
    return;
  }
  const body = `
    UPDATE TrackFiles SET
      release_group_id = COALESCE(release_group_id, (SELECT id FROM Albums WHERE mbid = NEW.canonical_release_group_mbid)),
      album_release_id = COALESCE(album_release_id, (SELECT id FROM AlbumReleases WHERE mbid = NEW.canonical_release_mbid)),
      track_id = COALESCE(track_id, (SELECT id FROM Tracks WHERE mbid = NEW.canonical_track_mbid)),
      recording_id = COALESCE(
        recording_id,
        (SELECT id FROM Recordings WHERE mbid = NEW.canonical_recording_mbid),
        (SELECT pi.recording_id FROM ProviderItems pi
           WHERE pi.entity_type = 'video'
             AND CAST(pi.provider_id AS TEXT) = CAST(NEW.provider_id AS TEXT)
             AND pi.recording_id IS NOT NULL
           LIMIT 1)
      )
    WHERE id = NEW.id;
  `;
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_trackfiles_canonical_fks_ai
    AFTER INSERT ON TrackFiles
    BEGIN ${body} END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_trackfiles_canonical_fks_au
    AFTER UPDATE OF canonical_release_group_mbid, canonical_release_mbid,
                    canonical_track_mbid, canonical_recording_mbid, provider_id
    ON TrackFiles
    BEGIN ${body} END;
  `);
}

function createUpgradeQueueProviderIdentityTable(tableName = "upgrade_queue"): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id TEXT,
      album_id TEXT,
      provider TEXT,
      entity_type TEXT,
      provider_id TEXT,
      album_provider_id TEXT,
      track_file_id INTEGER REFERENCES TrackFiles(id) ON DELETE SET NULL,
      current_quality TEXT NOT NULL,
      target_quality TEXT NOT NULL,
      reason TEXT,
      status TEXT DEFAULT 'pending',  -- pending, completed, skipped
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME,
      UNIQUE(provider, entity_type, provider_id),
      UNIQUE(media_id)
    )
  `);
}

function ensureUpgradeQueueProviderIdentitySchema(): void {
  if (!hasTable("upgrade_queue")) {
    createUpgradeQueueProviderIdentityTable();
    return;
  }

  if (hasColumn("upgrade_queue", "provider_id") && hasColumn("upgrade_queue", "entity_type")) {
    return;
  }

  db.pragma("foreign_keys = OFF");
  try {
    db.exec("DROP TABLE IF EXISTS upgrade_queue_legacy_v27");
    db.exec("ALTER TABLE upgrade_queue RENAME TO upgrade_queue_legacy_v27");
    createUpgradeQueueProviderIdentityTable();

    if (hasTable("ProviderMedia") && hasTable("ProviderAlbums")) {
      db.exec(`
        INSERT OR IGNORE INTO upgrade_queue (
          media_id, album_id, provider, entity_type, provider_id, album_provider_id,
          current_quality, target_quality, reason, status, created_at, processed_at
        )
        SELECT
          CAST(legacy.media_id AS TEXT),
          CAST(legacy.album_id AS TEXT),
          'tidal',
          CASE WHEN legacy_media.type = 'Music Video' THEN 'video' ELSE 'track' END,
          COALESCE(CAST(legacy_media.id AS TEXT), CAST(legacy.media_id AS TEXT)),
          COALESCE(CAST(legacy_album.id AS TEXT), CAST(legacy.album_id AS TEXT)),
          legacy.current_quality,
          legacy.target_quality,
          legacy.reason,
          legacy.status,
          legacy.created_at,
          legacy.processed_at
        FROM upgrade_queue_legacy_v27 legacy
        LEFT JOIN ProviderMedia legacy_media ON CAST(legacy_media.id AS TEXT) = CAST(legacy.media_id AS TEXT)
        LEFT JOIN ProviderAlbums legacy_album ON CAST(legacy_album.id AS TEXT) = CAST(legacy.album_id AS TEXT)
      `);
    } else {
      db.exec(`
        INSERT OR IGNORE INTO upgrade_queue (
          media_id, album_id, provider, entity_type, provider_id, album_provider_id,
          current_quality, target_quality, reason, status, created_at, processed_at
        )
        SELECT
          CAST(media_id AS TEXT),
          CAST(album_id AS TEXT),
          'tidal',
          'track',
          CAST(media_id AS TEXT),
          CAST(album_id AS TEXT),
          current_quality,
          target_quality,
          reason,
          status,
          created_at,
          processed_at
        FROM upgrade_queue_legacy_v27
      `);
    }

    db.exec("DROP TABLE IF EXISTS upgrade_queue_legacy_v27");
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function ensureMetadataIdentitySchema(): void {
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_id TEXT NOT NULL,
      album_id TEXT,
      track_file_id INTEGER,
      media_id TEXT,
      relative_path TEXT NOT NULL,
      file_path TEXT NOT NULL UNIQUE,
      library_root TEXT NOT NULL,
      extension TEXT NOT NULL,
      added DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      hash TEXT,
      consumer TEXT NOT NULL DEFAULT 'Discogenius',
      type TEXT NOT NULL,
      file_type TEXT NOT NULL,
      provider TEXT,
      provider_entity_type TEXT,
      provider_id TEXT,
      library_slot TEXT NOT NULL DEFAULT 'stereo',
      expected_path TEXT,
      needs_rename BOOLEAN NOT NULL DEFAULT 0,
      FOREIGN KEY(track_file_id) REFERENCES TrackFiles(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS LyricFiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_id TEXT NOT NULL,
      album_id TEXT,
      track_file_id INTEGER,
      media_id TEXT,
      relative_path TEXT NOT NULL,
      file_path TEXT NOT NULL UNIQUE,
      library_root TEXT NOT NULL,
      extension TEXT NOT NULL,
      added DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      provider TEXT,
      provider_entity_type TEXT,
      provider_id TEXT,
      library_slot TEXT NOT NULL DEFAULT 'stereo',
      quality TEXT,
      canonical_artist_mbid TEXT,
      canonical_release_group_mbid TEXT,
      canonical_release_mbid TEXT,
      canonical_track_mbid TEXT,
      canonical_recording_mbid TEXT,
      expected_path TEXT,
      needs_rename BOOLEAN NOT NULL DEFAULT 0,
      FOREIGN KEY(track_file_id) REFERENCES TrackFiles(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS ExtraFiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_id TEXT NOT NULL,
      album_id TEXT,
      track_file_id INTEGER,
      media_id TEXT,
      relative_path TEXT NOT NULL,
      file_path TEXT NOT NULL UNIQUE,
      library_root TEXT NOT NULL,
      extension TEXT NOT NULL,
      added DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      file_type TEXT NOT NULL,
      provider TEXT,
      provider_entity_type TEXT,
      provider_id TEXT,
      library_slot TEXT NOT NULL DEFAULT 'stereo',
      expected_path TEXT,
      needs_rename BOOLEAN NOT NULL DEFAULT 0,
      FOREIGN KEY(track_file_id) REFERENCES TrackFiles(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_metadata_files_artist ON MetadataFiles(artist_id, type);
    CREATE INDEX IF NOT EXISTS idx_metadata_files_album ON MetadataFiles(album_id, type);
    CREATE INDEX IF NOT EXISTS idx_metadata_files_file_type ON MetadataFiles(file_type);
    CREATE INDEX IF NOT EXISTS idx_metadata_files_track_file ON MetadataFiles(track_file_id);
    CREATE INDEX IF NOT EXISTS idx_metadata_files_media ON MetadataFiles(media_id, type);
    CREATE INDEX IF NOT EXISTS idx_metadata_files_provider ON MetadataFiles(provider, provider_entity_type, provider_id);
    CREATE INDEX IF NOT EXISTS idx_lyric_files_artist ON LyricFiles(artist_id);
    CREATE INDEX IF NOT EXISTS idx_lyric_files_track_file ON LyricFiles(track_file_id);
    CREATE INDEX IF NOT EXISTS idx_lyric_files_media ON LyricFiles(media_id, library_slot);
    CREATE INDEX IF NOT EXISTS idx_lyric_files_provider ON LyricFiles(provider, provider_entity_type, provider_id);
    CREATE INDEX IF NOT EXISTS idx_lyric_files_recording ON LyricFiles(canonical_recording_mbid);
    CREATE INDEX IF NOT EXISTS idx_extra_files_artist ON ExtraFiles(artist_id, file_type);
    CREATE INDEX IF NOT EXISTS idx_extra_files_track_file ON ExtraFiles(track_file_id);
    CREATE INDEX IF NOT EXISTS idx_extra_files_media ON ExtraFiles(media_id, file_type);
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS ArtistMetadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      foreign_artist_id TEXT UNIQUE,
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      foreign_album_id TEXT UNIQUE,
      mbid TEXT UNIQUE,
      artist_mbid TEXT NOT NULL,
      title TEXT NOT NULL,
      primary_type TEXT,
      secondary_types TEXT,
      first_release_date TEXT,
      cover_image_id TEXT,
      vibrant_color TEXT,
      video_cover TEXT,
      popularity INT,
      review_text TEXT,
      review_source TEXT,
      review_last_updated DATETIME,
      disambiguation TEXT,
      data TEXT,
      images TEXT,
      monitored BOOLEAN NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS AlbumReleases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      foreign_release_id TEXT UNIQUE,
      mbid TEXT UNIQUE,
      release_group_mbid TEXT NOT NULL,
      artist_mbid TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT,
      country TEXT,
      date TEXT,
      barcode TEXT,
      copyright TEXT,
      disambiguation TEXT,
      media_count INT,
      track_count INT,
      data TEXT,
      monitored BOOLEAN NOT NULL DEFAULT 0,
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      foreign_recording_id TEXT UNIQUE,
      mbid TEXT UNIQUE,
      artist_metadata_id INTEGER,
      artist_mbid TEXT,
      title TEXT NOT NULL,
      artist_credit TEXT,
      length_ms INT,
      replay_gain REAL,                 -- provider-sourced audio normalization (supplement)
      peak REAL,                        -- provider-sourced peak amplitude (supplement)
      is_video BOOLEAN NOT NULL DEFAULT 0,
      metadata_status TEXT NOT NULL DEFAULT 'musicbrainz',
      release_date DATETIME,
      cover_image_id TEXT,
      cover_image_url TEXT,
      copyright TEXT,
      popularity INT,
      credits TEXT,
      monitored BOOLEAN NOT NULL DEFAULT 0,
      monitored_lock BOOLEAN NOT NULL DEFAULT 0,
      monitored_at DATETIME,
      locked_at DATETIME,
      isrcs TEXT,
      data TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(artist_metadata_id) REFERENCES ArtistMetadata(id) ON DELETE SET NULL,
      FOREIGN KEY(artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS Tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      foreign_track_id TEXT UNIQUE,
      foreign_recording_id TEXT,
      mbid TEXT UNIQUE,
      release_mbid TEXT NOT NULL,
      recording_mbid TEXT NOT NULL,
      medium_position INT NOT NULL,
      position INT NOT NULL,
      number TEXT,
      title TEXT NOT NULL,
      length_ms INT,
      data TEXT,
      monitored BOOLEAN NOT NULL DEFAULT 0,
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
      provider_album_id TEXT,             -- owning provider album id for track/video offers (replaces ProviderMedia.album_id link)
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_recording_id INTEGER,
      target_recording_id INTEGER,
      source_foreign_recording_id TEXT,
      target_foreign_recording_id TEXT,
      relation_type TEXT NOT NULL,
      foreign_relation_type_id TEXT,
      source TEXT NOT NULL DEFAULT 'discogenius',
      confidence REAL,
      data TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_recording_id, target_recording_id, relation_type),
      UNIQUE(source_foreign_recording_id, target_foreign_recording_id, relation_type),
      FOREIGN KEY(source_recording_id) REFERENCES Recordings(id) ON DELETE CASCADE,
      FOREIGN KEY(target_recording_id) REFERENCES Recordings(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ReleaseGroupSlots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_mbid TEXT NOT NULL,
      release_group_mbid TEXT NOT NULL,
      slot TEXT NOT NULL,
      monitored BOOLEAN NOT NULL DEFAULT 0,
      selected_provider TEXT,
      selected_provider_id TEXT,
      selected_release_mbid TEXT,
      quality TEXT,
      match_status TEXT,
      match_confidence REAL,
      match_method TEXT,
      match_evidence TEXT,
      provider_data TEXT,
      monitored_lock BOOLEAN NOT NULL DEFAULT 0,
      locked_at DATETIME,
      checked_at DATETIME,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(release_group_mbid, slot),
      FOREIGN KEY(artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE,
      FOREIGN KEY(release_group_mbid) REFERENCES Albums(mbid) ON DELETE CASCADE,
      FOREIGN KEY(selected_release_mbid) REFERENCES AlbumReleases(mbid) ON DELETE SET NULL
    );

    -- Additive provider -> MusicBrainz match graph. Persists all candidate matches
    -- (multiple target_mbid rows per provider source) so the release-availability
    -- switcher can show every MB release a provider can supply. Lives alongside the
    -- existing ProviderItems offer cache; it does not replace it.
    CREATE TABLE IF NOT EXISTS ProviderMatches (
      provider TEXT NOT NULL,
      entity_type TEXT NOT NULL,          -- 'artist' | 'release' | 'recording'
      provider_id TEXT NOT NULL,
      provider_album_id TEXT,             -- owning provider album for recording matches
      target_mbid TEXT NOT NULL,
      target_kind TEXT NOT NULL,          -- mirrors entity_type
      status TEXT,                        -- candidate | probable | verified | manual | rejected
      confidence REAL,
      method TEXT,
      evidence TEXT,                      -- JSON
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (provider, entity_type, provider_id, target_mbid)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_matches_target ON ProviderMatches(target_mbid, entity_type);
    CREATE INDEX IF NOT EXISTS idx_provider_matches_source ON ProviderMatches(provider, entity_type, provider_id);
  `);

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
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_items_entity_track ON ProviderItems(entity_type, track_mbid)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_items_entity_recording ON ProviderItems(entity_type, recording_mbid)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_items_entity_release_group ON ProviderItems(entity_type, release_group_mbid, library_slot)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_items_upc ON ProviderItems(provider, upc)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_items_isrc ON ProviderItems(provider, isrc)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_items_match ON ProviderItems(provider, entity_type, match_status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_items_recording_id ON ProviderItems(recording_id)");
  // Defensive: this schema-ensure runs before runMigrations() on existing DBs, so
  // guarantee the v28 column exists before indexing it (fresh DBs already have it
  // from the base CREATE TABLE above; existing DBs get it here ahead of migration).
  if (!hasColumn("ProviderItems", "provider_album_id")) {
    db.exec("ALTER TABLE ProviderItems ADD COLUMN provider_album_id TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_items_provider_album ON ProviderItems(provider_album_id, entity_type)");
  // The download-queue list resolves each item's metadata by provider_id (N+1
  // lookups in DownloadQueueQueryService). Every other ProviderItems index leads
  // with `provider` (the provider *name*), so a `WHERE provider_id = ?` lookup
  // full-scanned the table per queue item — the ~15s GET /api/v1/queue. Index it.
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_items_provider_id ON ProviderItems(provider_id, entity_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_recording_relations_source ON RecordingRelations(source_recording_id, relation_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_recording_relations_target ON RecordingRelations(target_recording_id, relation_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_recording_relations_foreign_source ON RecordingRelations(source_foreign_recording_id, relation_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_recording_relations_foreign_target ON RecordingRelations(target_foreign_recording_id, relation_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_release_group_slots_artist ON ReleaseGroupSlots(artist_mbid, slot)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_release_group_slots_provider ON ReleaseGroupSlots(selected_provider, selected_provider_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_release_group_slots_group_release_slot ON ReleaseGroupSlots(release_group_mbid, selected_release_mbid, slot)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_track_files_canonical_track_type ON TrackFiles(canonical_track_mbid, file_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_track_files_canonical_recording_type ON TrackFiles(canonical_recording_mbid, file_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_track_files_recording_id ON TrackFiles(recording_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_track_files_track_id ON TrackFiles(track_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_track_files_release_group_id ON TrackFiles(release_group_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_track_files_album_release_id ON TrackFiles(album_release_id)");
  // Recordings is large on real libraries (one row per MusicBrainz recording —
  // ~280k on a 2.3k-artist library). Artist-completion, download-stats and the
  // video counts filter Recordings by artist on every library + dashboard load;
  // without these the planner full-scans Recordings per artist, which turned
  // /api/stats into a ~38s synchronous event-loop stall (cascading into
  // app-wide "request timed out" errors). Indexed, that path drops to ~1s.
  db.exec("CREATE INDEX IF NOT EXISTS idx_recordings_artist_mbid ON Recordings(artist_mbid, is_video)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_recordings_artist_metadata ON Recordings(artist_metadata_id, is_video)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_recordings_video ON Recordings(is_video) WHERE is_video = 1");
  // (Tracks.recording_mbid is already indexed by idx_mb_tracks_recording_mbid in
  // initDatabase — no separate index needed here.)
}

type MigrationRunSummary = {
  fromVersion: number;
  toVersion: number;
  appliedDescriptions: string[];
};

function runMigrations(): MigrationRunSummary {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  const appliedDescriptions: string[] = [];

  let normalizedVersion = currentVersion;
  if (normalizedVersion === 0) {
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
      library_origin TEXT NOT NULL DEFAULT 'user',
      
      -- Biography
      bio_text TEXT,                   -- Full biography text
      bio_source TEXT,                 -- Source of biography
      bio_last_updated DATETIME,       -- When biography was last updated

      -- Monitoring & Lock Mechanism
      monitored BOOLEAN DEFAULT 0,       -- whether to scan, filter, and download releases from this artist, and monitor them for new releases
      monitored_at DATETIME,           -- when monitoring was enabled
      last_scanned DATETIME,           -- last time this artist was scanned for new releases
      downloaded INT DEFAULT 0         -- number between 0 and 100 representing percentage of artist's monitored media downloaded
    )
  `);

  // ====================================================================
  // TRACKFILES TABLE (Local file tracking; Lidarr-aligned file inventory)
  // ====================================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS TrackFiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, -- Internal file ID
      
      -- Linkage
      artist_id TEXT NOT NULL,           -- Managed artist id
      album_id TEXT,                     -- Legacy provider album shadow id; prefer provider_id/provider_album_id + catalog FKs
      media_id TEXT,                     -- Legacy provider media shadow id; prefer provider_id + catalog FKs

      -- Transitional MBID identity (migration debt; prefer integer FKs below)
      canonical_artist_mbid TEXT,
      canonical_release_group_mbid TEXT,
      canonical_release_mbid TEXT,
      canonical_track_mbid TEXT,
      canonical_recording_mbid TEXT,

      -- Catalog integer FKs (Lidarr-style: files link straight to catalog rows;
      -- recording_id covers mbid-less provider videos too)
      release_group_id INTEGER REFERENCES Albums(id) ON DELETE SET NULL,
      album_release_id INTEGER REFERENCES AlbumReleases(id) ON DELETE SET NULL,
      track_id INTEGER REFERENCES Tracks(id) ON DELETE SET NULL,
      recording_id INTEGER REFERENCES Recordings(id) ON DELETE SET NULL,

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
      
      FOREIGN KEY(artist_id) REFERENCES Artists(id) ON DELETE CASCADE
    )
  `);

  db.exec(`DROP TRIGGER IF EXISTS trg_track_files_download_state_insert`);
  db.exec(`DROP TRIGGER IF EXISTS trg_track_files_download_state_delete`);
  db.exec(`DROP TRIGGER IF EXISTS trg_track_files_download_state_update`);

  ensureMetadataIdentitySchema();
  ensureMusicBrainzProviderSchema();
  ensureExtraFileSchema();
  ensureMediaCoverProxyCacheSchema();
  ensureTrackFileForeignKeyTriggers();

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
  createUpgradeQueueProviderIdentityTable();
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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_monitored ON Artists(monitored)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_name ON Artists(name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_popularity ON Artists(popularity)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_last_scanned ON Artists(last_scanned)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_user_date_added ON Artists(user_date_added)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_mbid ON Artists(mbid)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_musicbrainz_status ON Artists(musicbrainz_status)`);

  db.exec(`DROP INDEX IF EXISTS idx_albums_downloaded`);
  db.exec(`DROP INDEX IF EXISTS idx_media_downloaded`);

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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_upgrade_queue_provider_resource ON upgrade_queue(provider, entity_type, provider_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_upgrade_queue_album_provider ON upgrade_queue(provider, album_provider_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_upgrade_queue_track_file ON upgrade_queue(track_file_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_upgrade_queue_status ON upgrade_queue(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_upgrade_queue_target_quality ON upgrade_queue(target_quality)`);

  // Foreign key and lookup performance indexes
  db.exec("CREATE INDEX IF NOT EXISTS idx_mb_releases_artist_mbid ON AlbumReleases(artist_mbid)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_mb_tracks_recording_mbid ON Tracks(recording_mbid)");
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

    // Quality profiles define what to MONITOR, not what the downloader fetches.
    // TIDAL only reports LOSSLESS and HIRES_LOSSLESS as quality metadata.
    // When the user wants lossy AAC we still monitor LOSSLESS; tiddl picks the
    // delivery tier from its track_quality setting.

    // Max Quality - monitors HIRES_LOSSLESS, upgrades from LOSSLESS to HIRES_LOSSLESS
    // Pair with audio_quality=max to get 24-bit Hi-Res files
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
    // Pair with audio_quality=high to get 16-bit FLAC files
    db.prepare(`
      INSERT INTO quality_profiles (name, upgrade_allowed, cutoff, items)
      VALUES (?, ?, ?, ?)
    `).run(
      "High Quality",
      1,
      "LOSSLESS",
      JSON.stringify(["LOSSLESS"])
    );

    // Normal Quality - monitors LOSSLESS, downloads 320kbps AAC
    // Pair with audio_quality=normal
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
