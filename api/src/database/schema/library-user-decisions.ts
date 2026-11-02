import type Database from "better-sqlite3";

/**
 * User-decision provenance and curation reasons.
 *
 * Additive. user_version stays 46. `locked = 1` and `decision = 'user'` are
 * the same album decision. A manual edition is `decision = 'user'` on that
 * edition. Unmonitor deletes the monitored row and writes LibraryUserExclusions
 * so the next curation pass cannot put it back.
 */
export function migrateLibraryUserDecisions(db: Database.Database): void {
  const tableExists = (name: string): boolean => Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
  const columnNames = (table: string): Set<string> => new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
  );

  if (tableExists("LibraryAlbums")) {
    const columns = columnNames("LibraryAlbums");
    if (!columns.has("decision")) {
      db.exec("ALTER TABLE LibraryAlbums ADD COLUMN decision TEXT NOT NULL DEFAULT 'curation'");
    }
  }
  if (tableExists("LibraryEditions")) {
    const columns = columnNames("LibraryEditions");
    if (!columns.has("decision")) {
      db.exec("ALTER TABLE LibraryEditions ADD COLUMN decision TEXT NOT NULL DEFAULT 'curation'");
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS LibraryUserExclusions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL,
      release_group_id INTEGER NOT NULL,
      edition_id INTEGER,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(library_id) REFERENCES Libraries(id) ON DELETE CASCADE,
      FOREIGN KEY(release_group_id) REFERENCES Albums(id) ON DELETE CASCADE,
      FOREIGN KEY(edition_id) REFERENCES AlbumEditions(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_library_user_exclusions_album
      ON LibraryUserExclusions(library_id, release_group_id) WHERE edition_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_library_user_exclusions_edition
      ON LibraryUserExclusions(library_id, edition_id) WHERE edition_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_library_user_exclusions_group
      ON LibraryUserExclusions(release_group_id);

    CREATE TABLE IF NOT EXISTS LibraryCurationOutcomes (
      library_id INTEGER NOT NULL,
      release_group_id INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('replaced', 'waiting')),
      replacement_title TEXT,
      covered INTEGER,
      total INTEGER,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(library_id, release_group_id),
      FOREIGN KEY(library_id) REFERENCES Libraries(id) ON DELETE CASCADE,
      FOREIGN KEY(release_group_id) REFERENCES Albums(id) ON DELETE CASCADE
    );
  `);

  if (!tableExists("LibraryAlbums")) return;

  // An import is not an edition choice. Rows that only an import marked
  // 'manual' go back to automatic before the lock pass below. Idempotent.
  db.exec(`
    UPDATE LibraryAlbums SET selection_mode = 'auto'
    WHERE selection_mode = 'manual' AND locked = 0 AND reason = 'canonical_manual_import';
  `);
  if (tableExists("LibraryEditions")) {
    db.exec(`
      UPDATE LibraryEditions SET selection_mode = 'auto'
      WHERE selection_mode = 'manual' AND reason = 'canonical_manual_import';
    `);
  }
  // A manual choice is a user decision. Locked rows already are. Idempotent.
  db.exec(`
    UPDATE LibraryAlbums
    SET locked = 1
    WHERE locked = 0
      AND (
        selection_mode = 'manual'
        OR EXISTS (
          SELECT 1
          FROM LibraryEditions monitored
          JOIN AlbumEditions edition ON edition.id = monitored.edition_id
          WHERE monitored.library_id = LibraryAlbums.library_id
            AND edition.release_group_id = LibraryAlbums.release_group_id
            AND monitored.selection_mode = 'manual'
        )
      );
    UPDATE LibraryAlbums
    SET decision = 'user'
    WHERE locked = 1 AND decision != 'user';
  `);
  if (tableExists("LibraryEditions") && columnNames("LibraryEditions").has("decision")) {
    db.exec(`
      UPDATE LibraryEditions
      SET decision = 'user'
      WHERE selection_mode = 'manual' AND decision != 'user'
    `);
  }
}
