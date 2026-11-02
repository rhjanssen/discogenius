import type Database from "better-sqlite3";

/**
 * MusicBrainz track artist credits as published on the release.
 *
 * Name: track-artist-credit-names
 *
 * This is not a user_version bump. Opening a schema-46 database is the live
 * contract; this adds one table and a config marker, and an older build simply
 * ignores the table.
 *
 * Why a separate table instead of `TrackArtistCredits`: the catalogue sync has
 * never stored per-track credits there. It copies the release-group credit
 * onto every track (`materializeIntegerCreditsForReleaseGroup`), and library
 * curation's `track_credit` scope reads those rows. Replacing them with real
 * per-track credits would change which editions curation selects, which is a
 * separate product decision. Tags need the real credit now, so the published
 * track credit lives here, keyed by track MBID, with the MusicBrainz artist
 * name and sort name of each credited artist next to the credited-as name.
 *
 * `artist_name` is the artist's own MusicBrainz name ("Afrojack"); it is never
 * a credited-as variant ("AFROJACK"). `credited_name` and `join_phrase` rebuild
 * the printed credit ("Afrojack feat. Eva Simons", Picard's `artist`).
 */
export const TRACK_ARTIST_CREDIT_NAMES_MIGRATION = "track-artist-credit-names";

export function createTrackArtistCreditNamesSchema(
  db: Database.Database,
  options: { ifNotExists?: boolean } = {},
): void {
  const ifNotExists = options.ifNotExists ? "IF NOT EXISTS" : "";
  db.exec(`
    CREATE TABLE ${ifNotExists} TrackArtistCreditNames (
      track_mbid TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      artist_mbid TEXT NOT NULL,
      artist_name TEXT NOT NULL,
      artist_sort_name TEXT,
      credited_name TEXT NOT NULL,
      join_phrase TEXT NOT NULL DEFAULT '',
      synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (track_mbid, ordinal)
    ) WITHOUT ROWID
  `);
}

export function migrateTrackArtistCreditNames(db: Database.Database): void {
  const apply = db.transaction(() => {
    createTrackArtistCreditNamesSchema(db, { ifNotExists: true });
    const hasConfig = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config'").get();
    if (!hasConfig) return;
    db.prepare(`
      INSERT INTO config (key, value, description)
      VALUES (?, 'applied', ?)
      ON CONFLICT(key) DO NOTHING
    `).run(
      `schema.migration.${TRACK_ARTIST_CREDIT_NAMES_MIGRATION}`,
      "Track artist tags use the MusicBrainz track credit (TrackArtistCreditNames), not the album credit.",
    );
  });
  apply();
}
