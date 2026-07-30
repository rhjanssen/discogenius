import type Database from "better-sqlite3";

export function createTrackFileForeignKeyTriggers(db: Database.Database): void {
  const body = `
    UPDATE TrackFiles SET
      release_group_id = COALESCE(release_group_id, (SELECT id FROM Albums WHERE mbid = NEW.canonical_release_group_mbid)),
      album_edition_id = COALESCE(album_edition_id, (SELECT id FROM AlbumEditions WHERE mbid = NEW.canonical_release_mbid)),
      track_id = COALESCE(track_id, (SELECT id FROM Tracks WHERE mbid = NEW.canonical_track_mbid)),
      recording_id = COALESCE(
        recording_id,
        (SELECT id FROM Recordings WHERE mbid = NEW.canonical_recording_mbid),
        (SELECT video_match.recording_id
           FROM ProviderItems pi
           JOIN ProviderVideoMatches video_match
             ON video_match.provider_video_item_id = pi.id
            AND video_match.match_state = 'accepted'
           WHERE pi.entity_type = 'video'
             AND NEW.file_type = 'video'
             AND pi.provider = NEW.provider
             AND CAST(pi.provider_id AS TEXT) = CAST(NEW.provider_id AS TEXT)
           LIMIT 1)
      )
    WHERE id = NEW.id;
  `;
  db.exec(`
    CREATE TRIGGER trg_trackfiles_canonical_fks_ai
    AFTER INSERT ON TrackFiles
    BEGIN ${body} END;
    CREATE TRIGGER trg_trackfiles_canonical_fks_au
    AFTER UPDATE OF canonical_release_group_mbid, canonical_release_mbid,
                    canonical_track_mbid, canonical_recording_mbid, provider,
                    provider_id, file_type
    ON TrackFiles
    BEGIN ${body} END;
  `);
}

export function createMetadataIdentitySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE metadata_identity_status (
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

export function createExtraFileSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE MetadataFiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_id TEXT NOT NULL,
      track_file_id INTEGER,
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
      canonical_artist_mbid TEXT,
      canonical_release_group_mbid TEXT,
      canonical_release_mbid TEXT,
      canonical_track_mbid TEXT,
      canonical_recording_mbid TEXT,
      expected_path TEXT,
      needs_rename BOOLEAN NOT NULL DEFAULT 0,
      FOREIGN KEY(track_file_id) REFERENCES TrackFiles(id) ON DELETE SET NULL
    );

    CREATE TABLE LyricFiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_id TEXT NOT NULL,
      track_file_id INTEGER,
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

    CREATE TABLE ExtraFiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_id TEXT NOT NULL,
      track_file_id INTEGER,
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
      canonical_artist_mbid TEXT,
      canonical_release_group_mbid TEXT,
      canonical_release_mbid TEXT,
      canonical_track_mbid TEXT,
      canonical_recording_mbid TEXT,
      expected_path TEXT,
      needs_rename BOOLEAN NOT NULL DEFAULT 0,
      FOREIGN KEY(track_file_id) REFERENCES TrackFiles(id) ON DELETE SET NULL
    );

    CREATE INDEX idx_metadata_files_artist ON MetadataFiles(artist_id, type);
    CREATE INDEX idx_metadata_files_file_type ON MetadataFiles(file_type);
    CREATE INDEX idx_metadata_files_track_file ON MetadataFiles(track_file_id);
    CREATE INDEX idx_metadata_files_provider ON MetadataFiles(provider, provider_entity_type, provider_id);
    CREATE INDEX idx_metadata_files_canonical_release_group ON MetadataFiles(canonical_release_group_mbid, file_type);
    CREATE INDEX idx_metadata_files_canonical_track ON MetadataFiles(canonical_track_mbid, file_type);
    CREATE INDEX idx_metadata_files_canonical_recording ON MetadataFiles(canonical_recording_mbid, file_type);
    CREATE INDEX idx_lyric_files_artist ON LyricFiles(artist_id);
    CREATE INDEX idx_lyric_files_track_file ON LyricFiles(track_file_id);
    CREATE INDEX idx_lyric_files_provider ON LyricFiles(provider, provider_entity_type, provider_id);
    CREATE INDEX idx_lyric_files_recording ON LyricFiles(canonical_recording_mbid);
    CREATE INDEX idx_lyric_files_expected_path ON LyricFiles(expected_path);
    CREATE INDEX idx_extra_files_artist ON ExtraFiles(artist_id, file_type);
    CREATE INDEX idx_extra_files_track_file ON ExtraFiles(track_file_id);
    CREATE INDEX idx_extra_files_canonical_release_group ON ExtraFiles(canonical_release_group_mbid, file_type);
    CREATE INDEX idx_extra_files_canonical_track ON ExtraFiles(canonical_track_mbid, file_type);
    CREATE INDEX idx_extra_files_canonical_recording ON ExtraFiles(canonical_recording_mbid, file_type);
    CREATE INDEX idx_extra_files_expected_path ON ExtraFiles(expected_path);
    CREATE INDEX idx_metadata_files_expected_path ON MetadataFiles(expected_path);
  `);
}

export function createMediaCoverProxyCacheSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE MediaCoverProxyCache (
      hash TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
  db.exec("CREATE INDEX idx_media_cover_proxy_expires ON MediaCoverProxyCache(expires_at)");
}
