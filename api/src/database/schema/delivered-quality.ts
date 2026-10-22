import type Database from "better-sqlite3";

/**
 * Delivered quality per provider audio variant.
 *
 * Name: delivered-quality
 *
 * Providers advertise a tier per track (TIDAL `HIRES_LOSSLESS` from
 * mediaMetadata.tags) that the stream does not always deliver: tiddl asked for
 * max and received 16-bit/44.1 kHz FLAC. After import we know what the stream
 * really is.
 *
 * `quality_class` / `provider_quality_label` stay exactly what the provider
 * offers (SOURCE CAPABILITY). The measurement lives only in
 * `delivered_quality_class`; planning and the upgrade check read
 * COALESCE(delivered_quality_class, quality_class) at query time.
 *
 * An earlier build overwrote `quality_class` with the measurement. The repair
 * below puts the advertised class back for those rows; plan snapshots keep the
 * delivered class because they describe what the plan will really receive.
 * Additive column, no user_version bump. Idempotent.
 */
export const DELIVERED_QUALITY_MIGRATION = "delivered-quality";

export function migrateDeliveredQuality(db: Database.Database): void {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ProviderItemAudioVariants'").get();
  if (!table) return;
  const columns = db.prepare("PRAGMA table_info(ProviderItemAudioVariants)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "delivered_quality_class")) {
    db.exec("ALTER TABLE ProviderItemAudioVariants ADD COLUMN delivered_quality_class TEXT");
  }
  backfillDeliveredQuality(db);
  restoreAdvertisedQualityClass(db);
}

const RANK_SQL = (expr: string) => `CASE LOWER(REPLACE(TRIM(${expr}), '_', '-'))
  WHEN 'hires-lossless' THEN 4 WHEN 'hires' THEN 4
  WHEN 'lossless' THEN 3 WHEN 'high' THEN 2 WHEN 'lossy' THEN 2 WHEN 'low' THEN 1
  ELSE NULL END`;

/**
 * One-time pass over files imported before this column existed: when every
 * imported file of a track-owned stereo variant measured below the advertised
 * class, record the best measured class as delivered. Idempotent (only rows
 * without a delivered class are considered).
 */
function backfillDeliveredQuality(db: Database.Database): void {
  const needed = ["TrackFiles", "AcquisitionPlanTracks"].every((name) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  if (!needed) return;
  // source_quality = the delivered stream before any profile conversion.
  const measured = "COALESCE(NULLIF(TRIM(file.source_quality), ''), NULLIF(TRIM(file.imported_quality), ''), NULLIF(TRIM(file.quality), ''))";
  db.transaction(() => {
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS delivered_quality_backfill AS
      SELECT variant.id AS variant_id,
             MAX(${RANK_SQL(measured)}) AS measured_rank
      FROM ProviderItemAudioVariants variant
      JOIN TrackFiles file ON file.source_audio_variant_id = variant.id
                          AND file.provider_item_id = variant.provider_item_id
      WHERE ${RANK_SQL("variant.quality_class")} IS NOT NULL
        AND variant.delivered_quality_class IS NULL
      GROUP BY variant.id
      HAVING MAX(${RANK_SQL(measured)}) IS NOT NULL
         AND MAX(${RANK_SQL(measured)}) < MAX(${RANK_SQL("variant.quality_class")})
    `);
    db.exec(`
      UPDATE ProviderItemAudioVariants
      SET delivered_quality_class = (
            SELECT CASE measured_rank WHEN 4 THEN 'hires-lossless' WHEN 3 THEN 'lossless' ELSE 'lossy' END
            FROM delivered_quality_backfill WHERE variant_id = ProviderItemAudioVariants.id),
          updated_at = CURRENT_TIMESTAMP
      WHERE id IN (SELECT variant_id FROM delivered_quality_backfill)
    `);
    db.exec("DROP TABLE delivered_quality_backfill");
  })();
}

/** Put the provider-advertised class back where an earlier build replaced it
 * with the measurement. Only rows carrying a delivered class were touched. */
function restoreAdvertisedQualityClass(db: Database.Database): void {
  db.exec(`
    UPDATE ProviderItemAudioVariants
    SET quality_class = CASE ${RANK_SQL("provider_quality_label")}
          WHEN 4 THEN 'hires-lossless' WHEN 3 THEN 'lossless' END,
        updated_at = CURRENT_TIMESTAMP
    WHERE delivered_quality_class IS NOT NULL
      AND quality_class = delivered_quality_class
      AND ${RANK_SQL("provider_quality_label")} IN (3, 4)
      AND ${RANK_SQL("provider_quality_label")} > COALESCE(${RANK_SQL("quality_class")}, 0)
  `);
}
