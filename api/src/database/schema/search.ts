import type Database from "better-sqlite3";

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
    BEGIN
      INSERT INTO TrackSearch(track_mbid, recording_mbid, title)
      VALUES (NEW.mbid, NEW.recording_mbid, NEW.title);
    END;

    CREATE TRIGGER tracks_search_delete
    AFTER DELETE ON Tracks
    BEGIN
      DELETE FROM TrackSearch WHERE track_mbid = OLD.mbid;
    END;

    CREATE TRIGGER tracks_search_update
    AFTER UPDATE OF mbid, recording_mbid, title ON Tracks
    BEGIN
      DELETE FROM TrackSearch WHERE track_mbid = OLD.mbid;
      INSERT INTO TrackSearch(track_mbid, recording_mbid, title)
      SELECT NEW.mbid, NEW.recording_mbid, NEW.title
      WHERE NEW.title IS NOT NULL;
    END;
  `);
}

export function createCatalogSearchIndex(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE CatalogSearch USING fts5(
      entity_type UNINDEXED,
      entity_id UNINDEXED,
      title,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER artist_catalog_search_insert
    AFTER INSERT ON ArtistMetadata
    WHEN NEW.name IS NOT NULL
    BEGIN
      INSERT INTO CatalogSearch(entity_type, entity_id, title)
      VALUES ('artist', CAST(NEW.id AS TEXT), NEW.name);
    END;
    CREATE TRIGGER artist_catalog_search_delete
    AFTER DELETE ON ArtistMetadata
    BEGIN
      DELETE FROM CatalogSearch WHERE entity_type = 'artist' AND entity_id = CAST(OLD.id AS TEXT);
    END;
    CREATE TRIGGER artist_catalog_search_update
    AFTER UPDATE OF id, name ON ArtistMetadata
    BEGIN
      DELETE FROM CatalogSearch WHERE entity_type = 'artist' AND entity_id = CAST(OLD.id AS TEXT);
      INSERT INTO CatalogSearch(entity_type, entity_id, title)
      SELECT 'artist', CAST(NEW.id AS TEXT), NEW.name WHERE NEW.name IS NOT NULL;
    END;

    CREATE TRIGGER album_catalog_search_insert
    AFTER INSERT ON Albums
    WHEN NEW.title IS NOT NULL
    BEGIN
      INSERT INTO CatalogSearch(entity_type, entity_id, title)
      VALUES ('album', NEW.mbid, NEW.title);
    END;
    CREATE TRIGGER album_catalog_search_delete
    AFTER DELETE ON Albums
    BEGIN
      DELETE FROM CatalogSearch WHERE entity_type = 'album' AND entity_id = OLD.mbid;
    END;
    CREATE TRIGGER album_catalog_search_update
    AFTER UPDATE OF mbid, title ON Albums
    BEGIN
      DELETE FROM CatalogSearch WHERE entity_type = 'album' AND entity_id = OLD.mbid;
      INSERT INTO CatalogSearch(entity_type, entity_id, title)
      SELECT 'album', NEW.mbid, NEW.title WHERE NEW.title IS NOT NULL;
    END;

    CREATE TRIGGER video_catalog_search_insert
    AFTER INSERT ON Recordings
    WHEN NEW.is_video = 1 AND NEW.title IS NOT NULL
    BEGIN
      INSERT INTO CatalogSearch(entity_type, entity_id, title)
      VALUES ('video', CAST(NEW.id AS TEXT), NEW.title);
    END;
    CREATE TRIGGER video_catalog_search_delete
    AFTER DELETE ON Recordings
    WHEN OLD.is_video = 1
    BEGIN
      DELETE FROM CatalogSearch WHERE entity_type = 'video' AND entity_id = CAST(OLD.id AS TEXT);
    END;
    CREATE TRIGGER video_catalog_search_update
    AFTER UPDATE OF id, title, is_video ON Recordings
    BEGIN
      DELETE FROM CatalogSearch WHERE entity_type = 'video' AND entity_id = CAST(OLD.id AS TEXT);
      INSERT INTO CatalogSearch(entity_type, entity_id, title)
      SELECT 'video', CAST(NEW.id AS TEXT), NEW.title
      WHERE NEW.is_video = 1 AND NEW.title IS NOT NULL;
    END;
  `);
}
