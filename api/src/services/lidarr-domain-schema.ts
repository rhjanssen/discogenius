import type Database from "better-sqlite3";

export const LIDARR_LIBRARY_TYPES = ["stereo", "atmos"] as const;
export type LidarrLibraryType = (typeof LIDARR_LIBRARY_TYPES)[number];

export const VIDEO_LIBRARY_TYPE = "video" as const;
export type DiscogeniusLibraryType = LidarrLibraryType | typeof VIDEO_LIBRARY_TYPE;

export function createLidarrDomainTables(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS artist_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      foreign_artist_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      sort_name TEXT,
      disambiguation TEXT,
      overview TEXT,
      images TEXT,
      links TEXT,
      genres TEXT,
      ratings TEXT,
      status TEXT,
      last_info_sync DATETIME,
      data TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS managed_artists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_metadata_id INTEGER NOT NULL UNIQUE,
      clean_name TEXT,
      sort_name TEXT,
      monitored BOOLEAN NOT NULL DEFAULT 0,
      monitor_new_items TEXT NOT NULL DEFAULT 'none',
      last_info_sync DATETIME,
      path TEXT,
      root_folder_path TEXT,
      added DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      quality_profile_id INTEGER,
      metadata_profile_id INTEGER,
      tags TEXT,
      FOREIGN KEY (artist_metadata_id) REFERENCES artist_metadata(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS release_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_metadata_id INTEGER NOT NULL,
      foreign_release_group_id TEXT NOT NULL UNIQUE,
      old_foreign_release_group_ids TEXT,
      title TEXT NOT NULL,
      overview TEXT,
      disambiguation TEXT,
      release_date TEXT,
      images TEXT,
      links TEXT,
      genres TEXT,
      album_type TEXT NOT NULL,
      secondary_types TEXT,
      ratings TEXT,
      clean_title TEXT,
      monitored BOOLEAN NOT NULL DEFAULT 0,
      any_release_ok BOOLEAN NOT NULL DEFAULT 0,
      last_info_sync DATETIME,
      last_search_time DATETIME,
      added DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      profile_id INTEGER,
      FOREIGN KEY (artist_metadata_id) REFERENCES artist_metadata(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS album_releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      release_group_id INTEGER NOT NULL,
      foreign_release_id TEXT NOT NULL UNIQUE,
      old_foreign_release_ids TEXT,
      title TEXT NOT NULL,
      status TEXT,
      duration INT,
      label TEXT,
      disambiguation TEXT,
      country TEXT,
      release_date TEXT,
      media TEXT,
      track_count INT NOT NULL DEFAULT 0,
      monitored BOOLEAN NOT NULL DEFAULT 0,
      FOREIGN KEY (release_group_id) REFERENCES release_groups(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      foreign_track_id TEXT NOT NULL UNIQUE,
      old_foreign_track_ids TEXT,
      foreign_recording_id TEXT,
      old_foreign_recording_ids TEXT,
      album_release_id INTEGER NOT NULL,
      artist_metadata_id INTEGER NOT NULL,
      track_number TEXT,
      absolute_track_number INT NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      duration INT,
      explicit BOOLEAN NOT NULL DEFAULT 0,
      ratings TEXT,
      medium_number INT NOT NULL DEFAULT 1,
      track_file_id INTEGER,
      isrcs TEXT,
      FOREIGN KEY (album_release_id) REFERENCES album_releases(id) ON DELETE CASCADE,
      FOREIGN KEY (artist_metadata_id) REFERENCES artist_metadata(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS release_group_monitoring (
      release_group_id INTEGER NOT NULL,
      library_type TEXT NOT NULL CHECK (library_type IN ('stereo', 'atmos')),
      monitored BOOLEAN NOT NULL DEFAULT 0,
      selected_release_id INTEGER,
      monitor_lock BOOLEAN NOT NULL DEFAULT 0,
      monitored_at DATETIME,
      redundancy_state TEXT NOT NULL DEFAULT 'selected',
      redundant_to_release_group_id INTEGER,
      redundancy_reason TEXT,
      PRIMARY KEY (release_group_id, library_type),
      FOREIGN KEY (release_group_id) REFERENCES release_groups(id) ON DELETE CASCADE,
      FOREIGN KEY (selected_release_id) REFERENCES album_releases(id) ON DELETE SET NULL,
      FOREIGN KEY (redundant_to_release_group_id) REFERENCES release_groups(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS track_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_id INTEGER,
      release_group_id INTEGER,
      album_release_id INTEGER,
      track_id INTEGER,
      library_type TEXT NOT NULL CHECK (library_type IN ('stereo', 'atmos')),
      file_path TEXT NOT NULL UNIQUE,
      relative_path TEXT NOT NULL,
      library_root TEXT NOT NULL,
      quality TEXT,
      format TEXT,
      size INT,
      duration INT,
      bitrate INT,
      sample_rate INT,
      bit_depth INT,
      channels INT,
      codec TEXT,
      fingerprint TEXT,
      original_filename TEXT,
      release_group_name TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      modified_at DATETIME,
      verified_at DATETIME,
      FOREIGN KEY (artist_id) REFERENCES managed_artists(id) ON DELETE SET NULL,
      FOREIGN KEY (release_group_id) REFERENCES release_groups(id) ON DELETE SET NULL,
      FOREIGN KEY (album_release_id) REFERENCES album_releases(id) ON DELETE SET NULL,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS provider_releases (
      provider TEXT NOT NULL,
      provider_release_id TEXT NOT NULL,
      release_group_id INTEGER,
      album_release_id INTEGER,
      library_type TEXT NOT NULL CHECK (library_type IN ('stereo', 'atmos')),
      title TEXT NOT NULL,
      artist_name TEXT,
      barcode TEXT,
      quality TEXT,
      explicit BOOLEAN,
      track_count INT,
      duration INT,
      availability TEXT,
      match_method TEXT,
      confidence REAL,
      score REAL,
      data TEXT,
      fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (provider, provider_release_id, library_type),
      FOREIGN KEY (release_group_id) REFERENCES release_groups(id) ON DELETE SET NULL,
      FOREIGN KEY (album_release_id) REFERENCES album_releases(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS provider_tracks (
      provider TEXT NOT NULL,
      provider_track_id TEXT NOT NULL,
      provider_release_id TEXT,
      library_type TEXT NOT NULL CHECK (library_type IN ('stereo', 'atmos')),
      track_id INTEGER,
      title TEXT NOT NULL,
      isrc TEXT,
      quality TEXT,
      streamable BOOLEAN NOT NULL DEFAULT 1,
      explicit BOOLEAN,
      duration INT,
      data TEXT,
      fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (provider, provider_track_id, library_type),
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_metadata_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      foreign_video_id TEXT,
      clean_title TEXT,
      release_date TEXT,
      duration INT,
      explicit BOOLEAN NOT NULL DEFAULT 0,
      monitored BOOLEAN NOT NULL DEFAULT 0,
      monitor_lock BOOLEAN NOT NULL DEFAULT 0,
      monitored_at DATETIME,
      images TEXT,
      ratings TEXT,
      data TEXT,
      FOREIGN KEY (artist_metadata_id) REFERENCES artist_metadata(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS provider_videos (
      provider TEXT NOT NULL,
      provider_video_id TEXT NOT NULL,
      video_id INTEGER,
      title TEXT NOT NULL,
      artist_name TEXT,
      quality TEXT,
      streamable BOOLEAN NOT NULL DEFAULT 1,
      duration INT,
      data TEXT,
      fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (provider, provider_video_id),
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS video_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_id INTEGER,
      video_id INTEGER,
      file_path TEXT NOT NULL UNIQUE,
      relative_path TEXT NOT NULL,
      library_root TEXT NOT NULL,
      quality TEXT,
      format TEXT,
      size INT,
      duration INT,
      width INT,
      height INT,
      codec TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      modified_at DATETIME,
      verified_at DATETIME,
      FOREIGN KEY (artist_id) REFERENCES managed_artists(id) ON DELETE SET NULL,
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_artist_metadata_foreign_artist_id ON artist_metadata(foreign_artist_id);
    CREATE INDEX IF NOT EXISTS idx_managed_artists_metadata ON managed_artists(artist_metadata_id);
    CREATE INDEX IF NOT EXISTS idx_managed_artists_monitored ON managed_artists(monitored);
    CREATE INDEX IF NOT EXISTS idx_release_groups_artist ON release_groups(artist_metadata_id);
    CREATE INDEX IF NOT EXISTS idx_release_groups_foreign_id ON release_groups(foreign_release_group_id);
    CREATE INDEX IF NOT EXISTS idx_release_groups_monitored ON release_groups(monitored);
    CREATE INDEX IF NOT EXISTS idx_album_releases_group ON album_releases(release_group_id);
    CREATE INDEX IF NOT EXISTS idx_album_releases_foreign_id ON album_releases(foreign_release_id);
    CREATE INDEX IF NOT EXISTS idx_album_releases_monitored ON album_releases(monitored);
    CREATE INDEX IF NOT EXISTS idx_tracks_release ON tracks(album_release_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_recording ON tracks(foreign_recording_id);
    CREATE INDEX IF NOT EXISTS idx_release_group_monitoring_selected_release ON release_group_monitoring(selected_release_id);
    CREATE INDEX IF NOT EXISTS idx_release_group_monitoring_library ON release_group_monitoring(library_type, monitored);
    CREATE INDEX IF NOT EXISTS idx_release_group_monitoring_redundant ON release_group_monitoring(redundant_to_release_group_id);
    CREATE INDEX IF NOT EXISTS idx_track_files_track_library ON track_files(track_id, library_type);
    CREATE INDEX IF NOT EXISTS idx_track_files_release_library ON track_files(album_release_id, library_type);
    CREATE INDEX IF NOT EXISTS idx_provider_releases_release_library ON provider_releases(album_release_id, library_type);
    CREATE INDEX IF NOT EXISTS idx_provider_releases_provider_release ON provider_releases(provider, provider_release_id);
    CREATE INDEX IF NOT EXISTS idx_provider_tracks_track_library ON provider_tracks(track_id, library_type);
    CREATE INDEX IF NOT EXISTS idx_videos_artist ON videos(artist_metadata_id);
    CREATE INDEX IF NOT EXISTS idx_videos_monitored ON videos(monitored);
    CREATE INDEX IF NOT EXISTS idx_provider_videos_video ON provider_videos(video_id);
    CREATE INDEX IF NOT EXISTS idx_video_files_video ON video_files(video_id);
  `);
}
