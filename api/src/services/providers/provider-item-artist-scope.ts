/**
 * Shared SQL fragments that scope schema-41 ProviderItems rows to a managed
 * artist (the legacy `Artists` TEXT id) through the typed authority instead of
 * the retired `ProviderItems.artist_mbid` shadow column.
 *
 * Both fragments expect the provider item aliased as `pi` and bind the managed
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
export const PROVIDER_MEMBER_ARTIST_SCOPE_SQL = `
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
export const PROVIDER_RELEASE_ARTIST_SCOPE_SQL = `
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
 * Scalar subquery: the first parent provider release's provider_id for a
 * track/video item (`pi`), or NULL when the item has no release membership.
 */
export const PROVIDER_MEMBER_ALBUM_ID_SQL = `
    (
      SELECT CAST(release_item.provider_id AS TEXT)
      FROM ProviderReleaseMembers member
      JOIN ProviderItems release_item ON release_item.id = member.provider_release_item_id
      WHERE member.member_item_id = pi.id
      ORDER BY member.id
      LIMIT 1
    )
`;
