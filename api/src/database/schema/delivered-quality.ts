import type Database from "better-sqlite3";

/**
 * Delivered quality per provider audio variant.
 *
 * Name: delivered-quality
 *
 * Providers advertise a tier per track (TIDAL `HIRES_LOSSLESS` from
 * mediaMetadata.tags) that the stream does not always deliver: tiddl asked for
 * max and received 16-bit/44.1 kHz FLAC. After import we know what the stream
 * really is. `delivered_quality_class` records that measured class when it is
 * below the advertised one; `quality_class` then follows it (so badges and
 * plan ranking reflect reality) while `provider_quality_label` keeps the
 * advertised value for display. A provider refresh must not overwrite it.
 * Additive column, no user_version bump.
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
}

const RANK_SQL = (expr: string) => `CASE LOWER(REPLACE(TRIM(${expr}), '_', '-'))
  WHEN 'hires-lossless' THEN 4 WHEN 'hires' THEN 4
  WHEN 'lossless' THEN 3 WHEN 'high' THEN 2 WHEN 'lossy' THEN 2 WHEN 'low' THEN 1
  ELSE NULL END`;

/**
 * One-time pass over files imported before this column existed: when every
 * imported file of a track-owned stereo variant measured below the advertised
 * class, record the best measured class as delivered. Idempotent (only rows
 * whose quality_class is still above the measurement change).
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
    db.exec(`
      UPDATE ProviderItemAudioVariants
      SET quality_class = delivered_quality_class
      WHERE id IN (SELECT variant_id FROM delivered_quality_backfill)
    `);
    db.exec(`
      UPDATE AcquisitionPlanTracks
      SET source_quality_snapshot = json_object('quality', (
            SELECT delivered_quality_class FROM ProviderItemAudioVariants v
            WHERE v.id = AcquisitionPlanTracks.provider_audio_variant_id)),
          updated_at = CURRENT_TIMESTAMP
      WHERE provider_audio_variant_id IN (SELECT variant_id FROM delivered_quality_backfill)
    `);
    db.exec("DROP TABLE delivered_quality_backfill");
  })();
}
