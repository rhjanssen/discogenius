/**
 * SQL expression that turns a planned track variant into a UI quality tag.
 *
 * Plan snapshots store the normalized ladder class (`spatial`, `lossless`, …).
 * Badges need the *display* tag (`DOLBY_ATMOS`, not generic `SPATIAL`) which
 * lives on `ProviderItemAudioVariants.spatial_format` / provider labels.
 *
 * Only promote Atmos when the variant is actually spatial-class or has an
 * Atmos spatial_format — Apple also stamps "dolby-atmos" on multi-capability
 * stereo labels and those must stay HIRES/LOSSLESS.
 */
export function planTrackDisplayQualitySql(
  planTrackAlias = "plan_track",
  variantAlias = "variant",
): string {
  return displayQualitySql(variantAlias, `CASE
    WHEN json_valid(${planTrackAlias}.source_quality_snapshot)
    THEN json_extract(${planTrackAlias}.source_quality_snapshot, '$.quality')
    ELSE ${planTrackAlias}.source_quality_snapshot
  END`);
}

/**
 * The same badge, for a variant with no plan behind it.
 *
 * Used where an offer is shown before (or without) a plan — the queue's
 * provider-item fallback. Reading `provider_quality_label` directly is not a
 * substitute: a provider's trait list can be several tags long, and only this
 * expression knows to collapse that to DOLBY_ATMOS or to the neutral class.
 */
export function variantDisplayQualitySql(variantAlias = "variant"): string {
  return displayQualitySql(variantAlias, "NULL");
}

/**
 * The last comma-separated segment of `expr` (the whole value when there is no
 * comma), using SQLite's `replace(x, rtrim(x, replace(x, ',', '')), '')` idiom.
 *
 * A quality tag is one token. Providers advertise a release's *capabilities* as
 * a list, and ingestion used to persist the whole joined list as one variant's
 * label — and then a plan snapshot copied it. So the database still holds
 * values like "dolby-atmos,lossless,lossy-stereo,LOSSLESS", tens of thousands
 * of them, which no badge can render. The canonical token is last, so take it
 * and let the badge work without waiting for a re-ingest.
 */
function lastQualityTokenSql(expr: string): string {
  return `TRIM(REPLACE(${expr}, RTRIM(${expr}, REPLACE(${expr}, ',', '')), ''))`;
}

function displayQualitySql(variantAlias: string, snapshotQuality: string): string {
  return lastQualityTokenSql(`CASE
    WHEN LOWER(COALESCE(${variantAlias}.spatial_format, '')) IN (
      'atmos', 'dolby_atmos', 'dolby-atmos'
    ) THEN 'DOLBY_ATMOS'
    WHEN LOWER(COALESCE(${variantAlias}.spatial_format, '')) IN (
      '360ra', 'sony_360ra', '360', 'mpeg-h'
    ) THEN 'SONY_360RA'
    WHEN LOWER(COALESCE(${variantAlias}.quality_class, '')) = 'spatial'
      AND (
        LOWER(COALESCE(${variantAlias}.provider_quality_label, '')) LIKE '%atmos%'
        OR LOWER(COALESCE(${snapshotQuality}, '')) LIKE '%atmos%'
      )
      THEN 'DOLBY_ATMOS'
    WHEN LOWER(COALESCE(${variantAlias}.quality_class, '')) = 'spatial'
      THEN COALESCE(
        NULLIF(TRIM(${variantAlias}.provider_quality_label), ''),
        NULLIF(TRIM(${snapshotQuality}), ''),
        'SPATIAL'
      )
    ELSE COALESCE(
      NULLIF(TRIM(${snapshotQuality}), ''),
      NULLIF(TRIM(${variantAlias}.provider_quality_label), ''),
      ${variantAlias}.quality_class
    )
  END`);
}

/**
 * Rank of one selected variant's tier. Lower is better.
 *
 * Written once because it was written four times before, and one of those
 * copies matched `hires_lossless` while the column stores `hires-lossless`.
 * That copy sorted every hi-res variant last, so a plan that genuinely
 * delivered hi-res advertised itself as Lossless.
 */
export function variantTierRankSql(variantAlias = "variant"): string {
  return `CASE LOWER(COALESCE(${variantAlias}.quality_class, ''))
    WHEN 'spatial' THEN 0
    WHEN 'hires-lossless' THEN 1
    WHEN 'hires_lossless' THEN 1
    WHEN 'hires' THEN 1
    WHEN 'lossless' THEN 2
    WHEN 'lossy' THEN 3
    ELSE 4
  END`;
}

/**
 * The headline quality of one acquisition plan: the best tier any of its
 * planned tracks actually selected.
 *
 * The product rule is "one Max track makes the plan Max", so the headline is a
 * maximum, not the first row. Album cards used to take `ORDER BY plan_track.id
 * LIMIT 1` — the *first* track's variant — so the same plan read as Max on the
 * Album page and High on the Artist page whenever the best track was not
 * track one.
 *
 * The distribution behind this headline is not discarded; see
 * {@link planQualityHistogramSql}, which ranking uses.
 */
export function planHeadlineQualitySql(planIdExpression: string): string {
  return `(
    SELECT ${planTrackDisplayQualitySql("headline_track", "headline_variant")}
    FROM AcquisitionPlanTracks headline_track
    JOIN ProviderItemAudioVariants headline_variant
      ON headline_variant.id = headline_track.provider_audio_variant_id
    WHERE headline_track.plan_id = ${planIdExpression}
    ORDER BY
      ${variantTierRankSql("headline_variant")},
      headline_track.id
    LIMIT 1
  )`;
}

/**
 * Per-tier counts for one plan, as a JSON object keyed by canonical tier.
 *
 * "1 Max + 9 High" and "10 Max" share a headline; only the distribution tells
 * them apart, and the curation solver ranks on it.
 */
export function planQualityHistogramSql(planIdExpression: string): string {
  return `(
    SELECT json_group_object(tier, tier_count) FROM (
      SELECT LOWER(COALESCE(histogram_variant.quality_class, 'unknown')) AS tier,
             COUNT(*) AS tier_count
      FROM AcquisitionPlanTracks histogram_track
      JOIN ProviderItemAudioVariants histogram_variant
        ON histogram_variant.id = histogram_track.provider_audio_variant_id
      WHERE histogram_track.plan_id = ${planIdExpression}
      GROUP BY tier
    )
  )`;
}
