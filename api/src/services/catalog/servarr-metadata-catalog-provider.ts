/**
 * `ServarrMetadataCatalogProvider` — wraps **today's** Servarr Metadata Server / MusicBrainz web-API
 * replica flow behind the `CatalogProvider` interface. See
 * `docs/DATA_MODEL_TARGET.md` §3.
 *
 * This is a thin, behavior-preserving adapter: every method delegates to the
 * existing `ServarrMetadataService` (`api.lidarr.audio`). It does NOT change what the
 * Servarr Metadata Server flow does — it only documents it as one `CatalogProvider`
 * implementation so the catalog source becomes swappable.
 *
 * Servarr Metadata Server capability gaps (these methods are intentionally absent / throwing):
 *  - no standalone recording endpoint  → `getRecording` omitted
 *  - no UPC index                       → `lookupByUPC` omitted
 *  - no ISRC index                      → `lookupByISRC` omitted
 * MB-local mode fills these in; until then matching falls back to
 * title/track-count/date/duration (see §3 "Rate limits").
 */
import { servarrMetadata, ServarrMetadataService } from "../metadata/servarr-metadata.js";
import type {
  CatalogProvider,
  CatalogSearchOptions,
  CatalogSearchResults,
  LidarrArtist,
  LidarrReleaseGroupDetail,
  LidarrRelease,
} from "./catalog-provider.js";
import { findReleaseInGroup, releaseGroupsFromArtist } from "./catalog-provider.js";
import type { MusicBrainzReleaseGroupForMatching } from "../metadata/provider-release-group-matcher.js";

export class ServarrMetadataCatalogProvider implements CatalogProvider {
  readonly id = "servarr-metadata";
  readonly name = "Servarr Metadata Server";

  /**
   * Inject the service for testability. Defaults to the shared
   * `servarrMetadata` singleton that every other caller in the process uses.
   *
   * It previously defaulted to a fresh `ServarrMetadataService`, which made the
   * registered catalog provider read through a second, parallel instance of the
   * canonical metadata client — a different object from the one the rest of the
   * ingestion path talks to.
   */
  constructor(private readonly service: Pick<
    ServarrMetadataService,
    "getArtistInfo" | "getAlbumInfo" | "searchForNewArtist" | "searchAll"
  > = servarrMetadata) {}

  async getArtist(artistMbid: string): Promise<LidarrArtist> {
    return this.service.getArtistInfo(artistMbid);
  }

  async getArtistReleaseGroups(artistMbid: string): Promise<MusicBrainzReleaseGroupForMatching[]> {
    const artist = await this.service.getArtistInfo(artistMbid);
    return releaseGroupsFromArtist(artist);
  }

  async getReleaseGroup(releaseGroupMbid: string): Promise<LidarrReleaseGroupDetail> {
    return this.service.getAlbumInfo(releaseGroupMbid);
  }

  /**
   * Servarr Metadata Server serves releases (with tracks) only as children of a release group,
   * not by release MBID. We fetch the parent group and project the release out.
   * Since we don't know the group MBID here, we cannot fetch directly — callers
   * that have the group should prefer `getReleaseGroup`. This convenience path
   * is supported only when the release MBID is already known to belong to a
   * group the caller fetched; otherwise returns null.
   */
  async getReleaseWithTracks(releaseMbid: string): Promise<LidarrRelease | null> {
    // Servarr Metadata Server has no `/release/{mbid}` endpoint; release detail is always nested
    // under `/album/{releaseGroupMbid}`. Without the group MBID we cannot
    // resolve it, so this returns null in the Servarr Metadata Server implementation. MB-local
    // overrides this with a direct release lookup.
    void releaseMbid;
    return null;
  }

  /**
   * Resolve a release (with tracks) when the owning release-group MBID is known.
   * Not part of the `CatalogProvider` contract, but the natural Servarr Metadata Server shape;
   * `musicbrainz-release-group-read-service` effectively does this against the
   * local replica today.
   */
  async getReleaseWithTracksInGroup(
    releaseGroupMbid: string,
    releaseMbid: string,
  ): Promise<LidarrRelease | null> {
    const detail = await this.service.getAlbumInfo(releaseGroupMbid);
    return findReleaseInGroup(detail, releaseMbid);
  }

  async search(query: string, options: CatalogSearchOptions = {}): Promise<CatalogSearchResults> {
    const limit = options.limit ?? 20;
    const [artists, raw] = await Promise.all([
      this.service.searchForNewArtist(query, limit),
      Promise.resolve(this.service.searchAll(query, limit)).catch(() => [] as unknown[]),
    ]);
    const releaseGroups = (Array.isArray(raw) ? raw : [])
      .map((item: any) => item?.album)
      .filter((album: any) => album?.id && album?.title)
      .map((album: any) => ({
        mbid: String(album.id),
        title: String(album.title),
        artistName: album.artistname || album.artistName || album.ArtistName || album.artist?.artistname || null,
        artistMbid: album.artistid || album.artistId || album.ArtistId || album.artist?.id || null,
        releaseDate: album.releasedate || album.releaseDate || null,
        disambiguation: album.disambiguation || album.Disambiguation || null,
        images: album.Images || album.images || [],
      }));
    return { artists, releaseGroups, raw };
  }
}

export const servarrMetadataCatalogProvider = new ServarrMetadataCatalogProvider();
