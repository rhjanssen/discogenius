import type Database from "better-sqlite3";

/**
 * Migration: track-file-source
 *
 * Adds `source_provider` to `TrackFiles` and backfills existing files from
 * provider facts, provider matches, acquisition plans, or sets 'unknown'.
 * Additive column, no user_version bump. Idempotent.
 */
export const TRACK_FILE_SOURCE_MIGRATION = "track-file-source";

export function migrateTrackFileSource(db: Database.Database): void {
  const hasTrackFiles = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'TrackFiles'").get(),
  );
  if (!hasTrackFiles) return;

  const columns = new Set(
    (db.prepare("PRAGMA table_info(TrackFiles)").all() as Array<{ name: string }>).map((column) => column.name),
  );

  if (!columns.has("source_provider")) {
    db.exec("ALTER TABLE TrackFiles ADD COLUMN source_provider TEXT");
  }

  backfillTrackFileSource(db);
}

const NORMALIZE_PROVIDER_SQL = (expr: string) => `CASE
  WHEN LOWER(${expr}) IN ('apple-music', 'apple_music') THEN 'apple'
  WHEN LOWER(${expr}) IN ('amazon-music', 'amazon_music') THEN 'amazon'
  WHEN LOWER(${expr}) IN ('youtube-music', 'youtube_music') THEN 'youtube'
  WHEN LOWER(${expr}) = 'manual' THEN 'external'
  ELSE LOWER(${expr})
END`;

export function backfillTrackFileSource(db: Database.Database): void {
  const hasTable = (name: string) =>
    Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

  const hasProviderItems = hasTable("ProviderItems");
  const hasAcquisitionPlans = hasTable("AcquisitionPlans") && hasTable("AcquisitionPlanTracks");
  const hasProviderTrackMatches = hasTable("ProviderTrackMatches");

  db.transaction(() => {
    // 1. If provider_item_id is set and points to ProviderItems, backfill source_provider
    if (hasProviderItems) {
      db.exec(`
        UPDATE TrackFiles
        SET source_provider = (
          SELECT ${NORMALIZE_PROVIDER_SQL("pi.provider")}
          FROM ProviderItems pi
          WHERE pi.id = TrackFiles.provider_item_id
        )
        WHERE (source_provider IS NULL OR source_provider = '')
          AND provider_item_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM ProviderItems pi WHERE pi.id = TrackFiles.provider_item_id);
      `);

      // If provider and provider_id are set but provider_item_id is NULL, resolve provider_item_id
      db.exec(`
        UPDATE TrackFiles
        SET provider_item_id = (
          SELECT pi.id
          FROM ProviderItems pi
          WHERE pi.provider = TrackFiles.provider
            AND pi.entity_type IN ('track', 'video')
            AND CAST(pi.provider_id AS TEXT) = CAST(TrackFiles.provider_id AS TEXT)
          LIMIT 1
        )
        WHERE provider_item_id IS NULL
          AND provider IS NOT NULL
          AND provider != ''
          AND provider_id IS NOT NULL
          AND provider_id != '';
      `);
    }

    // 2. If provider column is set on TrackFiles, backfill source_provider
    db.exec(`
      UPDATE TrackFiles
      SET source_provider = ${NORMALIZE_PROVIDER_SQL("provider")}
      WHERE (source_provider IS NULL OR source_provider = '')
        AND provider IS NOT NULL
        AND provider != '';
    `);

    // 3. If track_id has an AcquisitionPlanTracks entry, backfill source_provider and provider_item_id
    if (hasAcquisitionPlans) {
      const selectItemId = hasProviderTrackMatches
        ? `COALESCE(provider_item_id, (
            SELECT ptm.provider_track_item_id
            FROM AcquisitionPlanTracks apt
            JOIN ProviderTrackMatches ptm ON ptm.id = apt.provider_track_match_id
            WHERE apt.track_id = TrackFiles.track_id AND ptm.provider_track_item_id IS NOT NULL
            ORDER BY apt.id DESC
            LIMIT 1
          ))`
        : "provider_item_id";

      db.exec(`
        UPDATE TrackFiles
        SET
          source_provider = (
            SELECT ${NORMALIZE_PROVIDER_SQL("ap.provider")}
            FROM AcquisitionPlanTracks apt
            JOIN AcquisitionPlans ap ON ap.id = apt.plan_id
            WHERE apt.track_id = TrackFiles.track_id
            ORDER BY apt.id DESC
            LIMIT 1
          ),
          provider_item_id = ${selectItemId}
        WHERE (source_provider IS NULL OR source_provider = '')
          AND track_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM AcquisitionPlanTracks apt
            JOIN AcquisitionPlans ap ON ap.id = apt.plan_id
            WHERE apt.track_id = TrackFiles.track_id
          );
      `);
    }

    // 4. If track_id has an accepted ProviderTrackMatches entry, backfill source_provider and provider_item_id
    if (hasProviderTrackMatches && hasProviderItems) {
      db.exec(`
        UPDATE TrackFiles
        SET
          source_provider = (
            SELECT ${NORMALIZE_PROVIDER_SQL("pi.provider")}
            FROM ProviderTrackMatches ptm
            JOIN ProviderItems pi ON pi.id = ptm.provider_track_item_id
            WHERE ptm.track_id = TrackFiles.track_id AND ptm.match_state = 'accepted'
            ORDER BY ptm.id DESC
            LIMIT 1
          ),
          provider_item_id = COALESCE(
            provider_item_id,
            (
              SELECT ptm.provider_track_item_id
              FROM ProviderTrackMatches ptm
              WHERE ptm.track_id = TrackFiles.track_id AND ptm.match_state = 'accepted' AND ptm.provider_track_item_id IS NOT NULL
              ORDER BY ptm.id DESC
              LIMIT 1
            )
          )
        WHERE (source_provider IS NULL OR source_provider = '')
          AND track_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM ProviderTrackMatches ptm
            WHERE ptm.track_id = TrackFiles.track_id AND ptm.match_state = 'accepted'
          );
      `);
    }

    // 5. Remaining rows get 'unknown'
    db.exec(`
      UPDATE TrackFiles
      SET source_provider = 'unknown'
      WHERE source_provider IS NULL OR source_provider = '';
    `);
  })();
}
