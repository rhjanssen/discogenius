/**
 * SQL fragments that scope schema-41 ProviderItems rows to a managed artist (the
 * legacy `Artists` TEXT id) through the typed authority instead of the retired
 * `ProviderItems.artist_mbid` shadow column.
 *
 * SCOPE OF USE — legacy artist-FOLDER scanning only.
 *
 * These fragments answer "could this provider resource plausibly belong under
 * this artist's folder on disk?", which is what the folder-oriented library scan
 * needs. They are deliberately NOT a statement of library membership:
 *
 * - they ignore `LibraryArtists.credited_scope` (`primary_only` /
 *   `release_credit` / `release_and_track_credit`), so they neither expand to a
 *   collaborator's releases the library actually wants nor exclude ones it does
 *   not;
 * - they ignore `LibraryReleaseScopes`, which records WHY a selected release is
 *   wanted and by which managed-artist workflow;
 * - the canonical fallback below keys on `AlbumReleases.artist_mbid`, i.e. the
 *   primary credited artist, so a collaboration owned by another artist is
 *   invisible to it even when this artist performs on it.
 *
 * Do not reuse these for curation, acquisition, completion or any library-facing
 * membership question until a credited-scope-aware equivalent exists that reads
 * `LibraryArtists`/`LibraryReleaseScopes`. Track/release credits also flow
 * through `ProviderItemCredits`, so a featured or remixing artist matches here
 * exactly as a primary one does — correct for folder scanning, wrong as an
 * ownership claim.
 *
 * Every fragment expects the provider item aliased as `pi` and binds the managed
 * artist id as the named parameter `@artistId`.
 */

/**
 * A provider track/video belongs to the managed artist when:
 *  1. its own credits reach the artist through an accepted ProviderArtistMatches
 *     edge, or
 *  2. any parent provider release's credits do, or
 *  3. (canonical fallback) any parent provider release is accepted-matched to a
 *     canonical release owned by the artist.
 */
export const LEGACY_FOLDER_SCAN_MEMBER_ARTIST_SCOPE_SQL = `
    (
      EXISTS (
        SELECT 1
        FROM ProviderItemCredits credit
        JOIN ProviderArtistMatches artist_match
          ON artist_match.provider_artist_item_id = credit.artist_item_id
         AND artist_match.match_state = 'accepted'
        JOIN ArtistMetadata artist_meta ON artist_meta.id = artist_match.artist_id
        JOIN Artists managed_artist ON managed_artist.mbid = artist_meta.mbid
        WHERE credit.item_id = pi.id
          AND managed_artist.id = @artistId
      )
      OR EXISTS (
        SELECT 1
        FROM ProviderReleaseMembers member
        JOIN ProviderItemCredits credit ON credit.item_id = member.provider_release_item_id
        JOIN ProviderArtistMatches artist_match
          ON artist_match.provider_artist_item_id = credit.artist_item_id
         AND artist_match.match_state = 'accepted'
        JOIN ArtistMetadata artist_meta ON artist_meta.id = artist_match.artist_id
        JOIN Artists managed_artist ON managed_artist.mbid = artist_meta.mbid
        WHERE member.member_item_id = pi.id
          AND managed_artist.id = @artistId
      )
      OR EXISTS (
        SELECT 1
        FROM ProviderReleaseMembers member
        JOIN ProviderReleaseMatches release_match
          ON release_match.provider_release_item_id = member.provider_release_item_id
         AND release_match.match_state = 'accepted'
        JOIN AlbumReleases canonical_release ON canonical_release.id = release_match.release_id
        JOIN Artists managed_artist ON managed_artist.mbid = canonical_release.artist_mbid
        WHERE member.member_item_id = pi.id
          AND managed_artist.id = @artistId
      )
    )
`;

/**
 * A provider release belongs to the managed artist when its credits reach the
 * artist through an accepted ProviderArtistMatches edge, or it is
 * accepted-matched to a canonical release owned by the artist.
 */
export const LEGACY_FOLDER_SCAN_RELEASE_ARTIST_SCOPE_SQL = `
    (
      EXISTS (
        SELECT 1
        FROM ProviderItemCredits credit
        JOIN ProviderArtistMatches artist_match
          ON artist_match.provider_artist_item_id = credit.artist_item_id
         AND artist_match.match_state = 'accepted'
        JOIN ArtistMetadata artist_meta ON artist_meta.id = artist_match.artist_id
        JOIN Artists managed_artist ON managed_artist.mbid = artist_meta.mbid
        WHERE credit.item_id = pi.id
          AND managed_artist.id = @artistId
      )
      OR EXISTS (
        SELECT 1
        FROM ProviderReleaseMatches release_match
        JOIN AlbumReleases canonical_release ON canonical_release.id = release_match.release_id
        JOIN Artists managed_artist ON managed_artist.mbid = canonical_release.artist_mbid
        WHERE release_match.provider_release_item_id = pi.id
          AND release_match.match_state = 'accepted'
          AND managed_artist.id = @artistId
      )
    )
`;

/**
 * Scalar subquery: the parent provider release's provider_id for a track/video
 * item (`pi`) **only when that release context is unambiguous** — i.e. the item
 * belongs to exactly one provider release.
 *
 * One provider track may legitimately appear on several provider releases
 * (Apple songs on multiple albums, TIDAL to-many track/album relations,
 * SoundCloud/YouTube playlist membership). Picking the lowest member id in that
 * case invents a release context, which then propagates into folder naming and
 * sidecar linkage. Ambiguity yields NULL so callers fall back to a context they
 * can actually justify (selected acquisition source, TrackFile canonical
 * release, or the on-disk folder).
 */
export const PROVIDER_MEMBER_ALBUM_ID_SQL = `
    (
      SELECT CAST(release_item.provider_id AS TEXT)
      FROM ProviderReleaseMembers member
      JOIN ProviderItems release_item ON release_item.id = member.provider_release_item_id
      WHERE member.member_item_id = pi.id
        AND (
          SELECT COUNT(DISTINCT sibling.provider_release_item_id)
          FROM ProviderReleaseMembers sibling
          WHERE sibling.member_item_id = pi.id
        ) = 1
      LIMIT 1
    )
`;

/**
 * Scalar subquery: the provider release actually selected for this provider
 * track by a current acquisition plan — the authoritative release context when
 * one exists, because the plan records which provider release the library chose
 * to acquire the canonical track from. Falls back to NULL (never a guess).
 *
 * Expects the provider track item aliased as `pi`.
 */
export const PROVIDER_SELECTED_PLAN_ALBUM_ID_SQL = `
    (
      SELECT CAST(plan_release_item.provider_id AS TEXT)
      FROM ProviderReleaseMembers plan_member
      JOIN ProviderTrackMatches plan_match
        ON plan_match.provider_release_member_id = plan_member.id
       AND plan_match.match_state = 'accepted'
      JOIN AcquisitionPlanTracks plan_track
        ON plan_track.provider_track_match_id = plan_match.id
      JOIN AcquisitionPlans acquisition_plan
        ON acquisition_plan.id = plan_track.plan_id
       AND acquisition_plan.state = 'current'
      JOIN AcquisitionPlanSources plan_source
        ON plan_source.id = plan_track.source_id
      JOIN ProviderReleaseMatches plan_release_match
        ON plan_release_match.id = plan_source.provider_release_match_id
      JOIN ProviderItems plan_release_item
        ON plan_release_item.id = plan_release_match.provider_release_item_id
      WHERE plan_member.member_item_id = pi.id
      ORDER BY plan_source.sort_order, plan_source.id
      LIMIT 1
    )
`;

/**
 * The release context a caller should use for a provider track: the release the
 * library actually selected via its acquisition plan, else the item's single
 * unambiguous release membership, else NULL.
 */
export const PROVIDER_RESOLVED_ALBUM_ID_SQL = `
    COALESCE(${PROVIDER_SELECTED_PLAN_ALBUM_ID_SQL}, ${PROVIDER_MEMBER_ALBUM_ID_SQL})
`;
