import { db } from "../../database.js";
import { requestMusicBrainzJson } from "../fingerprint.js";

export type CanonicalAlbumArtist = {
  artistId: string;
  name: string;
  joinPhrase: string;
  picture: string | null;
  coverImageUrl: string | null;
};

type MusicBrainzArtistCredit = {
  artistId: string;
  name: string;
  joinPhrase: string;
};

type MusicBrainzReleaseGroup = {
  id?: string;
  title?: string;
  "primary-type"?: string;
  "secondary-types"?: string[];
  "first-release-date"?: string;
  disambiguation?: string;
  "artist-credit"?: unknown[];
};

function parseArtistCredits(rawCredits: unknown, fallbackArtistMbid?: string): MusicBrainzArtistCredit[] {
  if (!Array.isArray(rawCredits)) {
    return fallbackArtistMbid
      ? [{ artistId: fallbackArtistMbid, name: fallbackArtistMbid, joinPhrase: "" }]
      : [];
  }

  return rawCredits
    .map((rawCredit: any) => {
      const artistId = String(rawCredit?.artist?.id || "").trim();
      const name = String(rawCredit?.name || rawCredit?.artist?.name || "").trim();
      if (!artistId || !name) {
        return null;
      }

      return {
        artistId,
        name,
        joinPhrase: String(rawCredit?.joinphrase || ""),
      };
    })
    .filter(Boolean) as MusicBrainzArtistCredit[];
}

function ensureArtist(artist: MusicBrainzArtistCredit, origin = "musicbrainz-credit"): void {
  db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name, sort_name, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(mbid) DO UPDATE SET
      name = CASE WHEN excluded.name = excluded.mbid THEN ArtistMetadata.name ELSE excluded.name END,
      updated_at = CURRENT_TIMESTAMP
  `).run(artist.artistId, artist.name, artist.name);

  db.prepare(`
    INSERT INTO Artists (
      id, name, mbid, musicbrainz_status, musicbrainz_match_method, library_origin, monitor
    )
    VALUES (?, ?, ?, 'verified', 'musicbrainz-artist-credit', ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      name = CASE WHEN excluded.name = excluded.mbid THEN Artists.name ELSE excluded.name END,
      mbid = excluded.mbid,
      musicbrainz_status = excluded.musicbrainz_status,
      musicbrainz_match_method = excluded.musicbrainz_match_method
  `).run(artist.artistId, artist.name, artist.artistId, origin);
}

function upsertScope(artistMbid: string, releaseGroupMbid: string, relationship: string): void {
  db.prepare(`
    INSERT INTO ArtistReleaseGroups (artist_mbid, release_group_mbid, relationship, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(artist_mbid, release_group_mbid, relationship) DO UPDATE SET
      updated_at = CURRENT_TIMESTAMP
  `).run(artistMbid, releaseGroupMbid, relationship);
}

function replaceAlbumArtists(releaseGroupMbid: string, credits: MusicBrainzArtistCredit[]): void {
  db.prepare("DELETE FROM AlbumArtists WHERE release_group_mbid = ?").run(releaseGroupMbid);
  const insert = db.prepare(`
    INSERT INTO AlbumArtists (
      release_group_mbid, artist_mbid, ord, credited_name, join_phrase, is_primary, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  credits.forEach((credit, index) => {
    insert.run(releaseGroupMbid, credit.artistId, index, credit.name, credit.joinPhrase, index === 0 ? 1 : 0);
  });
}

export class MusicBrainzArtistCreditService {
  static ensureArtist(artistMbid: string, artistName?: string, origin = "musicbrainz-primary"): void {
    ensureArtist({
      artistId: artistMbid,
      name: String(artistName || artistMbid).trim(),
      joinPhrase: "",
    }, origin);
  }

  static ensurePrimaryScope(releaseGroupMbid: string, artistMbid: string, artistName?: string): void {
    const name = String(artistName || artistMbid).trim();
    const credit = { artistId: artistMbid, name, joinPhrase: "" };
    ensureArtist(credit, "musicbrainz-primary");
    upsertScope(artistMbid, releaseGroupMbid, "primary");

    const existing = db.prepare("SELECT 1 FROM AlbumArtists WHERE release_group_mbid = ? LIMIT 1")
      .get(releaseGroupMbid);
    if (!existing) {
      replaceAlbumArtists(releaseGroupMbid, [credit]);
    }
  }

  static async syncCreditedReleaseGroupsForArtist(artistMbid: string): Promise<{
    releaseGroups: number;
    artists: number;
    artistMbids: string[];
  }> {
    let offset = 0;
    let total = 0;
    const seenArtists = new Set<string>();

    do {
      const url = new URL("https://musicbrainz.org/ws/2/release-group");
      url.searchParams.set("artist", artistMbid);
      url.searchParams.set("release-group-status", "website-default");
      url.searchParams.set("inc", "artist-credits");
      url.searchParams.set("fmt", "json");
      url.searchParams.set("limit", "100");
      url.searchParams.set("offset", String(offset));

      const page = await requestMusicBrainzJson<any>(url.toString());
      const releaseGroups = Array.isArray(page?.["release-groups"])
        ? page["release-groups"] as MusicBrainzReleaseGroup[]
        : [];
      total = Number(page?.["release-group-count"] || releaseGroups.length);

      db.transaction(() => {
        for (const releaseGroup of releaseGroups) {
          const releaseGroupMbid = String(releaseGroup.id || "").trim();
          if (!releaseGroupMbid) {
            continue;
          }

          const credits = parseArtistCredits(releaseGroup["artist-credit"], artistMbid);
          if (credits.length === 0) {
            continue;
          }

          for (const credit of credits) {
            ensureArtist(credit);
            seenArtists.add(credit.artistId);
          }

          const owner = credits[0];
          db.prepare(`
            INSERT INTO Albums (
              mbid, artist_mbid, title, primary_type, secondary_types,
              first_release_date, disambiguation, data, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(mbid) DO UPDATE SET
              artist_mbid = excluded.artist_mbid,
              title = excluded.title,
              primary_type = excluded.primary_type,
              secondary_types = excluded.secondary_types,
              first_release_date = excluded.first_release_date,
              disambiguation = excluded.disambiguation,
              data = excluded.data,
              updated_at = CURRENT_TIMESTAMP
          `).run(
            releaseGroupMbid,
            owner.artistId,
            String(releaseGroup.title || ""),
            releaseGroup["primary-type"] || null,
            JSON.stringify(releaseGroup["secondary-types"] || []),
            releaseGroup["first-release-date"] || null,
            releaseGroup.disambiguation || null,
            JSON.stringify(releaseGroup),
          );

          replaceAlbumArtists(releaseGroupMbid, credits);
          credits.forEach((credit, index) => {
            upsertScope(credit.artistId, releaseGroupMbid, index === 0 ? "primary" : "album-credit");
          });
          upsertScope(artistMbid, releaseGroupMbid, "credited");
        }
      })();

      offset += releaseGroups.length;
      if (releaseGroups.length === 0) {
        break;
      }
    } while (offset < total);

    return {
      releaseGroups: offset,
      artists: seenArtists.size,
      artistMbids: Array.from(seenArtists),
    };
  }

  static getAlbumArtists(releaseGroupMbid: string): CanonicalAlbumArtist[] {
    return db.prepare(`
      SELECT
        aa.artist_mbid AS artistId,
        aa.credited_name AS name,
        aa.join_phrase AS joinPhrase,
        a.picture,
        a.cover_image_url AS coverImageUrl
      FROM AlbumArtists aa
      LEFT JOIN Artists a ON a.mbid = aa.artist_mbid
      WHERE aa.release_group_mbid = ?
      ORDER BY aa.ord ASC
    `).all(releaseGroupMbid) as CanonicalAlbumArtist[];
  }
}
