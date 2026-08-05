/**
 * `LocalMusicBrainzCatalogProvider` — reads a **local MusicBrainz-docker**
 * instance via its web-service API mirror (`:5000`, same JSON shape as
 * musicbrainz.org `/ws/2`). See `docs/DATA_MODEL_TARGET.md` §3.
 *
 * ⚠️ NOT WIRED INTO RUNTIME (U3 scaffolding). This is a stub implementation,
 * intended to be exercised by fixture unit tests and, later, against a running
 * `.ref_musicbrainz-docker` container. It is intentionally NOT registered as the
 * active catalog source — the live app keeps using the Servarr Metadata Server flow.
 *
 * Why the `:5000` mirror first (not direct Postgres)? It returns the exact MB
 * `/ws/2` JSON our existing MB-shaped code already consumes (see
 * `musicbrainz-video-service.ts`), so adoption is cheapest. A direct-Postgres
 * path against the MB schema is a possible future performance optimization, but
 * it is deferred and intentionally not implemented yet — see
 * `docs/MB_LOCAL_MODE.md`.
 *
 * On your own instance there is no 1-req/s rate limit, so full UPC/ISRC matching
 * (the payoff described in §3) is viable here.
 */
import { getDiscogeniusUserAgent } from "../config/user-agent.js";
import type {
  CatalogProvider,
  CatalogSearchOptions,
  CatalogSearchResults,
  CatalogRecording,
  CatalogUpcLookupResult,
  CatalogIsrcLookupResult,
  LidarrArtist,
  LidarrReleaseGroupDetail,
  LidarrRelease,
} from "./catalog-provider.js";
import { releaseGroupsFromArtist } from "./catalog-provider.js";
import type { MusicBrainzReleaseGroupForMatching } from "../metadata/provider-release-group-matcher.js";
import {
  mapMbArtistToLidarr,
  mapMbReleaseGroupToLidarrDetail,
  mapMbReleaseToLidarr,
  mapMbRecordingToCatalog,
  type MbArtist,
  type MbReleaseGroup,
  type MbRelease,
  type MbRecording,
} from "./musicbrainz-ws-mapping.js";
import {
  MbHttpError,
  withBoundedMbRetry,
  type BoundedRetryOptions,
} from "./mb-transient-retry.js";

/** Minimal HTTP transport so tests can inject a fixture fetcher (no live net). */
export type JsonFetcher = <T>(path: string) => Promise<T>;

export interface LocalMusicBrainzCatalogProviderOptions {
  /** Base URL of the MB web-service mirror, e.g. `http://localhost:5000/ws/2`. */
  baseUrl?: string;
  /** Override the HTTP layer (used by tests to serve fixtures). */
  fetcher?: JsonFetcher;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /**
   * Bounded retry for a momentarily busy mirror. Applies to whatever fetcher is
   * configured, so tests can drive it with an injected failing transport.
   */
  retry?: BoundedRetryOptions;
}

const DEFAULT_BASE_URL = "http://localhost:5000/ws/2";

/** `Retry-After` is seconds or an HTTP date; anything else means "no advice". */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

export class LocalMusicBrainzCatalogProvider implements CatalogProvider {
  readonly id = "musicbrainz-local";
  readonly name = "Local MusicBrainz (MB-docker :5000 mirror)";

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchJson: JsonFetcher;

  constructor(options: LocalMusicBrainzCatalogProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    const transport: JsonFetcher = options.fetcher ?? ((path) => this.defaultFetchJson(path));
    // Every read goes through the same bounded retry: a mirror that is busy for
    // a moment must not fail an artist intake, and one that is actually down
    // must still fail it — see mb-transient-retry.ts.
    this.fetchJson = <T>(path: string) => withBoundedMbRetry<T>(
      () => transport<T>(path),
      `MB-local ${path}`,
      {
        onRetry: ({ attempt, attempts, delayMs, error }) => {
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(
            `[MB-local] ${path} attempt ${attempt}/${attempts} failed (${reason}); retrying in ${delayMs}ms`,
          );
        },
        ...options.retry,
      },
    );
  }

  private async defaultFetchJson<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": getDiscogeniusUserAgent("MB-local catalog provider"),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new MbHttpError(
        `MB-local API ${path} failed: ${res.status} ${res.statusText}`,
        res.status,
        path,
        parseRetryAfterMs(res.headers.get("retry-after")),
      );
    }
    return res.json() as Promise<T>;
  }

  async getArtist(artistMbid: string): Promise<LidarrArtist> {
    // inc=release-groups gives us the artist's discography in one call.
    const artist = await this.fetchJson<MbArtist>(
      `/artist/${encodeURIComponent(artistMbid)}?inc=release-groups&fmt=json`,
    );
    return mapMbArtistToLidarr(artist);
  }

  async getArtistReleaseGroups(artistMbid: string): Promise<MusicBrainzReleaseGroupForMatching[]> {
    const artist = await this.getArtist(artistMbid);
    return releaseGroupsFromArtist(artist);
  }

  async getReleaseGroup(releaseGroupMbid: string): Promise<LidarrReleaseGroupDetail> {
    // inc=releases+artist-credits: release list + owning artist for the DTO.
    const rg = await this.fetchJson<MbReleaseGroup>(
      `/release-group/${encodeURIComponent(releaseGroupMbid)}?inc=releases+artist-credits&fmt=json`,
    );
    return mapMbReleaseGroupToLidarrDetail(rg);
  }

  async getReleaseWithTracks(releaseMbid: string): Promise<LidarrRelease | null> {
    // Unlike Servarr Metadata Server, MB exposes a direct /release/{mbid} endpoint with media,
    // tracks and inline recordings + ISRCs.
    const release = await this.fetchJson<MbRelease>(
      `/release/${encodeURIComponent(releaseMbid)}?inc=recordings+artist-credits+isrcs+labels&fmt=json`,
    );
    if (!release || !release.id) {
      return null;
    }
    return mapMbReleaseToLidarr(release);
  }

  async getRecording(recordingMbid: string): Promise<CatalogRecording | null> {
    const recording = await this.fetchJson<MbRecording>(
      `/recording/${encodeURIComponent(recordingMbid)}?inc=artist-credits+isrcs&fmt=json`,
    );
    if (!recording || !recording.id) {
      return null;
    }
    return mapMbRecordingToCatalog(recording);
  }

  async lookupByUPC(upc: string): Promise<CatalogUpcLookupResult> {
    const normalized = String(upc || "").replace(/[^0-9]/g, "");
    if (!normalized) {
      return { upc, releases: [] };
    }
    // MB release search supports a `barcode:` query field.
    const response = await this.fetchJson<{ releases?: MbRelease[] }>(
      `/release?query=${encodeURIComponent(`barcode:${normalized}`)}&fmt=json`,
    );
    const releases = (response.releases || [])
      .filter((release) => release.id)
      .map((release) => ({
        releaseMbid: String(release.id),
        releaseGroupMbid: release["release-group"]?.id ? String(release["release-group"]?.id) : null,
        title: release.title ?? null,
      }));
    return { upc: normalized, releases };
  }

  async lookupByISRC(isrc: string): Promise<CatalogIsrcLookupResult> {
    const normalized = String(isrc || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!normalized) {
      return { isrc, recordings: [] };
    }
    // MB has a dedicated /isrc/{isrc} endpoint returning matching recordings.
    const response = await this.fetchJson<{ recordings?: MbRecording[] }>(
      `/isrc/${encodeURIComponent(normalized)}?inc=artist-credits&fmt=json`,
    );
    const recordings = (response.recordings || [])
      .filter((recording) => recording.id)
      .map(mapMbRecordingToCatalog);
    return { isrc: normalized, recordings };
  }

  async search(query: string, options: CatalogSearchOptions = {}): Promise<CatalogSearchResults> {
    const trimmed = String(query || "").trim();
    if (!trimmed) {
      return { artists: [] };
    }
    const limit = options.limit ?? 20;
    const response = await this.fetchJson<{ artists?: MbArtist[] }>(
      `/artist?query=${encodeURIComponent(trimmed)}&limit=${limit}&fmt=json`,
    );
    const artists = (response.artists || [])
      .filter((artist) => artist.id && artist.name)
      .map(mapMbArtistToLidarr);
    return { artists };
  }
}

/**
 * Factory — NOT registered anywhere live. Construct on demand once MB-local mode
 * is wired up (a future unit). Kept un-instantiated at module scope so importing
 * this file has no side effects and performs no network calls.
 */
export function createLocalMusicBrainzCatalogProvider(
  options?: LocalMusicBrainzCatalogProviderOptions,
): LocalMusicBrainzCatalogProvider {
  return new LocalMusicBrainzCatalogProvider(options);
}
