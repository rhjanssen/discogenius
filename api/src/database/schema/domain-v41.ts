import type Database from "better-sqlite3";

/**
 * Clean schema-41 domain baseline.
 *
 * This function deliberately contains no compatibility tables or migrations.
 * It is executable in isolation so the target model can be contract-tested
 * before database.ts switches the production baseline to it.
 */
export function createDomainSchemaV41(db: Database.Database): void {
  db.exec(`
    CREATE TABLE ArtistMetadata (
      id INTEGER PRIMARY KEY,
      mbid TEXT NOT NULL UNIQUE,
      foreign_artist_id TEXT UNIQUE,
      name TEXT NOT NULL,
      sort_name TEXT,
      disambiguation TEXT,
      type TEXT,
      country TEXT,
      begin_date TEXT,
      end_date TEXT,
      picture TEXT,
      cover_image_url TEXT,
      popularity INTEGER,
      overview TEXT,
      status TEXT,
      images TEXT,
      links TEXT,
      genres TEXT,
      ratings TEXT,
      aliases TEXT,
      old_foreign_ids TEXT,
      content_hash TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE ManagedArtists (
      id INTEGER PRIMARY KEY,
      artist_id INTEGER NOT NULL UNIQUE,
      path TEXT,
      library_origin TEXT NOT NULL DEFAULT 'user',
      metadata_status TEXT,
      metadata_last_checked_at TEXT,
      metadata_match_method TEXT,
      added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (artist_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE
    );

    CREATE TABLE Albums (
      id INTEGER PRIMARY KEY,
      mbid TEXT NOT NULL UNIQUE,
      foreign_album_id TEXT UNIQUE,
      artist_metadata_id INTEGER,
      title TEXT NOT NULL,
      primary_type TEXT,
      secondary_types TEXT,
      first_release_date TEXT,
      cover_image_id TEXT,
      vibrant_color TEXT,
      video_cover TEXT,
      popularity INTEGER,
      review_text TEXT,
      review_source TEXT,
      review_last_updated TEXT,
      disambiguation TEXT,
      overview TEXT,
      images TEXT,
      links TEXT,
      genres TEXT,
      ratings TEXT,
      aliases TEXT,
      old_foreign_ids TEXT,
      content_hash TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (artist_metadata_id) REFERENCES ArtistMetadata(id) ON DELETE SET NULL
    );

    CREATE TABLE AlbumEditions (
      id INTEGER PRIMARY KEY,
      mbid TEXT NOT NULL UNIQUE,
      foreign_release_id TEXT UNIQUE,
      release_group_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT,
      country TEXT,
      date TEXT,
      barcode TEXT,
      copyright TEXT,
      disambiguation TEXT,
      media_count INTEGER,
      track_count INTEGER,
      label TEXT,
      media TEXT,
      old_foreign_ids TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (release_group_id) REFERENCES Albums(id) ON DELETE CASCADE
    );

    CREATE TABLE Recordings (
      id INTEGER PRIMARY KEY,
      mbid TEXT NOT NULL UNIQUE,
      foreign_recording_id TEXT UNIQUE,
      title TEXT NOT NULL,
      length_ms INTEGER,
      is_video INTEGER NOT NULL DEFAULT 0 CHECK (is_video IN (0, 1)),
      video_variant TEXT,
      metadata_status TEXT NOT NULL DEFAULT 'musicbrainz',
      release_date TEXT,
      cover_image_id TEXT,
      cover_image_url TEXT,
      copyright TEXT,
      popularity INTEGER,
      credits TEXT,
      monitored INTEGER NOT NULL DEFAULT 0 CHECK (monitored IN (0, 1)),
      monitored_lock INTEGER NOT NULL DEFAULT 0 CHECK (monitored_lock IN (0, 1)),
      monitored_at TEXT,
      locked_at TEXT,
      isrcs TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE Tracks (
      id INTEGER PRIMARY KEY,
      mbid TEXT NOT NULL UNIQUE,
      foreign_track_id TEXT UNIQUE,
      foreign_recording_id TEXT,
      album_edition_id INTEGER NOT NULL,
      recording_id INTEGER NOT NULL,
      medium_position INTEGER NOT NULL,
      position INTEGER NOT NULL,
      number TEXT,
      title TEXT NOT NULL,
      length_ms INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (album_edition_id, medium_position, position),
      FOREIGN KEY (album_edition_id) REFERENCES AlbumEditions(id) ON DELETE CASCADE,
      FOREIGN KEY (recording_id) REFERENCES Recordings(id) ON DELETE CASCADE
    );

    CREATE TABLE ReleaseGroupArtistCredits (
      release_group_id INTEGER NOT NULL,
      artist_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      credited_name TEXT NOT NULL,
      join_phrase TEXT NOT NULL DEFAULT '',
      role TEXT,
      PRIMARY KEY (release_group_id, ordinal),
      FOREIGN KEY (release_group_id) REFERENCES Albums(id) ON DELETE CASCADE,
      FOREIGN KEY (artist_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE
    );

    CREATE TABLE ReleaseArtistCredits (
      edition_id INTEGER NOT NULL,
      artist_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      credited_name TEXT NOT NULL,
      join_phrase TEXT NOT NULL DEFAULT '',
      role TEXT,
      PRIMARY KEY (edition_id, ordinal),
      FOREIGN KEY (edition_id) REFERENCES AlbumEditions(id) ON DELETE CASCADE,
      FOREIGN KEY (artist_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE
    );

    CREATE TABLE TrackArtistCredits (
      track_id INTEGER NOT NULL,
      artist_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      credited_name TEXT NOT NULL,
      join_phrase TEXT NOT NULL DEFAULT '',
      role TEXT,
      PRIMARY KEY (track_id, ordinal),
      FOREIGN KEY (track_id) REFERENCES Tracks(id) ON DELETE CASCADE,
      FOREIGN KEY (artist_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE
    );

    CREATE TABLE RecordingArtistCredits (
      recording_id INTEGER NOT NULL,
      artist_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      credited_name TEXT NOT NULL,
      join_phrase TEXT NOT NULL DEFAULT '',
      role TEXT,
      PRIMARY KEY (recording_id, ordinal),
      FOREIGN KEY (recording_id) REFERENCES Recordings(id) ON DELETE CASCADE,
      FOREIGN KEY (artist_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE
    );

    CREATE TABLE RecordingRelations (
      id INTEGER PRIMARY KEY,
      source_recording_id INTEGER NOT NULL,
      target_recording_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'musicbrainz',
      confidence REAL,
      evidence TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (source_recording_id, target_recording_id, relation_type),
      FOREIGN KEY (source_recording_id) REFERENCES Recordings(id) ON DELETE CASCADE,
      FOREIGN KEY (target_recording_id) REFERENCES Recordings(id) ON DELETE CASCADE
    );

    CREATE TABLE ProviderItems (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('artist', 'release', 'track', 'video')),
      provider_id TEXT NOT NULL,
      title TEXT,
      version TEXT,
      provider_type TEXT,
      upc TEXT,
      isrc TEXT,
      duration_ms INTEGER,
      release_date TEXT,
      explicit INTEGER CHECK (explicit IS NULL OR explicit IN (0, 1)),
      availability TEXT NOT NULL DEFAULT 'unknown',
      availability_reason TEXT,
      checked_at TEXT,
      provider_url TEXT,
      cover_id TEXT,
      artwork_url TEXT,
      volume_count INTEGER,
      replay_gain REAL,
      peak REAL,
      bpm REAL,
      musical_key TEXT,
      popularity INTEGER,
      video_quality TEXT,
      copyright TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (provider, entity_type, provider_id)
    );

    CREATE TABLE ProviderEditionMembers (
      id INTEGER PRIMARY KEY,
      provider_edition_item_id INTEGER NOT NULL,
      member_item_id INTEGER NOT NULL,
      medium_position INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL,
      number TEXT,
      contextual_title TEXT,
      contextual_duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (provider_edition_item_id, medium_position, position),
      FOREIGN KEY (provider_edition_item_id) REFERENCES ProviderItems(id) ON DELETE CASCADE,
      FOREIGN KEY (member_item_id) REFERENCES ProviderItems(id) ON DELETE CASCADE
    );

    CREATE TABLE ProviderItemCredits (
      item_id INTEGER NOT NULL,
      artist_item_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      credited_name TEXT NOT NULL,
      join_phrase TEXT NOT NULL DEFAULT '',
      normalized_role TEXT NOT NULL DEFAULT 'other'
        CHECK (normalized_role IN ('primary', 'featured', 'remixer', 'other')),
      provider_role TEXT,
      PRIMARY KEY (item_id, ordinal),
      FOREIGN KEY (item_id) REFERENCES ProviderItems(id) ON DELETE CASCADE,
      FOREIGN KEY (artist_item_id) REFERENCES ProviderItems(id) ON DELETE CASCADE
    );

    CREATE TABLE ProviderItemAudioVariants (
      id INTEGER PRIMARY KEY,
      provider_item_id INTEGER NOT NULL,
      variant_key TEXT NOT NULL,
      quality_class TEXT NOT NULL
        CHECK (quality_class IN ('lossy', 'lossless', 'hires-lossless', 'spatial')),
      codec TEXT,
      container TEXT,
      lossless INTEGER CHECK (lossless IS NULL OR lossless IN (0, 1)),
      bit_depth INTEGER,
      sample_rate INTEGER,
      bitrate INTEGER,
      channel_count INTEGER,
      channel_layout TEXT,
      spatial_format TEXT,
      provider_quality_label TEXT,
      availability TEXT NOT NULL DEFAULT 'unknown',
      availability_reason TEXT,
      verified_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (provider_item_id, variant_key),
      FOREIGN KEY (provider_item_id) REFERENCES ProviderItems(id) ON DELETE CASCADE
    );

    CREATE TABLE ProviderArtistMatches (
      id INTEGER PRIMARY KEY,
      provider_artist_item_id INTEGER NOT NULL,
      artist_id INTEGER NOT NULL,
      match_state TEXT NOT NULL CHECK (match_state IN ('candidate', 'accepted', 'ambiguous', 'rejected')),
      decision_source TEXT NOT NULL CHECK (decision_source IN ('automatic', 'manual')),
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      method TEXT NOT NULL,
      evidence TEXT,
      matcher_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (provider_artist_item_id, artist_id),
      FOREIGN KEY (provider_artist_item_id) REFERENCES ProviderItems(id) ON DELETE CASCADE,
      FOREIGN KEY (artist_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE
    );

    CREATE TABLE ProviderArtistIgnores (
      provider_artist_item_id INTEGER PRIMARY KEY,
      decision_source TEXT NOT NULL CHECK (decision_source = 'manual'),
      reason TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (provider_artist_item_id) REFERENCES ProviderItems(id) ON DELETE CASCADE
    );

    CREATE TABLE ProviderEditionMatches (
      id INTEGER PRIMARY KEY,
      provider_edition_item_id INTEGER NOT NULL,
      edition_id INTEGER NOT NULL,
      relation TEXT NOT NULL CHECK (relation IN ('exact', 'source_superset', 'source_subset', 'overlap')),
      match_state TEXT NOT NULL CHECK (match_state IN ('candidate', 'accepted', 'ambiguous', 'rejected')),
      decision_source TEXT NOT NULL CHECK (decision_source IN ('automatic', 'manual')),
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      method TEXT NOT NULL,
      evidence TEXT,
      matcher_version INTEGER NOT NULL,
      matched_track_count INTEGER NOT NULL DEFAULT 0,
      source_track_count INTEGER NOT NULL DEFAULT 0,
      target_track_count INTEGER NOT NULL DEFAULT 0,
      source_coverage REAL NOT NULL DEFAULT 0,
      target_coverage REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (provider_edition_item_id, edition_id),
      FOREIGN KEY (provider_edition_item_id) REFERENCES ProviderItems(id) ON DELETE CASCADE,
      FOREIGN KEY (edition_id) REFERENCES AlbumEditions(id) ON DELETE CASCADE
    );

    CREATE TABLE ProviderTrackMatches (
      id INTEGER PRIMARY KEY,
      provider_track_item_id INTEGER NOT NULL,
      provider_edition_member_id INTEGER,
      provider_edition_match_id INTEGER,
      track_id INTEGER,
      recording_id INTEGER NOT NULL,
      match_state TEXT NOT NULL CHECK (match_state IN ('candidate', 'accepted', 'ambiguous', 'rejected')),
      decision_source TEXT NOT NULL CHECK (decision_source IN ('automatic', 'manual')),
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      method TEXT NOT NULL,
      evidence TEXT,
      matcher_version INTEGER NOT NULL,
      duration_delta_ms INTEGER,
      ambiguity_margin REAL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (provider_track_item_id) REFERENCES ProviderItems(id) ON DELETE CASCADE,
      FOREIGN KEY (provider_edition_member_id) REFERENCES ProviderEditionMembers(id) ON DELETE CASCADE,
      FOREIGN KEY (provider_edition_match_id) REFERENCES ProviderEditionMatches(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES Tracks(id) ON DELETE CASCADE,
      FOREIGN KEY (recording_id) REFERENCES Recordings(id) ON DELETE CASCADE
    );

    CREATE TABLE ProviderVideoMatches (
      id INTEGER PRIMARY KEY,
      provider_video_item_id INTEGER NOT NULL,
      recording_id INTEGER NOT NULL,
      match_state TEXT NOT NULL CHECK (match_state IN ('candidate', 'accepted', 'ambiguous', 'rejected')),
      decision_source TEXT NOT NULL CHECK (decision_source IN ('automatic', 'manual')),
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      method TEXT NOT NULL,
      evidence TEXT,
      matcher_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (provider_video_item_id, recording_id),
      FOREIGN KEY (provider_video_item_id) REFERENCES ProviderItems(id) ON DELETE CASCADE,
      FOREIGN KEY (recording_id) REFERENCES Recordings(id) ON DELETE CASCADE
    );

    CREATE TABLE MetadataProfiles (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      release_type_policy TEXT NOT NULL,
      explicit_policy TEXT NOT NULL DEFAULT 'allow',
      require_provider_availability INTEGER NOT NULL DEFAULT 1,
      redundancy_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE quality_profiles (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      allowed_source_formats TEXT NOT NULL,
      preference_order TEXT NOT NULL,
      cutoff TEXT NOT NULL,
      continue_upgrades INTEGER NOT NULL DEFAULT 0,
      fallback_policy TEXT NOT NULL,
      output_format TEXT NOT NULL,
      transcode_policy TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE Libraries (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      root_path TEXT NOT NULL,
      metadata_profile_id INTEGER NOT NULL,
      quality_profile_id INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (metadata_profile_id) REFERENCES MetadataProfiles(id),
      FOREIGN KEY (quality_profile_id) REFERENCES quality_profiles(id)
    );

    CREATE TABLE LibraryArtists (
      id INTEGER PRIMARY KEY,
      library_id INTEGER NOT NULL,
      managed_artist_id INTEGER NOT NULL,
      monitored INTEGER NOT NULL DEFAULT 1 CHECK (monitored IN (0, 1)),
      credited_scope TEXT NOT NULL DEFAULT 'primary_only'
        CHECK (credited_scope IN ('primary_only', 'release_credit', 'release_and_track_credit')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (library_id, managed_artist_id),
      FOREIGN KEY (library_id) REFERENCES Libraries(id) ON DELETE CASCADE,
      FOREIGN KEY (managed_artist_id) REFERENCES ManagedArtists(id) ON DELETE CASCADE
    );

    CREATE TABLE LibraryAlbums (
      id INTEGER PRIMARY KEY,
      library_id INTEGER NOT NULL,
      release_group_id INTEGER NOT NULL,
      monitored INTEGER NOT NULL DEFAULT 1 CHECK (monitored IN (0, 1)),
      selection_mode TEXT NOT NULL CHECK (selection_mode IN ('auto', 'manual')),
      locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
      reason TEXT,
      curation_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (library_id, release_group_id),
      FOREIGN KEY (library_id) REFERENCES Libraries(id) ON DELETE CASCADE,
      FOREIGN KEY (release_group_id) REFERENCES Albums(id) ON DELETE CASCADE
    );

    -- Row existence is the monitoring decision. No monitored column, and no
    -- per-edition locked: LibraryAlbums.locked is the one Album lock.
    CREATE TABLE LibraryEditions (
      id INTEGER PRIMARY KEY,
      library_id INTEGER NOT NULL,
      edition_id INTEGER NOT NULL,
      selection_mode TEXT NOT NULL CHECK (selection_mode IN ('auto', 'manual')),
      representative INTEGER NOT NULL DEFAULT 1 CHECK (representative IN (0, 1)),
      reason TEXT,
      curation_version INTEGER NOT NULL,
      preferred_plan_key TEXT,
      plan_selection_mode TEXT NOT NULL DEFAULT 'auto'
        CHECK (plan_selection_mode IN ('auto', 'manual')),
      selected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (library_id, edition_id),
      FOREIGN KEY (library_id) REFERENCES Libraries(id) ON DELETE CASCADE,
      FOREIGN KEY (edition_id) REFERENCES AlbumEditions(id) ON DELETE CASCADE,
      FOREIGN KEY (library_id, edition_id, preferred_plan_key)
        REFERENCES AcquisitionPlans(library_id, edition_id, plan_key)
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE TABLE LibraryEditionScopes (
      library_edition_id INTEGER NOT NULL,
      library_artist_id INTEGER NOT NULL,
      scope_type TEXT NOT NULL CHECK (scope_type IN ('primary', 'release_credit', 'track_credit')),
      reason TEXT,
      PRIMARY KEY (library_edition_id, library_artist_id, scope_type),
      FOREIGN KEY (library_edition_id) REFERENCES LibraryEditions(id) ON DELETE CASCADE,
      FOREIGN KEY (library_artist_id) REFERENCES LibraryArtists(id) ON DELETE CASCADE
    );

    -- Scoped to a Library and a canonical Edition, so a plan can exist for an
    -- Edition that is evaluated but not monitored.
    CREATE TABLE AcquisitionPlans (
      id INTEGER PRIMARY KEY,
      library_id INTEGER NOT NULL,
      edition_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      composition TEXT NOT NULL CHECK (composition IN ('single_source', 'composite')),
      download_mode TEXT NOT NULL CHECK (download_mode IN ('album', 'tracks')),
      state TEXT NOT NULL CHECK (state IN ('current', 'stale', 'unavailable', 'failed')),
      plan_key TEXT NOT NULL,
      rank INTEGER NOT NULL DEFAULT 0,
      coverage INTEGER NOT NULL DEFAULT 0,
      target_track_count INTEGER NOT NULL DEFAULT 0,
      quality_tier TEXT NOT NULL DEFAULT 'lossless',
      explicit_content TEXT NOT NULL DEFAULT 'unknown'
        CHECK (explicit_content IN ('explicit', 'clean', 'unknown')),
      explicit_track_count INTEGER NOT NULL DEFAULT 0,
      clean_track_count INTEGER NOT NULL DEFAULT 0,
      unknown_explicitness_count INTEGER NOT NULL DEFAULT 0,
      planner_version INTEGER NOT NULL,
      policy_hash TEXT NOT NULL,
      computed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (library_id, edition_id, plan_key),
      FOREIGN KEY (library_id) REFERENCES Libraries(id) ON DELETE CASCADE,
      FOREIGN KEY (edition_id) REFERENCES AlbumEditions(id) ON DELETE CASCADE
    );

    CREATE TABLE AcquisitionPlanSources (
      id INTEGER PRIMARY KEY,
      plan_id INTEGER NOT NULL,
      provider_edition_match_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('primary', 'supplement')),
      sort_order INTEGER NOT NULL,
      UNIQUE (plan_id, provider_edition_match_id),
      FOREIGN KEY (plan_id) REFERENCES AcquisitionPlans(id) ON DELETE CASCADE,
      FOREIGN KEY (provider_edition_match_id) REFERENCES ProviderEditionMatches(id)
    );

    CREATE TABLE AcquisitionPlanTracks (
      id INTEGER PRIMARY KEY,
      plan_id INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      source_id INTEGER NOT NULL,
      provider_track_match_id INTEGER NOT NULL,
      provider_audio_variant_id INTEGER NOT NULL,
      source_quality_snapshot TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (plan_id, track_id),
      UNIQUE (plan_id, provider_track_match_id),
      FOREIGN KEY (plan_id) REFERENCES AcquisitionPlans(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES Tracks(id),
      FOREIGN KEY (source_id) REFERENCES AcquisitionPlanSources(id),
      FOREIGN KEY (provider_track_match_id) REFERENCES ProviderTrackMatches(id),
      FOREIGN KEY (provider_audio_variant_id) REFERENCES ProviderItemAudioVariants(id)
    );

    CREATE TABLE TrackFiles (
      id INTEGER PRIMARY KEY,
      library_id INTEGER NOT NULL,
      album_edition_id INTEGER NOT NULL,
      track_id INTEGER,
      recording_id INTEGER NOT NULL,
      provider_item_id INTEGER,
      source_audio_variant_id INTEGER,
      file_path TEXT NOT NULL UNIQUE,
      relative_path TEXT NOT NULL,
      filename TEXT NOT NULL,
      extension TEXT NOT NULL,
      file_size INTEGER,
      file_hash TEXT,
      duration_ms INTEGER,
      bitrate INTEGER,
      sample_rate INTEGER,
      bit_depth INTEGER,
      channel_count INTEGER,
      codec TEXT,
      container TEXT,
      channel_layout TEXT,
      spatial_format TEXT,
      video_codec TEXT,
      width INTEGER,
      height INTEGER,
      file_class TEXT NOT NULL CHECK (file_class IN ('audio', 'video')),
      source_quality TEXT,
      imported_quality TEXT,
      expected_path TEXT,
      needs_rename INTEGER NOT NULL DEFAULT 0 CHECK (needs_rename IN (0, 1)),
      original_filename TEXT,
      fingerprint TEXT,
      acoustid_id TEXT,
      fingerprint_duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      modified_at TEXT,
      verified_at TEXT,
      FOREIGN KEY (library_id) REFERENCES Libraries(id) ON DELETE CASCADE,
      FOREIGN KEY (album_edition_id) REFERENCES AlbumEditions(id),
      FOREIGN KEY (track_id) REFERENCES Tracks(id),
      FOREIGN KEY (recording_id) REFERENCES Recordings(id),
      FOREIGN KEY (provider_item_id) REFERENCES ProviderItems(id) ON DELETE SET NULL,
      FOREIGN KEY (source_audio_variant_id) REFERENCES ProviderItemAudioVariants(id) ON DELETE SET NULL
    );

    CREATE TABLE MediaCoverSelections (
      release_group_id INTEGER PRIMARY KEY,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('manual', 'canonical', 'provider')),
      selection_revision TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_identity TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (release_group_id) REFERENCES Albums(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE INDEX idx_managed_artists_artist ON ManagedArtists(artist_id);
    CREATE INDEX idx_albums_primary_artist ON Albums(artist_metadata_id, first_release_date);
    CREATE INDEX idx_releases_group ON AlbumEditions(release_group_id, date);
    CREATE INDEX idx_tracks_release_position ON Tracks(album_edition_id, medium_position, position);
    CREATE INDEX idx_tracks_recording_release ON Tracks(recording_id, album_edition_id);
    CREATE INDEX idx_rg_credits_artist ON ReleaseGroupArtistCredits(artist_id, release_group_id);
    CREATE INDEX idx_release_credits_artist ON ReleaseArtistCredits(artist_id, edition_id);
    CREATE INDEX idx_track_credits_artist ON TrackArtistCredits(artist_id, track_id);
    CREATE INDEX idx_recording_credits_artist ON RecordingArtistCredits(artist_id, recording_id);

    CREATE INDEX idx_provider_items_type ON ProviderItems(provider, entity_type, provider_id);
    CREATE INDEX idx_provider_items_upc ON ProviderItems(provider, upc) WHERE upc IS NOT NULL;
    CREATE INDEX idx_provider_items_isrc ON ProviderItems(provider, isrc) WHERE isrc IS NOT NULL;
    CREATE INDEX idx_provider_release_members_release ON ProviderEditionMembers(provider_edition_item_id, medium_position, position);
    CREATE INDEX idx_provider_release_members_member ON ProviderEditionMembers(member_item_id, provider_edition_item_id);
    CREATE INDEX idx_provider_item_credits_artist ON ProviderItemCredits(artist_item_id, item_id);
    CREATE INDEX idx_provider_audio_variants_item ON ProviderItemAudioVariants(provider_item_id, availability);
    CREATE INDEX idx_provider_artist_matches_provider ON ProviderArtistMatches(provider_artist_item_id, match_state);
    CREATE INDEX idx_provider_artist_matches_artist ON ProviderArtistMatches(artist_id, match_state);
    CREATE INDEX idx_provider_release_matches_provider ON ProviderEditionMatches(provider_edition_item_id, match_state, relation);
    CREATE INDEX idx_provider_release_matches_release ON ProviderEditionMatches(edition_id, match_state, relation);
    CREATE INDEX idx_provider_track_matches_member ON ProviderTrackMatches(provider_edition_member_id, match_state);
    CREATE INDEX idx_provider_track_matches_item ON ProviderTrackMatches(provider_track_item_id, match_state);
    CREATE INDEX idx_provider_track_matches_release_match ON ProviderTrackMatches(provider_edition_match_id, match_state);
    CREATE INDEX idx_provider_track_matches_track ON ProviderTrackMatches(track_id, match_state);
    CREATE INDEX idx_provider_track_matches_recording ON ProviderTrackMatches(recording_id, match_state);
    CREATE UNIQUE INDEX idx_provider_track_matches_unique_edge
      ON ProviderTrackMatches(
        provider_track_item_id,
        COALESCE(provider_edition_member_id, -1),
        COALESCE(provider_edition_match_id, -1),
        COALESCE(track_id, -1),
        recording_id
      );
    CREATE INDEX idx_provider_video_matches_recording ON ProviderVideoMatches(recording_id, match_state);

    CREATE INDEX idx_libraries_root_path ON Libraries(root_path, enabled, id);
    CREATE INDEX idx_library_artists_library ON LibraryArtists(library_id, monitored, managed_artist_id);
    CREATE INDEX idx_library_release_groups_library ON LibraryAlbums(library_id, monitored, release_group_id);
    CREATE INDEX idx_library_releases_library ON LibraryEditions(library_id, edition_id);
    CREATE INDEX idx_library_release_scopes_artist ON LibraryEditionScopes(library_artist_id, scope_type, library_edition_id);
    CREATE INDEX idx_acquisition_sources_plan ON AcquisitionPlanSources(plan_id, sort_order);
    CREATE INDEX idx_acquisition_tracks_plan ON AcquisitionPlanTracks(plan_id, track_id);
    CREATE INDEX idx_acquisition_tracks_source ON AcquisitionPlanTracks(source_id, track_id);
    CREATE INDEX idx_acquisition_tracks_match ON AcquisitionPlanTracks(provider_track_match_id);
    CREATE INDEX idx_track_files_library_track ON TrackFiles(library_id, track_id);
    CREATE INDEX idx_track_files_library_recording ON TrackFiles(library_id, recording_id);
    CREATE INDEX idx_track_files_library_release ON TrackFiles(library_id, album_edition_id);
    CREATE INDEX idx_acquisition_plans_edition ON AcquisitionPlans(library_id, edition_id, rank);

    -- The plan that actually executes: monitored Edition (a LibraryEditions row
    -- exists) AND the plan that row selected. Keeping both conditions in one
    -- view stops a reader satisfying one and forgetting the other.
    CREATE VIEW SelectedAcquisitionPlans AS
      SELECT
        plan.*,
        monitored_edition.id AS library_edition_id,
        monitored_edition.plan_selection_mode AS selection_mode
      FROM AcquisitionPlans plan
      JOIN LibraryEditions monitored_edition
        ON monitored_edition.library_id = plan.library_id
       AND monitored_edition.edition_id = plan.edition_id
       AND monitored_edition.preferred_plan_key = plan.plan_key;
  `);

  db.exec(`
    CREATE TRIGGER provider_release_members_validate_insert
    BEFORE INSERT ON ProviderEditionMembers
    BEGIN
      SELECT CASE
        WHEN (SELECT entity_type FROM ProviderItems WHERE id = NEW.provider_edition_item_id) != 'release'
          THEN RAISE(ABORT, 'provider release member parent must be a release')
        WHEN (SELECT entity_type FROM ProviderItems WHERE id = NEW.member_item_id) NOT IN ('track', 'video')
          THEN RAISE(ABORT, 'provider release member must be a track or video')
      END;
    END;

    CREATE TRIGGER provider_item_credits_validate_insert
    BEFORE INSERT ON ProviderItemCredits
    BEGIN
      SELECT CASE
        WHEN (SELECT entity_type FROM ProviderItems WHERE id = NEW.artist_item_id) != 'artist'
          THEN RAISE(ABORT, 'provider credit artist must be an artist item')
      END;
    END;

    CREATE TRIGGER provider_track_matches_validate_insert
    BEFORE INSERT ON ProviderTrackMatches
    BEGIN
      SELECT CASE
        WHEN (SELECT entity_type FROM ProviderItems WHERE id = NEW.provider_track_item_id) != 'track'
          THEN RAISE(ABORT, 'provider track match item must be a track')
        WHEN NEW.provider_edition_member_id IS NOT NULL
          AND (SELECT member_item_id FROM ProviderEditionMembers WHERE id = NEW.provider_edition_member_id)
              != NEW.provider_track_item_id
          THEN RAISE(ABORT, 'provider track match member disagrees with provider track item')
        WHEN NEW.provider_edition_match_id IS NOT NULL
          AND NEW.provider_edition_member_id IS NULL
          THEN RAISE(ABORT, 'provider edition match context requires an edition member')
        WHEN NEW.provider_edition_match_id IS NOT NULL
          AND (
            SELECT edition_match.provider_edition_item_id
            FROM ProviderEditionMatches edition_match
            WHERE edition_match.id = NEW.provider_edition_match_id
          ) != (
            SELECT member.provider_edition_item_id
            FROM ProviderEditionMembers member
            WHERE member.id = NEW.provider_edition_member_id
          )
          THEN RAISE(ABORT, 'provider track match edition context is inconsistent')
        WHEN NEW.track_id IS NOT NULL
          AND (SELECT recording_id FROM Tracks WHERE id = NEW.track_id) != NEW.recording_id
          THEN RAISE(ABORT, 'provider track match recording disagrees with canonical track')
      END;
    END;

    CREATE TRIGGER provider_artist_matches_validate_insert
    BEFORE INSERT ON ProviderArtistMatches
    BEGIN
      SELECT CASE
        WHEN (SELECT entity_type FROM ProviderItems WHERE id = NEW.provider_artist_item_id) != 'artist'
          THEN RAISE(ABORT, 'provider artist match source must be an artist item')
      END;
    END;

    CREATE TRIGGER provider_release_matches_validate_insert
    BEFORE INSERT ON ProviderEditionMatches
    BEGIN
      SELECT CASE
        WHEN (SELECT entity_type FROM ProviderItems WHERE id = NEW.provider_edition_item_id) != 'release'
          THEN RAISE(ABORT, 'provider release match source must be a release item')
      END;
    END;

    CREATE TRIGGER provider_video_matches_validate_insert
    BEFORE INSERT ON ProviderVideoMatches
    BEGIN
      SELECT CASE
        WHEN (SELECT entity_type FROM ProviderItems WHERE id = NEW.provider_video_item_id) != 'video'
          THEN RAISE(ABORT, 'provider video match source must be a video item')
        WHEN NEW.match_state != 'rejected' AND NOT EXISTS (
          SELECT 1 FROM Recordings
          WHERE id = NEW.recording_id AND is_video = 1 AND mbid IS NOT NULL
        )
          THEN RAISE(ABORT, 'provider video match target must be a canonical video recording')
      END;
    END;

    CREATE TRIGGER provider_video_matches_validate_update
    BEFORE UPDATE OF provider_video_item_id, recording_id, match_state ON ProviderVideoMatches
    BEGIN
      SELECT CASE
        WHEN (SELECT entity_type FROM ProviderItems WHERE id = NEW.provider_video_item_id) != 'video'
          THEN RAISE(ABORT, 'provider video match source must be a video item')
        WHEN NEW.match_state != 'rejected' AND NOT EXISTS (
          SELECT 1 FROM Recordings
          WHERE id = NEW.recording_id AND is_video = 1 AND mbid IS NOT NULL
        )
          THEN RAISE(ABORT, 'provider video match target must be a canonical video recording')
      END;
    END;
  `);
}
