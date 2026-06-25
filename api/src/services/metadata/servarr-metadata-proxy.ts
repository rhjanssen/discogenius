import { createHash } from "node:crypto";
import { db, runChunkedWrite } from "../../database.js";
import type { MusicBrainzReleaseGroupForMatching } from "./provider-release-group-matcher.js";
import { MediaCoverService } from "./media-cover-service.js";
import { MusicBrainzArtistCreditService } from "./musicbrainz-artist-credit-service.js";
import { getDiscogeniusUserAgent } from "../config/user-agent.js";

/** Servarr metadata-server rating (≈ Lidarr's RatingResource). */
export interface ServarrMetadataRating {
  Count?: number;
  Value?: number;
  count?: number;
  value?: number;
}

export interface LidarrArtist {
  id: string;
  artistname: string;
  sortname: string;
  disambiguation?: string;
  type?: string;
  images: Array<{ Url?: string; url?: string; CoverType?: string; coverType?: string; remoteUrl?: string }>;
  overview?: string;
  // Popularity rating from the Servarr metadata server. Lidarr maps this to
  // Artist.Ratings; we fold value (0–10) into our 0–100 popularity score.
  rating?: ServarrMetadataRating;
  Rating?: ServarrMetadataRating;
  Albums: LidarrAlbum[];
}

/**
 * Derive a 0–100 popularity score from the Servarr metadata-server rating,
 * mirroring how Lidarr surfaces artist popularity from the same source. The
 * rating value is on a 0–10 scale; we scale it to 0–100 to match the existing
 * provider-sourced popularity range. Returns null when there are no votes, so
 * an unrated artist never overwrites an existing provider popularity with 0.
 */
export function deriveServarrMetadataPopularity(rating: ServarrMetadataRating | undefined | null): number | null {
  if (!rating) return null;
  const count = Number(rating.Count ?? rating.count ?? 0);
  const value = Number(rating.Value ?? rating.value ?? 0);
  if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(value * 10)));
}

export interface LidarrAlbum {
  Id: string;
  Title: string;
  Type?: string;
  SecondaryTypes?: string[];
  ReleaseDate?: string;
  Disambiguation?: string;
  Images?: Array<{ Url?: string; url?: string; CoverType?: string; coverType?: string; remoteUrl?: string }>;
  images?: Array<{ Url?: string; url?: string; CoverType?: string; coverType?: string; remoteUrl?: string }>;
  Releases?: any[];
  releases?: any[];
}

export interface LidarrReleaseGroupDetail {
  id: string;
  artistid?: string;
  artistId?: string;
  title: string;
  type?: string;
  secondarytypes?: string[];
  releasedate?: string;
  disambiguation?: string;
  Images?: Array<{ Url?: string; url?: string; CoverType?: string; coverType?: string; remoteUrl?: string }>;
  images?: Array<{ Url?: string; url?: string; CoverType?: string; coverType?: string; remoteUrl?: string }>;
  Releases: LidarrRelease[];
}

export interface LidarrRelease {
  Id: string;
  Title: string;
  Status: string;
  Country: string[];
  Barcode?: string;
  barcode?: string;
  Label: string[];
  Media: Array<{ Position: number; Format: string; Name: string }>;
  ReleaseDate: string;
  TrackCount: number;
  MediumCount?: number;
  MediaCount?: number;
  Disambiguation: string;
  ExternalUrls?: string[];
  Tracks: LidarrTrack[];
}

export interface LidarrTrack {
  Id: string;
  RecordingId: string;
  TrackName: string;
  TrackNumber: string;
  TrackPosition: number;
  MediumNumber: number;
  DurationMs: number;
}

export interface MediaCover {
  url: string;
  coverType: string;
  remoteUrl: string;
  extension?: string;
}

/**
 * Cheap change-key over a remote metadata payload. Refresh compares this to the
 * stored `content_hash` to decide whether a row actually changed — Lidarr's
 * diff-reconcile (UpdateMany writes only changed rows). SHA-1 is plenty: this is
 * a change detector, not a security primitive, and it's the cheapest hash that
 * won't collide across a library's worth of payloads.
 */
export function computeContentHash(payload: unknown): string {
  return createHash("sha1").update(JSON.stringify(payload)).digest("hex");
}

export function mapServarrMetadataImages(images?: any[] | null): MediaCover[] {
  if (!images || !Array.isArray(images)) {
    return [];
  }
  return images.map((img: any) => {
    const rawUrl = img.url || img.Url || img.remoteUrl || "";
    const coverType = img.coverType || img.CoverType || "unknown";

    let extension = "";
    if (rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        const pathname = parsed.pathname;
        const lastDot = pathname.lastIndexOf(".");
        if (lastDot !== -1 && pathname.length - lastDot <= 5) {
          extension = pathname.slice(lastDot);
        }
      } catch {
        extension = "";
      }
    }

    const normalizedType = coverType.charAt(0).toUpperCase() + coverType.slice(1).toLowerCase();

    return {
      url: rawUrl,
      coverType: normalizedType,
      remoteUrl: rawUrl,
      ...(extension ? { extension } : {}),
    };
  });
}

/**
 * Collect external URLs from a curated `links` JSON column. The metadata-server
 * `links` array uses `{ type, target }` (target = the URL). This is the
 * matching-evidence reader for the curated columns, replacing the old recursive
 * walk over the raw `data` blob now that the blob is being retired.
 */
export function extractLinkUrls(linksJson?: string | null): string[] {
  if (!linksJson) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(linksJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const urls = new Set<string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    for (const value of Object.values(entry as Record<string, unknown>)) {
      if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) {
        urls.add(value.trim());
      }
    }
  }
  return Array.from(urls);
}

export class ServarrMetadataProxy {
  private readonly baseUrl = "https://api.lidarr.audio/api/v0.4";

  private normalizeSearchText(value: string): string {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  private rankSearchArtist(query: string, artist: LidarrArtist): number {
    const normalizedQuery = this.normalizeSearchText(query);
    const normalizedName = this.normalizeSearchText(artist.artistname || "");
    const albumCount = Array.isArray(artist.Albums) ? artist.Albums.length : 0;
    let score = 0;

    if (normalizedName === normalizedQuery) {
      score += 10_000;
    } else if (normalizedName.startsWith(normalizedQuery)) {
      score += 5_000;
    } else if (normalizedName.includes(normalizedQuery)) {
      score += 1_000;
    }

    if (String(artist.type || "").toLowerCase() === "group") {
      score += 25;
    }

    return score + Math.min(albumCount, 500);
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": getDiscogeniusUserAgent("metadata proxy"),
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      throw new Error(`MusicBrainz metadata API ${path} failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  async getArtistInfo(mbid: string): Promise<LidarrArtist> {
    return this.fetchJson<LidarrArtist>(`/artist/${encodeURIComponent(mbid)}`);
  }


  async searchForNewArtist(query: string, limit = 20): Promise<LidarrArtist[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const results = await this.fetchJson<LidarrArtist[]>(
      `/search?type=artist&query=${encodeURIComponent(trimmed)}`,
    );

    return results
      .filter((artist) => artist?.id && artist?.artistname)
      .sort((left, right) => this.rankSearchArtist(trimmed, right) - this.rankSearchArtist(trimmed, left))
      .slice(0, limit);
  }


  async searchAll(query: string, limit = 40): Promise<any[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    try {
      const results = await this.fetchJson<any[]>(
        `/search?type=all&query=${encodeURIComponent(trimmed)}`
      );
      if (Array.isArray(results)) {
        return results
          .sort((left, right) => {
            if (left?.artist && right?.artist) {
              return this.rankSearchArtist(trimmed, right.artist) - this.rankSearchArtist(trimmed, left.artist);
            }
            if (left?.artist) return -1;
            if (right?.artist) return 1;
            return 0;
          })
          .slice(0, limit);
      }
    } catch (e) {
      console.error("Servarr Metadata Server searchAll failed:", e);
    }
    return [];
  }

  async getAlbumInfo(releaseGroupMbid: string): Promise<LidarrReleaseGroupDetail> {
    return this.fetchJson<LidarrReleaseGroupDetail>(`/album/${encodeURIComponent(releaseGroupMbid)}`);
  }


  getArtistImageUrl(artist: LidarrArtist, preferredCoverType = "Poster"): string | null {
    return MediaCoverService.getArtistImageUrl(artist, preferredCoverType);
  }

  getAlbumImageUrl(album: LidarrAlbum, preferredCoverType = "Cover"): string | null {
    return MediaCoverService.getAlbumImageUrl(album, preferredCoverType);
  }

  getCachedReleaseGroupsForArtist(artistMbid: string): MusicBrainzReleaseGroupForMatching[] {
    const rows = db.prepare(`
      SELECT DISTINCT rg.mbid, rg.title, rg.primary_type, rg.secondary_types, rg.first_release_date, rg.disambiguation, rg.links
      FROM Albums rg
      LEFT JOIN ArtistReleaseGroups scope ON scope.release_group_mbid = rg.mbid
      WHERE rg.artist_mbid = ? OR scope.artist_mbid = ?
    `).all(artistMbid, artistMbid) as Array<{
      mbid: string;
      title: string;
      primary_type: string | null;
      secondary_types: string | null;
      first_release_date: string | null;
      disambiguation: string | null;
      links: string | null;
    }>;

    // External-link matching evidence lives on the release GROUP (`links`), not
    // the release — sourced from the curated column, replacing the old
    // extractLinkUrls(Albums.links) reads the curated relation column instead
    // of walking the retired raw metadata blob.
    const externalUrlsByReleaseGroup = new Map<string, string[]>(
      rows.map((row) => [row.mbid, extractLinkUrls(row.links)]),
    );

    const releaseRows = rows.length === 0
      ? []
      : db.prepare(`
        SELECT
          r.mbid,
          r.release_group_mbid,
          r.title,
          r.disambiguation,
          r.barcode,
          r.date,
          r.track_count,
          r.media_count,
          rec.isrcs AS recording_isrcs
        FROM AlbumReleases r
        LEFT JOIN Tracks t ON t.release_mbid = r.mbid
        LEFT JOIN Recordings rec ON rec.mbid = t.recording_mbid
        WHERE r.release_group_mbid IN (${rows.map(() => "?").join(",")})
      `).all(...rows.map((row) => row.mbid)) as Array<{
        mbid: string;
        release_group_mbid: string;
        title: string | null;
        disambiguation: string | null;
        barcode: string | null;
        date: string | null;
        track_count: number | null;
        media_count: number | null;
        recording_isrcs: string | null;
      }>;
    const releasesByReleaseGroup = new Map<string, Array<NonNullable<MusicBrainzReleaseGroupForMatching["releases"]>[number]>>();
    const releaseEvidenceByMbid = new Map<string, {
      releaseGroupMbid: string;
      mbid: string;
      title: string | null;
      disambiguation: string | null;
      barcode: string | null;
      date: string | null;
      trackCount: number | null;
      mediaCount: number | null;
      externalUrls: Set<string>;
      isrcs: Set<string>;
    }>();
    for (const release of releaseRows) {
      const evidence = releaseEvidenceByMbid.get(release.mbid) || {
        releaseGroupMbid: release.release_group_mbid,
        mbid: release.mbid,
        title: release.title,
        disambiguation: release.disambiguation,
        barcode: release.barcode,
        date: release.date,
        trackCount: release.track_count,
        mediaCount: release.media_count,
        externalUrls: new Set<string>(),
        isrcs: new Set<string>(),
      };
      for (const url of externalUrlsByReleaseGroup.get(release.release_group_mbid) ?? []) {
        evidence.externalUrls.add(url);
      }
      const rawIsrcs = String(release.recording_isrcs || "").trim();
      const values = rawIsrcs.startsWith("[") ? [rawIsrcs] : rawIsrcs.split(",");
      for (const value of values) {
        try {
          const parsed = JSON.parse(value || "[]");
          if (Array.isArray(parsed)) {
            parsed.forEach((isrc) => {
              const normalized = String(isrc || "").trim();
              if (normalized) evidence.isrcs.add(normalized);
            });
          }
        } catch {
          const normalized = String(value || "").trim();
          if (normalized) evidence.isrcs.add(normalized);
        }
      }
      releaseEvidenceByMbid.set(release.mbid, evidence);
    }

    for (const release of releaseEvidenceByMbid.values()) {
      const list = releasesByReleaseGroup.get(release.releaseGroupMbid) || [];
      list.push({
        mbid: release.mbid,
        title: release.title,
        disambiguation: release.disambiguation,
        barcode: release.barcode,
        date: release.date,
        trackCount: release.trackCount,
        mediaCount: release.mediaCount,
        externalUrls: Array.from(release.externalUrls),
        isrcs: Array.from(release.isrcs),
      });
      releasesByReleaseGroup.set(release.releaseGroupMbid, list);
    }

    return rows.map((row) => {
      let secondaryTypes: string[] = [];
      try {
        const parsed = JSON.parse(row.secondary_types || "[]");
        secondaryTypes = Array.isArray(parsed) ? parsed.map((type) => String(type)) : [];
      } catch {
        secondaryTypes = [];
      }

      return {
        mbid: row.mbid,
        title: row.title,
        primaryType: row.primary_type,
        secondaryTypes,
        firstReleaseDate: row.first_release_date,
        disambiguation: row.disambiguation,
        releases: releasesByReleaseGroup.get(row.mbid) || [],
      };
    });
  }

  async syncArtist(mbid: string): Promise<LidarrArtist> {
    const artist = await this.getArtistInfo(mbid);

    // Diff-reconcile: if the remote payload is byte-for-byte what we last stored,
    // the artist row and every release-group row it owns are already current —
    // skip the whole write (artist + N album upserts) instead of rewriting rows
    // to identical values. This is the throughput fix for re-refreshes: an
    // unchanged artist costs one hash + one indexed read, not hundreds of upserts.
    const contentHash = computeContentHash(artist);
    const existingHash = (db.prepare("SELECT content_hash FROM ArtistMetadata WHERE mbid = ?")
      .get(artist.id) as { content_hash?: string | null } | undefined)?.content_hash ?? null;
    if (existingHash && existingHash === contentHash) {
      return artist;
    }

    const imagesList = mapServarrMetadataImages(artist.images);
    const popularity = deriveServarrMetadataPopularity(artist.rating ?? artist.Rating);
    const raw = artist as Record<string, any>;

    db.prepare(`
      INSERT INTO ArtistMetadata (
        mbid, name, sort_name, disambiguation, type, overview, status, popularity,
        images, links, genres, ratings, aliases, old_foreign_ids, content_hash, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mbid) DO UPDATE SET
        name = excluded.name,
        sort_name = excluded.sort_name,
        disambiguation = excluded.disambiguation,
        type = excluded.type,
        overview = excluded.overview,
        status = excluded.status,
        -- Keep the Servarr rating when present; otherwise preserve whatever
        -- popularity a provider sync already stored.
        popularity = COALESCE(excluded.popularity, ArtistMetadata.popularity),
        images = excluded.images,
        links = excluded.links,
        genres = excluded.genres,
        ratings = excluded.ratings,
        aliases = excluded.aliases,
        old_foreign_ids = excluded.old_foreign_ids,
        content_hash = excluded.content_hash,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      artist.id,
      artist.artistname,
      artist.sortname,
      artist.disambiguation || null,
      artist.type || null,
      raw.overview ?? null,
      raw.status ?? null,
      popularity,
      JSON.stringify(imagesList),
      JSON.stringify(raw.links ?? []),
      JSON.stringify(raw.genres ?? []),
      JSON.stringify(raw.rating ?? raw.Rating ?? null),
      JSON.stringify(raw.artistaliases ?? raw.aliases ?? []),
      JSON.stringify(raw.oldids ?? raw.oldIds ?? []),
      contentHash,
    );

    // The artist payload carries only SHALLOW album entries (no images, links,
    // genres, or full release detail). On conflict, update only the shallow
    // scalar fields it actually has and NEVER overwrite the detail-sourced
    // columns (images, links, genres, overview, content_hash) — those are
    // owned by syncReleaseGroup when it fetches the full release-group detail.
    // (This replaces the old read-existing-blob-then-merge dance.)
    const insertRg = db.prepare(`
      INSERT INTO Albums (mbid, artist_mbid, title, primary_type, secondary_types, first_release_date, disambiguation, images, ratings, old_foreign_ids, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mbid) DO UPDATE SET
        title = excluded.title,
        primary_type = excluded.primary_type,
        secondary_types = excluded.secondary_types,
        first_release_date = excluded.first_release_date,
        disambiguation = excluded.disambiguation,
        ratings = excluded.ratings,
        old_foreign_ids = excluded.old_foreign_ids,
        updated_at = CURRENT_TIMESTAMP
    `);

    // Chunk the per-album upserts: a large artist (hundreds of release groups)
    // would otherwise hold the write lock for the entire catalog and starve
    // concurrent refresh workers + the main-thread job claim.
    const albums = (artist.Albums || []).filter((album) => album.Id);
    runChunkedWrite(albums, (album) => {
      const rawAlbum = album as Record<string, any>;
      const albumImages = mapServarrMetadataImages(album.images || album.Images);

      insertRg.run(
        album.Id,
        artist.id,
        album.Title,
        album.Type || null,
        JSON.stringify(album.SecondaryTypes || []),
        album.ReleaseDate || null,
        album.Disambiguation || null,
        JSON.stringify(albumImages),
        JSON.stringify(rawAlbum.Rating ?? rawAlbum.rating ?? null),
        JSON.stringify(rawAlbum.OldIds ?? rawAlbum.oldids ?? []),
      );
      MusicBrainzArtistCreditService.ensurePrimaryScope(album.Id, artist.id, artist.artistname);
    });

    await MediaCoverService.resolveArtistArtwork({
      artistMbid: artist.id,
      servarrMetadataData: artist,
      preferredCoverTypes: ["Poster", "Headshot"],
    });

    return artist;
  }

  async syncReleaseGroup(releaseGroupMbid: string, artistMbid: string): Promise<void> {
    const detail = await this.getAlbumInfo(releaseGroupMbid);
    const ownerArtistMbid = String(detail.artistid || detail.artistId || artistMbid).trim();

    // Diff-reconcile: skip rewriting an unchanged release group's entire
    // tracklist (a popular RG is many editions × many tracks → the dominant
    // write cost). Only skip when the remote payload is unchanged AND the
    // releases are actually present locally — so a hash match never suppresses
    // re-hydration of a release group whose child rows were pruned/never written.
    const contentHash = computeContentHash(detail);
    const existing = db.prepare(`
      SELECT
        rg.content_hash AS contentHash,
        EXISTS(SELECT 1 FROM AlbumReleases ar WHERE ar.release_group_mbid = rg.mbid) AS hasReleases
      FROM Albums rg
      WHERE rg.mbid = ?
    `).get(releaseGroupMbid) as { contentHash?: string | null; hasReleases?: number } | undefined;
    if (existing?.contentHash && existing.contentHash === contentHash && existing.hasReleases) {
      return;
    }

    const insertRg = db.prepare(`
      INSERT INTO Albums (
        mbid, artist_mbid, title, primary_type, secondary_types, first_release_date,
        disambiguation, overview, images, links, genres, ratings, aliases,
        old_foreign_ids, content_hash, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mbid) DO UPDATE SET
        title = excluded.title,
        primary_type = excluded.primary_type,
        secondary_types = excluded.secondary_types,
        first_release_date = excluded.first_release_date,
        disambiguation = excluded.disambiguation,
        overview = excluded.overview,
        images = excluded.images,
        links = excluded.links,
        genres = excluded.genres,
        ratings = excluded.ratings,
        aliases = excluded.aliases,
        old_foreign_ids = excluded.old_foreign_ids,
        content_hash = excluded.content_hash,
        updated_at = CURRENT_TIMESTAMP
    `);

    const insertRelease = db.prepare(`
      INSERT INTO AlbumReleases (
        mbid, release_group_mbid, artist_mbid, title, status, country,
        date, barcode, disambiguation, media_count, track_count,
        label, media, old_foreign_ids, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mbid) DO UPDATE SET
        title = excluded.title,
        status = excluded.status,
        country = excluded.country,
        date = excluded.date,
        barcode = excluded.barcode,
        disambiguation = excluded.disambiguation,
        media_count = excluded.media_count,
        track_count = excluded.track_count,
        label = excluded.label,
        media = excluded.media,
        old_foreign_ids = excluded.old_foreign_ids,
        updated_at = CURRENT_TIMESTAMP
    `);

    const insertRecording = db.prepare(`
      INSERT INTO Recordings (mbid, title, length_ms, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(mbid) DO UPDATE SET
        title = excluded.title,
        length_ms = excluded.length_ms,
        updated_at = CURRENT_TIMESTAMP
    `);

    const insertTrack = db.prepare(`
      INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(release_mbid, medium_position, position) DO UPDATE SET
        mbid = excluded.mbid,
        recording_mbid = excluded.recording_mbid,
        number = excluded.number,
        title = excluded.title,
        length_ms = excluded.length_ms,
        updated_at = CURRENT_TIMESTAMP
    `);

    const releases = detail.Releases || [];

    const albumImages = mapServarrMetadataImages(detail.images || detail.Images);

    // Release group + its release rows are bounded and share one transaction.
    db.transaction(() => {
      MusicBrainzArtistCreditService.ensureArtist(ownerArtistMbid);

      const rawDetail = detail as Record<string, any>;
      insertRg.run(
        releaseGroupMbid,
        ownerArtistMbid,
        detail.title || "",
        detail.type || null,
        JSON.stringify(detail.secondarytypes || []),
        detail.releasedate || null,
        detail.disambiguation || null,
        rawDetail.overview ?? null,
        JSON.stringify(albumImages),
        JSON.stringify(rawDetail.links ?? []),
        JSON.stringify(rawDetail.genres ?? []),
        JSON.stringify(rawDetail.rating ?? rawDetail.Rating ?? null),
        JSON.stringify(rawDetail.aliases ?? []),
        JSON.stringify(rawDetail.oldids ?? rawDetail.oldIds ?? []),
        contentHash,
      );
      MusicBrainzArtistCreditService.ensurePrimaryScope(releaseGroupMbid, ownerArtistMbid);

      for (const release of releases) {
        const rawRelease = release as Record<string, any>;
        insertRelease.run(
          release.Id,
          releaseGroupMbid,
          ownerArtistMbid,
          release.Title,
          release.Status || null,
          JSON.stringify(release.Country || []),
          release.ReleaseDate || null,
          release.Barcode ?? rawRelease.barcode ?? null,
          release.Disambiguation || null,
          release.MediaCount ?? release.MediumCount ?? (release.Media || []).length,
          release.TrackCount ?? (release.Tracks || []).length,
          JSON.stringify(release.Label ?? rawRelease.label ?? []),
          JSON.stringify(release.Media ?? rawRelease.media ?? []),
          JSON.stringify(rawRelease.OldIds ?? rawRelease.oldids ?? []),
        );
      }
    })();

    // Tracks/recordings scale with the whole release group (a popular RG can have
    // dozens of editions × many tracks). Chunk them so the write lock isn't held
    // for the entire tracklist while concurrent workers wait.
    const trackRows: Array<{ release: typeof releases[number]; track: any }> = [];
    for (const release of releases) {
      for (const track of release.Tracks || []) {
        trackRows.push({ release, track });
      }
    }
    runChunkedWrite(trackRows, ({ release, track }) => {
      insertRecording.run(track.RecordingId, track.TrackName, track.DurationMs);
      insertTrack.run(
        track.Id,
        release.Id,
        track.RecordingId,
        track.MediumNumber,
        track.TrackPosition,
        track.TrackNumber,
        track.TrackName,
        track.DurationMs,
      );
    });
  }
}

export const servarrMetadataProxy = new ServarrMetadataProxy();
