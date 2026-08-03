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
  const snapshotQuality = `CASE
    WHEN json_valid(${planTrackAlias}.source_quality_snapshot)
    THEN json_extract(${planTrackAlias}.source_quality_snapshot, '$.quality')
    ELSE ${planTrackAlias}.source_quality_snapshot
  END`;
  return `CASE
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
  END`;
}
