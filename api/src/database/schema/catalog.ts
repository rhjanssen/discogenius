import type Database from "better-sqlite3";

export function createCatalogForeignKeyIndexes(db: Database.Database): void {
  db.exec("CREATE INDEX idx_albums_artist_metadata_id ON Albums(artist_metadata_id)");
  db.exec("CREATE INDEX idx_albums_library_release_date ON Albums((first_release_date IS NULL), first_release_date DESC)");
  db.exec("CREATE INDEX idx_album_releases_release_group_id ON AlbumEditions(release_group_id)");
  db.exec("CREATE INDEX idx_album_releases_artist_metadata_id ON AlbumEditions(artist_metadata_id)");
  db.exec("CREATE INDEX idx_album_artists_release_group_id ON AlbumArtists(release_group_id)");
  db.exec("CREATE INDEX idx_album_artists_artist_metadata_id ON AlbumArtists(artist_metadata_id)");
  db.exec("CREATE INDEX idx_artist_release_groups_artist_metadata_id ON ArtistReleaseGroups(artist_metadata_id)");
  db.exec("CREATE INDEX idx_artist_release_groups_release_group_id ON ArtistReleaseGroups(release_group_id)");
  db.exec("CREATE INDEX idx_artist_release_group_curation_artist_metadata_id ON ArtistReleaseGroupCuration(source_artist_metadata_id, included)");
  db.exec("CREATE INDEX idx_artist_release_group_curation_release_group_id ON ArtistReleaseGroupCuration(release_group_id)");
  db.exec("CREATE INDEX idx_artist_release_group_curation_source_release_group_id ON ArtistReleaseGroupCuration(source_artist_mbid, included, release_group_id)");
  db.exec("CREATE INDEX idx_tracks_album_release_mbid ON Tracks(album_edition_id, mbid)");
  db.exec("CREATE INDEX idx_tracks_recording_release ON Tracks(recording_id, album_edition_id)");
  db.exec("CREATE INDEX idx_tracks_album_release_position ON Tracks(album_edition_id, medium_position, position)");
  db.exec("CREATE INDEX idx_recordings_library_popularity ON Recordings(COALESCE(popularity, 0) DESC, id ASC)");
}

export function createCatalogForeignKeyTriggers(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER trg_artist_release_groups_fks_ai
    AFTER INSERT ON ArtistReleaseGroups
    BEGIN
      UPDATE ArtistReleaseGroups SET
        artist_metadata_id = COALESCE(NEW.artist_metadata_id, (SELECT id FROM ArtistMetadata WHERE mbid = NEW.artist_mbid)),
        release_group_id = COALESCE(NEW.release_group_id, (SELECT id FROM Albums WHERE mbid = NEW.release_group_mbid))
      WHERE artist_mbid = NEW.artist_mbid
        AND release_group_mbid = NEW.release_group_mbid
        AND relationship = NEW.relationship;
    END;

    CREATE TRIGGER trg_artist_release_groups_fks_au
    AFTER UPDATE OF artist_mbid, release_group_mbid ON ArtistReleaseGroups
    BEGIN
      UPDATE ArtistReleaseGroups SET
        artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = NEW.artist_mbid),
        release_group_id = (SELECT id FROM Albums WHERE mbid = NEW.release_group_mbid)
      WHERE artist_mbid = NEW.artist_mbid
        AND release_group_mbid = NEW.release_group_mbid
        AND relationship = NEW.relationship;
    END;

    CREATE TRIGGER trg_artist_release_group_curation_fks_ai
    AFTER INSERT ON ArtistReleaseGroupCuration
    BEGIN
      UPDATE ArtistReleaseGroupCuration SET
        source_artist_metadata_id = COALESCE(NEW.source_artist_metadata_id, (SELECT id FROM ArtistMetadata WHERE mbid = NEW.source_artist_mbid)),
        release_group_id = COALESCE(NEW.release_group_id, (SELECT id FROM Albums WHERE mbid = NEW.release_group_mbid)),
        redundant_to_release_group_id = COALESCE(NEW.redundant_to_release_group_id, (SELECT id FROM Albums WHERE mbid = NEW.redundant_to_release_group_mbid))
      WHERE source_artist_mbid = NEW.source_artist_mbid
        AND release_group_mbid = NEW.release_group_mbid;
    END;

    CREATE TRIGGER trg_artist_release_group_curation_fks_au
    AFTER UPDATE OF source_artist_mbid, release_group_mbid, redundant_to_release_group_mbid ON ArtistReleaseGroupCuration
    BEGIN
      UPDATE ArtistReleaseGroupCuration SET
        source_artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = NEW.source_artist_mbid),
        release_group_id = (SELECT id FROM Albums WHERE mbid = NEW.release_group_mbid),
        redundant_to_release_group_id = (SELECT id FROM Albums WHERE mbid = NEW.redundant_to_release_group_mbid)
      WHERE source_artist_mbid = NEW.source_artist_mbid
        AND release_group_mbid = NEW.release_group_mbid;
    END;

    CREATE TRIGGER trg_albums_catalog_fks_ai
    AFTER INSERT ON Albums
    BEGIN
      UPDATE Albums
      SET artist_metadata_id = COALESCE(NEW.artist_metadata_id, (SELECT id FROM ArtistMetadata WHERE mbid = NEW.artist_mbid))
      WHERE id = NEW.id;
    END;
  `);
  db.exec(`
    CREATE TRIGGER trg_albums_catalog_fks_au
    AFTER UPDATE OF artist_mbid ON Albums
    BEGIN
      UPDATE Albums SET artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = NEW.artist_mbid)
      WHERE id = NEW.id;
    END;
  `);

  db.exec(`
    CREATE TRIGGER trg_album_releases_catalog_fks_ai
    AFTER INSERT ON AlbumEditions
    BEGIN
      UPDATE AlbumEditions SET
        release_group_id = COALESCE(NEW.release_group_id, (SELECT id FROM Albums WHERE mbid = NEW.release_group_mbid)),
        artist_metadata_id = COALESCE(NEW.artist_metadata_id, (SELECT id FROM ArtistMetadata WHERE mbid = NEW.artist_mbid))
      WHERE id = NEW.id;
    END;
  `);
  db.exec(`
    CREATE TRIGGER trg_album_releases_catalog_fks_au
    AFTER UPDATE OF release_group_mbid, artist_mbid ON AlbumEditions
    BEGIN
      UPDATE AlbumEditions SET
        release_group_id = (SELECT id FROM Albums WHERE mbid = NEW.release_group_mbid),
        artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = NEW.artist_mbid)
      WHERE id = NEW.id;
    END;
  `);

  db.exec(`
    CREATE TRIGGER trg_tracks_catalog_fks_ai
    AFTER INSERT ON Tracks
    BEGIN
      UPDATE Tracks SET
        album_edition_id = COALESCE(NEW.album_edition_id, (SELECT id FROM AlbumEditions WHERE mbid = NEW.release_mbid)),
        recording_id = COALESCE(NEW.recording_id, (SELECT id FROM Recordings WHERE mbid = NEW.recording_mbid))
      WHERE id = NEW.id;
    END;
  `);
  db.exec(`
    CREATE TRIGGER trg_tracks_catalog_fks_au
    AFTER UPDATE OF release_mbid, recording_mbid ON Tracks
    BEGIN
      UPDATE Tracks SET
        album_edition_id = (SELECT id FROM AlbumEditions WHERE mbid = NEW.release_mbid),
        recording_id = (SELECT id FROM Recordings WHERE mbid = NEW.recording_mbid)
      WHERE id = NEW.id;
    END;
  `);

}

export function createCatalogSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE ArtistMetadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      foreign_artist_id TEXT UNIQUE,
      mbid TEXT UNIQUE,
      name TEXT NOT NULL,
      sort_name TEXT,
      disambiguation TEXT,
      type TEXT,
      country TEXT,
      begin_date TEXT,
      end_date TEXT,
      picture TEXT,
      cover_image_url TEXT,
      popularity INT,
      overview TEXT,
      status TEXT,
      images TEXT,
      -- Curated per-field JSON columns (Lidarr's EmbeddedDocumentConverter
      -- pattern): bounded arrays/objects stored as one JSON column each, replacing
      -- the raw data blob. Sourced from the metadata-server artist payload
      -- (links, genres, artistaliases, rating, oldids).
      links TEXT,
      genres TEXT,
      ratings TEXT,
      aliases TEXT,
      old_foreign_ids TEXT,
      -- Cheap change-key over the remote payload. Refresh compares this instead
      -- of the multi-KB data blob to decide whether a row actually changed, so an
      -- unchanged artist is never rewritten (Lidarr's UpdateMany-only-changed
      -- diff-reconcile). NULL means "force a write" (never synced).
      content_hash TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE Albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      foreign_album_id TEXT UNIQUE,
      mbid TEXT UNIQUE,
      artist_metadata_id INTEGER,
      artist_mbid TEXT NOT NULL,
      title TEXT NOT NULL,
      primary_type TEXT,
      secondary_types TEXT,
      first_release_date TEXT,
      cover_image_id TEXT,
      vibrant_color TEXT,
      video_cover TEXT,
      popularity INT,
      review_text TEXT,
      review_source TEXT,
      review_last_updated DATETIME,
      disambiguation TEXT,
      overview TEXT,
      images TEXT,
      -- Curated per-field JSON columns sourced from the release-group detail
      -- payload (links carries the external relations used as matching evidence;
      -- genres/rating/aliases/oldids round out the discarded raw blob).
      links TEXT,
      genres TEXT,
      ratings TEXT,
      aliases TEXT,
      old_foreign_ids TEXT,
      -- Change-key over the full release-group detail (release group + its
      -- releases + tracks). syncReleaseGroup compares this to skip rewriting an
      -- unchanged release group's entire tracklist. Owned by syncReleaseGroup
      -- (the only writer with the full detail); syncArtist leaves it untouched.
      content_hash TEXT,
      monitored BOOLEAN NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(artist_metadata_id) REFERENCES ArtistMetadata(id) ON DELETE SET NULL,
      FOREIGN KEY(artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE
    );

    CREATE TABLE AlbumEditions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      foreign_release_id TEXT UNIQUE,
      mbid TEXT UNIQUE,
      release_group_id INTEGER,
      release_group_mbid TEXT NOT NULL,
      artist_metadata_id INTEGER,
      artist_mbid TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT,
      country TEXT,
      date TEXT,
      barcode TEXT,
      copyright TEXT,
      disambiguation TEXT,
      media_count INT,
      track_count INT,
      -- Curated per-field JSON columns from the release payload: label[] and the
      -- media[] disc structure (used by NFO writing + edition selection), plus
      -- oldids. country already lives as a JSON-array TEXT column above.
      label TEXT,
      media TEXT,
      old_foreign_ids TEXT,
      monitored BOOLEAN NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(release_group_id) REFERENCES Albums(id) ON DELETE CASCADE,
      FOREIGN KEY(release_group_mbid) REFERENCES Albums(mbid) ON DELETE CASCADE,
      FOREIGN KEY(artist_metadata_id) REFERENCES ArtistMetadata(id) ON DELETE SET NULL,
      FOREIGN KEY(artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE
    );

    CREATE TABLE AlbumArtists (
      release_group_id INTEGER,
      release_group_mbid TEXT NOT NULL,
      artist_metadata_id INTEGER,
      artist_mbid TEXT NOT NULL,
      ord INT NOT NULL,
      credited_name TEXT NOT NULL,
      join_phrase TEXT NOT NULL DEFAULT '',
      is_primary BOOLEAN NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(release_group_mbid, ord),
      FOREIGN KEY(release_group_id) REFERENCES Albums(id) ON DELETE CASCADE,
      FOREIGN KEY(release_group_mbid) REFERENCES Albums(mbid) ON DELETE CASCADE,
      FOREIGN KEY(artist_metadata_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE,
      FOREIGN KEY(artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE
    );

    CREATE TABLE ArtistReleaseGroups (
      artist_metadata_id INTEGER,
      artist_mbid TEXT NOT NULL,
      release_group_id INTEGER,
      release_group_mbid TEXT NOT NULL,
      relationship TEXT NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(artist_mbid, release_group_mbid, relationship),
      FOREIGN KEY(artist_metadata_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE,
      FOREIGN KEY(artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE,
      FOREIGN KEY(release_group_id) REFERENCES Albums(id) ON DELETE CASCADE,
      FOREIGN KEY(release_group_mbid) REFERENCES Albums(mbid) ON DELETE CASCADE
    );

    CREATE TABLE ArtistReleaseGroupCuration (
      source_artist_metadata_id INTEGER,
      source_artist_mbid TEXT NOT NULL,
      release_group_id INTEGER,
      release_group_mbid TEXT NOT NULL,
      included BOOLEAN NOT NULL DEFAULT 0,
      reason TEXT,
      redundant_to_release_group_id INTEGER,
      redundant_to_release_group_mbid TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(source_artist_mbid, release_group_mbid),
      FOREIGN KEY(source_artist_metadata_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE,
      FOREIGN KEY(source_artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE,
      FOREIGN KEY(release_group_id) REFERENCES Albums(id) ON DELETE CASCADE,
      FOREIGN KEY(release_group_mbid) REFERENCES Albums(mbid) ON DELETE CASCADE,
      FOREIGN KEY(redundant_to_release_group_id) REFERENCES Albums(id) ON DELETE SET NULL,
      FOREIGN KEY(redundant_to_release_group_mbid) REFERENCES Albums(mbid) ON DELETE SET NULL
    );

    CREATE TABLE Recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      foreign_recording_id TEXT UNIQUE,
      mbid TEXT UNIQUE,
      artist_metadata_id INTEGER,
      artist_mbid TEXT,
      title TEXT NOT NULL,
      artist_credit TEXT,
      length_ms INT,
      is_video BOOLEAN NOT NULL DEFAULT 0,
      -- Catalog video class for import/naming (lyric/live/audio/visualizer/video).
      -- Provider titles are evidence; marketing wrappers are stripped for display,
      -- while venue/live/feat parentheticals may be kept on title.
      video_variant TEXT,
      metadata_status TEXT NOT NULL DEFAULT 'musicbrainz',
      release_date DATETIME,
      cover_image_id TEXT,
      cover_image_url TEXT,
      copyright TEXT,
      popularity INT,
      credits TEXT,
      monitored BOOLEAN NOT NULL DEFAULT 0,
      monitored_lock BOOLEAN NOT NULL DEFAULT 0,
      monitored_at DATETIME,
      locked_at DATETIME,
      isrcs TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(artist_metadata_id) REFERENCES ArtistMetadata(id) ON DELETE SET NULL,
      FOREIGN KEY(artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE SET NULL
    );

    CREATE TABLE Tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      foreign_track_id TEXT UNIQUE,
      foreign_recording_id TEXT,
      mbid TEXT UNIQUE,
      album_edition_id INTEGER,
      release_mbid TEXT NOT NULL,
      recording_id INTEGER,
      recording_mbid TEXT NOT NULL,
      medium_position INT NOT NULL,
      position INT NOT NULL,
      number TEXT,
      title TEXT NOT NULL,
      length_ms INT,
      monitored BOOLEAN NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(release_mbid, medium_position, position),
      FOREIGN KEY(album_edition_id) REFERENCES AlbumEditions(id) ON DELETE CASCADE,
      FOREIGN KEY(release_mbid) REFERENCES AlbumEditions(mbid) ON DELETE CASCADE,
      FOREIGN KEY(recording_id) REFERENCES Recordings(id) ON DELETE CASCADE,
      FOREIGN KEY(recording_mbid) REFERENCES Recordings(mbid) ON DELETE CASCADE
    );

    CREATE TABLE ProviderItems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('artist', 'release', 'track', 'video')),
      provider_id TEXT NOT NULL,
      title TEXT,
      version TEXT,
      provider_type TEXT,
      upc TEXT,
      isrc TEXT,
      duration_ms INTEGER,
      release_date TEXT,
      explicit INTEGER CHECK(explicit IS NULL OR explicit IN (0, 1)),
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
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, entity_type, provider_id)
    );

    CREATE TABLE RecordingRelations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_recording_id INTEGER,
      target_recording_id INTEGER,
      source_foreign_recording_id TEXT,
      target_foreign_recording_id TEXT,
      relation_type TEXT NOT NULL,
      foreign_relation_type_id TEXT,
      source TEXT NOT NULL DEFAULT 'discogenius',
      confidence REAL,
      data TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_recording_id, target_recording_id, relation_type),
      UNIQUE(source_foreign_recording_id, target_foreign_recording_id, relation_type),
      FOREIGN KEY(source_recording_id) REFERENCES Recordings(id) ON DELETE CASCADE,
      FOREIGN KEY(target_recording_id) REFERENCES Recordings(id) ON DELETE CASCADE
    );

  `);

  db.exec(`
    CREATE TABLE ProviderEditionMembers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_edition_item_id INTEGER NOT NULL,
      member_item_id INTEGER NOT NULL,
      medium_position INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL,
      number TEXT,
      contextual_title TEXT,
      contextual_duration_ms INTEGER,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider_edition_item_id, medium_position, position),
      FOREIGN KEY(provider_edition_item_id) REFERENCES ProviderItems(id) ON DELETE CASCADE,
      FOREIGN KEY(member_item_id) REFERENCES ProviderItems(id) ON DELETE CASCADE
    );

    CREATE TABLE ProviderItemCredits (
      item_id INTEGER NOT NULL,
      artist_item_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      credited_name TEXT NOT NULL,
      join_phrase TEXT NOT NULL DEFAULT '',
      normalized_role TEXT NOT NULL DEFAULT 'other'
        CHECK(normalized_role IN ('primary', 'featured', 'remixer', 'other')),
      provider_role TEXT,
      PRIMARY KEY(item_id, ordinal),
      FOREIGN KEY(item_id) REFERENCES ProviderItems(id) ON DELETE CASCADE,
      FOREIGN KEY(artist_item_id) REFERENCES ProviderItems(id) ON DELETE CASCADE
    );

    CREATE TABLE ProviderItemAudioVariants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_item_id INTEGER NOT NULL,
      variant_key TEXT NOT NULL,
      quality_class TEXT NOT NULL
        CHECK(quality_class IN ('lossy', 'lossless', 'hires-lossless', 'spatial')),
      codec TEXT,
      container TEXT,
      lossless BOOLEAN,
      bit_depth INTEGER,
      sample_rate INTEGER,
      bitrate INTEGER,
      channel_count INTEGER,
      channel_layout TEXT,
      spatial_format TEXT,
      provider_quality_label TEXT,
      availability TEXT NOT NULL DEFAULT 'unknown',
      availability_reason TEXT,
      verified_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider_item_id, variant_key),
      FOREIGN KEY(provider_item_id) REFERENCES ProviderItems(id) ON DELETE CASCADE
    );

    CREATE TABLE ProviderArtistMatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_artist_item_id INTEGER NOT NULL,
      artist_id INTEGER NOT NULL,
      match_state TEXT NOT NULL CHECK(match_state IN ('candidate', 'accepted', 'ambiguous', 'rejected')),
      decision_source TEXT NOT NULL CHECK(decision_source IN ('automatic', 'manual')),
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      method TEXT NOT NULL,
      evidence TEXT,
      matcher_version INTEGER NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider_artist_item_id, artist_id),
      FOREIGN KEY(provider_artist_item_id) REFERENCES ProviderItems(id) ON DELETE CASCADE,
      FOREIGN KEY(artist_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE
    );

    CREATE TABLE ProviderArtistIgnores (
      provider_artist_item_id INTEGER PRIMARY KEY,
      decision_source TEXT NOT NULL CHECK(decision_source = 'manual'),
      reason TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(provider_artist_item_id) REFERENCES ProviderItems(id) ON DELETE CASCADE
    );

    CREATE TABLE ProviderEditionMatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_edition_item_id INTEGER NOT NULL,
      edition_id INTEGER NOT NULL,
      relation TEXT NOT NULL CHECK(relation IN ('exact', 'source_superset', 'source_subset', 'overlap')),
      match_state TEXT NOT NULL CHECK(match_state IN ('candidate', 'accepted', 'ambiguous', 'rejected')),
      decision_source TEXT NOT NULL CHECK(decision_source IN ('automatic', 'manual')),
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      method TEXT NOT NULL,
      evidence TEXT,
      matcher_version INTEGER NOT NULL,
      matched_track_count INTEGER NOT NULL DEFAULT 0,
      source_track_count INTEGER NOT NULL DEFAULT 0,
      target_track_count INTEGER NOT NULL DEFAULT 0,
      source_coverage REAL NOT NULL DEFAULT 0,
      target_coverage REAL NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider_edition_item_id, edition_id),
      FOREIGN KEY(provider_edition_item_id) REFERENCES ProviderItems(id) ON DELETE CASCADE,
      FOREIGN KEY(edition_id) REFERENCES AlbumEditions(id) ON DELETE CASCADE
    );

    CREATE TABLE ProviderTrackMatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_edition_member_id INTEGER NOT NULL,
      provider_edition_match_id INTEGER NOT NULL,
      track_id INTEGER,
      recording_id INTEGER NOT NULL,
      match_state TEXT NOT NULL CHECK(match_state IN ('candidate', 'accepted', 'ambiguous', 'rejected')),
      decision_source TEXT NOT NULL CHECK(decision_source IN ('automatic', 'manual')),
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      method TEXT NOT NULL,
      evidence TEXT,
      matcher_version INTEGER NOT NULL,
      duration_delta_ms INTEGER,
      ambiguity_margin REAL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(provider_edition_member_id) REFERENCES ProviderEditionMembers(id) ON DELETE CASCADE,
      FOREIGN KEY(provider_edition_match_id) REFERENCES ProviderEditionMatches(id) ON DELETE CASCADE,
      FOREIGN KEY(track_id) REFERENCES Tracks(id) ON DELETE CASCADE,
      FOREIGN KEY(recording_id) REFERENCES Recordings(id) ON DELETE CASCADE
    );

    CREATE TABLE ProviderVideoMatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_video_item_id INTEGER NOT NULL,
      recording_id INTEGER NOT NULL,
      match_state TEXT NOT NULL CHECK(match_state IN ('candidate', 'accepted', 'ambiguous', 'rejected')),
      decision_source TEXT NOT NULL CHECK(decision_source IN ('automatic', 'manual')),
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      method TEXT NOT NULL,
      evidence TEXT,
      matcher_version INTEGER NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider_video_item_id, recording_id),
      FOREIGN KEY(provider_video_item_id) REFERENCES ProviderItems(id) ON DELETE CASCADE,
      FOREIGN KEY(recording_id) REFERENCES Recordings(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_provider_release_members_release
      ON ProviderEditionMembers(provider_edition_item_id, medium_position, position);
    CREATE INDEX idx_provider_release_members_member
      ON ProviderEditionMembers(member_item_id, provider_edition_item_id);
    CREATE INDEX idx_provider_item_credits_artist
      ON ProviderItemCredits(artist_item_id, item_id);
    CREATE INDEX idx_provider_audio_variants_item
      ON ProviderItemAudioVariants(provider_item_id, availability);
    CREATE INDEX idx_provider_artist_matches_provider
      ON ProviderArtistMatches(provider_artist_item_id, match_state);
    CREATE INDEX idx_provider_artist_matches_artist
      ON ProviderArtistMatches(artist_id, match_state);
    CREATE INDEX idx_provider_release_matches_provider
      ON ProviderEditionMatches(provider_edition_item_id, match_state, relation);
    CREATE INDEX idx_provider_release_matches_release
      ON ProviderEditionMatches(edition_id, match_state, relation);
    CREATE INDEX idx_provider_track_matches_member
      ON ProviderTrackMatches(provider_edition_member_id, match_state);
    CREATE INDEX idx_provider_track_matches_release_match
      ON ProviderTrackMatches(provider_edition_match_id, match_state);
    CREATE INDEX idx_provider_track_matches_track
      ON ProviderTrackMatches(track_id, match_state);
    CREATE INDEX idx_provider_track_matches_recording
      ON ProviderTrackMatches(recording_id, match_state);
    CREATE UNIQUE INDEX idx_provider_track_matches_unique_edge
      ON ProviderTrackMatches(
        provider_edition_member_id,
        provider_edition_match_id,
        COALESCE(track_id, -1),
        recording_id
      );
    CREATE INDEX idx_provider_video_matches_recording
      ON ProviderVideoMatches(recording_id, match_state);

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
    WHEN NEW.track_id IS NOT NULL
    BEGIN
      SELECT CASE
        WHEN (SELECT recording_id FROM Tracks WHERE id = NEW.track_id) != NEW.recording_id
          THEN RAISE(ABORT, 'provider track match recording disagrees with canonical track')
      END;
    END;
  `);

  db.exec("CREATE INDEX idx_mb_release_groups_artist ON Albums(artist_mbid, first_release_date)");
  db.exec("CREATE INDEX idx_album_artists_artist ON AlbumArtists(artist_mbid, release_group_mbid)");
  db.exec("CREATE INDEX idx_artist_release_groups_group ON ArtistReleaseGroups(release_group_mbid, artist_mbid)");
  db.exec("CREATE INDEX idx_artist_release_group_curation_group ON ArtistReleaseGroupCuration(release_group_mbid, included)");
  db.exec("CREATE INDEX idx_artist_release_group_curation_source_included ON ArtistReleaseGroupCuration(source_artist_mbid, included, release_group_mbid)");
  db.exec("CREATE INDEX idx_mb_releases_group ON AlbumEditions(release_group_mbid, date)");
  // Tracks already has UNIQUE(release_mbid, medium_position, position) and both
  // covering indexes below lead with album_edition_id, so no single-column
  // idx_tracks_album_release_id / idx_mb_tracks_release_position is created.
  db.exec("CREATE INDEX idx_provider_items_type ON ProviderItems(provider, entity_type, provider_id)");
  db.exec("CREATE INDEX idx_provider_items_upc ON ProviderItems(provider, upc) WHERE upc IS NOT NULL");
  db.exec("CREATE INDEX idx_provider_items_isrc ON ProviderItems(provider, isrc) WHERE isrc IS NOT NULL");
  // The download-queue list resolves each item's metadata by provider_id (N+1
  // lookups in DownloadQueueQueryService). Every other ProviderItems index leads
  // with `provider` (the provider *name*), so a `WHERE provider_id = ?` lookup
  // full-scanned the table per queue item — the ~15s GET /api/v1/queue. Index it.
  db.exec("CREATE INDEX idx_provider_items_provider_id ON ProviderItems(provider_id, entity_type)");
  db.exec("CREATE INDEX idx_recording_relations_source ON RecordingRelations(source_recording_id, relation_type)");
  db.exec("CREATE INDEX idx_recording_relations_target ON RecordingRelations(target_recording_id, relation_type)");
  db.exec("CREATE INDEX idx_recording_relations_foreign_source ON RecordingRelations(source_foreign_recording_id, relation_type)");
  db.exec("CREATE INDEX idx_recording_relations_foreign_target ON RecordingRelations(target_foreign_recording_id, relation_type)");
  db.exec("CREATE INDEX idx_track_files_canonical_track_type ON TrackFiles(canonical_track_mbid, file_type)");
  db.exec("CREATE INDEX idx_track_files_canonical_recording_type ON TrackFiles(canonical_recording_mbid, file_type)");
  db.exec("CREATE INDEX idx_track_files_recording_id ON TrackFiles(recording_id)");
  db.exec("CREATE INDEX idx_track_files_track_id ON TrackFiles(track_id)");
  db.exec("CREATE INDEX idx_track_files_release_group_id ON TrackFiles(release_group_id)");
  db.exec("CREATE INDEX idx_track_files_album_release_id ON TrackFiles(album_edition_id)");
  // Recordings is large on real libraries (one row per MusicBrainz recording —
  // ~280k on a 2.3k-artist library). Artist-completion, download-stats and the
  // video counts filter Recordings by artist on every library + dashboard load;
  // without these the planner full-scans Recordings per artist, which turned
  // /api/stats into a ~38s synchronous event-loop stall (cascading into
  // app-wide "request timed out" errors). Indexed, that path drops to ~1s.
  db.exec("CREATE INDEX idx_recordings_artist_mbid ON Recordings(artist_mbid, is_video)");
  db.exec("CREATE INDEX idx_recordings_artist_metadata ON Recordings(artist_metadata_id, is_video)");
  db.exec("CREATE INDEX idx_recordings_video ON Recordings(is_video) WHERE is_video = 1");
  db.exec("CREATE INDEX idx_recordings_video_monitored ON Recordings(is_video, monitored) WHERE is_video = 1");
  db.exec("CREATE INDEX idx_recordings_video_library_release_date ON Recordings(monitored, (release_date IS NULL), release_date DESC, id) WHERE is_video = 1");
  db.exec("CREATE INDEX idx_recordings_video_library_popularity ON Recordings(monitored, COALESCE(popularity, 0) DESC, id) WHERE is_video = 1");
  db.exec("CREATE INDEX idx_recordings_video_library_title ON Recordings(monitored, title, id) WHERE is_video = 1");
  db.exec("CREATE INDEX idx_recordings_video_library_updated ON Recordings(monitored, (updated_at IS NULL), updated_at DESC, id) WHERE is_video = 1");
  // ArtistMetadata.mbid/foreign_artist_id are UNIQUE (autoindexed). Name lookups
  // and sort-name browsing need an explicit covering index for artist search UI.
  db.exec("CREATE INDEX idx_artist_metadata_name ON ArtistMetadata(name COLLATE NOCASE)");
  db.exec("CREATE INDEX idx_artist_metadata_sort_name ON ArtistMetadata(sort_name COLLATE NOCASE)");
  // (Tracks.recording_mbid is already indexed by idx_mb_tracks_recording_mbid in
  // initDatabase — no separate index needed here.)
}
