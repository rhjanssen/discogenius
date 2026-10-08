import type Database from "better-sqlite3";

/** Durable artwork provenance and library links; deleting UI proxies cannot
 * delete these records. Entity IDs are the same canonical IDs used by URLs. */
export function createArtworkStateSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ArtworkSources (
      cover_entity TEXT NOT NULL CHECK (cover_entity IN ('Artist','Album','Edition','Video')),
      entity_id TEXT NOT NULL,
      cover_type TEXT NOT NULL,
      source_url TEXT NOT NULL,
      preference TEXT CHECK (preference IN ('canonical','provider')),
      fulfilled_by TEXT CHECK (fulfilled_by IN ('canonical','provider','manual')),
      content_hash TEXT,
      PRIMARY KEY (cover_entity, entity_id, cover_type)
    );
    CREATE TABLE IF NOT EXISTS ArtworkLibraryLinks (
      cover_entity TEXT NOT NULL CHECK (cover_entity IN ('Artist','Album','Edition','Video')),
      entity_id TEXT NOT NULL,
      cover_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      metadata_file_id INTEGER REFERENCES MetadataFiles(id) ON DELETE CASCADE,
      PRIMARY KEY (cover_entity, entity_id, cover_type, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_artwork_library_links_metadata
      ON ArtworkLibraryLinks(metadata_file_id);
    CREATE TABLE IF NOT EXISTS ArtworkProxyVariants (
      cover_entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      cover_type TEXT NOT NULL,
      height INTEGER NOT NULL CHECK (height IN (250,500)),
      source_hash TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      PRIMARY KEY (cover_entity,entity_id,cover_type,height),
      FOREIGN KEY (cover_entity,entity_id,cover_type)
        REFERENCES ArtworkSources(cover_entity,entity_id,cover_type) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ArtworkMutationJournal (
      id TEXT PRIMARY KEY,
      cover_entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      cover_type TEXT NOT NULL,
      destination_path TEXT NOT NULL UNIQUE,
      staged_path TEXT NOT NULL,
      backup_path TEXT NOT NULL,
      original_identity TEXT,
      replacement_identity TEXT NOT NULL,
      database_snapshot TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'prepared' CHECK (phase IN ('prepared','committed')),
      recovery_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS ArtworkCacheRetirement (
      command_id INTEGER NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
      source_path TEXT NOT NULL,
      file_identity TEXT NOT NULL,
      source_snapshot TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('prepared','retired','protected')),
      reason TEXT,
      PRIMARY KEY(command_id,source_path)
    );
    CREATE TABLE IF NOT EXISTS ArtworkCacheRuns (
      command_id INTEGER PRIMARY KEY REFERENCES commands(id) ON DELETE CASCADE,
      retired INTEGER NOT NULL DEFAULT 0,
      protected INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ArtworkCacheInventories (
      command_id INTEGER NOT NULL REFERENCES commands(id) ON DELETE CASCADE,
      family INTEGER NOT NULL,
      directory TEXT NOT NULL,
      directory_identity TEXT NOT NULL,
      complete INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(command_id,family)
    );
    CREATE TABLE IF NOT EXISTS ArtworkCacheFolders (
      command_id INTEGER NOT NULL,
      family INTEGER NOT NULL,
      name TEXT NOT NULL,
      PRIMARY KEY(command_id,family,name),
      FOREIGN KEY(command_id,family) REFERENCES ArtworkCacheInventories(command_id,family) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_metadata_files_canonical_artist
      ON MetadataFiles(canonical_artist_mbid);
    CREATE INDEX IF NOT EXISTS idx_metadata_files_canonical_edition
      ON MetadataFiles(canonical_release_mbid);
  `);
}
