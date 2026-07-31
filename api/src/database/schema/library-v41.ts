import type Database from "better-sqlite3";

export function createCanonicalCreditSchemaV41(db: Database.Database): void {
  db.exec(`
    CREATE TABLE ReleaseGroupArtistCredits (
      release_group_id INTEGER NOT NULL,
      artist_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      credited_name TEXT NOT NULL,
      join_phrase TEXT NOT NULL DEFAULT '',
      role TEXT,
      PRIMARY KEY(release_group_id, ordinal),
      FOREIGN KEY(release_group_id) REFERENCES Albums(id) ON DELETE CASCADE,
      FOREIGN KEY(artist_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE
    );

    CREATE TABLE ReleaseArtistCredits (
      edition_id INTEGER NOT NULL,
      artist_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      credited_name TEXT NOT NULL,
      join_phrase TEXT NOT NULL DEFAULT '',
      role TEXT,
      PRIMARY KEY(edition_id, ordinal),
      FOREIGN KEY(edition_id) REFERENCES AlbumEditions(id) ON DELETE CASCADE,
      FOREIGN KEY(artist_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE
    );

    CREATE TABLE TrackArtistCredits (
      track_id INTEGER NOT NULL,
      artist_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      credited_name TEXT NOT NULL,
      join_phrase TEXT NOT NULL DEFAULT '',
      role TEXT,
      PRIMARY KEY(track_id, ordinal),
      FOREIGN KEY(track_id) REFERENCES Tracks(id) ON DELETE CASCADE,
      FOREIGN KEY(artist_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE
    );

    CREATE TABLE RecordingArtistCredits (
      recording_id INTEGER NOT NULL,
      artist_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      credited_name TEXT NOT NULL,
      join_phrase TEXT NOT NULL DEFAULT '',
      role TEXT,
      PRIMARY KEY(recording_id, ordinal),
      FOREIGN KEY(recording_id) REFERENCES Recordings(id) ON DELETE CASCADE,
      FOREIGN KEY(artist_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_rg_credits_artist
      ON ReleaseGroupArtistCredits(artist_id, release_group_id);
    CREATE INDEX idx_release_credits_artist
      ON ReleaseArtistCredits(artist_id, edition_id);
    CREATE INDEX idx_track_credits_artist
      ON TrackArtistCredits(artist_id, track_id);
    CREATE INDEX idx_recording_credits_artist
      ON RecordingArtistCredits(artist_id, recording_id);
  `);
}

export function createLibrarySchemaV41(db: Database.Database): void {
  db.exec(`
    CREATE TABLE ManagedArtists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_id INTEGER NOT NULL UNIQUE,
      path TEXT,
      library_origin TEXT NOT NULL DEFAULT 'user',
      metadata_status TEXT,
      metadata_last_checked_at DATETIME,
      metadata_match_method TEXT,
      added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(artist_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE
    );

    CREATE TABLE MetadataProfiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      release_type_policy TEXT NOT NULL,
      explicit_policy TEXT NOT NULL DEFAULT 'allow',
      require_provider_availability BOOLEAN NOT NULL DEFAULT 1,
      redundancy_enabled BOOLEAN NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE Libraries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      root_path TEXT NOT NULL,
      metadata_profile_id INTEGER NOT NULL,
      quality_profile_id INTEGER NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(metadata_profile_id) REFERENCES MetadataProfiles(id),
      FOREIGN KEY(quality_profile_id) REFERENCES quality_profiles(id)
    );

    CREATE TABLE LibraryArtists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL,
      managed_artist_id INTEGER NOT NULL,
      monitored BOOLEAN NOT NULL DEFAULT 1,
      credited_scope TEXT NOT NULL DEFAULT 'primary_only'
        CHECK(credited_scope IN ('primary_only', 'release_credit', 'release_and_track_credit')),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(library_id, managed_artist_id),
      FOREIGN KEY(library_id) REFERENCES Libraries(id) ON DELETE CASCADE,
      FOREIGN KEY(managed_artist_id) REFERENCES ManagedArtists(id) ON DELETE CASCADE
    );

    CREATE TABLE LibraryAlbums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL,
      release_group_id INTEGER NOT NULL,
      monitored BOOLEAN NOT NULL DEFAULT 1,
      selection_mode TEXT NOT NULL CHECK(selection_mode IN ('auto', 'manual')),
      locked BOOLEAN NOT NULL DEFAULT 0,
      reason TEXT,
      curation_version INTEGER NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(library_id, release_group_id),
      FOREIGN KEY(library_id) REFERENCES Libraries(id) ON DELETE CASCADE,
      FOREIGN KEY(release_group_id) REFERENCES Albums(id) ON DELETE CASCADE
    );

    CREATE TABLE LibraryEditions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL,
      edition_id INTEGER NOT NULL,
      selection_mode TEXT NOT NULL CHECK(selection_mode IN ('auto', 'manual')),
      locked BOOLEAN NOT NULL DEFAULT 0,
      reason TEXT,
      curation_version INTEGER NOT NULL,
      selected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(library_id, edition_id),
      FOREIGN KEY(library_id) REFERENCES Libraries(id) ON DELETE CASCADE,
      FOREIGN KEY(edition_id) REFERENCES AlbumEditions(id) ON DELETE CASCADE
    );

    CREATE TABLE LibraryEditionScopes (
      library_edition_id INTEGER NOT NULL,
      library_artist_id INTEGER NOT NULL,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('primary', 'release_credit', 'track_credit')),
      reason TEXT,
      PRIMARY KEY(library_edition_id, library_artist_id, scope_type),
      FOREIGN KEY(library_edition_id) REFERENCES LibraryEditions(id) ON DELETE CASCADE,
      FOREIGN KEY(library_artist_id) REFERENCES LibraryArtists(id) ON DELETE CASCADE
    );

    CREATE TABLE AcquisitionPlans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_edition_id INTEGER NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      composition TEXT NOT NULL CHECK(composition IN ('single_source', 'composite')),
      download_mode TEXT NOT NULL CHECK(download_mode IN ('album', 'tracks')),
      state TEXT NOT NULL CHECK(state IN ('current', 'stale', 'unavailable', 'failed')),
      planner_version INTEGER NOT NULL,
      policy_hash TEXT NOT NULL,
      computed_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(library_edition_id) REFERENCES LibraryEditions(id) ON DELETE CASCADE
    );

    CREATE TABLE AcquisitionPlanSources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      provider_edition_match_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('primary', 'supplement')),
      sort_order INTEGER NOT NULL,
      UNIQUE(plan_id, provider_edition_match_id),
      FOREIGN KEY(plan_id) REFERENCES AcquisitionPlans(id) ON DELETE CASCADE,
      FOREIGN KEY(provider_edition_match_id) REFERENCES ProviderEditionMatches(id)
    );

    CREATE TABLE AcquisitionPlanTracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      source_id INTEGER NOT NULL,
      provider_track_match_id INTEGER NOT NULL,
      provider_audio_variant_id INTEGER NOT NULL,
      source_quality_snapshot TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(plan_id, track_id),
      UNIQUE(plan_id, provider_track_match_id),
      FOREIGN KEY(plan_id) REFERENCES AcquisitionPlans(id) ON DELETE CASCADE,
      FOREIGN KEY(track_id) REFERENCES Tracks(id),
      FOREIGN KEY(source_id) REFERENCES AcquisitionPlanSources(id),
      FOREIGN KEY(provider_track_match_id) REFERENCES ProviderTrackMatches(id),
      FOREIGN KEY(provider_audio_variant_id) REFERENCES ProviderItemAudioVariants(id)
    );

    CREATE TABLE MediaCoverSelections (
      release_group_id INTEGER PRIMARY KEY,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('manual', 'canonical', 'provider')),
      selection_revision TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_identity TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(release_group_id) REFERENCES Albums(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_managed_artists_artist ON ManagedArtists(artist_id);
    CREATE INDEX idx_libraries_root_path ON Libraries(root_path, enabled, id);
    CREATE INDEX idx_library_artists_library
      ON LibraryArtists(library_id, monitored, managed_artist_id);
    CREATE INDEX idx_library_release_groups_library
      ON LibraryAlbums(library_id, monitored, release_group_id);
    CREATE INDEX idx_library_releases_library
      ON LibraryEditions(library_id, edition_id);
    CREATE INDEX idx_library_release_scopes_artist
      ON LibraryEditionScopes(library_artist_id, scope_type, library_edition_id);
    CREATE INDEX idx_acquisition_sources_plan
      ON AcquisitionPlanSources(plan_id, sort_order);
    CREATE INDEX idx_acquisition_tracks_plan
      ON AcquisitionPlanTracks(plan_id, track_id);
    CREATE INDEX idx_acquisition_tracks_source
      ON AcquisitionPlanTracks(source_id, track_id);
    CREATE INDEX idx_acquisition_tracks_match
      ON AcquisitionPlanTracks(provider_track_match_id);
    CREATE INDEX idx_track_files_library_track
      ON TrackFiles(library_id, track_id);
    CREATE INDEX idx_track_files_library_recording
      ON TrackFiles(library_id, recording_id);
    CREATE INDEX idx_track_files_library_release
      ON TrackFiles(library_id, album_edition_id);
  `);
}
