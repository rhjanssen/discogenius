/**
 * Build a SQL predicate that maps a provider-native audio quality value onto
 * Discogenius' neutral MAX / HIGH / NORMAL / LOW tiers.
 *
 * `qualityColumn` must be a code-controlled SQL expression. `tier` is
 * validated against the fixed enum before anything is interpolated.
 */
export function qualityTierSqlCondition(qualityColumn: string, tier: string): string | null {
  const q = `UPPER(COALESCE(${qualityColumn}, ''))`;
  const hires = `(${q} = 'MAX' OR ${q} LIKE '%HIRES%' OR ${q} LIKE '%HI_RES%' OR ${q} LIKE '%MQA%' OR ${q} LIKE '%MASTER%')`;
  const lossless = `(${q} LIKE '%LOSSLESS%' OR ${q} LIKE '%FLAC%' OR ${q} LIKE '%ALAC%')`;
  const low = `(${q} = 'LOW' OR SUBSTR(${q}, -4) = '_LOW'`
    + ` OR INSTR(${q}, '_96') > 0 OR INSTR(${q}, '_128') > 0 OR INSTR(${q}, '_64') > 0`
    + ` OR ${q} LIKE '%YOUTUBE_LOSSY%' OR ${q} LIKE '%YT_LOSSY%')`;

  switch (tier.toUpperCase()) {
    case "MAX":
      return hires;
    case "HIGH":
      return `(${lossless} AND NOT ${hires})`;
    case "LOW":
      return `(${low} AND NOT ${hires} AND NOT ${lossless})`;
    case "NORMAL":
      return `(${q} != '' AND NOT ${hires} AND NOT ${lossless} AND NOT ${low}`
        + ` AND ${q} NOT LIKE '%ATMOS%' AND ${q} NOT LIKE '%SPATIAL%' AND ${q} NOT LIKE '%360%')`;
    default:
      return null;
  }
}
