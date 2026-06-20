/**
 * `SkyhookCatalogProvider` — wraps **today's** SkyHook / MusicBrainz web-API
 * replica flow behind the `CatalogProvider` interface. See
 * `docs/DATA_MODEL_TARGET.md` §3.
 *
 * This is a thin, behavior-preserving adapter: every method delegates to the
 * existing `SkyHookProxy` (`api.lidarr.audio`). It does NOT change what the
 * SkyHook flow does — it only documents it as one `CatalogProvider`
 * implementation so the catalog source becomes swappable.
 *
 * NOTE (U3 scaffolding): not yet wired into the live request path. The live app
 * still calls `skyHookProxy` directly. This adapter exists so MB-local mode can
 * be slotted in later without touching call sites.
 *
 * SkyHook capability gaps (these methods are intentionally absent / throwing):
 *  - no standalone recording endpoint  → `getRecording` omitted
 *  - no UPC index                       → `lookupByUPC` omitted
 *  - no ISRC index                      → `lookupByISRC` omitted
 * MB-local mode fills these in; until then matching falls back to
 * title/track-count/date/duration (see §3 "Rate limits").
 */
import { SkyHookProxy } from "../metadata/skyhook-proxy.js";
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

export class SkyhookCatalogProvider implements CatalogProvider {
  readonly id = "skyhook";
  readonly name = "SkyHook (Lidarr / MusicBrainz API)";

  /**
   * Inject the proxy for testability. Defaults to a fresh `SkyHookProxy`
   * (read-only methods used here don't touch the DB, so a fresh instance is
   * safe — the DB-writing `syncArtist` / `syncReleaseGroup` live on the proxy
   * and remain the live ingestion path, separate from this read adapter).
   */
  constructor(private readonly proxy: Pick<
    SkyHookProxy,
    "getArtistInfo" | "getAlbumInfo" | "searchForNewArtist" | "searchAll"
  > = new SkyHookProxy()) {}

  async getArtist(artistMbid: string): Promise<LidarrArtist> {
    return this.proxy.getArtistInfo(artistMbid);
  }

  async getArtistReleaseGroups(artistMbid: string): Promise<MusicBrainzReleaseGroupForMatching[]> {
    const artist = await this.proxy.getArtistInfo(artistMbid);
    return releaseGroupsFromArtist(artist);
  }

  async getReleaseGroup(releaseGroupMbid: string): Promise<LidarrReleaseGroupDetail> {
    return this.proxy.getAlbumInfo(releaseGroupMbid);
  }

  /**
   * SkyHook serves releases (with tracks) only as children of a release group,
   * not by release MBID. We fetch the parent group and project the release out.
   * Since we don't know the group MBID here, we cannot fetch directly — callers
   * that have the group should prefer `getReleaseGroup`. This convenience path
   * is supported only when the release MBID is already known to belong to a
   * group the caller fetched; otherwise returns null.
   */
  async getReleaseWithTracks(releaseMbid: string): Promise<LidarrRelease | null> {
    // SkyHook has no `/release/{mbid}` endpoint; release detail is always nested
    // under `/album/{releaseGroupMbid}`. Without the group MBID we cannot
    // resolve it, so this returns null in the SkyHook implementation. MB-local
    // overrides this with a direct release lookup.
    void releaseMbid;
    return null;
  }

  /**
   * Resolve a release (with tracks) when the owning release-group MBID is known.
   * Not part of the `CatalogProvider` contract, but the natural SkyHook shape;
   * `musicbrainz-release-group-read-service` effectively does this against the
   * local replica today.
   */
  async getReleaseWithTracksInGroup(
    releaseGroupMbid: string,
    releaseMbid: string,
  ): Promise<LidarrRelease | null> {
    const detail = await this.proxy.getAlbumInfo(releaseGroupMbid);
    return findReleaseInGroup(detail, releaseMbid);
  }

  async search(query: string, options: CatalogSearchOptions = {}): Promise<CatalogSearchResults> {
    const limit = options.limit ?? 20;
    const [artists, raw] = await Promise.all([
      this.proxy.searchForNewArtist(query, limit),
      Promise.resolve(this.proxy.searchAll(query, limit)).catch(() => [] as unknown[]),
    ]);
    return { artists, raw };
  }
}

export const skyhookCatalogProvider = new SkyhookCatalogProvider();
