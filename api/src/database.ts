import Database from "better-sqlite3";
import { BASE_SCHEMA_VERSION } from "./database/schema/version.js";
import { isMainThread } from "node:worker_threads";
import { DB_PATH } from "./services/config/bootstrap.js";

import {
  createCatalogForeignKeyIndexes,
  createCatalogForeignKeyTriggers,
  createCatalogSchema,
} from "./database/schema/catalog.js";
import {
  createTrackFileForeignKeyTriggers,
  createMetadataIdentitySchema,
  createExtraFileSchema,
  createMediaCoverProxyCacheSchema,
} from "./database/schema/files.js";
import {
  createArtistTopTrackProjectionSchema,
  createAlbumLibraryProjectionSchema,
  createTrackLibraryProjectionSchema,
} from "./database/schema/projections.js";
import {
  createTrackSearchIndex,
  createCatalogSearchIndex,
} from "./database/schema/search.js";
import {
  createCommandsSchema,
  createCommandsIndexes,
} from "./database/schema/commands.js";
import { createRuntimeControlSchema } from "./database/schema/control-plane.js";
import {
  createCanonicalCreditSchemaV41,
  createLibrarySchemaV41,
} from "./database/schema/library-v41.js";
import { getCurrentAppReleaseInfo } from "./services/config/app-release.js";
import { REPO_ROOT } from "./services/config/bootstrap.js";
import path from "node:path";
import { LibraryCurationRepository } from "./services/music/library-curation-repository.js";
import { ensureDefaultQualityProfiles } from "./services/music/library-settings-sync.js";
import { clearConfigCache, getConfigSection } from "./services/config/config.js";

let _db: Database.Database | null = null;

/**
 * Run a user-initiated write on the MAIN thread with an async busy-retry that
 * yields the event loop between attempts (never freezes it). Relies on
 * SQLite's own locking + a short busy_timeout + retry rather than an app-level
 * write mutex; this is the main-thread equivalent for route/scheduler writes so
 * they ride out brief worker write-lock contention instead of failing fast.
 */
export function withDbWrite<T>(fn: () => T): Promise<T> {
  return runWithAsyncBusyRetry(fn);
}

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
// request, SSE stream, and /health probe for its full duration. Keep the main
// thread's timeout small and its retry to a single quick attempt so a contended
// main-thread write (chiefly the markProcessing job-claim, occasionally a route
// write) fails fast and is retried at the next scheduler tick — never freezing
// the server for tens of seconds.
const MAIN_THREAD_BUSY_TIMEOUT_MS = 1000;
const WORKER_THREAD_BUSY_TIMEOUT_MS = 30000;
const SQLITE_BUSY_RETRY_ATTEMPTS = isMainThread ? 1 : 8;

// Optional write profiling: log any write transaction that holds the SQLite write
// lock longer than this (ms). Off unless DISCOGENIUS_WRITE_PROFILE_MS is set. Used
// to find slow writes by data, not guesswork — short writes are what keep the DB
// responsive under load, so this surfaces the ones to shorten.
const WRITE_PROFILE_MS = (() => {
  const raw = Number.parseInt(String(process.env.DISCOGENIUS_WRITE_PROFILE_MS ?? ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
})();

function profileWrite<T>(op: () => T): T {
  if (!WRITE_PROFILE_MS) return op();
  const startedAt = Date.now();
  try {
    return op();
  } finally {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= WRITE_PROFILE_MS) {
      const stack = new Error().stack?.split("\n").slice(3, 8).join("\n") ?? "";
      console.warn(`[write-profile] write held ${elapsed}ms\n${stack}`);
    }
  }
}

// Optional READ profiling, symmetric to the write profiler. The main thread is
// the event loop and better-sqlite3 reads are synchronous, so a slow read
// (a scan, a big join) blocks every request/SSE/health probe for its whole
// duration — the chief cause of the UI bogging down under heavy refresh/import
// load. Set DISCOGENIUS_READ_PROFILE_MS to log any main-thread read that holds
// the loop longer than that (ms), so the culprit query is found by data, not
// guesswork, and can be scoped/indexed (or offloaded) specifically. Off by
// default: when unset, statements are never wrapped, so there is zero per-read
// overhead on the hot path.
const READ_PROFILE_MS = (() => {
  const raw = Number.parseInt(String(process.env.DISCOGENIUS_READ_PROFILE_MS ?? ""), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
})();

function profileRead<T>(source: string, op: () => T): T {
  const startedAt = Date.now();
  try {
    return op();
  } finally {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= READ_PROFILE_MS) {
      const sql = source.replace(/\s+/g, " ").trim().slice(0, 160);
      console.warn(`[read-profile] main-thread read held ${elapsed}ms: ${sql}`);
    }
  }
}

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

/**
 * Async busy-retry for user-initiated writes on the MAIN (request) thread.
 *
 * The synchronous `runWithSqliteBusyRetry` is right for workers but on the main
 * thread it can only fail fast (1 attempt) — otherwise it would freeze the event
 * loop. That's correct for the background job-claim, but a user action (enqueue
 * an import, add an artist, toggle monitoring) shouldn't error just because a
 * refresh worker held the write lock for a moment. This retries the write with
 * `await setTimeout` backoff, which YIELDS the event loop between attempts, so
 * the server stays responsive while the write waits its turn. Route handlers are
 * already async, so they can `await` this.
 */
export async function runWithAsyncBusyRetry<T>(
  operation: () => T,
  attempts = 10,
  baseDelayMs = 150,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusy(error) || attempt >= attempts) {
        throw error;
      }
      lastError = error;
      const delayMs = Math.min(1000, baseDelayMs * (attempt + 1)) + Math.floor(Math.random() * baseDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
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
        // Only wrap reads when profiling is on AND we're on the event loop —
        // otherwise leave .get/.all untouched for zero hot-path overhead.
        if (READ_PROFILE_MS && isMainThread) {
          const originalGet = stmt.get.bind(stmt);
          const originalAll = stmt.all.bind(stmt);
          stmt.get = ((...args: unknown[]) => profileRead(source, () => originalGet(...args))) as typeof stmt.get;
          stmt.all = ((...args: unknown[]) => profileRead(source, () => originalAll(...args))) as typeof stmt.all;
        }
        return stmt;
      };
    }
    if (prop === "exec") {
      return (source: string) => runWithSqliteBusyRetry(() => instance.exec(source));
    }
    if (prop === "transaction") {
      return (fn: any) => {
        const txn = instance.transaction(fn) as any;
        const runImmediate = (...args: any[]) => runWithSqliteBusyRetry(() => profileWrite(() => txn.immediate(...args)));
        const runDeferred = (...args: any[]) => runWithSqliteBusyRetry(() => profileWrite(() => txn.deferred(...args)));
        const runDefault = (...args: any[]) => runWithSqliteBusyRetry(() => profileWrite(() => txn.default(...args)));
        const runExclusive = (...args: any[]) => runWithSqliteBusyRetry(() => profileWrite(() => txn.exclusive(...args)));
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

/**
 * The cheap half of WAL upkeep, safe to run on the HTTP event loop.
 *
 * PASSIVE copies whatever frames it can and never blocks, so a contended tick
 * costs nothing. What it cannot do is *reset* the log: that needs a moment when
 * no reader holds an old snapshot, and under multi-worker load such moments
 * have to be waited for. This used to escalate to `wal_checkpoint(TRUNCATE)`
 * with `busy_timeout = 0` — which by construction bails on the first
 * conflicting reader and so essentially never reclaimed anything (measured: the
 * WAL still reached 1.75 GB with this running every 15s). That escalation now
 * lives on the WAL maintenance thread, where it is allowed a finite wait
 * without stalling every request in the process.
 */
export function checkpointWal(): void {
  try {
    db.pragma("wal_checkpoint(PASSIVE)");
  } catch (error) {
    console.warn("⚠️  Failed to checkpoint SQLite WAL:", error);
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
 * One commit instead of N.
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
  chunkSize: number = 50,
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
 * Serialize a SQLite write section against every other writer in the process.
 *
 * Local-MB can fetch many artists' Postgres payloads concurrently, but
 * better-sqlite3 still serialises writers on one connection. Wrap each writer's
 * commit section (including `runChunkedWrite`) so overlapping commands wait
 * their turn instead of fighting the busy timeout. Fetches and network work
 * must stay *outside* the gate.
 *
 * The queue itself lives in `services/commands/worker/sqlite-write-lock.ts` and
 * is owned by the main thread. It used to be a module-scope promise tail right
 * here, which gave every command worker its own private gate — the defect this
 * indirection exists to fix.
 */
/**
 * `runChunkedWrite`, taking the gate **per chunk** instead of once for the
 * whole batch.
 *
 * Wrapping a whole chunked write in one gate acquisition defeats the point of
 * chunking: the lock is bounded inside SQLite but the gate is held for the
 * entire batch, so peers wait it out anyway. Measured on the live library, one
 * worker held the gate for 63 seconds with four others queued behind it.
 *
 * Per chunk, every writer still sees a single writer at a time, waits are still
 * promises, and peers interleave between chunks exactly as the chunk size was
 * chosen to allow. Callers must already satisfy `runChunkedWrite`'s rule that
 * each chunk is independently consistent.
 */
export async function runGatedChunkedWrite<T>(
  items: readonly T[],
  perItem: (item: T, index: number) => void,
  chunkSize: number = 50,
  label = "unlabelled-chunked",
): Promise<number> {
  const size = Math.max(1, chunkSize);
  for (let start = 0; start < items.length; start += size) {
    const end = Math.min(items.length, start + size);
    await withSqliteWriteGate(() => {
      const runChunk = db.transaction(() => {
        for (let i = start; i < end; i += 1) {
          perItem(items[i], i);
        }
      });
      runChunk();
    }, label);
  }
  return items.length;
}

export async function withSqliteWriteGate<T>(
  work: () => T | Promise<T>,
  /** Names this write section in the write-lock diagnostics. Always pass one. */
  label = "unlabelled",
): Promise<T> {
  const { withGlobalSqliteWriteLock } = await import(
    "./services/commands/worker/sqlite-write-lock.js"
  );
  return withGlobalSqliteWriteLock(work, undefined, label);
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

// Re-exported so existing importers of database.js keep working; the value
// lives in its own module because two release-hardening scripts open the
// database file directly and must agree without importing this one.
export { BASE_SCHEMA_VERSION };

function getUserTableCount(): number {
  const row = db.prepare(`
    SELECT COUNT(*) as count
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
  `).get() as { count: number };
  return Number(row.count || 0);
}

function assertDatabaseVersionCanStart(): void {
  const fromVersion = db.pragma("user_version", { simple: true }) as number;
  const userTableCount = getUserTableCount();
  if (fromVersion === 0 && userTableCount === 0) {
    return;
  }

  if (fromVersion !== BASE_SCHEMA_VERSION) {
    throw new Error(
      `Database schema ${fromVersion || "unversioned"} is not supported by this build. ` +
      `Reset the runtime database so Discogenius can create a clean schema ${BASE_SCHEMA_VERSION} database.`,
    );
  }
}

function stampSchemaVersion(): void {
  const fromVersion = db.pragma("user_version", { simple: true }) as number;
  if (fromVersion === 0) {
    console.log(`🛠️  Baseline schema at version ${BASE_SCHEMA_VERSION} (PRAGMA user_version=${BASE_SCHEMA_VERSION}).`);
    db.pragma(`user_version = ${BASE_SCHEMA_VERSION}`);
  }
}

function runStartupIntegrityCheck(): void {
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
}

export function initDatabase() {
  console.log("🗄️  Initializing database schema...");
  assertDatabaseVersionCanStart();

  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  const isEmptyDatabase = currentVersion === 0 && getUserTableCount() === 0;

  if (isEmptyDatabase) {
    // Fresh database: build the schema-41 baseline in one coherent pass,
    // stamp the version, then seed defaults.
    createBaselineSchemaV41();
    stampSchemaVersion();
    runStartupIntegrityCheck();
    console.log("✅ Database schema initialized");
  } else {
    // Existing schema-41 database: open only.
    runStartupIntegrityCheck();
    console.log(`✅ Opened existing schema ${BASE_SCHEMA_VERSION} database`);
  }

  initializeDefaultData();
}

/**
 * Create the complete schema-41 baseline: every table, index, trigger and FTS
 * object, using plain CREATE statements (no IF NOT EXISTS). Only ever runs
 * against a verified-empty database, so ordering and uniqueness are guaranteed.
 * Parents are created before children where trigger/index bodies depend on them.
 */
function createBaselineSchemaV41(): void {
  // ====================================================================
  // ARTISTS TABLE
  // ====================================================================
  db.exec(`
    CREATE TABLE Artists (
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
    CREATE TABLE ArtistStatistics (
      artist_id TEXT PRIMARY KEY REFERENCES Artists(id) ON DELETE CASCADE,
      artist_mbid TEXT,
      album_count INTEGER NOT NULL DEFAULT 0,
      monitored_album_count INTEGER NOT NULL DEFAULT 0,
      downloaded_album_count INTEGER NOT NULL DEFAULT 0,
      track_count INTEGER NOT NULL DEFAULT 0,
      monitored_track_count INTEGER NOT NULL DEFAULT 0,
      track_file_count INTEGER NOT NULL DEFAULT 0,
      video_count INTEGER NOT NULL DEFAULT 0,
      size_on_disk INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ====================================================================
  // TRACKFILES TABLE (Local file tracking; file inventory)
  // ====================================================================
  db.exec(`
    CREATE TABLE TrackFiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, -- Internal file ID
      
      -- Linkage
      artist_id TEXT NOT NULL,           -- Managed artist id

      -- MusicBrainz identity captured when the file was imported/downloaded
      canonical_artist_mbid TEXT,
      canonical_release_group_mbid TEXT,
      canonical_release_mbid TEXT,
      canonical_track_mbid TEXT,
      canonical_recording_mbid TEXT,

      -- Catalog integer FKs (files link straight to catalog rows;
      -- recording_id covers mbid-less provider videos too)
      release_group_id INTEGER REFERENCES Albums(id) ON DELETE SET NULL,
      album_edition_id INTEGER REFERENCES AlbumEditions(id) ON DELETE SET NULL,
      track_id INTEGER REFERENCES Tracks(id) ON DELETE SET NULL,
      recording_id INTEGER REFERENCES Recordings(id) ON DELETE SET NULL,

      -- Provider resource that produced or owns this file
      provider TEXT,
      provider_entity_type TEXT,
      provider_id TEXT,
      -- Internal provider-resource identity. A provider_id alone is unique only
      -- within (provider, entity_type), so the triple above is a snapshot and
      -- THIS is the resolvable link. Nullable: a manually imported file need not
      -- have any provider resource at all.
      provider_item_id INTEGER,
      library_slot TEXT NOT NULL DEFAULT 'stereo',                 -- stereo, spatial, video
      library_id INTEGER,
      source_audio_variant_id INTEGER,
      
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
      video_codec TEXT,                  -- Video stream codec when file_type=video (h264, hevc, av1, …)
      width INT,                         -- Video frame width (pixels); null for audio-only
      height INT,                        -- Video frame height (pixels); null for audio-only
      
      -- Content Type
      file_type TEXT NOT NULL,           -- track, video, cover, video_cover, video_thumbnail, bio, review, lyrics
      quality TEXT,                      -- LOSSLESS, HIRES_LOSSLESS, DOLBY_ATMOS, etc
      file_class TEXT,
      source_quality TEXT,
      imported_quality TEXT,
      
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
      FOREIGN KEY(library_id) REFERENCES Libraries(id) ON DELETE CASCADE,
      FOREIGN KEY(provider_item_id) REFERENCES ProviderItems(id) ON DELETE SET NULL,
      FOREIGN KEY(source_audio_variant_id) REFERENCES ProviderItemAudioVariants(id) ON DELETE SET NULL
    )
  `);

  createMetadataIdentitySchema(db);
  createCatalogSchema(db);
  createCanonicalCreditSchemaV41(db);
  createCommandsSchema(db);
  createRuntimeControlSchema(db);
  createLibrarySchemaV41(db);
  createArtistTopTrackProjectionSchema(db);
  createAlbumLibraryProjectionSchema(db);
  createTrackLibraryProjectionSchema(db);
  createExtraFileSchema(db);
  createMediaCoverProxyCacheSchema(db);
  createTrackFileForeignKeyTriggers(db);

  // ====================================================================
  // UNMAPPED FILES TABLE (local files not mapped to canonical metadata/provider evidence)
  // ====================================================================
  db.exec(`
    CREATE TABLE UnmappedFiles (
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

  createCatalogForeignKeyIndexes(db);
  createCatalogForeignKeyTriggers(db);
  createTrackSearchIndex(db);
  createCatalogSearchIndex(db);

  // ====================================================================
  // INDEXES
  // ====================================================================
  // Artist indexes
  db.exec(`CREATE INDEX idx_artists_monitored ON Artists(monitored)`);
  db.exec(`CREATE INDEX idx_artists_name ON Artists(name)`);
  db.exec(`CREATE INDEX idx_artists_popularity ON Artists(popularity)`);
  db.exec(`CREATE INDEX idx_artists_last_scanned ON Artists(last_scanned)`);
  db.exec(`CREATE INDEX idx_artists_user_date_added ON Artists(user_date_added)`);
  db.exec(`CREATE INDEX idx_artists_mbid ON Artists(mbid)`);
  db.exec(`CREATE INDEX idx_artists_mbid_monitored ON Artists(mbid, monitored)`);
  db.exec(`CREATE INDEX idx_artists_musicbrainz_status ON Artists(musicbrainz_status)`);

  // Job indexes
  createCommandsIndexes(db);

  // Library file indexes
  db.exec(`CREATE INDEX idx_track_files_artist_id ON TrackFiles(artist_id)`);
  db.exec(`CREATE INDEX idx_track_files_file_type ON TrackFiles(file_type)`);
  db.exec(`CREATE INDEX idx_track_files_library_root ON TrackFiles(library_root)`);
  db.exec(`CREATE INDEX idx_track_files_needs_rename ON TrackFiles(needs_rename)`);
  db.exec(`CREATE INDEX idx_track_files_quality ON TrackFiles(quality)`);
  db.exec(`CREATE UNIQUE INDEX idx_track_files_path ON TrackFiles(file_path)`);
  db.exec(`CREATE INDEX idx_track_files_fingerprint ON TrackFiles(fingerprint)`);
  db.exec(`CREATE INDEX idx_track_files_acoustid_id ON TrackFiles(acoustid_id)`);
  db.exec(`CREATE INDEX idx_track_files_canonical_artist ON TrackFiles(canonical_artist_mbid)`);
  db.exec(`CREATE INDEX idx_track_files_canonical_release_group ON TrackFiles(canonical_release_group_mbid, library_slot)`);
  db.exec(`CREATE INDEX idx_track_files_canonical_release ON TrackFiles(canonical_release_mbid)`);
  db.exec(`CREATE INDEX idx_track_files_provider_resource ON TrackFiles(provider, provider_entity_type, provider_id)`);
  db.exec(`CREATE INDEX idx_track_files_slot_type ON TrackFiles(library_slot, file_type)`);
  db.exec(`CREATE INDEX idx_track_files_expected_path ON TrackFiles(expected_path)`);
  db.exec(`CREATE INDEX idx_track_files_provider_id_type_slot ON TrackFiles(provider_id, file_type, library_slot)`);
  db.exec("CREATE INDEX idx_artist_statistics_mbid ON ArtistStatistics(artist_mbid)");

  db.exec(`CREATE INDEX idx_metadata_identity_status_status ON metadata_identity_status(status, updated_at DESC)`);

  // Foreign key and lookup performance indexes
  db.exec("CREATE INDEX idx_mb_releases_artist_mbid ON AlbumEditions(artist_mbid)");
  db.exec("CREATE INDEX idx_mb_tracks_recording_mbid ON Tracks(recording_mbid)");
  db.exec("CREATE INDEX idx_artists_path ON Artists(path)");
}

function recordDatabaseVersionState() {
  const releaseInfo = getCurrentAppReleaseInfo();
  const appVersion = releaseInfo.version;
  const apiVersion = releaseInfo.apiVersion;
  const schemaUserVersion = db.pragma("user_version", { simple: true }) as number;
  const schemaVersion = String(schemaUserVersion);

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

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function initializeDefaultData() {
  // Stereo quality ladder + Spatial/Video profiles. Settings.audio_quality picks
  // which stereo profile the fixed Stereo library uses (see library-settings-sync).
  console.log("📋 Ensuring default quality profiles...");
  ensureDefaultQualityProfiles(db);

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

  const resolveLibraryRoot = (environmentValue: string | undefined, relativePath: string): string => {
    const configured = environmentValue?.trim();
    if (configured) {
      return path.isAbsolute(configured) ? configured : path.resolve(REPO_ROOT, configured);
    }
    return process.env.DOCKER === "true"
      ? `/${relativePath.replaceAll("\\", "/")}`
      : path.resolve(REPO_ROOT, relativePath);
  };
  // Config defaults land before this so Settings → library mapping is available.
  clearConfigCache();
  const quality = getConfigSection("quality");
  const filtering = getConfigSection("filtering");
  new LibraryCurationRepository(db).bootstrapDefaultLibraries(
    {
      stereoRoot: resolveLibraryRoot(process.env.MUSIC_PATH, "library/stereo-music"),
      spatialRoot: resolveLibraryRoot(process.env.SPATIAL_PATH, "library/spatial-music"),
      videoRoot: resolveLibraryRoot(process.env.VIDEO_PATH, "library/music-videos"),
    },
    {
      audioQuality: quality.audio_quality,
      includeSpatial: filtering.include_spatial === true,
    },
  );

  recordDatabaseVersionState();

  console.log("✅ Default configuration initialized");
}
