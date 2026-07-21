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

    CREATE TRIGGER trg_album_library_album_ai
    AFTER INSERT ON Albums
    BEGIN
      INSERT INTO AlbumLibraryIndex (
        release_group_id, artist_mbid, title, popularity, first_release_date,
        album_updated_at, included, monitored, monitored_lock,
        has_stereo_provider, has_spatial_provider, updated_at
      ) VALUES (
        NEW.id, NEW.artist_mbid, NEW.title, COALESCE(NEW.popularity, 0), NEW.first_release_date,
        NEW.updated_at,
        CASE WHEN
          EXISTS (SELECT 1 FROM Artists imported_artist WHERE imported_artist.mbid = NEW.artist_mbid)
          AND EXISTS (
            SELECT 1
            FROM ArtistReleaseGroupCuration context
            JOIN Artists source_artist
              ON source_artist.mbid = context.source_artist_mbid
             AND source_artist.monitored = 1
            WHERE context.release_group_mbid = NEW.mbid
              AND context.included = 1
          ) THEN 1 ELSE 0 END,
        EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.release_group_mbid = NEW.mbid AND slot.monitored = 1),
        EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.release_group_mbid = NEW.mbid AND slot.monitored_lock = 1),
        EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.release_group_mbid = NEW.mbid AND slot.slot = 'stereo' AND slot.selected_provider_id IS NOT NULL),
        EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.release_group_mbid = NEW.mbid AND slot.slot = 'spatial' AND slot.selected_provider_id IS NOT NULL),
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(release_group_id) DO UPDATE SET
        artist_mbid = excluded.artist_mbid,
        title = excluded.title,
        popularity = excluded.popularity,
        first_release_date = excluded.first_release_date,
        album_updated_at = excluded.album_updated_at,
        included = excluded.included,
        monitored = excluded.monitored,
        monitored_lock = excluded.monitored_lock,
        has_stereo_provider = excluded.has_stereo_provider,
        has_spatial_provider = excluded.has_spatial_provider,
        updated_at = CURRENT_TIMESTAMP;
    END;

    CREATE TRIGGER trg_album_library_album_au
    AFTER UPDATE OF artist_mbid, mbid, title, popularity, first_release_date, updated_at ON Albums
    BEGIN
      UPDATE AlbumLibraryIndex
      SET artist_mbid = NEW.artist_mbid,
          title = NEW.title,
          popularity = COALESCE(NEW.popularity, 0),
          first_release_date = NEW.first_release_date,
          album_updated_at = NEW.updated_at,
          included = CASE WHEN
            EXISTS (SELECT 1 FROM Artists imported_artist WHERE imported_artist.mbid = NEW.artist_mbid)
            AND EXISTS (
              SELECT 1
              FROM ArtistReleaseGroupCuration context
              JOIN Artists source_artist
                ON source_artist.mbid = context.source_artist_mbid
               AND source_artist.monitored = 1
              WHERE context.release_group_mbid = NEW.mbid
                AND context.included = 1
            ) THEN 1 ELSE 0 END,
          updated_at = CURRENT_TIMESTAMP
      WHERE release_group_id = NEW.id;
    END;

    CREATE TRIGGER trg_album_library_curation_ai
    AFTER INSERT ON ArtistReleaseGroupCuration
    BEGIN
      UPDATE AlbumLibraryIndex
      SET included = CASE WHEN
        EXISTS (
          SELECT 1 FROM Albums album
          JOIN Artists imported_artist ON imported_artist.mbid = album.artist_mbid
          WHERE album.id = AlbumLibraryIndex.release_group_id
        )
        AND EXISTS (
          SELECT 1
          FROM ArtistReleaseGroupCuration context
          JOIN Artists source_artist
            ON source_artist.mbid = context.source_artist_mbid
           AND source_artist.monitored = 1
          WHERE context.release_group_id = AlbumLibraryIndex.release_group_id
            AND context.included = 1
        ) THEN 1 ELSE 0 END,
        updated_at = CURRENT_TIMESTAMP
      WHERE release_group_id = COALESCE(NEW.release_group_id, (SELECT id FROM Albums WHERE mbid = NEW.release_group_mbid));
    END;

    CREATE TRIGGER trg_album_library_curation_au
    AFTER UPDATE OF source_artist_mbid, release_group_mbid, release_group_id, included ON ArtistReleaseGroupCuration
    BEGIN
      UPDATE AlbumLibraryIndex
      SET included = CASE WHEN
        EXISTS (
          SELECT 1 FROM Albums album
          JOIN Artists imported_artist ON imported_artist.mbid = album.artist_mbid
          WHERE album.id = AlbumLibraryIndex.release_group_id
        )
        AND EXISTS (
          SELECT 1
          FROM ArtistReleaseGroupCuration context
          JOIN Artists source_artist
            ON source_artist.mbid = context.source_artist_mbid
           AND source_artist.monitored = 1
          WHERE context.release_group_id = AlbumLibraryIndex.release_group_id
            AND context.included = 1
        ) THEN 1 ELSE 0 END,
        updated_at = CURRENT_TIMESTAMP
      WHERE release_group_id IN (
        COALESCE(OLD.release_group_id, (SELECT id FROM Albums WHERE mbid = OLD.release_group_mbid)),
        COALESCE(NEW.release_group_id, (SELECT id FROM Albums WHERE mbid = NEW.release_group_mbid))
      );
    END;

    CREATE TRIGGER trg_album_library_curation_ad
    AFTER DELETE ON ArtistReleaseGroupCuration
    BEGIN
      UPDATE AlbumLibraryIndex
      SET included = CASE WHEN
        EXISTS (
          SELECT 1 FROM Albums album
          JOIN Artists imported_artist ON imported_artist.mbid = album.artist_mbid
          WHERE album.id = AlbumLibraryIndex.release_group_id
        )
        AND EXISTS (
          SELECT 1
          FROM ArtistReleaseGroupCuration context
          JOIN Artists source_artist
            ON source_artist.mbid = context.source_artist_mbid
           AND source_artist.monitored = 1
          WHERE context.release_group_id = AlbumLibraryIndex.release_group_id
            AND context.included = 1
        ) THEN 1 ELSE 0 END,
        updated_at = CURRENT_TIMESTAMP
      WHERE release_group_id = COALESCE(OLD.release_group_id, (SELECT id FROM Albums WHERE mbid = OLD.release_group_mbid));
    END;

    CREATE TRIGGER trg_album_library_slot_ai
    AFTER INSERT ON ReleaseGroupSlots
    BEGIN
      UPDATE AlbumLibraryIndex
      SET monitored = EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.release_group_id = AlbumLibraryIndex.release_group_id AND slot.monitored = 1),
          monitored_lock = EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.release_group_id = AlbumLibraryIndex.release_group_id AND slot.monitored_lock = 1),
          has_stereo_provider = EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.release_group_id = AlbumLibraryIndex.release_group_id AND slot.slot = 'stereo' AND slot.selected_provider_id IS NOT NULL),
          has_spatial_provider = EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.release_group_id = AlbumLibraryIndex.release_group_id AND slot.slot = 'spatial' AND slot.selected_provider_id IS NOT NULL),
          updated_at = CURRENT_TIMESTAMP
      WHERE release_group_id = COALESCE(NEW.release_group_id, (SELECT id FROM Albums WHERE mbid = NEW.release_group_mbid));
    END;

    CREATE TRIGGER trg_album_library_slot_au
    AFTER UPDATE OF release_group_mbid, release_group_id, slot, monitored, monitored_lock, selected_provider_id ON ReleaseGroupSlots
    BEGIN
      UPDATE AlbumLibraryIndex
      SET monitored = EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.release_group_id = AlbumLibraryIndex.release_group_id AND slot.monitored = 1),
          monitored_lock = EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.release_group_id = AlbumLibraryIndex.release_group_id AND slot.monitored_lock = 1),
          has_stereo_provider = EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.release_group_id = AlbumLibraryIndex.release_group_id AND slot.slot = 'stereo' AND slot.selected_provider_id IS NOT NULL),
          has_spatial_provider = EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.release_group_id = AlbumLibraryIndex.release_group_id AND slot.slot = 'spatial' AND slot.selected_provider_id IS NOT NULL),
          updated_at = CURRENT_TIMESTAMP
      WHERE release_group_id IN (
        COALESCE(OLD.release_group_id, (SELECT id FROM Albums WHERE mbid = OLD.release_group_mbid)),
        COALESCE(NEW.release_group_id, (SELECT id FROM Albums WHERE mbid = NEW.release_group_mbid))
      );
    END;

    CREATE TRIGGER trg_album_library_slot_ad
    AFTER DELETE ON ReleaseGroupSlots
    BEGIN
      UPDATE AlbumLibraryIndex
      SET monitored = EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.release_group_id = AlbumLibraryIndex.release_group_id AND slot.monitored = 1),
          monitored_lock = EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.release_group_id = AlbumLibraryIndex.release_group_id AND slot.monitored_lock = 1),
          has_stereo_provider = EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.release_group_id = AlbumLibraryIndex.release_group_id AND slot.slot = 'stereo' AND slot.selected_provider_id IS NOT NULL),
          has_spatial_provider = EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.release_group_id = AlbumLibraryIndex.release_group_id AND slot.slot = 'spatial' AND slot.selected_provider_id IS NOT NULL),
          updated_at = CURRENT_TIMESTAMP
      WHERE release_group_id = COALESCE(OLD.release_group_id, (SELECT id FROM Albums WHERE mbid = OLD.release_group_mbid));
    END;

    CREATE TRIGGER trg_album_library_artist_ai
    AFTER INSERT ON Artists
    BEGIN
      UPDATE AlbumLibraryIndex
      SET included = CASE WHEN
        EXISTS (SELECT 1 FROM Artists imported_artist WHERE imported_artist.mbid = AlbumLibraryIndex.artist_mbid)
        AND EXISTS (
          SELECT 1
          FROM ArtistReleaseGroupCuration context
          JOIN Artists source_artist
            ON source_artist.mbid = context.source_artist_mbid
           AND source_artist.monitored = 1
          WHERE context.release_group_id = AlbumLibraryIndex.release_group_id
            AND context.included = 1
        ) THEN 1 ELSE 0 END,
        updated_at = CURRENT_TIMESTAMP
      WHERE artist_mbid = NEW.mbid
         OR release_group_id IN (SELECT release_group_id FROM ArtistReleaseGroupCuration WHERE source_artist_mbid = NEW.mbid);
    END;

    CREATE TRIGGER trg_album_library_artist_au
    AFTER UPDATE OF mbid, monitored ON Artists
    BEGIN
      UPDATE AlbumLibraryIndex
      SET included = CASE WHEN
        EXISTS (SELECT 1 FROM Artists imported_artist WHERE imported_artist.mbid = AlbumLibraryIndex.artist_mbid)
        AND EXISTS (
          SELECT 1
          FROM ArtistReleaseGroupCuration context
          JOIN Artists source_artist
            ON source_artist.mbid = context.source_artist_mbid
           AND source_artist.monitored = 1
          WHERE context.release_group_id = AlbumLibraryIndex.release_group_id
            AND context.included = 1
        ) THEN 1 ELSE 0 END,
        updated_at = CURRENT_TIMESTAMP
      WHERE artist_mbid IN (OLD.mbid, NEW.mbid)
         OR release_group_id IN (
           SELECT release_group_id FROM ArtistReleaseGroupCuration
           WHERE source_artist_mbid IN (OLD.mbid, NEW.mbid)
         );
    END;

    CREATE TRIGGER trg_album_library_artist_ad
    AFTER DELETE ON Artists
    BEGIN
      UPDATE AlbumLibraryIndex
      SET included = CASE WHEN
        EXISTS (SELECT 1 FROM Artists imported_artist WHERE imported_artist.mbid = AlbumLibraryIndex.artist_mbid)
        AND EXISTS (
          SELECT 1
          FROM ArtistReleaseGroupCuration context
          JOIN Artists source_artist
            ON source_artist.mbid = context.source_artist_mbid
           AND source_artist.monitored = 1
          WHERE context.release_group_id = AlbumLibraryIndex.release_group_id
            AND context.included = 1
        ) THEN 1 ELSE 0 END,
        updated_at = CURRENT_TIMESTAMP
      WHERE artist_mbid = OLD.mbid
         OR release_group_id IN (SELECT release_group_id FROM ArtistReleaseGroupCuration WHERE source_artist_mbid = OLD.mbid);
    END;
  `);

  // A genuinely empty database is already fully projected; subsequent inserts
  // are maintained by the triggers above. Existing installations are left
  // unmarked so the command worker can perform the one-time set-based backfill
  // without delaying HTTP startup.
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
      album_release_id INTEGER NOT NULL,
      recording_id INTEGER,
      popularity REAL NOT NULL DEFAULT 0,
      downloaded BOOLEAN NOT NULL DEFAULT 0,
      has_stereo BOOLEAN NOT NULL DEFAULT 0,
      has_spatial BOOLEAN NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(track_id) REFERENCES Tracks(id) ON DELETE CASCADE,
      FOREIGN KEY(album_release_id) REFERENCES AlbumReleases(id) ON DELETE CASCADE,
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

    CREATE TRIGGER trg_track_library_track_ai
    AFTER INSERT ON Tracks
    BEGIN
      INSERT INTO TrackLibraryIndex (
        track_id, album_release_id, recording_id, popularity, downloaded,
        has_stereo, has_spatial, updated_at
      )
      SELECT
        NEW.id, NEW.album_release_id, NEW.recording_id, COALESCE(recording.popularity, 0),
        EXISTS (SELECT 1 FROM TrackFiles file WHERE file.track_id = NEW.id AND file.file_type = 'track'),
        EXISTS (
          SELECT 1 FROM ReleaseGroupSlots slot
          WHERE slot.selected_album_release_id = NEW.album_release_id
            AND slot.slot = 'stereo' AND slot.monitored = 1
            AND slot.selected_provider_id IS NOT NULL
        ),
        EXISTS (
          SELECT 1 FROM ReleaseGroupSlots slot
          WHERE slot.selected_album_release_id = NEW.album_release_id
            AND slot.slot = 'spatial' AND slot.monitored = 1
            AND slot.selected_provider_id IS NOT NULL
        ),
        CURRENT_TIMESTAMP
      FROM Recordings recording
      WHERE recording.id = NEW.recording_id
        AND EXISTS (
          SELECT 1 FROM ReleaseGroupSlots slot
          WHERE slot.selected_album_release_id = NEW.album_release_id
            AND slot.monitored = 1 AND slot.selected_provider_id IS NOT NULL
        )
      ON CONFLICT(track_id) DO UPDATE SET
        album_release_id = excluded.album_release_id,
        recording_id = excluded.recording_id,
        popularity = excluded.popularity,
        downloaded = excluded.downloaded,
        has_stereo = excluded.has_stereo,
        has_spatial = excluded.has_spatial,
        updated_at = CURRENT_TIMESTAMP;
    END;

    CREATE TRIGGER trg_track_library_track_au
    AFTER UPDATE OF album_release_id, recording_id ON Tracks
    BEGIN
      DELETE FROM TrackLibraryIndex WHERE track_id = NEW.id;
      INSERT INTO TrackLibraryIndex (
        track_id, album_release_id, recording_id, popularity, downloaded,
        has_stereo, has_spatial, updated_at
      )
      SELECT
        NEW.id, NEW.album_release_id, NEW.recording_id, COALESCE(recording.popularity, 0),
        EXISTS (SELECT 1 FROM TrackFiles file WHERE file.track_id = NEW.id AND file.file_type = 'track'),
        EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.selected_album_release_id = NEW.album_release_id AND slot.slot = 'stereo' AND slot.monitored = 1 AND slot.selected_provider_id IS NOT NULL),
        EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.selected_album_release_id = NEW.album_release_id AND slot.slot = 'spatial' AND slot.monitored = 1 AND slot.selected_provider_id IS NOT NULL),
        CURRENT_TIMESTAMP
      FROM Recordings recording
      WHERE recording.id = NEW.recording_id
        AND EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.selected_album_release_id = NEW.album_release_id AND slot.monitored = 1 AND slot.selected_provider_id IS NOT NULL);
    END;

    CREATE TRIGGER trg_track_library_recording_au
    AFTER UPDATE OF popularity ON Recordings
    BEGIN
      UPDATE TrackLibraryIndex
      SET popularity = COALESCE(NEW.popularity, 0), updated_at = CURRENT_TIMESTAMP
      WHERE recording_id = NEW.id;
    END;

    CREATE TRIGGER trg_track_library_slot_ai
    AFTER INSERT ON ReleaseGroupSlots
    WHEN NEW.selected_album_release_id IS NOT NULL
    BEGIN
      DELETE FROM TrackLibraryIndex WHERE album_release_id = NEW.selected_album_release_id;
      INSERT INTO TrackLibraryIndex (
        track_id, album_release_id, recording_id, popularity, downloaded,
        has_stereo, has_spatial, updated_at
      )
      SELECT
        track.id, track.album_release_id, track.recording_id, COALESCE(recording.popularity, 0),
        EXISTS (SELECT 1 FROM TrackFiles file WHERE file.track_id = track.id AND file.file_type = 'track'),
        EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.selected_album_release_id = track.album_release_id AND slot.slot = 'stereo' AND slot.monitored = 1 AND slot.selected_provider_id IS NOT NULL),
        EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.selected_album_release_id = track.album_release_id AND slot.slot = 'spatial' AND slot.monitored = 1 AND slot.selected_provider_id IS NOT NULL),
        CURRENT_TIMESTAMP
      FROM Tracks track
      LEFT JOIN Recordings recording ON recording.id = track.recording_id
      WHERE track.album_release_id = NEW.selected_album_release_id
        AND EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.selected_album_release_id = track.album_release_id AND slot.monitored = 1 AND slot.selected_provider_id IS NOT NULL);
    END;

    CREATE TRIGGER trg_track_library_slot_au
    AFTER UPDATE OF selected_album_release_id, selected_provider_id, monitored, slot ON ReleaseGroupSlots
    BEGIN
      DELETE FROM TrackLibraryIndex
      WHERE album_release_id IN (OLD.selected_album_release_id, NEW.selected_album_release_id);
      INSERT INTO TrackLibraryIndex (
        track_id, album_release_id, recording_id, popularity, downloaded,
        has_stereo, has_spatial, updated_at
      )
      SELECT
        track.id, track.album_release_id, track.recording_id, COALESCE(recording.popularity, 0),
        EXISTS (SELECT 1 FROM TrackFiles file WHERE file.track_id = track.id AND file.file_type = 'track'),
        EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.selected_album_release_id = track.album_release_id AND slot.slot = 'stereo' AND slot.monitored = 1 AND slot.selected_provider_id IS NOT NULL),
        EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.selected_album_release_id = track.album_release_id AND slot.slot = 'spatial' AND slot.monitored = 1 AND slot.selected_provider_id IS NOT NULL),
        CURRENT_TIMESTAMP
      FROM Tracks track
      LEFT JOIN Recordings recording ON recording.id = track.recording_id
      WHERE track.album_release_id IN (OLD.selected_album_release_id, NEW.selected_album_release_id)
        AND EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.selected_album_release_id = track.album_release_id AND slot.monitored = 1 AND slot.selected_provider_id IS NOT NULL);
    END;

    CREATE TRIGGER trg_track_library_slot_ad
    AFTER DELETE ON ReleaseGroupSlots
    WHEN OLD.selected_album_release_id IS NOT NULL
    BEGIN
      DELETE FROM TrackLibraryIndex WHERE album_release_id = OLD.selected_album_release_id;
      INSERT INTO TrackLibraryIndex (
        track_id, album_release_id, recording_id, popularity, downloaded,
        has_stereo, has_spatial, updated_at
      )
      SELECT
        track.id, track.album_release_id, track.recording_id, COALESCE(recording.popularity, 0),
        EXISTS (SELECT 1 FROM TrackFiles file WHERE file.track_id = track.id AND file.file_type = 'track'),
        EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.selected_album_release_id = track.album_release_id AND slot.slot = 'stereo' AND slot.monitored = 1 AND slot.selected_provider_id IS NOT NULL),
        EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.selected_album_release_id = track.album_release_id AND slot.slot = 'spatial' AND slot.monitored = 1 AND slot.selected_provider_id IS NOT NULL),
        CURRENT_TIMESTAMP
      FROM Tracks track
      LEFT JOIN Recordings recording ON recording.id = track.recording_id
      WHERE track.album_release_id = OLD.selected_album_release_id
        AND EXISTS (SELECT 1 FROM ReleaseGroupSlots slot WHERE slot.selected_album_release_id = track.album_release_id AND slot.monitored = 1 AND slot.selected_provider_id IS NOT NULL);
    END;

    CREATE TRIGGER trg_track_library_file_ai
    AFTER INSERT ON TrackFiles
    WHEN NEW.track_id IS NOT NULL AND NEW.file_type = 'track'
    BEGIN
      UPDATE TrackLibraryIndex SET downloaded = 1, updated_at = CURRENT_TIMESTAMP WHERE track_id = NEW.track_id;
    END;

    CREATE TRIGGER trg_track_library_file_au
    AFTER UPDATE OF track_id, file_type ON TrackFiles
    BEGIN
      UPDATE TrackLibraryIndex
      SET downloaded = EXISTS (SELECT 1 FROM TrackFiles file WHERE file.track_id = OLD.track_id AND file.file_type = 'track'),
          updated_at = CURRENT_TIMESTAMP
      WHERE track_id = OLD.track_id;
      UPDATE TrackLibraryIndex
      SET downloaded = EXISTS (SELECT 1 FROM TrackFiles file WHERE file.track_id = NEW.track_id AND file.file_type = 'track'),
          updated_at = CURRENT_TIMESTAMP
      WHERE track_id = NEW.track_id;
    END;

    CREATE TRIGGER trg_track_library_file_ad
    AFTER DELETE ON TrackFiles
    WHEN OLD.track_id IS NOT NULL AND OLD.file_type = 'track'
    BEGIN
      UPDATE TrackLibraryIndex
      SET downloaded = EXISTS (SELECT 1 FROM TrackFiles file WHERE file.track_id = OLD.track_id AND file.file_type = 'track'),
          updated_at = CURRENT_TIMESTAMP
      WHERE track_id = OLD.track_id;
    END;
  `);

  db.exec(`
    INSERT INTO TrackLibraryProjectionState (singleton_id, row_count, updated_at)
    SELECT 1, 0, CURRENT_TIMESTAMP
    WHERE NOT EXISTS (SELECT 1 FROM Tracks)
      AND NOT EXISTS (SELECT 1 FROM TrackLibraryProjectionState WHERE singleton_id = 1);
  `);
}
