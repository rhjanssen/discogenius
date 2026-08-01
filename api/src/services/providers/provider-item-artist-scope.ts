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
 * - they ignore `LibraryEditionScopes`, which records WHY a selected release is
 *   wanted and by which managed-artist workflow;
 * - the canonical fallback below keys on `AlbumEditions.artist_mbid`, i.e. the
 *   primary credited artist, so a collaboration owned by another artist is
 *   invisible to it even when this artist performs on it.
 *
 * Do not reuse these for curation, acquisition, completion or any library-facing
 * membership question until a credited-scope-aware equivalent exists that reads
 * `LibraryArtists`/`LibraryEditionScopes`. Track/release credits also flow
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
        FROM ProviderEditionMembers member
        JOIN ProviderItemCredits credit ON credit.item_id = member.provider_edition_item_id
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
        FROM ProviderEditionMembers member
        JOIN ProviderEditionMatches release_match
          ON release_match.provider_edition_item_id = member.provider_edition_item_id
         AND release_match.match_state = 'accepted'
        JOIN AlbumEditions canonical_release ON canonical_release.id = release_match.edition_id
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
        FROM ProviderEditionMatches release_match
        JOIN AlbumEditions canonical_release ON canonical_release.id = release_match.edition_id
        JOIN Artists managed_artist ON managed_artist.mbid = canonical_release.artist_mbid
        WHERE release_match.provider_edition_item_id = pi.id
          AND release_match.match_state = 'accepted'
          AND managed_artist.id = @artistId
      )
    )
`;

/**
 * Scalar subquery: the parent provider release's provider_id for a track/video
 * item **only when that release context is unambiguous** — i.e. the item belongs
 * to exactly one provider release.
 *
 * One provider track may legitimately appear on several provider releases
 * (Apple songs on multiple albums, TIDAL to-many track/album relations,
 * SoundCloud/YouTube playlist membership). Picking the lowest member id in that
 * case invents a release context, which then propagates into folder naming and
 * sidecar linkage. Ambiguity yields NULL so callers fall back to a context they
 * can actually justify (selected acquisition source, TrackFile canonical
 * release, or the on-disk folder).
 *
 * Pass the alias the provider item carries in the caller's query.
 */
export function providerUnambiguousAlbumIdSql(itemAlias: string): string {
  return `
    (
      SELECT CAST(release_item.provider_id AS TEXT)
      FROM ProviderEditionMembers member
      JOIN ProviderItems release_item ON release_item.id = member.provider_edition_item_id
      WHERE member.member_item_id = ${itemAlias}.id
        AND (
          SELECT COUNT(DISTINCT sibling.provider_edition_item_id)
          FROM ProviderEditionMembers sibling
          WHERE sibling.member_item_id = ${itemAlias}.id
        ) = 1
      LIMIT 1
    )
  `;
}

export const PROVIDER_MEMBER_ALBUM_ID_SQL = providerUnambiguousAlbumIdSql("pi");

/**
 * Which acquisition context a caller can prove. One provider track can be
 * planned in SEVERAL libraries at once, each selecting a different provider
 * release for a different canonical release — so "the plan" is only meaningful
 * once one of these narrows it to a single plan.
 *
 * Bind the corresponding named parameters alongside the query.
 */
export interface ProviderAlbumContext {
  /** Narrow to one plan: binds @planId. */
  planId?: boolean;
  /** Narrow to one selected library release: binds @libraryEditionId. */
  libraryEditionId?: boolean;
  /** Narrow to one library: binds @libraryId. */
  libraryId?: boolean;
  /** Narrow to the plan row for one canonical track: binds @canonicalTrackId. */
  canonicalTrackId?: boolean;
  /** Narrow to plans for one canonical release: binds @canonicalReleaseId. */
  canonicalReleaseId?: boolean;
  /**
   * Alias of the provider track/video item in the enclosing query. Defaults to
   * `pi`; set it when the outer query names the item something else.
   */
  itemAlias?: string;
  /**
   * Correlated library context for row-at-a-time callers: a SQL expression from
   * the enclosing query (e.g. `lf.library_id`) instead of a bound `@libraryId`.
   * A row whose expression is NULL falls back to the no-context rule — every
   * relevant current plan must agree — rather than matching every library.
   */
  libraryIdExpr?: string;
}

/**
 * Scalar subquery: the provider release a current acquisition plan selected for
 * this provider track (`pi`).
 *
 * A bare `LIMIT 1` over every current plan containing the track is wrong — the
 * same provider track may be planned in a stereo and a spatial library from two
 * different provider releases, and the winner would be arbitrary. So:
 *
 * - with context (plan / library release / library / canonical track / canonical
 *   release) the answer is scoped to that context;
 * - with no context the answer is returned ONLY when every relevant current plan
 *   agrees on the same provider release; disagreement yields NULL and the caller
 *   falls back to something it can justify.
 */
export function providerSelectedPlanAlbumIdSql(context: ProviderAlbumContext = {}): string {
  const itemAlias = context.itemAlias ?? "pi";
  const filters: string[] = [];
  if (context.planId) filters.push("AND acquisition_plan.id = @planId");
  if (context.libraryEditionId) filters.push("AND acquisition_plan.library_edition_id = @libraryEditionId");
  if (context.libraryId) filters.push("AND plan_library_release.library_id = @libraryId");
  if (context.libraryIdExpr) {
    // NULL expression → no narrowing, so the agree-or-NULL rule still applies.
    filters.push(`AND (${context.libraryIdExpr} IS NULL OR plan_library_release.library_id = ${context.libraryIdExpr})`);
  }
  if (context.canonicalTrackId) filters.push("AND plan_track.track_id = @canonicalTrackId");
  if (context.canonicalReleaseId) filters.push("AND plan_library_release.edition_id = @canonicalReleaseId");

  return `
    (
      SELECT CASE
        WHEN COUNT(DISTINCT plan_choice.release_item_id) = 1
        THEN MAX(plan_choice.release_provider_id)
      END
      FROM (
        SELECT
          plan_release_item.id AS release_item_id,
          CAST(plan_release_item.provider_id AS TEXT) AS release_provider_id
        FROM ProviderEditionMembers plan_member
        JOIN ProviderTrackMatches plan_match
          ON plan_match.provider_edition_member_id = plan_member.id
         AND plan_match.match_state = 'accepted'
        JOIN AcquisitionPlanTracks plan_track
          ON plan_track.provider_track_match_id = plan_match.id
        JOIN SelectedAcquisitionPlans acquisition_plan
          ON acquisition_plan.id = plan_track.plan_id
         AND acquisition_plan.state = 'current'
        JOIN LibraryEditions plan_library_release
          ON plan_library_release.id = acquisition_plan.library_edition_id
        JOIN AcquisitionPlanSources plan_source
          ON plan_source.id = plan_track.source_id
        JOIN ProviderEditionMatches plan_release_match
          ON plan_release_match.id = plan_source.provider_edition_match_id
        JOIN ProviderItems plan_release_item
          ON plan_release_item.id = plan_release_match.provider_edition_item_id
        WHERE plan_member.member_item_id = ${itemAlias}.id
          ${filters.join("\n          ")}
      ) plan_choice
    )
  `;
}

/**
 * The release context a caller should use for a provider track: the release the
 * library actually selected via its acquisition plan (scoped by whatever context
 * the caller can prove), else the item's single unambiguous release membership,
 * else NULL.
 */
export function providerResolvedAlbumIdSql(context: ProviderAlbumContext = {}): string {
  return `COALESCE(
    ${providerSelectedPlanAlbumIdSql(context)},
    ${providerUnambiguousAlbumIdSql(context.itemAlias ?? "pi")}
  )`;
}

/**
 * Context-free resolution, for callers (the artist-folder scan) that genuinely
 * have no library, plan or canonical target in hand. Plans must agree.
 */
export const PROVIDER_RESOLVED_ALBUM_ID_SQL = providerResolvedAlbumIdSql();

/**
 * Scalar subquery: the canonical release-group MBID implied by a provider
 * track/video item (`pi`), returned ONLY when every accepted release match
 * reachable from its memberships agrees on one release group.
 *
 * Callers that hold an explicit download/acquisition context (the release group
 * the job is importing into) must prefer that context and use this only as the
 * fallback — a provider item on several releases spanning different groups has
 * no single answer, and inventing one mis-files the resulting media.
 */
export const PROVIDER_ITEM_AGREED_RELEASE_GROUP_MBID_SQL = `
    (
      SELECT CASE
        WHEN COUNT(DISTINCT group_choice.release_group_id) = 1
        THEN MAX(group_choice.release_group_mbid)
      END
      FROM (
        SELECT
          release_group.id AS release_group_id,
          release_group.mbid AS release_group_mbid
        FROM ProviderEditionMembers member
        JOIN ProviderEditionMatches release_match
          ON release_match.provider_edition_item_id = member.provider_edition_item_id
         AND release_match.match_state = 'accepted'
        JOIN AlbumEditions canonical_release ON canonical_release.id = release_match.edition_id
        JOIN Albums release_group ON release_group.id = canonical_release.release_group_id
        WHERE member.member_item_id = pi.id
      ) group_choice
    )
`;

/**
 * Predicate: the provider track/video item (`pi`) occurs on one of the given
 * provider releases. This is a MEMBERSHIP question — the schema-41 replacement
 * for `provider_album_id IN (...)` — and stays true for every release the item
 * legitimately appears on, so it never has to pick a winner.
 *
 * `placeholders` is the caller's already-built bind list (e.g. "?, ?, ?").
 */
export function providerItemOnAnyReleaseSql(placeholders: string): string {
  return `
    EXISTS (
      SELECT 1
      FROM ProviderEditionMembers scope_member
      JOIN ProviderItems scope_release
        ON scope_release.id = scope_member.provider_edition_item_id
      WHERE scope_member.member_item_id = pi.id
        AND CAST(scope_release.provider_id AS TEXT) IN (${placeholders})
    )
  `;
}
