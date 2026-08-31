/**
 * Shared fixture for PRODUCTION-SERVICE tests: boots the ACTIVE runtime database
 * schema, the one `initDatabase()` creates and the app actually runs on.
 *
 * Why this exists
 * ---------------
 * Some suites built their fixture from `database/schema/domain-baseline.ts`.
 * That is the ASPIRATIONAL clean-start schema — it is contract-tested but not
 * wired into production, and it diverges from the active baseline in both
 * directions. A production service tested against it can pass while being
 * broken at runtime; that is exactly how an UPDATE writing
 * `TrackFiles.provider_item_id` shipped against an active schema that had no
 * such column.
 *
 * Rule: production-service fixtures boot the active schema (this helper).
 * `domain-baseline.ts` fixtures are only for domain/schema contract tests.
 *
 * Usage — the DB path env vars must be set before `database.js` is imported, so
 * call `prepareActiveSchemaEnv()` at module top level, then `openActiveSchemaDb()`:
 *
 *   const { tempDir } = prepareActiveSchemaEnv("my-service");
 *   const { db, dbModule } = await openActiveSchemaDb();
 *   after(() => closeActiveSchemaDb(dbModule, tempDir));
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ActiveSchemaEnv = { tempDir: string };

/**
 * Point the app's database + config at a throwaway directory. MUST run before
 * anything imports `database.js`, because DB_PATH is read at module load.
 */
export function prepareActiveSchemaEnv(label: string): ActiveSchemaEnv {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `discogenius-${label}-`));
  process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
  process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
  return { tempDir };
}

export async function openActiveSchemaDb(): Promise<{
  db: typeof import("../database.js").db;
  dbModule: typeof import("../database.js");
}> {
  const dbModule = await import("../database.js");
  dbModule.initDatabase();
  // Most active-schema service fixtures predate the user-facing video toggle
  // and intentionally exercise the complete three-library model. Preserve
  // that fixture contract; tests for the disabled state switch it off
  // explicitly.
  enableVideoLibraryForTests(dbModule.db);
  return { db: dbModule.db, dbModule };
}

export function enableVideoLibraryForTests(
  db: { prepare: (sql: string) => { run: (...args: any[]) => unknown } },
): void {
  db.prepare("UPDATE Libraries SET enabled = 1 WHERE name = 'Video'").run();
}

export function closeActiveSchemaDb(
  dbModule: typeof import("../database.js"),
  tempDir: string,
): void {
  try {
    dbModule.closeDatabase();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Assert a table really carries the columns a production writer depends on.
 *
 * Preparing the statement is the stronger check (SQLite resolves names at prepare
 * time), but this gives a readable failure listing what is missing.
 */
export function assertTableHasColumns(
  db: { prepare: (sql: string) => { all: (...args: any[]) => unknown[] } },
  table: string,
  requiredColumns: readonly string[],
): string[] {
  const present = new Set(
    (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>)
      .map((row) => row.name),
  );
  return requiredColumns.filter((column) => !present.has(column));
}

/**
 * Select a canonical video into the enabled Video Libraries.
 *
 * A `LibraryVideos` row IS the monitoring statement — there is no
 * `Recordings.monitored` to set — so a fixture that wants a monitored video
 * says so by selecting it. Placement defaults to separated; tests exercising
 * inline placement set it explicitly.
 */
export function selectVideoInVideoLibraries(
  db: { prepare: (sql: string) => { run: (...args: any[]) => unknown } },
  videoRecordingId: number | string,
  options: { selectionMode?: "auto" | "manual" } = {},
): void {
  db.prepare(`
    INSERT INTO LibraryVideos (
      library_id, video_recording_id, selection_mode, placement_mode, reason
    )
    SELECT library.id, ?, ?, 'separated', 'fixture'
    FROM Libraries library
    JOIN quality_profiles quality_profile
      ON quality_profile.id = library.quality_profile_id
    WHERE library.enabled = 1
      AND EXISTS (
        SELECT 1
        FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
        WHERE allowed.value = 'video'
      )
    ON CONFLICT(library_id, video_recording_id) DO UPDATE SET
      selection_mode = excluded.selection_mode
  `).run(videoRecordingId, options.selectionMode ?? "auto");
}

/**
 * Attach a catalog artist to every enabled library.
 *
 * A LibraryArtists row is membership. Unmonitor deletes the row; pause keeps
 * the row with policy `none`. This helper inserts policy `all` unless
 * `monitored === false`, in which case it deletes membership and does not
 * insert. Pause tests write policy `none` themselves.
 */
export function seedLibraryArtistMonitoring(
  db: {
    prepare: (sql: string) => {
      get: (...args: any[]) => unknown;
      run: (...args: any[]) => unknown;
    };
  },
  artistMbid: string,
  options: { monitored?: boolean } = {},
): { artistMetadataId: number } {
  const canonical = db.prepare(`
    SELECT id FROM ArtistMetadata WHERE mbid = ?
  `).get(artistMbid) as { id: number } | undefined;
  if (!canonical) {
    throw new Error(`seedLibraryArtistMonitoring: missing ArtistMetadata for ${artistMbid}`);
  }
  if (options.monitored === false) {
    db.prepare(`
      DELETE FROM LibraryArtists WHERE artist_metadata_id = ?
    `).run(canonical.id);
    return { artistMetadataId: canonical.id };
  }
  db.prepare(`
    INSERT INTO LibraryArtists (library_id, artist_metadata_id, policy, credited_scope)
    SELECT library.id, ?, 'all', 'release_and_track_credit'
    FROM Libraries library
    WHERE library.enabled = 1
    ON CONFLICT(library_id, artist_metadata_id) DO UPDATE SET
      policy = excluded.policy
  `).run(canonical.id);
  return { artistMetadataId: canonical.id };
}

/**
 * Tables whose rows are provider/library state rather than canonical catalogue
 * facts. Delete in this order between tests — children before parents, so an
 * FK-enforced database does not reject the reset.
 */
export const PROVIDER_STATE_TABLES_IN_DELETE_ORDER = [
  "AcquisitionPlanTracks",
  "AcquisitionPlanSources",
  "AcquisitionPlans",
  "ArtistStatistics",
  "TrackFiles",
  "ProviderTrackMatches",
  "ProviderVideoMatches",
  "ProviderEditionMatches",
  "ProviderArtistMatches",
  "ProviderArtistIgnores",
  "ProviderEditionMembers",
  "ProviderItemAudioVariants",
  "ProviderItemCredits",
  "ProviderItems",
] as const;

export const CANONICAL_TABLES_IN_DELETE_ORDER = [
  "LibraryVideos",
  "LibraryEditions",
  "LibraryAlbums",
  "LibraryArtists",
  "RecordingRelations",
  "Tracks",
  "Recordings",
  "AlbumEditions",
  "Albums",
  "ArtistMetadata",
] as const;

/** Reset provider + canonical state, ignoring tables a given schema lacks. */
export function resetActiveSchemaRows(
  db: { prepare: (sql: string) => { run: (...args: any[]) => unknown } },
  extraTablesFirst: readonly string[] = [],
): void {
  // `LibraryEditions.preferred_plan_key` is a deferred foreign key into
  // AcquisitionPlans, which is emptied first. Release the reference before the
  // rows it points at disappear, or the reset fails the constraint at commit.
  try {
    db.prepare("UPDATE LibraryEditions SET preferred_plan_key = NULL").run();
  } catch {
    // A suite's schema may predate the column; nothing to release.
  }
  const tables = [
    ...extraTablesFirst,
    ...PROVIDER_STATE_TABLES_IN_DELETE_ORDER,
    ...CANONICAL_TABLES_IN_DELETE_ORDER,
  ];
  for (const table of tables) {
    try {
      db.prepare(`DELETE FROM ${table}`).run();
    } catch {
      // A suite's schema may not include every optional table; skipping is fine.
    }
  }
}
