import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DB_PATH } from "./services/config.js";
import { getCurrentAppReleaseInfo } from "./services/app-release.js";

console.log(`📁 Database path: ${DB_PATH}`);

export const db = new Database(DB_PATH);

const journalMode = "WAL";

// Keep SQLite in WAL mode across environments for better concurrent read/write behavior.
db.pragma(`journal_mode = ${journalMode}`);

// Wait up to 5 seconds for locks before returning BUSY error
// This prevents "database is locked" errors during concurrent access
db.pragma("busy_timeout = 5000");

db.pragma("synchronous = NORMAL");

// Increase cache size for better read performance (negative = KB, -512000 = 512MB)
db.pragma("cache_size = -512000");

// Enable foreign key enforcement
db.pragma("foreign_keys = ON");

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

export function backfillArtistPaths(resolveFolder: (name: string, mbid?: string | null) => string): number {
  const artists = db.prepare("SELECT id, name, mbid FROM artists WHERE path IS NULL").all() as Array<{ id: number; name: string; mbid: string | null }>;
  if (artists.length === 0) return 0;

  const update = db.prepare("UPDATE artists SET path = ? WHERE id = ? AND path IS NULL");
  const tx = db.transaction(() => {
    for (const artist of artists) {
      update.run(resolveFolder(artist.name, artist.mbid), artist.id);
    }
  });
  tx();
  return artists.length;
}

const BASE_SCHEMA_VERSION = 1;
const LEGACY_SEMVER_BASELINE_VERSION = 10000;
const SCHEMA_VERSION_FORMAT_KEY = "runtime.schema_version_format";
const INTEGER_SCHEMA_VERSION_FORMAT = "integer";

// ====================================================================
// SCHEMA MIGRATIONS
// Discogenius 1.0.x resets the schema baseline so SQLite `user_version`
// tracks an independent integer schema series starting at `1`.
//
// The legacy numbered migrations remain so older local databases can still
// be lifted to the current schema before the baseline is normalized.
// Future schema migrations should increment the integer schema version.
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

function getConfigValue(key: string): string | undefined {
  if (!tableExists("config")) {
    return undefined;
  }

  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as { value?: string } | undefined;
  return row?.value;
}

function ensureUnmappedFilesAudioMetadataColumns() {
  if (!tableExists("unmapped_files")) {
    return;
  }

  const cols = db.prepare("PRAGMA table_info(unmapped_files)").all() as Array<{ name: string }>;
  const existing = new Set(cols.map((c) => c.name));
  const toAdd = [
    { name: "bitrate", sql: "ALTER TABLE unmapped_files ADD COLUMN bitrate INT" },
    { name: "sample_rate", sql: "ALTER TABLE unmapped_files ADD COLUMN sample_rate INT" },
    { name: "bit_depth", sql: "ALTER TABLE unmapped_files ADD COLUMN bit_depth INT" },
    { name: "channels", sql: "ALTER TABLE unmapped_files ADD COLUMN channels INT" },
    { name: "codec", sql: "ALTER TABLE unmapped_files ADD COLUMN codec TEXT" },
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
            FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE,
            FOREIGN KEY(album_id) REFERENCES albums(id) ON DELETE CASCADE
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
      if (!tableExists("albums")) {
        return;
      }

      const cols = db.prepare("PRAGMA table_info(albums)").all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === "mb_release_group_id")) return;
      db.exec("ALTER TABLE albums ADD COLUMN mb_release_group_id TEXT");
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
          artist_id INT,
          album_id INT,
          media_id INT,
          library_file_id INT,
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
    description: "migrate playlist_tracks primary key to playlist position and add playlist track lookup index",
    up: () => {
      if (!tableExists("playlist_tracks")) {
        return;
      }

      const columns = db.prepare("PRAGMA table_info(playlist_tracks)").all() as Array<{
        name: string;
        notnull: number;
        pk: number;
      }>;

      const primaryKey = columns
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name);
      const positionColumn = columns.find((column) => column.name === "position");

      const hasDesiredSchema =
        primaryKey.length === 2
        && primaryKey[0] === "playlist_uuid"
        && primaryKey[1] === "position"
        && positionColumn?.notnull === 1;

      if (hasDesiredSchema) {
        db.exec("CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_uuid_track_id ON playlist_tracks(playlist_uuid, track_id)");
        return;
      }

      db.pragma("foreign_keys = OFF");
      try {
        db.exec("BEGIN");
        db.exec(`
          ALTER TABLE playlist_tracks RENAME TO playlist_tracks_legacy;

          CREATE TABLE playlist_tracks (
            playlist_uuid TEXT NOT NULL,
            track_id INTEGER NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (playlist_uuid, position),
            FOREIGN KEY (playlist_uuid) REFERENCES playlists(uuid) ON DELETE CASCADE,
            FOREIGN KEY (track_id) REFERENCES media(id) ON DELETE CASCADE
          );

          INSERT INTO playlist_tracks (playlist_uuid, track_id, position)
          WITH ranked_tracks AS (
            SELECT
              playlist_uuid,
              track_id,
              ROW_NUMBER() OVER (
                PARTITION BY playlist_uuid
                ORDER BY
                  CASE WHEN position IS NULL THEN 1 ELSE 0 END,
                  position,
                  rowid
              ) - 1 AS normalized_position
            FROM playlist_tracks_legacy
          )
          SELECT playlist_uuid, track_id, normalized_position
          FROM ranked_tracks;

          DROP TABLE playlist_tracks_legacy;
        `);
        db.exec("CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_uuid_track_id ON playlist_tracks(playlist_uuid, track_id)");
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
    // 7
    description: "normalize legacy HI_RES_LOSSLESS quality values to HIRES_LOSSLESS",
    up: () => {
      const qualityColumns: Array<{ table: string; column: string }> = [
        { table: "albums", column: "quality" },
        { table: "media", column: "quality" },
        { table: "library_files", column: "quality" },
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
        ON media_artists(artist_id, type, media_id)
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
      if (!columnExists("artists", "path")) {
        db.exec("ALTER TABLE artists ADD COLUMN path TEXT");
      }
    },
  },
];

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
    && (tableHasRows("artists") || tableHasRows("albums") || tableHasRows("media") || tableHasRows("library_files"));

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
    CREATE TABLE IF NOT EXISTS artists (
      id INT PRIMARY KEY,              -- TIDAL artist id
      name TEXT NOT NULL,              -- Artist name
      picture TEXT,                    -- Artist picture UUID
      popularity INT,                  -- TIDAL popularity score
      artist_types TEXT,               -- JSON array: ["ARTIST", "CONTRIBUTOR", ...ETC]
      artist_roles TEXT,               -- JSON array: [{"categoryId": -1, "category": "Artist"}, {"categoryId": 2, "category": "Songwriter"}, ...ETC]
      user_date_added DATETIME,        -- When added to TIDAL favorites
      mbid TEXT,                       -- MusicBrainz ID
      path TEXT,                       -- Resolved library folder path (set at add/import time)
      
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
    CREATE TABLE IF NOT EXISTS albums (
      id INT PRIMARY KEY,                -- TIDAL album id
      artist_id INT NOT NULL,            -- Main artist id
      title TEXT NOT NULL,               -- Album title
      version TEXT,                      -- Album version (Deluxe, Remastered, etc)
      release_date DATETIME,             -- Original release date
      type TEXT NOT NULL,                -- Main release type: ALBUM/EP/SINGLE
      explicit BOOLEAN NOT NULL,         -- Whether album is explicit or clean
      quality TEXT NOT NULL,             -- retrieved from media_metadata_tag, e.g. "LOSSLESS", "HIRES_LOSSLESS", or "DOLBY_ATMOS"
      user_date_added DATETIME,          -- When added to TIDAL favorites

      -- Media
      cover TEXT,                        -- Album cover UUID
      vibrant_color TEXT,                -- Hex color code of dominant cover color
      video_cover TEXT,                  -- animated cover UUID
      
      -- Counts
      num_tracks INT NOT NULL,           -- Number of tracks
      num_volumes INT NOT NULL,          -- Number of volumes
      num_videos INT NOT NULL,           -- Number of videos
      duration INT NOT NULL,             -- Total duration in seconds
      popularity INT,                    -- TIDAL popularity score
      
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

      FOREIGN KEY(artist_id) REFERENCES artists(id) ON DELETE CASCADE
    )
  `);

  // ====================================================================
  // MEDIA TABLE  
  // ====================================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS media (
      id INT PRIMARY KEY,               -- TIDAL track or video id
      artist_id INT NOT NULL,           -- Main artist id
      album_id INT,                     -- Album id (if applicable)
      title TEXT NOT NULL,              -- Track or video title
      version TEXT,                     -- version specifier (Remastered, etc)
      release_date DATETIME,            -- Original release date
      type TEXT NOT NULL,               -- Main release type: ALBUM/EP/SINGLE/Music Video
      explicit BOOLEAN NOT NULL,        -- Whether track is explicit or clean
      quality TEXT NOT NULL,            -- retrieved from media_metadata_tag, e.g. "LOSSLESS", "HIRES_LOSSLESS", or "DOLBY_ATMOS"
      user_date_added DATETIME,         -- When added to TIDAL favorites

      -- Media
      cover TEXT,                       -- Cover UUID (video thumbnail; optional for tracks)

      -- Positioning
      track_number INT,                 -- Track number on album
      volume_number INT,                -- Volume number on album
      duration INT,                     -- Duration in seconds
      popularity INT,                   -- TIDAL popularity score
      
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
      
      -- Monitoring & Filtering
      monitor BOOLEAN DEFAULT 0,        -- whether to scan and download this track, and monitor it for changes
      monitored_at DATETIME,            -- when monitoring was enabled
      monitor_lock BOOLEAN DEFAULT 0,   -- whether monitoring is locked (allowed to be changed during automated scanning/filtering)
      locked_at DATETIME,               -- when lock was enabled
      last_scanned DATETIME,            -- last time this track was scanned for changes
      downloaded BOOLEAN,               -- whether this track has been downloaded
      redundant TEXT,                   -- If redundant, points to the id of the better version
      
      FOREIGN KEY(artist_id) REFERENCES artists(id) ON DELETE CASCADE,
      FOREIGN KEY(album_id) REFERENCES albums(id) ON DELETE CASCADE
    )
  `);

  // ====================================================================
  // NORMALIZED METADATA TABLES
  // ====================================================================

  // Album artists relationship
  db.exec(`
    CREATE TABLE IF NOT EXISTS album_artists (
      album_id INT NOT NULL,             -- TIDAL album id  
      artist_id INT NOT NULL,            -- TIDAL artist id
      artist_name TEXT,                  -- Cached artist name (for fast UI rendering)
      ord INT,                           -- Ordering of artists on the release
      type TEXT NOT NULL,                -- contribution type
      group_type TEXT,                   -- retrieved from endpoint ALBUMS, EPSANDSINGLES, or COMPILATIONS
      version_group_id INT,              -- Group id for related album versions (explicit/clean, qualities)
      version_group_name TEXT,           -- Group name for related album versions ("Album Name")
      module TEXT,                       -- derived from release type and page module ALBUM, EP, SINGLE, COMPILATIONS, LIVE, REMIX, APPEARS_ON
      PRIMARY KEY (artist_id, album_id),
      FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE,
      FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
    )
  `);

  // Media artist relationship
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_artists (
      media_id INT NOT NULL,             -- TIDAL track or video id
      artist_id INT NOT NULL,            -- TIDAL artist id
      type TEXT NOT NULL,                -- contribution type
      PRIMARY KEY (media_id, artist_id),
      FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE,
      FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE
    )
  `);

  // ====================================================================
  // SIMILAR ENTITIES JUNCTION TABLES
  // ====================================================================

  // Similar artists relationship (junction table)
  db.exec(`
    CREATE TABLE IF NOT EXISTS similar_artists (
      artist_id INT NOT NULL,              -- Source artist
      similar_artist_id INT NOT NULL,      -- Similar artist
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (artist_id, similar_artist_id),
      FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE,
      FOREIGN KEY (similar_artist_id) REFERENCES artists(id) ON DELETE CASCADE
    )
  `);

  // Similar albums relationship (junction table)
  db.exec(`
    CREATE TABLE IF NOT EXISTS similar_albums (
      album_id INT NOT NULL,               -- Source album
      similar_album_id INT NOT NULL,       -- Similar album
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (album_id, similar_album_id),
      FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE,
      FOREIGN KEY (similar_album_id) REFERENCES albums(id) ON DELETE CASCADE
    )
  `);

  // ====================================================================
  // LIBRARY FILES TABLE (Local File Tracking)
  // ====================================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, -- Internal file ID
      
      -- Linkage (at least artist_id required, then either media_id for tracks/videos)
      artist_id INT NOT NULL,            -- TIDAL artist id (always required)
      album_id INT,                      -- TIDAL album id (for tracks)
      media_id INT,                      -- TIDAL track or video id (links to media table)
      
      -- File Location
      file_path TEXT NOT NULL UNIQUE,    -- Absolute path to the file in library
      relative_path TEXT NOT NULL,       -- Path relative to library root (for portability)
      library_root TEXT NOT NULL,        -- Which library: music, spatial_music, music_videos
      
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
      file_type TEXT NOT NULL,           -- track, video, cover, video_cover, video_thumbnail, bio, review, lyrics, playlist
      quality TEXT,                      -- LOSSLESS, HIRES_LOSSLESS, DOLBY_ATMOS, etc
      
      -- Naming & Organization
      naming_template TEXT,              -- Template used when file was created
      expected_path TEXT,                -- Path the file should have based on current naming template
      needs_rename BOOLEAN DEFAULT 0,    -- Flag if file_path != expected_path
      
      -- Import & Source Data
      original_filename TEXT,            -- Original filename before rename/import (Scene Name)
      release_group TEXT,                -- Release group extracted from original filename
      fingerprint TEXT,                  -- AcoustID/Chromaprint fingerprint for audio matching

      
      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,               -- When file record was created
      modified_at DATETIME,              -- File system modified time
      verified_at DATETIME,              -- Last time file existence was verified
      
      FOREIGN KEY(artist_id) REFERENCES artists(id) ON DELETE CASCADE,
      FOREIGN KEY(album_id) REFERENCES albums(id) ON DELETE SET NULL,
      FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE SET NULL
    )
  `);

  db.exec(`DROP TRIGGER IF EXISTS trg_library_files_download_state_insert`);
  db.exec(`DROP TRIGGER IF EXISTS trg_library_files_download_state_delete`);
  db.exec(`DROP TRIGGER IF EXISTS trg_library_files_download_state_update`);

  // ====================================================================
  // UNMAPPED FILES TABLE (Local Files not mapped to TIDAL)
  // ====================================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS unmapped_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      
      file_path TEXT NOT NULL UNIQUE,    -- Absolute path to the file
      relative_path TEXT NOT NULL,       -- Path relative to library root
      library_root TEXT NOT NULL,        -- Which library: music, spatial_music, music_videos
      
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
      reason TEXT,                       -- "No matching TIDAL track", "Ignored by user", etc.
      
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
      FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE,
      FOREIGN KEY(album_id) REFERENCES albums(id) ON DELETE CASCADE
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
      artist_id INT,
      album_id INT,
      media_id INT,
      library_file_id INT,
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
  // PROVIDER IDS TABLE
  // Maps TIDAL-primary entities to IDs from other providers/sources.
  // entity_type: 'artist' | 'album' | 'media'
  // entity_id: references artists.id / albums.id / media.id (TIDAL IDs for now)
  // provider: 'tidal' | 'spotify' | 'apple' | 'musicbrainz' | 'discogs' | 'deezer'
  // external_id: the provider's own identifier for this entity
  //
  // For albums, join on mb_release_group_id to group format variants (16-bit,
  // 24-bit, Atmos) that share the same abstract album across providers.
  // For media, ISRC on the media table is already the canonical cross-provider key.
  // ====================================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_ids (
      entity_type TEXT NOT NULL,
      entity_id   INT  NOT NULL,
      provider    TEXT NOT NULL,
      external_id TEXT NOT NULL,
      fetched_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (entity_type, entity_id, provider)
    )
  `);

  // ====================================================================
  // INDEXES
  // ====================================================================
  // PLAYLISTS TABLE
  // Stores TIDAL playlists that have been added for monitoring/download.
  // ====================================================================
  db.exec(`
      CREATE TABLE IF NOT EXISTS playlists (
        uuid TEXT PRIMARY KEY,
        tidal_id TEXT UNIQUE,
        title TEXT NOT NULL,
        description TEXT,
        creator_name TEXT,
        creator_id TEXT,
        cover_id TEXT,
        square_cover_id TEXT,
        num_tracks INTEGER DEFAULT 0,
        num_videos INTEGER DEFAULT 0,
        duration INTEGER DEFAULT 0,
        created TEXT,
        last_updated TEXT,
        type TEXT DEFAULT 'PLAYLIST',
        public_playlist INTEGER DEFAULT 0,
        monitored INTEGER DEFAULT 0,
        downloaded INTEGER DEFAULT 0,
        user_date_added DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_scanned DATETIME
      )
    `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS playlist_tracks (
        playlist_uuid TEXT NOT NULL,
        track_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (playlist_uuid, position),
        FOREIGN KEY (playlist_uuid) REFERENCES playlists(uuid) ON DELETE CASCADE,
        FOREIGN KEY (track_id) REFERENCES media(id) ON DELETE CASCADE
      )
    `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_uuid_track_id ON playlist_tracks(playlist_uuid, track_id)`);

  // ====================================================================
  // MIGRATIONS — must run before indexes so migration-added columns exist
  // ====================================================================
  // Integrity check
  const integrityResult = db.pragma("integrity_check", { simple: true }) as string;
  if (integrityResult !== "ok") {
    console.error(`🚨 Database integrity check failed: ${integrityResult}`);
    console.error("   The database may be corrupted. Consider restoring from a backup.");
  }

  // Pre-migration backup for safety
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  if (currentVersion > 0 && fs.existsSync(DB_PATH)) {
    const backupPath = `${DB_PATH}.pre-migration-v${currentVersion}.bak`;
    if (!fs.existsSync(backupPath)) {
      try {
        fs.copyFileSync(DB_PATH, backupPath);
        console.log(`📦 Database backup created: ${path.basename(backupPath)}`);
      } catch (err) {
        console.warn(`⚠️  Could not create pre-migration backup: ${(err as Error).message}`);
      }
    }
  }

  const migrationSummary = runMigrations();

  // ====================================================================
  // INDEXES
  // ====================================================================
  // Artist indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_monitor ON artists(monitor)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_name ON artists(name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_popularity ON artists(popularity)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_last_scanned ON artists(last_scanned)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_user_date_added ON artists(user_date_added)`);

  // Album indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_albums_artist_id ON albums(artist_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_albums_monitor ON albums(monitor)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_albums_monitor_lock ON albums(monitor_lock)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_albums_type ON albums(type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_albums_quality ON albums(quality)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_albums_release_date ON albums(release_date)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_albums_title ON albums(title)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_albums_mb_release_group ON albums(mb_release_group_id)`);
  db.exec(`DROP INDEX IF EXISTS idx_albums_downloaded`);

  // Album artists indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_album_artists_version_group ON album_artists(version_group_id)`);

  // Similar entities indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_similar_artists_source ON similar_artists(artist_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_similar_artists_target ON similar_artists(similar_artist_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_similar_albums_source ON similar_albums(album_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_similar_albums_target ON similar_albums(similar_album_id)`);

  // Media indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_artist_id ON media(artist_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_album_id ON media(album_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_isrc ON media(isrc)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_monitor ON media(monitor)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_monitor_lock ON media(monitor_lock)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_quality ON media(quality)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_type ON media(type)`);
  db.exec(`DROP INDEX IF EXISTS idx_media_downloaded`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_title ON media(title)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_release_date ON media(release_date)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_last_scanned ON media(last_scanned)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_artists_artist_type_media ON media_artists(artist_id, type, media_id)`);

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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_poll ON job_queue(status, priority DESC, trigger DESC, queue_order ASC, created_at ASC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(enabled)`);

  // Library file indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_library_files_artist_id ON library_files(artist_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_library_files_album_id ON library_files(album_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_library_files_media_id ON library_files(media_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_library_files_file_type ON library_files(file_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_library_files_library_root ON library_files(library_root)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_library_files_needs_rename ON library_files(needs_rename)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_library_files_quality ON library_files(quality)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_library_files_path ON library_files(file_path)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_library_files_fingerprint ON library_files(fingerprint)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_library_files_media_id_file_type ON library_files(media_id, file_type)`);

  // Quality profiles indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_quality_profiles_name ON quality_profiles(name)`);

  // Provider IDs indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_provider_ids_entity ON provider_ids(entity_type, entity_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_provider_ids_provider ON provider_ids(provider, external_id)`);

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
