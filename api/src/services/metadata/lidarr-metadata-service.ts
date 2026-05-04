import { db } from "../../database.js";
import type { MusicBrainzReleaseGroupForMatching } from "./provider-release-group-matcher.js";

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
}

export interface LidarrReleaseGroupDetail {
  id: string;
  title: string;
  Releases: LidarrRelease[];
}

export interface LidarrRelease {
  Id: string;
  Title: string;
  Status: string;
  Country: string[];
  Label: string[];
  Media: Array<{ Position: number; Format: string; Name: string }>;
  ReleaseDate: string;
  TrackCount: number;
  Disambiguation: string;
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

export class LidarrMetadataService {
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
        "User-Agent": "Discogenius/1.2.6",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      throw new Error(`Lidarr metadata API ${path} failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  async getArtist(mbid: string): Promise<LidarrArtist> {
    return this.fetchJson<LidarrArtist>(`/artist/${encodeURIComponent(mbid)}`);
  }

  async searchArtists(query: string, limit = 20): Promise<LidarrArtist[]> {
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

  async getAlbum(releaseGroupMbid: string): Promise<LidarrReleaseGroupDetail> {
    return this.fetchJson<LidarrReleaseGroupDetail>(`/album/${encodeURIComponent(releaseGroupMbid)}`);
  }

  getArtistImageUrl(artist: LidarrArtist, preferredCoverType = "Poster"): string | null {
    const images = Array.isArray(artist.images) ? artist.images : [];
    const preferred = images.find((image) =>
      String(image.CoverType || image.coverType || "").toLowerCase() === preferredCoverType.toLowerCase()
    ) || images.find((image) => image.Url || image.url || image.remoteUrl);

    return preferred?.Url || preferred?.url || preferred?.remoteUrl || null;
  }

  getAlbumImageUrl(album: LidarrAlbum, preferredCoverType = "Cover"): string | null {
    const images = Array.isArray(album.Images) ? album.Images : (Array.isArray(album.images) ? album.images : []);
    const preferred = images.find((image) =>
      String(image.CoverType || image.coverType || "").toLowerCase() === preferredCoverType.toLowerCase()
    ) || images.find((image) => image.Url || image.url || image.remoteUrl);

    return preferred?.Url || preferred?.url || preferred?.remoteUrl || null;
  }

  getCachedReleaseGroupsForArtist(artistMbid: string): MusicBrainzReleaseGroupForMatching[] {
    const rows = db.prepare(`
      SELECT mbid, title, primary_type, secondary_types, first_release_date, disambiguation
      FROM mb_release_groups
      WHERE artist_mbid = ?
    `).all(artistMbid) as Array<{
      mbid: string;
      title: string;
      primary_type: string | null;
      secondary_types: string | null;
      first_release_date: string | null;
      disambiguation: string | null;
    }>;

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
      };
    });
  }

  async syncArtist(mbid: string): Promise<LidarrArtist> {
    const artist = await this.getArtist(mbid);

    db.transaction(() => {
      db.prepare(`
        INSERT INTO mb_artists (mbid, name, sort_name, disambiguation, type, data, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(mbid) DO UPDATE SET
          name = excluded.name,
          sort_name = excluded.sort_name,
          disambiguation = excluded.disambiguation,
          type = excluded.type,
          data = excluded.data,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        artist.id,
        artist.artistname,
        artist.sortname,
        artist.disambiguation || null,
        artist.type || null,
        JSON.stringify(artist),
      );

      const insertRg = db.prepare(`
        INSERT INTO mb_release_groups (mbid, artist_mbid, title, primary_type, secondary_types, first_release_date, disambiguation, data, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(mbid) DO UPDATE SET
          title = excluded.title,
          primary_type = excluded.primary_type,
          secondary_types = excluded.secondary_types,
          first_release_date = excluded.first_release_date,
          disambiguation = excluded.disambiguation,
          data = excluded.data,
          updated_at = CURRENT_TIMESTAMP
      `);

      for (const album of artist.Albums || []) {
        insertRg.run(
          album.Id,
          artist.id,
          album.Title,
          album.Type || null,
          JSON.stringify(album.SecondaryTypes || []),
          album.ReleaseDate || null,
          album.Disambiguation || null,
          JSON.stringify(album),
        );
      }
    })();

    return artist;
  }

  async syncReleaseGroup(releaseGroupMbid: string, artistMbid: string): Promise<void> {
    const detail = await this.getAlbum(releaseGroupMbid);

    db.transaction(() => {
      const insertRelease = db.prepare(`
        INSERT INTO mb_releases (mbid, release_group_mbid, artist_mbid, title, status, country, date, disambiguation, track_count, data, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(mbid) DO UPDATE SET
          title = excluded.title,
          status = excluded.status,
          country = excluded.country,
          date = excluded.date,
          disambiguation = excluded.disambiguation,
          track_count = excluded.track_count,
          data = excluded.data,
          updated_at = CURRENT_TIMESTAMP
      `);

      const insertMedium = db.prepare(`
        INSERT INTO mb_mediums (release_mbid, position, format, title, track_count, data, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(release_mbid, position) DO UPDATE SET
          format = excluded.format,
          title = excluded.title,
          track_count = excluded.track_count,
          data = excluded.data,
          updated_at = CURRENT_TIMESTAMP
      `);

      const insertRecording = db.prepare(`
        INSERT INTO mb_recordings (mbid, title, length_ms, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(mbid) DO UPDATE SET
          title = excluded.title,
          length_ms = excluded.length_ms,
          updated_at = CURRENT_TIMESTAMP
      `);

      const insertTrack = db.prepare(`
        INSERT INTO mb_tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms, data, updated_at)
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
          artistMbid,
          release.Title,
          release.Status || null,
          JSON.stringify(release.Country || []),
          release.ReleaseDate || null,
          release.Disambiguation || null,
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

export const lidarrMetadataService = new LidarrMetadataService();
