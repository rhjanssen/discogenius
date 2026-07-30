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

function createProjectionInvalidationTriggers(
  db: Database.Database,
  options: {
    prefix: string;
    stateTable: string;
    tables: readonly string[];
  },
): void {
  for (const table of options.tables) {
    const normalizedTableName = table.replace(/[^A-Za-z0-9_]/g, "");
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const suffix = operation === "INSERT" ? "ai" : operation === "UPDATE" ? "au" : "ad";
      db.exec(`
        CREATE TRIGGER ${options.prefix}_${normalizedTableName.toLowerCase()}_${suffix}
        AFTER ${operation} ON ${table}
        BEGIN
          DELETE FROM ${options.stateTable};
        END;
      `);
    }
  }
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
      included BOOLEAN NOT NULL DEFAULT 0,
      monitored BOOLEAN NOT NULL DEFAULT 0,
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
      ON AlbumLibraryIndex(included, monitored, popularity DESC, title, release_group_id);
    CREATE INDEX idx_album_library_release_date
      ON AlbumLibraryIndex(included, monitored, (first_release_date IS NULL), first_release_date DESC, title, release_group_id);
    CREATE INDEX idx_album_library_title
      ON AlbumLibraryIndex(included, monitored, title, release_group_id);
    CREATE INDEX idx_album_library_updated
      ON AlbumLibraryIndex(included, monitored, (album_updated_at IS NULL), album_updated_at DESC, title, release_group_id);
  `);

  createProjectionInvalidationTriggers(db, {
    prefix: "trg_album_library_invalidate",
    stateTable: "AlbumLibraryProjectionState",
    tables: [
      "Albums",
      "AlbumEditions",
      "LibraryAlbums",
      "LibraryEditions",
      "AcquisitionPlans",
      "AcquisitionPlanTracks",
      "ProviderItemAudioVariants",
    ],
  });

  // A genuinely empty database is already fully projected. Every authority
  // mutation invalidates this marker so the command worker can perform the
  // next set-based rebuild without delaying the write path.
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

  createProjectionInvalidationTriggers(db, {
    prefix: "trg_track_library_invalidate",
    stateTable: "TrackLibraryProjectionState",
    tables: [
      "Tracks",
      "Recordings",
      "TrackFiles",
      "AlbumEditions",
      "LibraryAlbums",
      "LibraryEditions",
      "AcquisitionPlans",
      "AcquisitionPlanTracks",
      "ProviderItemAudioVariants",
    ],
  });

  db.exec(`
    INSERT INTO TrackLibraryProjectionState (singleton_id, row_count, updated_at)
    SELECT 1, 0, CURRENT_TIMESTAMP
    WHERE NOT EXISTS (SELECT 1 FROM Tracks)
      AND NOT EXISTS (SELECT 1 FROM TrackLibraryProjectionState WHERE singleton_id = 1);
  `);
}
