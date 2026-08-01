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

    -- A row here means exactly one thing: this Album is monitored in this
    -- Library. Unmonitoring deletes the row, which takes the Album's lock with
    -- it. There is deliberately no monitored column: a row saying monitored = 0
    -- is a second answer to a question the row's existence already answers, and
    -- the two drift. The same rule governs LibraryEditions below.
    CREATE TABLE LibraryAlbums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL,
      release_group_id INTEGER NOT NULL,
      selection_mode TEXT NOT NULL CHECK(selection_mode IN ('auto', 'manual')),
      locked BOOLEAN NOT NULL DEFAULT 0,
      reason TEXT,
      curation_version INTEGER NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(library_id, release_group_id),
      FOREIGN KEY(library_id) REFERENCES Libraries(id) ON DELETE CASCADE,
      FOREIGN KEY(release_group_id) REFERENCES Albums(id) ON DELETE CASCADE
    );

    -- A row here means exactly one thing: this Edition is monitored in this
    -- Library. Removing the row unmonitors it. Same rule as LibraryAlbums: no
    -- monitored column, and no locked column either — the Album lock on
    -- LibraryAlbums is the single authority that curation, planning and the UI
    -- all consult.
    CREATE TABLE LibraryEditions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL,
      edition_id INTEGER NOT NULL,
      selection_mode TEXT NOT NULL CHECK(selection_mode IN ('auto', 'manual')),
      -- The representative ("Primary") Edition of its Album in this Library.
      -- Exactly one monitored Edition per (library, album) carries it; the rest
      -- are supplemental.
      representative BOOLEAN NOT NULL DEFAULT 1,
      reason TEXT,
      curation_version INTEGER NOT NULL,
      -- The acquisition plan this monitored Edition executes, remembered by
      -- stable plan_key so it survives replanning. The planner writes the
      -- resolved key every time it plans, so NULL means "no viable plan",
      -- never "look it up somewhere else".
      preferred_plan_key TEXT,
      plan_selection_mode TEXT NOT NULL DEFAULT 'auto'
        CHECK(plan_selection_mode IN ('auto', 'manual')),
      selected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(library_id, edition_id),
      FOREIGN KEY(library_id) REFERENCES Libraries(id) ON DELETE CASCADE,
      FOREIGN KEY(edition_id) REFERENCES AlbumEditions(id) ON DELETE CASCADE,
      -- The selected plan must belong to THIS Library and THIS Edition. A bare
      -- plan_key could name a plan built for another edition entirely; this
      -- composite reference makes that unrepresentable. Deferred because
      -- replanning deletes and reinserts the plan rows the key points at
      -- within one transaction.
      FOREIGN KEY(library_id, edition_id, preferred_plan_key)
        REFERENCES AcquisitionPlans(library_id, edition_id, plan_key)
        DEFERRABLE INITIALLY DEFERRED
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

    -- Scoped to a Library and a CANONICAL Edition, never to a LibraryEditions
    -- row. Plans have to exist for Editions curation evaluated and did not
    -- monitor, because offering the user another Edition is precisely what the
    -- Album page is for. Monitoring is a separate decision made later.
    CREATE TABLE AcquisitionPlans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL,
      edition_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      composition TEXT NOT NULL CHECK(composition IN ('single_source', 'composite')),
      download_mode TEXT NOT NULL CHECK(download_mode IN ('album', 'tracks')),
      state TEXT NOT NULL CHECK(state IN ('current', 'stale', 'unavailable', 'failed')),
      -- Stable identity of the plan's shape (provider + ordered source matches
      -- + the exact per-track assignment). Plan rows are regenerated on every
      -- replan, so a user's choice is remembered by key rather than by row id.
      plan_key TEXT NOT NULL,
      -- Optimizer ranking within this edition, 0 = best. Presentation order.
      rank INTEGER NOT NULL DEFAULT 0,
      -- Canonical tracks this plan covers, and how many the canonical Edition
      -- has in total. coverage < target_track_count is a real, displayable
      -- gap — the canonical track list is never trimmed to what a provider has.
      coverage INTEGER NOT NULL DEFAULT 0,
      target_track_count INTEGER NOT NULL DEFAULT 0,
      -- The axes a user actually chooses along, alongside composition.
      quality_tier TEXT NOT NULL DEFAULT 'lossless',
      explicit_content TEXT NOT NULL DEFAULT 'unknown'
        CHECK(explicit_content IN ('explicit', 'clean', 'unknown')),
      -- Diagnostics behind explicit_content, so a classification can be argued
      -- with rather than merely trusted.
      explicit_track_count INTEGER NOT NULL DEFAULT 0,
      clean_track_count INTEGER NOT NULL DEFAULT 0,
      unknown_explicitness_count INTEGER NOT NULL DEFAULT 0,
      planner_version INTEGER NOT NULL,
      policy_hash TEXT NOT NULL,
      computed_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      -- Also the parent key LibraryEditions.preferred_plan_key references.
      UNIQUE(library_id, edition_id, plan_key),
      FOREIGN KEY(library_id) REFERENCES Libraries(id) ON DELETE CASCADE,
      FOREIGN KEY(edition_id) REFERENCES AlbumEditions(id) ON DELETE CASCADE
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

    -- The videos a Library actually selected.
    --
    -- Three layers, deliberately not collapsed into one. Canonical video
    -- Recordings and ProviderVideoMatches are every video Discogenius knows
    -- about — usually several per audio recording, since an artist may put out
    -- an official video, a lyric video and a live cut of the same song. A row
    -- here means one Library chose one of them. And the placement columns say
    -- where that one video lives on disk: exactly one location per selected
    -- video, so it can appear on a dozen Album pages without ever being
    -- downloaded twice.
    --
    -- Row existence is the monitoring statement, as it is for LibraryAlbums and
    -- LibraryEditions. Videos that lose curation keep their canonical and
    -- provider rows and stay visible as alternatives; they simply have no row
    -- here.
    CREATE TABLE LibraryVideos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- The Video Library (or video policy) that selected this video.
      library_id INTEGER NOT NULL,
      video_recording_id INTEGER NOT NULL,
      -- The provider offer that will execute, by stable key. A video offer is
      -- atomic; it is never folded into an audio AcquisitionPlan.
      preferred_offer_key TEXT,
      selection_mode TEXT NOT NULL DEFAULT 'auto'
        CHECK(selection_mode IN ('auto', 'manual')),
      placement_mode TEXT NOT NULL DEFAULT 'separated'
        CHECK(placement_mode IN ('separated', 'inline')),
      -- The AUDIO library receiving an inline file. Null when separated.
      placement_library_id INTEGER,
      -- The exact canonical audio Track occurrence the inline file sits beside.
      inline_track_id INTEGER,
      inline_slot TEXT CHECK(inline_slot IN ('video', 'lyrics')),
      placement_selection_mode TEXT NOT NULL DEFAULT 'auto'
        CHECK(placement_selection_mode IN ('auto', 'manual')),
      reason TEXT,
      selected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(library_id, video_recording_id),
      -- Inline placement needs all three of its columns or none of them.
      CHECK(
        (placement_mode = 'inline'
          AND placement_library_id IS NOT NULL
          AND inline_track_id IS NOT NULL
          AND inline_slot IS NOT NULL)
        OR (placement_mode = 'separated'
          AND placement_library_id IS NULL
          AND inline_track_id IS NULL
          AND inline_slot IS NULL)
      ),
      FOREIGN KEY(library_id) REFERENCES Libraries(id) ON DELETE CASCADE,
      FOREIGN KEY(video_recording_id) REFERENCES Recordings(id) ON DELETE CASCADE,
      FOREIGN KEY(placement_library_id) REFERENCES Libraries(id) ON DELETE CASCADE,
      FOREIGN KEY(inline_track_id) REFERENCES Tracks(id) ON DELETE CASCADE
    );

    -- One occupant per Plex role. A track has one video extra and one lyrics
    -- extra; several official videos, or an official and a live cut, compete for
    -- the first. Making a second winner unrepresentable is what stops two files
    -- resolving to the same name and silently overwriting each other.
    CREATE UNIQUE INDEX idx_library_videos_inline_slot
      ON LibraryVideos(library_id, placement_library_id, inline_track_id, inline_slot)
      WHERE placement_mode = 'inline';
    CREATE INDEX idx_library_videos_recording
      ON LibraryVideos(video_recording_id, library_id);
    CREATE INDEX idx_library_videos_inline_track
      ON LibraryVideos(inline_track_id) WHERE placement_mode = 'inline';

    -- Only a canonical VIDEO recording may be selected as one.
    CREATE TRIGGER library_videos_validate_insert
    BEFORE INSERT ON LibraryVideos
    BEGIN
      SELECT CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM Recordings WHERE id = NEW.video_recording_id AND is_video = 1
        ) THEN RAISE(ABORT, 'LibraryVideos target must be a canonical video recording')
      END;
    END;

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
    -- UNIQUE(library_id, release_group_id) already indexes the only lookup
    -- LibraryAlbums has left, so no separate monitoring index is needed.
    CREATE INDEX idx_library_releases_library
      ON LibraryEditions(library_id, edition_id);
    CREATE INDEX idx_library_release_scopes_artist
      ON LibraryEditionScopes(library_artist_id, scope_type, library_edition_id);
    CREATE INDEX idx_acquisition_plans_edition
      ON AcquisitionPlans(library_id, edition_id, rank);
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
    -- Completion/statistics queries only care about media rows of the matching
    -- class. Partial covering indexes avoid walking duplicate artwork,
    -- sidecars, spatial/video siblings, and other file inventory entries for
    -- every monitored Track or Recording under a large library.
    CREATE INDEX idx_track_files_audio_completion
      ON TrackFiles(library_id, track_id)
      WHERE file_class = 'audio';
    CREATE INDEX idx_track_files_video_completion
      ON TrackFiles(library_id, recording_id)
      WHERE file_class = 'video';
    CREATE INDEX idx_track_files_library_release
      ON TrackFiles(library_id, album_edition_id);

    -- The plan that actually executes.
    --
    -- AcquisitionPlans holds every candidate, including candidates for Editions
    -- nobody monitors. Two independent conditions narrow that to the one plan a
    -- reader means when it says "the plan": the Edition is monitored in this
    -- Library (a LibraryEditions row exists) and this is the plan that row
    -- selected. Both live in the join, so a reader cannot satisfy one and forget
    -- the other — which is what the old global chosen flag allowed.
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
}
