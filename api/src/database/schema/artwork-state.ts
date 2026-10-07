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
  `);
}
