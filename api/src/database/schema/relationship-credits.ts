import type Database from "better-sqlite3";

/**
 * Picard relationship credits (composer, performer, work, …). Additive tables
 * and one Recordings column. user_version stays 46 so a queued RetagArtist is
 * not reset. artist_mbid is plain text: these people are not monitored artists.
 */
export function createRelationshipCreditSchema(db: Database.Database): void {
  const recordings = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'Recordings'").get();
  if (recordings) {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(Recordings)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!columns.has("relationship_credits_at")) {
      db.exec("ALTER TABLE Recordings ADD COLUMN relationship_credits_at TEXT");
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS CatalogRelationshipCredits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL CHECK (scope IN ('recording', 'release', 'work')),
      recording_id INTEGER,
      edition_id INTEGER,
      work_mbid TEXT,
      role TEXT NOT NULL,
      attribute TEXT NOT NULL DEFAULT '',
      artist_mbid TEXT NOT NULL,
      credited_name TEXT NOT NULL,
      sort_name TEXT,
      credit_order INTEGER NOT NULL DEFAULT 0,
      medium_position INTEGER,
      FOREIGN KEY (recording_id) REFERENCES Recordings(id) ON DELETE CASCADE,
      FOREIGN KEY (edition_id) REFERENCES AlbumEditions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_rel_credits_recording
      ON CatalogRelationshipCredits(recording_id) WHERE recording_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_rel_credits_edition
      ON CatalogRelationshipCredits(edition_id) WHERE edition_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_rel_credits_work
      ON CatalogRelationshipCredits(work_mbid) WHERE work_mbid IS NOT NULL;

    CREATE TABLE IF NOT EXISTS RecordingWorks (
      recording_id INTEGER NOT NULL,
      work_mbid TEXT NOT NULL,
      work_title TEXT NOT NULL,
      link_order INTEGER NOT NULL DEFAULT 0,
      instrumental INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (recording_id, work_mbid),
      FOREIGN KEY (recording_id) REFERENCES Recordings(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_recording_works_work ON RecordingWorks(work_mbid);
  `);
}

export function migrateRelationshipCredits(db: Database.Database): void {
  createRelationshipCreditSchema(db);
}
