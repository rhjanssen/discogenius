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
  CatalogArtistLocaleAlias,
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
  constructor(
    private readonly service: Pick<
      ServarrMetadataService,
      "getArtistInfo" | "getAlbumInfo" | "searchForNewArtist" | "searchAll"
    > = servarrMetadata,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getArtist(artistMbid: string): Promise<LidarrArtist> {
    return this.service.getArtistInfo(artistMbid);
  }

  async getArtistLocaleAliases(artistMbids: string[]): Promise<Map<string, CatalogArtistLocaleAlias[]>> {
    const result = new Map<string, CatalogArtistLocaleAlias[]>();
    const uniqueMbids = [...new Set(artistMbids.map((id) => String(id || "").trim().toLowerCase()).filter(Boolean))];
    for (const mbid of uniqueMbids) {
      let aliases: CatalogArtistLocaleAlias[] = [];
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        try {
          const response = await this.fetchImpl(
            `https://musicbrainz.org/ws/2/artist/${encodeURIComponent(mbid)}?inc=aliases&fmt=json`,
            {
              headers: {
                Accept: "application/json",
                "User-Agent": "Discogenius/1.0 (https://github.com/rhjanssen/discogenius)",
              },
              signal: controller.signal,
            },
          );
          if (response.ok) {
            const payload = await response.json() as {
              aliases?: Array<{
                name?: unknown;
                "sort-name"?: unknown;
                locale?: unknown;
                primary?: unknown;
                type?: unknown;
              }>;
            };
            aliases = (Array.isArray(payload?.aliases) ? payload.aliases : [])
              .map((alias) => {
                const name = String(alias?.name ?? "").trim();
                const locale = String(alias?.locale ?? "").trim();
                if (!name || !locale) return null;
                return {
                  name,
                  sortName: alias?.["sort-name"] ? String(alias["sort-name"]).trim() : null,
                  locale,
                  primaryForLocale: Boolean(alias?.primary),
                  type: alias?.type ? String(alias.type).trim() : null,
                } satisfies CatalogArtistLocaleAlias;
              })
              .filter((entry): entry is CatalogArtistLocaleAlias => entry !== null);
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // Fall through to best-effort Servarr alias inspection below.
      }

      if (aliases.length === 0) {
        try {
          const artist = await this.service.getArtistInfo(mbid) as LidarrArtist & {
            aliases?: Array<string | { name?: unknown; sortName?: unknown; "sort-name"?: unknown; locale?: unknown; primary?: unknown; primaryForLocale?: unknown; type?: unknown }>;
          };
          const rawAliases = Array.isArray(artist?.aliases) ? artist.aliases : [];
          aliases = rawAliases
            .map((alias) => {
              if (!alias || typeof alias !== "object") return null;
              const name = String(alias.name ?? "").trim();
              const locale = String(alias.locale ?? "").trim();
              if (!name || !locale) return null;
              return {
                name,
                sortName: alias.sortName
                  ? String(alias.sortName).trim()
                  : alias["sort-name"]
                    ? String(alias["sort-name"]).trim()
                    : null,
                locale,
                primaryForLocale: Boolean(alias.primaryForLocale ?? alias.primary),
                type: alias.type ? String(alias.type).trim() : null,
              } satisfies CatalogArtistLocaleAlias;
            })
            .filter((entry): entry is CatalogArtistLocaleAlias => entry !== null);
        } catch {
          // Ignore Servarr fallback failure
        }
      }

      result.set(mbid, aliases);
    }
    return result;
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
