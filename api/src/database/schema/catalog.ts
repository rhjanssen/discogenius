import type Database from "better-sqlite3";

export function createCatalogForeignKeyIndexes(db: Database.Database): void {
  db.exec("CREATE INDEX idx_albums_artist_metadata_id ON Albums(artist_metadata_id)");
  db.exec("CREATE INDEX idx_albums_library_release_date ON Albums((first_release_date IS NULL), first_release_date DESC)");
  db.exec("CREATE INDEX idx_album_releases_release_group_id ON AlbumReleases(release_group_id)");
  db.exec("CREATE INDEX idx_album_releases_artist_metadata_id ON AlbumReleases(artist_metadata_id)");
  db.exec("CREATE INDEX idx_album_artists_release_group_id ON AlbumArtists(release_group_id)");
  db.exec("CREATE INDEX idx_album_artists_artist_metadata_id ON AlbumArtists(artist_metadata_id)");
  db.exec("CREATE INDEX idx_artist_release_groups_artist_metadata_id ON ArtistReleaseGroups(artist_metadata_id)");
  db.exec("CREATE INDEX idx_artist_release_groups_release_group_id ON ArtistReleaseGroups(release_group_id)");
  db.exec("CREATE INDEX idx_artist_release_group_curation_artist_metadata_id ON ArtistReleaseGroupCuration(source_artist_metadata_id, included)");
  db.exec("CREATE INDEX idx_artist_release_group_curation_release_group_id ON ArtistReleaseGroupCuration(release_group_id)");
  db.exec("CREATE INDEX idx_artist_release_group_curation_source_release_group_id ON ArtistReleaseGroupCuration(source_artist_mbid, included, release_group_id)");
  db.exec("CREATE INDEX idx_tracks_album_release_mbid ON Tracks(album_release_id, mbid)");
  db.exec("CREATE INDEX idx_tracks_recording_release ON Tracks(recording_id, album_release_id)");
  db.exec("CREATE INDEX idx_tracks_album_release_position ON Tracks(album_release_id, medium_position, position)");
  db.exec("CREATE INDEX idx_recordings_library_popularity ON Recordings(COALESCE(popularity, 0) DESC, id ASC)");
  db.exec("CREATE INDEX idx_release_group_slots_artist_metadata_id ON ReleaseGroupSlots(artist_metadata_id, slot)");
  db.exec("CREATE INDEX idx_release_group_slots_release_group_id ON ReleaseGroupSlots(release_group_id, slot)");
  db.exec("CREATE INDEX idx_release_group_slots_selected_album_monitor ON ReleaseGroupSlots(selected_album_release_id, monitored, selected_provider_id)");
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
    AFTER INSERT ON AlbumReleases
    BEGIN
      UPDATE AlbumReleases SET
        release_group_id = COALESCE(NEW.release_group_id, (SELECT id FROM Albums WHERE mbid = NEW.release_group_mbid)),
        artist_metadata_id = COALESCE(NEW.artist_metadata_id, (SELECT id FROM ArtistMetadata WHERE mbid = NEW.artist_mbid))
      WHERE id = NEW.id;
    END;
  `);
  db.exec(`
    CREATE TRIGGER trg_album_releases_catalog_fks_au
    AFTER UPDATE OF release_group_mbid, artist_mbid ON AlbumReleases
    BEGIN
      UPDATE AlbumReleases SET
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
        album_release_id = COALESCE(NEW.album_release_id, (SELECT id FROM AlbumReleases WHERE mbid = NEW.release_mbid)),
        recording_id = COALESCE(NEW.recording_id, (SELECT id FROM Recordings WHERE mbid = NEW.recording_mbid))
      WHERE id = NEW.id;
    END;
  `);
  db.exec(`
    CREATE TRIGGER trg_tracks_catalog_fks_au
    AFTER UPDATE OF release_mbid, recording_mbid ON Tracks
    BEGIN
      UPDATE Tracks SET
        album_release_id = (SELECT id FROM AlbumReleases WHERE mbid = NEW.release_mbid),
        recording_id = (SELECT id FROM Recordings WHERE mbid = NEW.recording_mbid)
      WHERE id = NEW.id;
    END;
  `);

  db.exec(`
    CREATE TRIGGER trg_release_group_slots_catalog_fks_ai
    AFTER INSERT ON ReleaseGroupSlots
    BEGIN
      UPDATE ReleaseGroupSlots SET
        artist_metadata_id = COALESCE(NEW.artist_metadata_id, (SELECT id FROM ArtistMetadata WHERE mbid = NEW.artist_mbid)),
        release_group_id = COALESCE(NEW.release_group_id, (SELECT id FROM Albums WHERE mbid = NEW.release_group_mbid)),
        selected_album_release_id = COALESCE(NEW.selected_album_release_id, (SELECT id FROM AlbumReleases WHERE mbid = NEW.selected_release_mbid))
      WHERE id = NEW.id;
    END;
  `);
  db.exec(`
    CREATE TRIGGER trg_release_group_slots_catalog_fks_au
    AFTER UPDATE OF artist_mbid, release_group_mbid, selected_release_mbid ON ReleaseGroupSlots
    BEGIN
      UPDATE ReleaseGroupSlots SET
        artist_metadata_id = (SELECT id FROM ArtistMetadata WHERE mbid = NEW.artist_mbid),
        release_group_id = (SELECT id FROM Albums WHERE mbid = NEW.release_group_mbid),
        selected_album_release_id = (SELECT id FROM AlbumReleases WHERE mbid = NEW.selected_release_mbid)
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

    CREATE TABLE AlbumReleases (
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
      album_release_id INTEGER,
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
      FOREIGN KEY(album_release_id) REFERENCES AlbumReleases(id) ON DELETE CASCADE,
      FOREIGN KEY(release_mbid) REFERENCES AlbumReleases(mbid) ON DELETE CASCADE,
      FOREIGN KEY(recording_id) REFERENCES Recordings(id) ON DELETE CASCADE,
      FOREIGN KEY(recording_mbid) REFERENCES Recordings(mbid) ON DELETE CASCADE
    );

    CREATE TABLE ProviderItems (
      provider TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      artist_mbid TEXT,
      release_group_mbid TEXT,
      release_mbid TEXT,
      track_mbid TEXT,
      recording_mbid TEXT,
      title TEXT,
      version TEXT,
      explicit BOOLEAN,
      quality TEXT,
      type TEXT,                          -- album offer type: album/single/ep/compilation/...
      upc TEXT,
      isrc TEXT,
      duration INT,
      volume_count INTEGER,               -- album offer medium/disc count
      track_number INTEGER,               -- track offer position on its medium
      volume_number INTEGER,              -- track offer medium/disc number
      replay_gain REAL,                   -- provider-only: track loudness normalization (MB has none)
      peak REAL,                          -- provider-only: track peak amplitude
      bpm REAL,                           -- provider-only: tempo
      musical_key TEXT,                   -- provider-only: musical key
      release_date TEXT,
      availability TEXT,
      library_slot TEXT NOT NULL DEFAULT 'stereo',
      artist_metadata_id INTEGER,
      album_id INTEGER,
      cover TEXT,
      popularity INTEGER,
      review_text TEXT,
      review_score REAL,
      copyright TEXT,
      audio_quality TEXT,
      discovered_from_artist_mbid TEXT,
      album_release_id INTEGER,
      track_id INTEGER,
      recording_id INTEGER,
      provider_album_id TEXT,             -- owning provider album id for track/video offers
      provider_url TEXT,
      asset_id TEXT,
      match_status TEXT,
      match_confidence REAL,
      match_method TEXT,
      match_evidence TEXT,
      provider_artist_name TEXT,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(provider, entity_type, provider_id)
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

    CREATE TABLE ReleaseGroupSlots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_metadata_id INTEGER,
      artist_mbid TEXT NOT NULL,
      release_group_id INTEGER,
      release_group_mbid TEXT NOT NULL,
      slot TEXT NOT NULL,
      monitored BOOLEAN NOT NULL DEFAULT 0,
      selected_provider TEXT,
      selected_provider_id TEXT,
      selected_album_release_id INTEGER,
      selected_release_mbid TEXT,
      quality TEXT,
      match_status TEXT,
      match_confidence REAL,
      match_method TEXT,
      match_evidence TEXT,
      provider_artist_name TEXT,
      provider_title TEXT,
      cover TEXT,
      popularity INTEGER,
      monitored_lock BOOLEAN NOT NULL DEFAULT 0,
      locked_at DATETIME,
      checked_at DATETIME,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(release_group_mbid, slot),
      FOREIGN KEY(artist_metadata_id) REFERENCES ArtistMetadata(id) ON DELETE CASCADE,
      FOREIGN KEY(artist_mbid) REFERENCES ArtistMetadata(mbid) ON DELETE CASCADE,
      FOREIGN KEY(release_group_id) REFERENCES Albums(id) ON DELETE CASCADE,
      FOREIGN KEY(release_group_mbid) REFERENCES Albums(mbid) ON DELETE CASCADE,
      FOREIGN KEY(selected_album_release_id) REFERENCES AlbumReleases(id) ON DELETE SET NULL,
      FOREIGN KEY(selected_release_mbid) REFERENCES AlbumReleases(mbid) ON DELETE SET NULL
    );

    -- Provider item -> MusicBrainz match graph. ProviderItems stores provider-native
    -- offer facts; this table stores only the edges to MusicBrainz entities.
    -- A provider album maps to an MB release. A provider track maps to its MB
    -- release + track + recording. Provider videos currently map to an MB recording
    -- and may later fill release/track when that relationship is known.
    CREATE TABLE ProviderItemMatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      provider_item_type TEXT NOT NULL,   -- 'artist' | 'album' | 'track' | 'video'
      provider_item_id TEXT NOT NULL,
      provider_album_id TEXT,             -- owning provider album for recording matches
      musicbrainz_artist_mbid TEXT,
      musicbrainz_release_mbid TEXT,
      musicbrainz_track_mbid TEXT,
      musicbrainz_recording_mbid TEXT,
      status TEXT,                        -- candidate | probable | verified | manual | rejected
      confidence REAL,
      method TEXT,
      evidence TEXT,                      -- JSON
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (
        musicbrainz_artist_mbid IS NOT NULL
        OR musicbrainz_release_mbid IS NOT NULL
        OR musicbrainz_track_mbid IS NOT NULL
        OR musicbrainz_recording_mbid IS NOT NULL
      )
    );

    CREATE UNIQUE INDEX idx_provider_item_matches_unique_edge
      ON ProviderItemMatches(
        provider,
        provider_item_type,
        provider_item_id,
        COALESCE(musicbrainz_artist_mbid, ''),
        COALESCE(musicbrainz_release_mbid, ''),
        COALESCE(musicbrainz_track_mbid, ''),
        COALESCE(musicbrainz_recording_mbid, '')
      );
    CREATE INDEX idx_provider_item_matches_artist ON ProviderItemMatches(musicbrainz_artist_mbid, provider_item_type);
    CREATE INDEX idx_provider_item_matches_release ON ProviderItemMatches(musicbrainz_release_mbid, provider_item_type);
    CREATE INDEX idx_provider_item_matches_track ON ProviderItemMatches(musicbrainz_track_mbid, provider_item_type);
    CREATE INDEX idx_provider_item_matches_recording ON ProviderItemMatches(musicbrainz_recording_mbid, provider_item_type);
    CREATE INDEX idx_provider_item_matches_source ON ProviderItemMatches(provider, provider_item_type, provider_item_id);
  `);

  db.exec("CREATE INDEX idx_mb_release_groups_artist ON Albums(artist_mbid, first_release_date)");
  db.exec("CREATE INDEX idx_album_artists_artist ON AlbumArtists(artist_mbid, release_group_mbid)");
  db.exec("CREATE INDEX idx_artist_release_groups_group ON ArtistReleaseGroups(release_group_mbid, artist_mbid)");
  db.exec("CREATE INDEX idx_artist_release_group_curation_group ON ArtistReleaseGroupCuration(release_group_mbid, included)");
  db.exec("CREATE INDEX idx_artist_release_group_curation_source_included ON ArtistReleaseGroupCuration(source_artist_mbid, included, release_group_mbid)");
  db.exec("CREATE INDEX idx_mb_releases_group ON AlbumReleases(release_group_mbid, date)");
  // Tracks already has UNIQUE(release_mbid, medium_position, position) and both
  // covering indexes below lead with album_release_id, so no single-column
  // idx_tracks_album_release_id / idx_mb_tracks_release_position is created.
  db.exec("CREATE INDEX idx_provider_items_mb_artist ON ProviderItems(provider, artist_mbid, entity_type)");
  db.exec("CREATE INDEX idx_provider_items_mb_release_group ON ProviderItems(provider, release_group_mbid, entity_type)");
  db.exec("CREATE INDEX idx_provider_items_mb_release ON ProviderItems(provider, release_mbid, entity_type)");
  db.exec("CREATE INDEX idx_provider_items_recording ON ProviderItems(provider, recording_mbid, entity_type)");
  db.exec("CREATE INDEX idx_provider_items_entity_track ON ProviderItems(entity_type, track_mbid)");
  db.exec("CREATE INDEX idx_provider_items_entity_recording ON ProviderItems(entity_type, recording_mbid)");
  db.exec("CREATE INDEX idx_provider_items_entity_release_group ON ProviderItems(entity_type, release_group_mbid, library_slot)");
  // Artist-scoped video/slot filters (artist page + offer lists) need artist_mbid
  // ahead of library_slot; the release-group composite above cannot serve that plan.
  db.exec("CREATE INDEX idx_provider_items_entity_artist_slot ON ProviderItems(entity_type, artist_mbid, library_slot)");
  db.exec("CREATE INDEX idx_provider_items_upc ON ProviderItems(provider, upc)");
  db.exec("CREATE INDEX idx_provider_items_isrc ON ProviderItems(provider, isrc)");
  db.exec("CREATE INDEX idx_provider_items_match ON ProviderItems(provider, entity_type, match_status)");
  db.exec("CREATE INDEX idx_provider_items_recording_id ON ProviderItems(recording_id)");
  db.exec("CREATE INDEX idx_provider_items_track_id ON ProviderItems(track_id, entity_type)");
  db.exec("CREATE INDEX idx_provider_items_provider_album ON ProviderItems(provider_album_id, entity_type)");
  // The download-queue list resolves each item's metadata by provider_id (N+1
  // lookups in DownloadQueueQueryService). Every other ProviderItems index leads
  // with `provider` (the provider *name*), so a `WHERE provider_id = ?` lookup
  // full-scanned the table per queue item — the ~15s GET /api/v1/queue. Index it.
  db.exec("CREATE INDEX idx_provider_items_provider_id ON ProviderItems(provider_id, entity_type)");
  db.exec("CREATE INDEX idx_recording_relations_source ON RecordingRelations(source_recording_id, relation_type)");
  db.exec("CREATE INDEX idx_recording_relations_target ON RecordingRelations(target_recording_id, relation_type)");
  db.exec("CREATE INDEX idx_recording_relations_foreign_source ON RecordingRelations(source_foreign_recording_id, relation_type)");
  db.exec("CREATE INDEX idx_recording_relations_foreign_target ON RecordingRelations(target_foreign_recording_id, relation_type)");
  db.exec("CREATE INDEX idx_release_group_slots_artist ON ReleaseGroupSlots(artist_mbid, slot)");
  db.exec("CREATE INDEX idx_release_group_slots_provider ON ReleaseGroupSlots(selected_provider, selected_provider_id)");
  db.exec("CREATE INDEX idx_release_group_slots_group_release_slot ON ReleaseGroupSlots(release_group_mbid, selected_release_mbid, slot)");
  db.exec("CREATE INDEX idx_track_files_canonical_track_type ON TrackFiles(canonical_track_mbid, file_type)");
  db.exec("CREATE INDEX idx_track_files_canonical_recording_type ON TrackFiles(canonical_recording_mbid, file_type)");
  db.exec("CREATE INDEX idx_track_files_recording_id ON TrackFiles(recording_id)");
  db.exec("CREATE INDEX idx_track_files_track_id ON TrackFiles(track_id)");
  db.exec("CREATE INDEX idx_track_files_release_group_id ON TrackFiles(release_group_id)");
  db.exec("CREATE INDEX idx_track_files_album_release_id ON TrackFiles(album_release_id)");
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
