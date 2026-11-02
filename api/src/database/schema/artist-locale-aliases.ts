import type Database from "better-sqlite3";

/**
 * MusicBrainz artist aliases that carry a locale, used to write artist names
 * in the user's language (Picard "translate artist names").
 *
 * Name: artist-locale-aliases
 *
 * Additive like track-artist-credit-names: no user_version bump, an older
 * build ignores the table. Only aliases with a locale and no end date are
 * stored, and only for artists that are credited on library files, so the
 * table follows the library, not the catalogue.
 */
export const ARTIST_LOCALE_ALIASES_MIGRATION = "artist-locale-aliases";

export function createArtistLocaleAliasesSchema(
  db: Database.Database,
  options: { ifNotExists?: boolean } = {},
): void {
  const ifNotExists = options.ifNotExists ? "IF NOT EXISTS" : "";
  db.exec(`
    CREATE TABLE ${ifNotExists} ArtistLocaleAliases (
      artist_mbid TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      name TEXT NOT NULL,
      sort_name TEXT,
      locale TEXT NOT NULL,
      primary_for_locale INTEGER NOT NULL DEFAULT 0,
      alias_type TEXT,
      synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (artist_mbid, ordinal)
    ) WITHOUT ROWID
  `);
  // Artists that were synced and have no locale alias get one marker row so a
  // sync can tell "checked, nothing" from "never checked".
  db.exec(`
    CREATE TABLE ${ifNotExists} ArtistLocaleAliasSync (
      artist_mbid TEXT PRIMARY KEY,
      synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) WITHOUT ROWID
  `);
}

export function migrateArtistLocaleAliases(db: Database.Database): void {
  const apply = db.transaction(() => {
    createArtistLocaleAliasesSchema(db, { ifNotExists: true });
    const hasConfig = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config'").get();
    if (!hasConfig) return;
    db.prepare(`
      INSERT INTO config (key, value, description)
      VALUES (?, 'applied', ?)
      ON CONFLICT(key) DO NOTHING
    `).run(
      `schema.migration.${ARTIST_LOCALE_ALIASES_MIGRATION}`,
      "Artist names in tags can use MusicBrainz locale aliases (ArtistLocaleAliases).",
    );
  });
  apply();
}
