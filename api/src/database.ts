import Database from "better-sqlite3";
import { isMainThread } from "node:worker_threads";
import { DB_PATH } from "./services/config/config.js";
import { getCurrentAppReleaseInfo } from "./services/config/app-release.js";

let _db: Database.Database | null = null;

const SQLITE_BUSY_RETRY_BASE_MS = 50;
const SQLITE_BUSY_RETRY_MAX_MS = 2000;
// SQLite serialises writers. Under multithreaded execution (worker pool + main
// thread) write-lock contention is expected, so connections must WAIT rather
// than error: a busy_timeout long enough to ride out a peer's write transaction
// plus a JS-level retry backstop. If a write throws SQLITE_BUSY uncaught,
// better-sqlite3 can hard-abort the process (v8::ToLocalChecked) — so every
// write must go through the retry.
//
// The crucial asymmetry: worker threads run OFF the HTTP/SSE event loop, so they
// can afford to block — a generous timeout + many retries means heavy refresh
// writes wait their turn instead of erroring. The MAIN thread *is* the event
// loop, and better-sqlite3 is synchronous, so any wait here freezes every HTTP
// request, SSE stream, and /health probe for its full duration. Lidarr keeps a
// 100ms busy_timeout on its (multi-threaded, pooled) request path for exactly
// this reason. We keep the main thread's timeout small and its retry to a single
// quick attempt so a contended main-thread write (chiefly the markProcessing
// job-claim, occasionally a route write) fails fast and is retried at the next
// scheduler tick — never freezing the server for tens of seconds.
const MAIN_THREAD_BUSY_TIMEOUT_MS = 1000;
const WORKER_THREAD_BUSY_TIMEOUT_MS = 30000;
const SQLITE_BUSY_RETRY_ATTEMPTS = isMainThread ? 1 : 8;

function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT" || code === "SQLITE_LOCKED") {
    return true;
  }
  const message = (error as { message?: string }).message;
  return typeof message === "string" && /database( table)? is locked/i.test(message);
}

function sleepSync(ms: number): void {
  // Allowed on the Node main thread (unlike browsers). Keeps the retry backoff
  // synchronous so better-sqlite3's synchronous API is preserved.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run a synchronous DB operation, retrying on SQLITE_BUSY/LOCKED with capped
 * exponential backoff. Applied on both the main thread and worker threads so a
 * lost write-lock race never escapes as an uncaught (process-aborting) error.
 */
export function runWithSqliteBusyRetry<T>(operation: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt <= SQLITE_BUSY_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusy(error) || attempt >= SQLITE_BUSY_RETRY_ATTEMPTS) {
        throw error;
      }

      lastError = error;
      const delayMs = Math.min(SQLITE_BUSY_RETRY_MAX_MS, SQLITE_BUSY_RETRY_BASE_MS * (2 ** attempt))
        + Math.floor(Math.random() * SQLITE_BUSY_RETRY_BASE_MS);
      sleepSync(delayMs);
    }
  }

  throw lastError;
}

function getDbInstance(): Database.Database {
  if (_db) return _db;

  try {
    console.log(`📁 Database path: ${DB_PATH}`);
    const busyTimeoutMs = isMainThread ? MAIN_THREAD_BUSY_TIMEOUT_MS : WORKER_THREAD_BUSY_TIMEOUT_MS;
    _db = new Database(DB_PATH, { timeout: busyTimeoutMs });
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
  _db.pragma(`busy_timeout = ${isMainThread ? MAIN_THREAD_BUSY_TIMEOUT_MS : WORKER_THREAD_BUSY_TIMEOUT_MS}`);
  _db.pragma("synchronous = NORMAL");
  _db.pragma("cache_size = -512000");
  _db.pragma("foreign_keys = ON");
  // Bound the WAL on disk: without a size limit a write storm (worker pool +
  // main) grows the WAL into the hundreds of MB, and every reader then has to
  // traverse it — turning the library list into a multi-second read. Cap the
  // file so it's truncated back down after each checkpoint, and checkpoint a bit
  // more eagerly than the 1000-frame default.
  _db.pragma("journal_size_limit = 67108864"); // 64 MB
  _db.pragma("wal_autocheckpoint = 400");

  return _db;
}

export const db = new Proxy({} as any, {
  get(target, prop, receiver) {
    const instance = getDbInstance();
    if (prop === "prepare") {
      // Wrap every prepared statement's write path (.run) in busy-retry so a
      // lost write-lock race never aborts the process. Reads (.get/.all) don't
      // take the write lock under WAL, so they're left untouched.
      return (source: string) => {
        const stmt = instance.prepare(source);
        const originalRun = stmt.run.bind(stmt);
        stmt.run = ((...args: unknown[]) => runWithSqliteBusyRetry(() => originalRun(...args))) as typeof stmt.run;
        return stmt;
      };
    }
    if (prop === "exec") {
      return (source: string) => runWithSqliteBusyRetry(() => instance.exec(source));
    }
    if (prop === "transaction") {
      return (fn: any) => {
        const txn = instance.transaction(fn) as any;
        const runImmediate = (...args: any[]) => runWithSqliteBusyRetry(() => txn.immediate(...args));
        const runDeferred = (...args: any[]) => runWithSqliteBusyRetry(() => txn.deferred(...args));
        const runDefault = (...args: any[]) => runWithSqliteBusyRetry(() => txn.default(...args));
        const runExclusive = (...args: any[]) => runWithSqliteBusyRetry(() => txn.exclusive(...args));
        const immediateTxn = (...args: any[]) => runImmediate(...args);
        Object.defineProperties(immediateTxn, {
          default: { value: runDefault },
          deferred: { value: runDeferred },
          immediate: { value: runImmediate },
          exclusive: { value: runExclusive },
          database: { value: txn.database },
        });
        return immediateTxn;
      };
    }
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
 * Run `items` through `perItem` inside transactions of at most `chunkSize` items,
 * committing between chunks. SQLite serialises writers, and the main (HTTP/SSE)
 * thread claims jobs with a deliberately short busy_timeout — so a single
 * transaction that upserts an entire large artist's catalog (hundreds of release
 * groups, thousands of tracks) holds the write lock long enough to starve other
 * writers into "database is locked" and to make the main thread's claim time out.
 * Committing every `chunkSize` rows bounds how long the lock is held, letting
 * peers (and the main thread) interleave between chunks.
 *
 * Callers must ensure each chunk is independently consistent. Idempotent upserts
 * (the catalog hydration paths) are; operations with cross-row invariants that
 * must all-or-nothing should keep using a single `db.transaction`.
 */
export function runChunkedWrite<T>(
  items: readonly T[],
  perItem: (item: T, index: number) => void,
  chunkSize: number = 200,
): number {
  const size = Math.max(1, chunkSize);
  for (let start = 0; start < items.length; start += size) {
    const end = Math.min(items.length, start + size);
    const runChunk = db.transaction(() => {
      for (let i = start; i < end; i += 1) {
        perItem(items[i], i);
      }
    });
    runChunk();
  }
  return items.length;
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

const BASE_SCHEMA_VERSION = 31;
const SCHEMA_VERSION_FORMAT_KEY = "runtime.schema_version_format";
const INTEGER_SCHEMA_VERSION_FORMAT = "integer";

// ====================================================================
// SCHEMA
// Fresh databases are created directly at the current schema. Runtime startup
// does not migrate old schemas or backfill old rows.
// ====================================================================
function ensureCatalogForeignKeyIndexes(): void {
  db.exec("CREATE INDEX IF NOT EXISTS idx_albums_artist_metadata_id ON Albums(artist_metadata_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_album_releases_release_group_id ON AlbumReleases(release_group_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_album_releases_artist_metadata_id ON AlbumReleases(artist_metadata_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_album_artists_release_group_id ON AlbumArtists(release_group_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_album_artists_artist_metadata_id ON AlbumArtists(artist_metadata_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_artist_release_groups_artist_metadata_id ON ArtistReleaseGroups(artist_metadata_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_artist_release_groups_release_group_id ON ArtistReleaseGroups(release_group_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_artist_release_group_curation_artist_metadata_id ON ArtistReleaseGroupCuration(source_artist_metadata_id, included)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_artist_release_group_curation_release_group_id ON ArtistReleaseGroupCuration(release_group_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tracks_album_release_id ON Tracks(album_release_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tracks_recording_id ON Tracks(recording_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tracks_album_release_position ON Tracks(album_release_id, medium_position, position)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_release_group_slots_artist_metadata_id ON ReleaseGroupSlots(artist_metadata_id, slot)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_release_group_slots_release_group_id ON ReleaseGroupSlots(release_group_id, slot)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_release_group_slots_selected_album_release_id ON ReleaseGroupSlots(selected_album_release_id)");
}

function ensureCatalogForeignKeyTriggers(): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_albums_catalog_fks_ai
    AFTER INSERT ON Albums
    BEGIN
      UPDATE Albums
      SET artist_metadata_id = COALESCE(NEW.artist_metadata_id, (SELECT id FROM ArtistMetadata WHERE mbid = NEW.artist_mbid))
      WHERE id = NEW.id;
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_albums_catalog_fks_au
    AFTER UPDATE OF artist_mbid ON Albums
    BEGIN
      UPDATE Albums SET artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = NEW.artist_mbid)
      WHERE id = NEW.id;
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_album_releases_catalog_fks_ai
    AFTER INSERT ON AlbumReleases
    BEGIN
      UPDATE AlbumReleases SET
        release_group_id = COALESCE(NEW.release_group_id, (SELECT id FROM Albums WHERE mbid = NEW.release_group_mbid)),
        artist_metadata_id = COALESCE(NEW.artist_metadata_id, (SELECT id FROM ArtistMetadata WHERE mbid = NEW.artist_mbid))
      WHERE id = NEW.id;
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_album_releases_catalog_fks_au
    AFTER UPDATE OF release_group_mbid, artist_mbid ON AlbumReleases
    BEGIN
      UPDATE AlbumReleases SET
        release_group_id = (SELECT id FROM Albums WHERE mbid = NEW.release_group_mbid),
        artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = NEW.artist_mbid)
      WHERE id = NEW.id;
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_tracks_catalog_fks_ai
    AFTER INSERT ON Tracks
    BEGIN
      UPDATE Tracks SET
        album_release_id = COALESCE(NEW.album_release_id, (SELECT id FROM AlbumReleases WHERE mbid = NEW.release_mbid)),
        recording_id = COALESCE(NEW.recording_id, (SELECT id FROM Recordings WHERE mbid = NEW.recording_mbid))
      WHERE id = NEW.id;
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_tracks_catalog_fks_au
    AFTER UPDATE OF release_mbid, recording_mbid ON Tracks
    BEGIN
      UPDATE Tracks SET
        album_release_id = (SELECT id FROM AlbumReleases WHERE mbid = NEW.release_mbid),
        recording_id = (SELECT id FROM Recordings WHERE mbid = NEW.recording_mbid)
      WHERE id = NEW.id;
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_release_group_slots_catalog_fks_ai
    AFTER INSERT ON ReleaseGroupSlots
    BEGIN
      UPDATE ReleaseGroupSlots SET
        artist_metadata_id = COALESCE(NEW.artist_metadata_id, (SELECT id FROM ArtistMetadata WHERE mbid = NEW.artist_mbid)),
        release_group_id = COALESCE(NEW.release_group_id, (SELECT id FROM Albums WHERE mbid = NEW.release_group_mbid)),
        selected_album_release_id = COALESCE(NEW.selected_album_release_id, (SELECT id FROM AlbumReleases WHERE mbid = NEW.selected_release_mbid))
      WHERE id = NEW.id;
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_release_group_slots_catalog_fks_au
    AFTER UPDATE OF artist_mbid, release_group_mbid, selected_release_mbid ON ReleaseGroupSlots
    BEGIN
      UPDATE ReleaseGroupSlots SET
        artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = NEW.artist_mbid),
        release_group_id = (SELECT id FROM Albums WHERE mbid = NEW.release_group_mbid),
        selected_album_release_id = (SELECT id FROM AlbumReleases WHERE mbid = NEW.selected_release_mbid)
      WHERE id = NEW.id;
    END;
  `);
}

/**
 * Keep TrackFiles catalog integer FKs in sync when code writes MBID/provider
 * identity. New write paths should set these FKs directly; the trigger keeps
 * derived writes consistent.
 */
function ensureTrackFileForeignKeyTriggers(): void {
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
      artist_metadata_id INTEGER,
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
      FOREIGN KEY(artist_metadata_id) REFERENCES ArtistMetadata(id) ON DELETE SET NULL,
      FOREIGN KEY(artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS AlbumReleases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      foreign_release_id TEXT UNIQUE,
      mbid TEXT UNIQUE,
      release_group_id INTEGER,
      release_group_mbid TEXT NOT NULL,
      artist_metadata_id INTEGER,
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
      FOREIGN KEY(release_group_id) REFERENCES Albums(id) ON DELETE CASCADE,
      FOREIGN KEY(release_group_mbid) REFERENCES Albums(mbid) ON DELETE CASCADE,
      FOREIGN KEY(artist_metadata_id) REFERENCES ArtistMetadata(id) ON DELETE SET NULL,
      FOREIGN KEY(artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS AlbumArtists (
      release_group_id INTEGER,
      release_group_mbid TEXT NOT NULL,
      artist_metadata_id INTEGER,
      artist_mbid TEXT NOT NULL,
      ord INT NOT NULL,
      credited_name TEXT NOT NULL,
      join_phrase TEXT NOT NULL DEFAULT '',
      is_primary BOOLEAN NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(release_group_mbid, ord),
      FOREIGN KEY(release_group_id) REFERENCES Albums(id) ON DELETE CASCADE,
      FOREIGN KEY(release_group_mbid) REFERENCES Albums(mbid) ON DELETE CASCADE,
      FOREIGN KEY(artist_metadata_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE,
      FOREIGN KEY(artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ArtistReleaseGroups (
      artist_metadata_id INTEGER,
      artist_mbid TEXT NOT NULL,
      release_group_id INTEGER,
      release_group_mbid TEXT NOT NULL,
      relationship TEXT NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(artist_mbid, release_group_mbid, relationship),
      FOREIGN KEY(artist_metadata_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE,
      FOREIGN KEY(artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE,
      FOREIGN KEY(release_group_id) REFERENCES Albums(id) ON DELETE CASCADE,
      FOREIGN KEY(release_group_mbid) REFERENCES Albums(mbid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ArtistReleaseGroupCuration (
      source_artist_metadata_id INTEGER,
      source_artist_mbid TEXT NOT NULL,
      release_group_id INTEGER,
      release_group_mbid TEXT NOT NULL,
      included BOOLEAN NOT NULL DEFAULT 0,
      reason TEXT,
      redundant_to_release_group_id INTEGER,
      redundant_to_release_group_mbid TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(source_artist_mbid, release_group_mbid),
      FOREIGN KEY(source_artist_metadata_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE,
      FOREIGN KEY(source_artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE,
      FOREIGN KEY(release_group_id) REFERENCES Albums(id) ON DELETE CASCADE,
      FOREIGN KEY(release_group_mbid) REFERENCES Albums(mbid) ON DELETE CASCADE,
      FOREIGN KEY(redundant_to_release_group_id) REFERENCES Albums(id) ON DELETE SET NULL,
      FOREIGN KEY(redundant_to_release_group_mbid) REFERENCES Albums(mbid) ON DELETE SET NULL
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
      album_release_id INTEGER,
      release_mbid TEXT NOT NULL,
      recording_id INTEGER,
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
      FOREIGN KEY(album_release_id) REFERENCES AlbumReleases(id) ON DELETE CASCADE,
      FOREIGN KEY(release_mbid) REFERENCES AlbumReleases(mbid) ON DELETE CASCADE,
      FOREIGN KEY(recording_id) REFERENCES Recordings(id) ON DELETE CASCADE,
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
      provider_album_id TEXT,             -- owning provider album id for track/video offers
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
      artist_metadata_id INTEGER,
      artist_mbid TEXT NOT NULL,
      release_group_id INTEGER,
      release_group_mbid TEXT NOT NULL,
      slot TEXT NOT NULL,
      monitored BOOLEAN NOT NULL DEFAULT 0,
      selected_provider TEXT,
      selected_provider_id TEXT,
      selected_album_release_id INTEGER,
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
      FOREIGN KEY(artist_metadata_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE,
      FOREIGN KEY(artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE,
      FOREIGN KEY(release_group_id) REFERENCES Albums(id) ON DELETE CASCADE,
      FOREIGN KEY(release_group_mbid) REFERENCES Albums(mbid) ON DELETE CASCADE,
      FOREIGN KEY(selected_album_release_id) REFERENCES AlbumReleases(id) ON DELETE SET NULL,
      FOREIGN KEY(selected_release_mbid) REFERENCES AlbumReleases(mbid) ON DELETE SET NULL
    );

    -- Provider item -> MusicBrainz match graph. ProviderItems stores provider-native
    -- offer facts; this table stores only the edges to MusicBrainz entities.
    -- A provider album maps to an MB release. A provider track maps to its MB
    -- release + track + recording. Provider videos currently map to an MB recording
    -- and may later fill release/track when that relationship is known.
    CREATE TABLE IF NOT EXISTS ProviderItemMatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      provider_item_type TEXT NOT NULL,   -- 'artist' | 'album' | 'track' | 'video'
      provider_item_id TEXT NOT NULL,
      provider_album_id TEXT,             -- owning provider album for recording matches
      musicbrainz_artist_mbid TEXT,
      musicbrainz_release_mbid TEXT,
      musicbrainz_track_mbid TEXT,
      musicbrainz_recording_mbid TEXT,
      status TEXT,                        -- candidate | probable | verified | manual | rejected
      confidence REAL,
      method TEXT,
      evidence TEXT,                      -- JSON
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (
        musicbrainz_artist_mbid IS NOT NULL
        OR musicbrainz_release_mbid IS NOT NULL
        OR musicbrainz_track_mbid IS NOT NULL
        OR musicbrainz_recording_mbid IS NOT NULL
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_item_matches_unique_edge
      ON ProviderItemMatches(
        provider,
        provider_item_type,
        provider_item_id,
        COALESCE(musicbrainz_artist_mbid, ''),
        COALESCE(musicbrainz_release_mbid, ''),
        COALESCE(musicbrainz_track_mbid, ''),
        COALESCE(musicbrainz_recording_mbid, '')
      );
    CREATE INDEX IF NOT EXISTS idx_provider_item_matches_artist ON ProviderItemMatches(musicbrainz_artist_mbid, provider_item_type);
    CREATE INDEX IF NOT EXISTS idx_provider_item_matches_release ON ProviderItemMatches(musicbrainz_release_mbid, provider_item_type);
    CREATE INDEX IF NOT EXISTS idx_provider_item_matches_track ON ProviderItemMatches(musicbrainz_track_mbid, provider_item_type);
    CREATE INDEX IF NOT EXISTS idx_provider_item_matches_recording ON ProviderItemMatches(musicbrainz_recording_mbid, provider_item_type);
    CREATE INDEX IF NOT EXISTS idx_provider_item_matches_source ON ProviderItemMatches(provider, provider_item_type, provider_item_id);
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_mb_release_groups_artist ON Albums(artist_mbid, first_release_date)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_album_artists_artist ON AlbumArtists(artist_mbid, release_group_mbid)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_artist_release_groups_group ON ArtistReleaseGroups(release_group_mbid, artist_mbid)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_artist_release_group_curation_group ON ArtistReleaseGroupCuration(release_group_mbid, included)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_artist_release_group_curation_source_included ON ArtistReleaseGroupCuration(source_artist_mbid, included, release_group_mbid)");
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

function stampSchemaVersion(): void {
  const fromVersion = db.pragma("user_version", { simple: true }) as number;
  if (fromVersion !== BASE_SCHEMA_VERSION) {
    console.log(`🛠️  Baseline schema at version ${BASE_SCHEMA_VERSION} (PRAGMA user_version=${BASE_SCHEMA_VERSION}).`);
    db.pragma(`user_version = ${BASE_SCHEMA_VERSION}`);
  }
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS ArtistStatistics (
      artist_id TEXT PRIMARY KEY REFERENCES Artists(id) ON DELETE CASCADE,
      artist_mbid TEXT,
      album_count INTEGER NOT NULL DEFAULT 0,
      monitored_album_count INTEGER NOT NULL DEFAULT 0,
      track_count INTEGER NOT NULL DEFAULT 0,
      monitored_track_count INTEGER NOT NULL DEFAULT 0,
      track_file_count INTEGER NOT NULL DEFAULT 0,
      size_on_disk INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

      -- MusicBrainz identity captured when the file was imported/downloaded
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
    CREATE TABLE IF NOT EXISTS commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT, -- Internal command ID
      name TEXT NOT NULL,               -- Command name (RefreshArtist, DownloadAlbum, etc.)
      ref_id TEXT,                      -- Optional reference id (Tidal ID, file id, etc)
      payload TEXT NOT NULL,            -- JSON data necessary for execution
      status TEXT DEFAULT 'queued',     -- queued, started, completed, failed, cancelled
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

  const startupIntegrityCheck = String(process.env.DISCOGENIUS_STARTUP_INTEGRITY_CHECK || "off").toLowerCase();
  if (startupIntegrityCheck === "quick" || startupIntegrityCheck === "full") {
    const pragmaName = startupIntegrityCheck === "full" ? "integrity_check" : "quick_check";
    const integrityResult = db.pragma(pragmaName, { simple: true }) as string;
    if (integrityResult !== "ok") {
      console.error(`🚨 Database ${pragmaName} failed: ${integrityResult}`);
      console.error("   The database may be corrupted. Consider restoring from a backup.");
    }
  } else {
    console.log("[SQLite] Startup integrity check skipped. Set DISCOGENIUS_STARTUP_INTEGRITY_CHECK=quick or full to run one at boot.");
  }

  stampSchemaVersion();
  ensureCatalogForeignKeyIndexes();
  ensureCatalogForeignKeyTriggers();

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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_mbid_monitored ON Artists(mbid, monitored)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_musicbrainz_status ON Artists(musicbrainz_status)`);

  // Job indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_commands_status ON commands(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_commands_name ON commands(name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_commands_ref_id ON commands(ref_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_commands_priority ON commands(priority)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_commands_queue_order ON commands(queue_order)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_commands_status_priority ON commands(status, priority)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_commands_name_status_ref_id ON commands(name, status, ref_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_commands_status_name_created ON commands(status, name, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_commands_status_name_started ON commands(status, name, started_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_commands_status_name_completed ON commands(status, name, completed_at DESC, id DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_commands_poll ON commands(status, priority DESC, trigger DESC, queue_order ASC, created_at ASC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(enabled)`);

  // Library file indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_artist_id ON TrackFiles(artist_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_file_type ON TrackFiles(file_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_library_root ON TrackFiles(library_root)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_needs_rename ON TrackFiles(needs_rename)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_quality ON TrackFiles(quality)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_track_files_path ON TrackFiles(file_path)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_fingerprint ON TrackFiles(fingerprint)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_acoustid_id ON TrackFiles(acoustid_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_canonical_artist ON TrackFiles(canonical_artist_mbid)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_canonical_release_group ON TrackFiles(canonical_release_group_mbid, library_slot)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_canonical_release ON TrackFiles(canonical_release_mbid)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_canonical_track ON TrackFiles(canonical_track_mbid)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_canonical_recording ON TrackFiles(canonical_recording_mbid)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_provider_resource ON TrackFiles(provider, provider_entity_type, provider_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_track_files_slot_type ON TrackFiles(library_slot, file_type)`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_artist_statistics_mbid ON ArtistStatistics(artist_mbid)");

  db.exec(`CREATE INDEX IF NOT EXISTS idx_metadata_identity_status_status ON metadata_identity_status(status, updated_at DESC)`);

  // Quality profiles indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_quality_profiles_name ON quality_profiles(name)`);

  // History / schema provenance indexes
  db.exec("CREATE INDEX IF NOT EXISTS idx_history_events_date ON history_events(date DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_history_events_artist ON history_events(artist_id, date DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_history_events_album ON history_events(album_id, date DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_history_events_media ON history_events(media_id, date DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_history_events_event_type ON history_events(event_type, date DESC)");

  // Foreign key and lookup performance indexes
  db.exec("CREATE INDEX IF NOT EXISTS idx_mb_releases_artist_mbid ON AlbumReleases(artist_mbid)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_mb_tracks_recording_mbid ON Tracks(recording_mbid)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_release_group_slots_selected_release ON ReleaseGroupSlots(selected_release_mbid)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_artists_path ON Artists(path)");

  console.log("✅ Database schema initialized");

  // ====================================================================
  // DEFAULT DATA
  // ====================================================================
  initializeDefaultData();

}

function recordDatabaseVersionState() {
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

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function initializeDefaultData() {
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

  recordDatabaseVersionState();

  console.log("✅ Default configuration initialized");
}
