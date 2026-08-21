import type Database from "better-sqlite3";

export function createArtistTopTrackProjectionSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE ArtistTopTracks (
      artist_metadata_id INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      recording_id INTEGER,
      popularity REAL NOT NULL DEFAULT 0,
      release_date TEXT,
      rank INTEGER NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (artist_metadata_id, track_id),
      UNIQUE (artist_metadata_id, rank),
      FOREIGN KEY(artist_metadata_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE,
      FOREIGN KEY(track_id) REFERENCES Tracks(id) ON DELETE CASCADE,
      FOREIGN KEY(recording_id) REFERENCES Recordings(id) ON DELETE CASCADE
    );

    CREATE TABLE ArtistTopTrackProjectionState (
      artist_metadata_id INTEGER PRIMARY KEY,
      row_count INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(artist_metadata_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_artist_top_tracks_rank
      ON ArtistTopTracks(artist_metadata_id, rank, track_id);
  `);
}

function dropProjectionInvalidationTriggers(
  db: Database.Database,
  prefix: string,
  tables: readonly string[],
): void {
  for (const table of tables) {
    const normalizedTableName = table.replace(/[^A-Za-z0-9_]/g, "").toLowerCase();
    for (const suffix of ["ai", "au", "ad"] as const) {
      db.exec(`DROP TRIGGER IF EXISTS ${prefix}_${normalizedTableName}_${suffix}`);
    }
  }
}

/**
 * Library lists page from LibraryAlbums / LibraryEditions, the way Lidarr pages
 * from Albums / Tracks: SQLite B-tree indexes on those tables update themselves
 * on write. A denormalized copy that we DELETE+rebuild is not required, and
 * wiping AlbumLibraryProjectionState on membership writes is what forced
 * Update Library Metadata to lock the database for minutes.
 *
 * These functions only drop the old invalidate/dirty triggers. Catalog hydrates
 * never needed to touch a projection marker.
 */
const OBSOLETE_PROJECTION_TRIGGER_TABLES = [
  "Albums",
  "AlbumEditions",
  "AcquisitionPlans",
  "AcquisitionPlanTracks",
  "ProviderItemAudioVariants",
  "TrackFiles",
  "Recordings",
  "Tracks",
  "LibraryAlbums",
  "LibraryEditions",
  "Libraries",
] as const;

export function syncAlbumLibraryProjectionInvalidationTriggers(db: Database.Database): void {
  dropProjectionInvalidationTriggers(
    db,
    "trg_album_library_invalidate",
    OBSOLETE_PROJECTION_TRIGGER_TABLES,
  );
  dropProjectionInvalidationTriggers(
    db,
    "trg_album_library_dirty",
    OBSOLETE_PROJECTION_TRIGGER_TABLES,
  );
}

export function syncTrackLibraryProjectionInvalidationTriggers(db: Database.Database): void {
  dropProjectionInvalidationTriggers(
    db,
    "trg_track_library_invalidate",
    OBSOLETE_PROJECTION_TRIGGER_TABLES,
  );
  dropProjectionInvalidationTriggers(
    db,
    "trg_track_library_dirty",
    OBSOLETE_PROJECTION_TRIGGER_TABLES,
  );
}

export function createAlbumLibraryProjectionSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE AlbumLibraryIndex (
      release_group_id INTEGER PRIMARY KEY,
      artist_mbid TEXT NOT NULL,
      title TEXT NOT NULL,
      popularity REAL NOT NULL DEFAULT 0,
      first_release_date TEXT,
      album_updated_at DATETIME,
      -- Row existence is the library statement. Rebuild only inserts albums
      -- that currently have a LibraryAlbums row; included stays 1 for those.
      included BOOLEAN NOT NULL DEFAULT 0,
      monitored_lock BOOLEAN NOT NULL DEFAULT 0,
      has_stereo_provider BOOLEAN NOT NULL DEFAULT 0,
      has_spatial_provider BOOLEAN NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(release_group_id) REFERENCES Albums(id) ON DELETE CASCADE
    );

    CREATE TABLE AlbumLibraryProjectionState (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      row_count INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX idx_album_library_popularity
      ON AlbumLibraryIndex(included, popularity DESC, title, release_group_id);
    CREATE INDEX idx_album_library_release_date
      ON AlbumLibraryIndex(included, (first_release_date IS NULL), first_release_date DESC, title, release_group_id);
    CREATE INDEX idx_album_library_title
      ON AlbumLibraryIndex(included, title, release_group_id);
    CREATE INDEX idx_album_library_updated
      ON AlbumLibraryIndex(included, (album_updated_at IS NULL), album_updated_at DESC, title, release_group_id);
  `);

  syncAlbumLibraryProjectionInvalidationTriggers(db);

  db.exec(`
    INSERT INTO AlbumLibraryProjectionState (singleton_id, row_count, updated_at)
    SELECT 1, 0, CURRENT_TIMESTAMP
    WHERE NOT EXISTS (SELECT 1 FROM Albums)
      AND NOT EXISTS (SELECT 1 FROM AlbumLibraryProjectionState WHERE singleton_id = 1);
  `);
}

export function createTrackLibraryProjectionSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE TrackLibraryIndex (
      track_id INTEGER PRIMARY KEY,
      album_edition_id INTEGER NOT NULL,
      recording_id INTEGER,
      popularity REAL NOT NULL DEFAULT 0,
      downloaded BOOLEAN NOT NULL DEFAULT 0,
      has_stereo BOOLEAN NOT NULL DEFAULT 0,
      has_spatial BOOLEAN NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(track_id) REFERENCES Tracks(id) ON DELETE CASCADE,
      FOREIGN KEY(album_edition_id) REFERENCES AlbumEditions(id) ON DELETE CASCADE,
      FOREIGN KEY(recording_id) REFERENCES Recordings(id) ON DELETE SET NULL
    );

    CREATE TABLE TrackLibraryProjectionState (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      row_count INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX idx_track_library_popularity
      ON TrackLibraryIndex(popularity DESC, track_id);
    CREATE INDEX idx_track_library_downloaded_popularity
      ON TrackLibraryIndex(downloaded, popularity DESC, track_id);
    CREATE INDEX idx_track_library_stereo_popularity
      ON TrackLibraryIndex(has_stereo, popularity DESC, track_id);
    CREATE INDEX idx_track_library_spatial_popularity
      ON TrackLibraryIndex(has_spatial, popularity DESC, track_id);
  `);

  syncTrackLibraryProjectionInvalidationTriggers(db);

  db.exec(`
    INSERT INTO TrackLibraryProjectionState (singleton_id, row_count, updated_at)
    SELECT 1, 0, CURRENT_TIMESTAMP
    WHERE NOT EXISTS (SELECT 1 FROM Tracks)
      AND NOT EXISTS (SELECT 1 FROM TrackLibraryProjectionState WHERE singleton_id = 1);
  `);
}
