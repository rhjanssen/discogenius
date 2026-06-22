import { db } from "../../database.js";
import type { MusicBrainzReleaseGroupForMatching } from "./provider-release-group-matcher.js";
import { MediaCoverService } from "./media-cover-service.js";
import { MusicBrainzArtistCreditService } from "./musicbrainz-artist-credit-service.js";
import { getDiscogeniusUserAgent } from "../config/user-agent.js";

export interface LidarrArtist {
  id: string;
  artistname: string;
  sortname: string;
  disambiguation?: string;
  type?: string;
  images: Array<{ Url?: string; url?: string; CoverType?: string; coverType?: string; remoteUrl?: string }>;
  overview?: string;
  Albums: LidarrAlbum[];
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

export function mapSkyHookImages(images?: any[] | null): MediaCover[] {
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

function extractExternalUrls(rawData?: string | null): string[] {
  if (!rawData) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return [];
  }

  const urls = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const text = value.trim();
      if (/^https?:\/\//i.test(text)) {
        urls.add(text);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/^(resource|url|externalUrl|externalUrls|relations?)$/i.test(key)) {
        visit(child);
      } else if (key === "target" || key === "target-credit") {
        continue;
      } else if (typeof child === "object" && child !== null) {
        visit(child);
      }
    }
  };

  visit(parsed);
  return Array.from(urls);
}

export class SkyHookProxy {
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
      console.error("Skyhook searchAll failed:", e);
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
      SELECT DISTINCT rg.mbid, rg.title, rg.primary_type, rg.secondary_types, rg.first_release_date, rg.disambiguation
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
    }>;

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
          r.data,
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
        data: string | null;
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
      for (const url of extractExternalUrls(release.data)) {
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

    db.transaction(() => {
      const imagesList = mapSkyHookImages(artist.images);

      db.prepare(`
        INSERT INTO ArtistMetadata (mbid, name, sort_name, disambiguation, type, data, images, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(mbid) DO UPDATE SET
          name = excluded.name,
          sort_name = excluded.sort_name,
          disambiguation = excluded.disambiguation,
          type = excluded.type,
          data = excluded.data,
          images = excluded.images,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        artist.id,
        artist.artistname,
        artist.sortname,
        artist.disambiguation || null,
        artist.type || null,
        JSON.stringify(artist),
        JSON.stringify(imagesList),
      );

      const insertRg = db.prepare(`
        INSERT INTO Albums (mbid, artist_mbid, title, primary_type, secondary_types, first_release_date, disambiguation, data, images, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(mbid) DO UPDATE SET
          title = excluded.title,
          primary_type = excluded.primary_type,
          secondary_types = excluded.secondary_types,
          first_release_date = excluded.first_release_date,
          disambiguation = excluded.disambiguation,
          data = excluded.data,
          images = excluded.images,
          updated_at = CURRENT_TIMESTAMP
      `);

      const selectExisting = db.prepare(`SELECT data FROM Albums WHERE mbid = ?`);
      for (const album of artist.Albums || []) {
        if (!album.Id) {
          continue;
        }

        const existingRow = selectExisting.get(album.Id) as { data: string } | undefined;
        let mergedData = album;
        if (existingRow?.data) {
          try {
            const existingData = JSON.parse(existingRow.data);
            if (existingData.images || existingData.Images || existingData.Releases || existingData.releases) {
              mergedData = {
                ...album,
                images: album.images || album.Images || existingData.images || existingData.Images,
                Releases: album.Releases || album.releases || existingData.Releases || existingData.releases,
              };
            }
          } catch {
            // Ignore parse errors
          }
        }

        const albumImages = mapSkyHookImages(album.images || album.Images);

        insertRg.run(
          album.Id,
          artist.id,
          album.Title,
          album.Type || null,
          JSON.stringify(album.SecondaryTypes || []),
          album.ReleaseDate || null,
          album.Disambiguation || null,
          JSON.stringify(mergedData),
          JSON.stringify(albumImages),
        );
        MusicBrainzArtistCreditService.ensurePrimaryScope(album.Id, artist.id, artist.artistname);
      }
    })();

    return artist;
  }

  async syncReleaseGroup(releaseGroupMbid: string, artistMbid: string): Promise<void> {
    const detail = await this.getAlbumInfo(releaseGroupMbid);
    const ownerArtistMbid = String(detail.artistid || detail.artistId || artistMbid).trim();

    db.transaction(() => {
      MusicBrainzArtistCreditService.ensureArtist(ownerArtistMbid);
      const insertRg = db.prepare(`
        INSERT INTO Albums (mbid, artist_mbid, title, primary_type, secondary_types, first_release_date, disambiguation, data, images, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(mbid) DO UPDATE SET
          title = excluded.title,
          primary_type = excluded.primary_type,
          secondary_types = excluded.secondary_types,
          first_release_date = excluded.first_release_date,
          disambiguation = excluded.disambiguation,
          data = excluded.data,
          images = excluded.images,
          updated_at = CURRENT_TIMESTAMP
      `);

      const title = detail.title || "";
      const primaryType = detail.type || null;
      const secondaryTypes = JSON.stringify(detail.secondarytypes || []);
      const firstReleaseDate = detail.releasedate || null;
      const disambiguation = detail.disambiguation || null;

      const albumImages = mapSkyHookImages(detail.images || detail.Images);

      insertRg.run(
        releaseGroupMbid,
        ownerArtistMbid,
        title,
        primaryType,
        secondaryTypes,
        firstReleaseDate,
        disambiguation,
        JSON.stringify(detail),
        JSON.stringify(albumImages),
      );
      MusicBrainzArtistCreditService.ensurePrimaryScope(releaseGroupMbid, ownerArtistMbid);

      const insertRelease = db.prepare(`
        INSERT INTO AlbumReleases (
          mbid, release_group_mbid, artist_mbid, title, status, country,
          date, disambiguation, media_count, track_count, data, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(mbid) DO UPDATE SET
          title = excluded.title,
          status = excluded.status,
          country = excluded.country,
          date = excluded.date,
          disambiguation = excluded.disambiguation,
          media_count = excluded.media_count,
          track_count = excluded.track_count,
          data = excluded.data,
          updated_at = CURRENT_TIMESTAMP
      `);

      const insertMedium = db.prepare(`
        INSERT INTO AlbumReleaseMedia (release_mbid, position, format, title, track_count, data, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(release_mbid, position) DO UPDATE SET
          format = excluded.format,
          title = excluded.title,
          track_count = excluded.track_count,
          data = excluded.data,
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
        INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms, data, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(release_mbid, medium_position, position) DO UPDATE SET
          mbid = excluded.mbid,
          recording_mbid = excluded.recording_mbid,
          number = excluded.number,
          title = excluded.title,
          length_ms = excluded.length_ms,
          data = excluded.data,
          updated_at = CURRENT_TIMESTAMP
      `);

      for (const release of detail.Releases || []) {
        insertRelease.run(
          release.Id,
          releaseGroupMbid,
          ownerArtistMbid,
          release.Title,
          release.Status || null,
          JSON.stringify(release.Country || []),
          release.ReleaseDate || null,
          release.Disambiguation || null,
          release.MediaCount ?? release.MediumCount ?? (release.Media || []).length,
          release.TrackCount ?? (release.Tracks || []).length,
          JSON.stringify(release),
        );

        for (const media of release.Media || []) {
          insertMedium.run(
            release.Id,
            media.Position,
            media.Format || null,
            media.Name || null,
            (release.Tracks || []).filter((track) => track.MediumNumber === media.Position).length || null,
            JSON.stringify(media),
          );
        }

        for (const track of release.Tracks || []) {
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
            JSON.stringify(track),
          );
        }
      }
    })();
  }
}

export const skyHookProxy = new SkyHookProxy();
