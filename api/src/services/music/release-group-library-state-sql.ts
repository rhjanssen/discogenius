import { planHeadlineQualitySql } from "../../utils/display-quality-sql.js";

const spatialLibraryClassSql = `CASE WHEN EXISTS (
        SELECT 1
        FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
        WHERE allowed.value = 'spatial'
      ) THEN 'spatial' ELSE 'stereo' END`;

/**
 * Selected stereo/spatial library state for a *bounded* set of release groups.
 *
 * The ranked CTE used to start from every LibraryAlbums row (~14k on a mature
 * catalog) and compute each plan's headline quality via a correlated scan of
 * AcquisitionPlanTracks (millions of rows). Artist-page and library-list
 * reads then threw that work away for every album that was not on the page.
 * Callers pass `wantedGroupsSql` that yields `id` values for the groups they
 * actually need.
 */
export function releaseGroupLibraryStateCte(wantedGroupsSql: string): string {
  return `
  WITH wanted_groups AS MATERIALIZED (
    ${wantedGroupsSql}
  ),
  ranked_library_state AS MATERIALIZED (
    SELECT
      library_group.release_group_id,
      ${spatialLibraryClassSql} AS library_class,
      1 AS monitored,
      MAX(CASE WHEN library_group.locked = 1 THEN 1 ELSE 0 END) OVER (
        PARTITION BY
          library_group.release_group_id,
          ${spatialLibraryClassSql}
      ) AS monitored_lock,
      release.id AS selected_album_release_id,
      release.mbid AS selected_release_mbid,
      COALESCE(provider_item.provider, plan.provider) AS selected_provider,
      provider_item.id AS selected_provider_item_id,
      provider_item.provider_id AS selected_provider_id,
      provider_item.provider_url,
      plan.id AS selected_plan_id,
      release_match.match_state AS match_status,
      release_match.method AS match_method,
      release_match.relation AS match_relation,
      plan.composition AS plan_composition,
      plan.coverage AS plan_coverage,
      plan.target_track_count AS plan_target_track_count,
      COALESCE(provider_item.artwork_url, provider_item.cover_id) AS cover,
      provider_item.cover_id AS asset_id,
      provider_item.explicit,
      COALESCE(CAST(provider_item.popularity AS REAL), 0) AS popularity,
      ROW_NUMBER() OVER (
        PARTITION BY
          library_group.release_group_id,
          ${spatialLibraryClassSql}
        ORDER BY
          CASE WHEN plan.state = 'current' AND provider_item.id IS NOT NULL THEN 0 ELSE 1 END,
          library_release.representative DESC,
          library_release.updated_at DESC,
          library_release.id DESC,
          library.id ASC
      ) AS state_rank
    FROM wanted_groups
    JOIN LibraryAlbums library_group
      ON library_group.release_group_id = wanted_groups.id
    JOIN Libraries library
      ON library.id = library_group.library_id
     AND library.enabled = 1
    JOIN quality_profiles quality_profile
      ON quality_profile.id = library.quality_profile_id
    LEFT JOIN LibraryEditions library_release
      ON library_release.library_id = library_group.library_id
     AND EXISTS (
       SELECT 1
       FROM AlbumEditions selected_release
       WHERE selected_release.id = library_release.edition_id
         AND selected_release.release_group_id = library_group.release_group_id
     )
    LEFT JOIN AlbumEditions release
      ON release.id = library_release.edition_id
    LEFT JOIN SelectedAcquisitionPlans plan
      ON plan.library_edition_id = library_release.id
     AND plan.state = 'current'
    LEFT JOIN AcquisitionPlanSources plan_source
      ON plan_source.plan_id = plan.id
     AND plan_source.id = (
       SELECT preferred_source.id
       FROM AcquisitionPlanSources preferred_source
       WHERE preferred_source.plan_id = plan.id
       ORDER BY
         CASE preferred_source.role WHEN 'primary' THEN 0 ELSE 1 END,
         preferred_source.sort_order,
         preferred_source.id
       LIMIT 1
     )
    LEFT JOIN ProviderEditionMatches release_match
      ON release_match.id = plan_source.provider_edition_match_id
     AND release_match.match_state = 'accepted'
    LEFT JOIN ProviderItems provider_item
      ON provider_item.id = release_match.provider_edition_item_id
     AND (
       provider_item.availability IS NULL
       OR LOWER(CAST(provider_item.availability AS TEXT))
          NOT IN ('0', 'false', 'unavailable', 'no', '')
     )
  ),
  library_state AS MATERIALIZED (
    SELECT *
    FROM ranked_library_state
    WHERE state_rank = 1
  )
`;
}

export function planQualityExpression(planIdExpression: string): string {
  return `CASE
    WHEN ${planIdExpression} IS NULL THEN NULL
    ELSE ${planHeadlineQualitySql(planIdExpression)}
  END`;
}

export const ARTIST_WANTED_RELEASE_GROUPS_SQL = `
    SELECT id
    FROM Albums
    WHERE artist_mbid = ?
       OR mbid IN (
         SELECT scope.release_group_mbid
         FROM ArtistReleaseGroups scope
         WHERE scope.artist_mbid = ?
       )
`;

/**
 * Library list: albums monitored in an enabled library. ArtistReleaseGroupCuration
 * is a discography-inclusion overlay and can be empty during a refresh, so it
 * must not gate the library page.
 */
export const CURATED_LIBRARY_RELEASE_GROUPS_SQL = `
    SELECT DISTINCT library_group.release_group_id AS id
    FROM LibraryAlbums library_group
    JOIN Libraries library
      ON library.id = library_group.library_id
     AND library.enabled = 1
`;

export function pagedReleaseGroupIdsSql(placeholders: string): string {
  return `SELECT id FROM Albums WHERE id IN (${placeholders})`;
}
