/**
 * Catalog source abstraction — see `docs/DATA_MODEL_TARGET.md` §3.
 *
 * Symmetric to `StreamingProvider`: it makes the *canonical catalog* source
 * (MusicBrainz) pluggable. Today the only live implementation is
 * `ServarrMetadataCatalogProvider`, which delegates to the existing Servarr Metadata Server / MB web
 * API replica flow. A future `LocalMusicBrainzCatalogProvider` reads a local
 * MusicBrainz-docker instance instead.
 *
 * **DTOs are deliberately the Servarr Metadata Server/Lidarr shapes already produced by
 * `ServarrMetadataProxy`** (`LidarrArtist`, `LidarrReleaseGroupDetail`, `LidarrRelease`,
 * `LidarrTrack`) plus the matcher's `MusicBrainzReleaseGroupForMatching`. These
 * are the canonical-metadata DTOs in this codebase — every downstream consumer
 * (`refresh-artist-service`, `musicbrainz-release-group-read-service`, the
 * release-group matcher, search routes) already speaks them. Reusing them means
 * any `CatalogProvider` implementation is a drop-in for the Servarr Metadata Server flow without
 * forking a parallel DTO hierarchy.
 *
 * NOTE (U3 scaffolding): this interface is *additive*. It is not yet wired into
 * the live request path. The live app keeps calling `ServarrMetadataProxy` directly; the
 * adapters here document today's behavior and prepare for MB-local mode.
 */
import type {
  LidarrArtist,
  LidarrReleaseGroupDetail,
  LidarrRelease,
  LidarrTrack,
} from "../metadata/servarr-metadata-proxy.js";
import type { MusicBrainzReleaseGroupForMatching } from "../metadata/provider-release-group-matcher.js";

export type {
  LidarrArtist,
  LidarrAlbum,
  LidarrReleaseGroupDetail,
  LidarrRelease,
  LidarrTrack,
} from "../metadata/servarr-metadata-proxy.js";

/**
 * A canonical recording, keyed by MBID. Servarr Metadata Server does not expose a standalone
 * recording endpoint (recordings only arrive embedded in a release's tracks),
 * so `getRecording` is optional. MB-local can serve it directly.
 */
export interface CatalogRecording {
  /** Recording MBID (`gid`). */
  mbid: string;
  title: string;
  /** Recording length in milliseconds, when known. */
  lengthMs?: number | null;
  isVideo?: boolean;
  /** ISRCs attached to the recording (MB-local / `:5000` only — Servarr Metadata Server omits these). */
  isrcs?: string[];
  /** Flattened artist-credit display string ("A feat. B"). */
  artistCredit?: string | null;
  /** Raw provider payload for debugging / re-mapping. */
  raw?: unknown;
}

/** Result of a UPC/barcode lookup: the releases (and their groups) carrying it. */
export interface CatalogUpcLookupResult {
  upc: string;
  releases: Array<{
    releaseMbid: string;
    releaseGroupMbid?: string | null;
    title?: string | null;
  }>;
}

/** Result of an ISRC lookup: the recordings carrying it. */
export interface CatalogIsrcLookupResult {
  isrc: string;
  recordings: CatalogRecording[];
}

/** A unified search hit. `entityType` disambiguates the populated payload. */
export interface CatalogSearchResults {
  artists: LidarrArtist[];
  /** Raw Servarr Metadata Server `searchAll` rows (artist/album mixed) — opaque to callers that only need artists. */
  raw?: unknown[];
}

export interface CatalogSearchOptions {
  limit?: number;
}

/**
 * Pluggable canonical-catalog source. All ids are MBIDs (`gid`).
 *
 * Implementations MUST translate their backend's native shape into the
 * Servarr Metadata Server/Lidarr DTOs above; we never expose MusicBrainz's normalized Postgres
 * rows (split dates, `artist_credit_name`, etc.) to the rest of the app.
 */
export interface CatalogProvider {
  readonly id: string;
  readonly name: string;

  /** Full artist payload incl. its release-group list (`LidarrArtist.Albums`). */
  getArtist(artistMbid: string): Promise<LidarrArtist>;

  /**
   * Release groups for an artist, in the matcher's lightweight shape. Defaults
   * may derive this from `getArtist().Albums`; MB-local can query directly.
   */
  getArtistReleaseGroups(artistMbid: string): Promise<MusicBrainzReleaseGroupForMatching[]>;

  /** Release-group detail incl. all releases (without tracks necessarily filled). */
  getReleaseGroup(releaseGroupMbid: string): Promise<LidarrReleaseGroupDetail>;

  /** A single release with its full medium/track list. */
  getReleaseWithTracks(releaseMbid: string): Promise<LidarrRelease | null>;

  /** A single recording by MBID. Optional: Servarr Metadata Server has no recording endpoint. */
  getRecording?(recordingMbid: string): Promise<CatalogRecording | null>;

  /** Releases carrying a given UPC/barcode. Optional: Servarr Metadata Server exposes no UPC index. */
  lookupByUPC?(upc: string): Promise<CatalogUpcLookupResult>;

  /** Recordings carrying a given ISRC. Optional: Servarr Metadata Server exposes no ISRC index. */
  lookupByISRC?(isrc: string): Promise<CatalogIsrcLookupResult>;

  /** Free-text search (artists by default). */
  search(query: string, options?: CatalogSearchOptions): Promise<CatalogSearchResults>;
}

/** Helper: project a `LidarrReleaseGroupDetail` into a `LidarrRelease` by MBID. */
export function findReleaseInGroup(
  detail: LidarrReleaseGroupDetail,
  releaseMbid: string,
): LidarrRelease | null {
  for (const release of detail.Releases || []) {
    if (String(release.Id) === String(releaseMbid)) {
      return release;
    }
  }
  return null;
}

/** Helper: derive matcher-shaped release groups from a full `LidarrArtist`. */
export function releaseGroupsFromArtist(artist: LidarrArtist): MusicBrainzReleaseGroupForMatching[] {
  return (artist.Albums || [])
    .filter((album) => Boolean(album.Id))
    .map((album) => ({
      mbid: album.Id,
      title: album.Title,
      primaryType: album.Type ?? null,
      secondaryTypes: Array.isArray(album.SecondaryTypes) ? album.SecondaryTypes : [],
      firstReleaseDate: album.ReleaseDate ?? null,
      disambiguation: album.Disambiguation ?? null,
      releases: [],
    }));
}

/** Helper: shape a `LidarrRecording`-less track into a `CatalogRecording`. */
export function recordingFromLidarrTrack(track: LidarrTrack): CatalogRecording {
  return {
    mbid: track.RecordingId,
    title: track.TrackName,
    lengthMs: typeof track.DurationMs === "number" ? track.DurationMs : null,
  };
}
