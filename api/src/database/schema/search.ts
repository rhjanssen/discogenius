import type Database from "better-sqlite3";

// FTS UNINDEXED columns store values but cannot locate rows efficiently. Each
// index row uses its canonical integer primary key; catalog kinds get disjoint
// rowid ranges modulo four. Readers retain their existing public identifiers.
// TrackSearch indexes ONLY tracks on monitored editions (LibraryEditions):
// indexing every unselected pressing bloated the FTS index to >1 GB on live
// libraries while local search only surfaces library tracks.
export function createTrackSearchIndex(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE TrackSearch USING fts5(
      track_mbid UNINDEXED,
      recording_mbid UNINDEXED,
      title,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER tracks_search_insert
    AFTER INSERT ON Tracks
    WHEN NEW.title IS NOT NULL
      AND NEW.album_edition_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM LibraryEditions WHERE edition_id = NEW.album_edition_id)
    BEGIN
      DELETE FROM TrackSearch WHERE rowid = NEW.id;
      INSERT INTO TrackSearch(rowid, track_mbid, recording_mbid, title)
      VALUES (NEW.id, NEW.mbid, NEW.recording_mbid, NEW.title);
    END;

    CREATE TRIGGER tracks_search_delete
    AFTER DELETE ON Tracks
    BEGIN
      DELETE FROM TrackSearch WHERE rowid = OLD.id;
    END;

    CREATE TRIGGER tracks_search_update
    AFTER UPDATE OF id, mbid, recording_mbid, title, album_edition_id ON Tracks
    WHEN OLD.id IS NOT NEW.id OR OLD.mbid IS NOT NEW.mbid
      OR OLD.recording_mbid IS NOT NEW.recording_mbid OR OLD.title IS NOT NEW.title
      OR OLD.album_edition_id IS NOT NEW.album_edition_id
    BEGIN
      DELETE FROM TrackSearch WHERE rowid = OLD.id;
      INSERT INTO TrackSearch(rowid, track_mbid, recording_mbid, title)
      SELECT NEW.id, NEW.mbid, NEW.recording_mbid, NEW.title
      WHERE NEW.title IS NOT NULL
        AND NEW.album_edition_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM LibraryEditions WHERE edition_id = NEW.album_edition_id);
    END;

    CREATE TRIGGER library_editions_track_search_insert
    AFTER INSERT ON LibraryEditions
    WHEN (SELECT COUNT(*) FROM LibraryEditions WHERE edition_id = NEW.edition_id) = 1
    BEGIN
      DELETE FROM TrackSearch
      WHERE rowid IN (SELECT id FROM Tracks WHERE album_edition_id = NEW.edition_id);
      INSERT INTO TrackSearch(rowid, track_mbid, recording_mbid, title)
      SELECT id, mbid, recording_mbid, title
      FROM Tracks
      WHERE album_edition_id = NEW.edition_id
        AND title IS NOT NULL;
    END;

    CREATE TRIGGER library_editions_track_search_delete
    AFTER DELETE ON LibraryEditions
    WHEN NOT EXISTS (SELECT 1 FROM LibraryEditions WHERE edition_id = OLD.edition_id)
    BEGIN
      DELETE FROM TrackSearch
      WHERE rowid IN (SELECT id FROM Tracks WHERE album_edition_id = OLD.edition_id);
    END;

    CREATE TRIGGER library_editions_track_search_update
    AFTER UPDATE OF edition_id ON LibraryEditions
    WHEN OLD.edition_id IS NOT NEW.edition_id
    BEGIN
      DELETE FROM TrackSearch
      WHERE NOT EXISTS (SELECT 1 FROM LibraryEditions WHERE edition_id = OLD.edition_id)
        AND rowid IN (SELECT id FROM Tracks WHERE album_edition_id = OLD.edition_id);
      DELETE FROM TrackSearch
      WHERE rowid IN (SELECT id FROM Tracks WHERE album_edition_id = NEW.edition_id);
      INSERT INTO TrackSearch(rowid, track_mbid, recording_mbid, title)
      SELECT id, mbid, recording_mbid, title
      FROM Tracks
      WHERE album_edition_id = NEW.edition_id
        AND title IS NOT NULL;
    END;
  `);
}

export function createCatalogSearchIndex(db: Database.Database, substring = false): void {
  const table = substring ? "CatalogSubstringSearch" : "CatalogSearch";
  const prefix = substring ? "catalog_substring_search" : "catalog_search";
  // Prefix search and substring filters have different tokenization needs.
  // The trigram index retains LIKE semantics, including punctuation and infixes.
  const tokenizer = substring ? "trigram" : "unicode61 remove_diacritics 2";
  db.exec(`
    CREATE VIRTUAL TABLE ${table} USING fts5(
      entity_type UNINDEXED,
      entity_id UNINDEXED,
      title,
      tokenize = '${tokenizer}'${substring ? ', detail = none' : ''}
    );

    CREATE TRIGGER artist_${prefix}_insert
    AFTER INSERT ON ArtistMetadata
    WHEN NEW.name IS NOT NULL
    BEGIN
      INSERT INTO ${table}(rowid, entity_type, entity_id, title)
      VALUES (NEW.id * 4, 'artist', CAST(NEW.id AS TEXT), NEW.name);
    END;
    CREATE TRIGGER artist_${prefix}_delete
    AFTER DELETE ON ArtistMetadata
    BEGIN
      DELETE FROM ${table} WHERE rowid = OLD.id * 4;
    END;
    CREATE TRIGGER artist_${prefix}_update
    AFTER UPDATE OF id, name ON ArtistMetadata
    WHEN OLD.id IS NOT NEW.id OR OLD.name IS NOT NEW.name
    BEGIN
      DELETE FROM ${table} WHERE rowid = OLD.id * 4;
      INSERT INTO ${table}(rowid, entity_type, entity_id, title)
      SELECT NEW.id * 4, 'artist', CAST(NEW.id AS TEXT), NEW.name WHERE NEW.name IS NOT NULL;
    END;

    CREATE TRIGGER album_${prefix}_insert
    AFTER INSERT ON Albums
    WHEN NEW.title IS NOT NULL
    BEGIN
      INSERT INTO ${table}(rowid, entity_type, entity_id, title)
      VALUES (NEW.id * 4 + 1, 'album', NEW.mbid, NEW.title);
    END;
    CREATE TRIGGER album_${prefix}_delete
    AFTER DELETE ON Albums
    BEGIN
      DELETE FROM ${table} WHERE rowid = OLD.id * 4 + 1;
    END;
    CREATE TRIGGER album_${prefix}_update
    AFTER UPDATE OF id, mbid, title ON Albums
    WHEN OLD.id IS NOT NEW.id OR OLD.mbid IS NOT NEW.mbid OR OLD.title IS NOT NEW.title
    BEGIN
      DELETE FROM ${table} WHERE rowid = OLD.id * 4 + 1;
      INSERT INTO ${table}(rowid, entity_type, entity_id, title)
      SELECT NEW.id * 4 + 1, 'album', NEW.mbid, NEW.title WHERE NEW.title IS NOT NULL;
    END;

    CREATE TRIGGER video_${prefix}_insert
    AFTER INSERT ON Recordings
    WHEN NEW.is_video = 1 AND NEW.title IS NOT NULL
    BEGIN
      INSERT INTO ${table}(rowid, entity_type, entity_id, title)
      VALUES (NEW.id * 4 + 2, 'video', CAST(NEW.id AS TEXT), NEW.title);
    END;
    CREATE TRIGGER video_${prefix}_delete
    AFTER DELETE ON Recordings
    WHEN OLD.is_video = 1
    BEGIN
      DELETE FROM ${table} WHERE rowid = OLD.id * 4 + 2;
    END;
    CREATE TRIGGER video_${prefix}_update
    AFTER UPDATE OF id, title, is_video ON Recordings
    WHEN (OLD.is_video = 1 OR NEW.is_video = 1)
      AND (OLD.id IS NOT NEW.id OR OLD.title IS NOT NEW.title OR OLD.is_video IS NOT NEW.is_video)
    BEGIN
      DELETE FROM ${table} WHERE rowid = OLD.id * 4 + 2;
      INSERT INTO ${table}(rowid, entity_type, entity_id, title)
      SELECT NEW.id * 4 + 2, 'video', CAST(NEW.id AS TEXT), NEW.title
      WHERE NEW.is_video = 1 AND NEW.title IS NOT NULL;
    END;
  `);
}

type SearchIndex = "TrackSearch" | "CatalogSearch" | "CatalogSubstringSearch";

/** Recreate derived indexes from canonical rows, never from damaged FTS blobs. */
export function rebuildSearchIndex(db: Database.Database, table: SearchIndex): void {
  db.transaction(() => {
    const catalogPrefix = table === "CatalogSubstringSearch" ? "catalog_substring_search" : "catalog_search";
    const prefixes = table === "TrackSearch"
      ? ["tracks_search", "library_editions_track_search"]
      : [`artist_${catalogPrefix}`, `album_${catalogPrefix}`, `video_${catalogPrefix}`];
    for (const prefix of prefixes) {
      for (const operation of ["insert", "update", "delete"]) {
        db.exec(`DROP TRIGGER IF EXISTS ${prefix}_${operation}`);
      }
    }
    db.exec(`DROP TABLE IF EXISTS ${table}`);
    if (table === "TrackSearch") {
      createTrackSearchIndex(db);
      db.exec(`INSERT INTO TrackSearch(rowid, track_mbid, recording_mbid, title)
        SELECT id, mbid, recording_mbid, title
        FROM Tracks
        WHERE title IS NOT NULL
          AND album_edition_id IN (SELECT DISTINCT edition_id FROM LibraryEditions)`);
    } else {
      createCatalogSearchIndex(db, table === "CatalogSubstringSearch");
      db.exec(`INSERT INTO ${table}(rowid, entity_type, entity_id, title)
        SELECT id * 4, 'artist', CAST(id AS TEXT), name FROM ArtistMetadata WHERE name IS NOT NULL;
        INSERT INTO ${table}(rowid, entity_type, entity_id, title)
        SELECT id * 4 + 1, 'album', mbid, title FROM Albums WHERE title IS NOT NULL;
        INSERT INTO ${table}(rowid, entity_type, entity_id, title)
        SELECT id * 4 + 2, 'video', CAST(id AS TEXT), title FROM Recordings WHERE is_video = 1 AND title IS NOT NULL`);
    }
    db.prepare(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`).run();
  })();
}

/**
 * Startup only, before workers open connections. Rebuild obsolete index formats
 * via a fast trigger-definition check without running a full FTS5
 * integrity-check write scan at boot (deep integrity checks run off the main
 * thread in CheckHealth and auto-rebuild damaged FTS tables).
 */
export function ensureSearchIndexes(db: Database.Database): string[] {
  const rebuilt: string[] = [];
  for (const [table, trigger, extraTrigger] of [
    ["TrackSearch", "tracks_search_delete", "library_editions_track_search_insert"],
    ["CatalogSearch", "artist_catalog_search_delete", null],
    ["CatalogSubstringSearch", "artist_catalog_substring_search_delete", null],
  ] as const) {
    const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
      .get(trigger) as { sql: string } | undefined;
    const extraExists = extraTrigger == null
      || Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(extraTrigger));
    if (!definition?.sql.includes("WHERE rowid = OLD.id") || !extraExists) {
      rebuildSearchIndex(db, table);
      rebuilt.push(table);
    }
  }
  return rebuilt;
}
