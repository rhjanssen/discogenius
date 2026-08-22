import { db, runGatedChunkedWrite } from "../../database.js";
import type { CatalogArtistCreditReleaseGroup } from "../catalog/catalog-provider.js";

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

function catalogReleaseGroupToMusicBrainzReleaseGroup(group: CatalogArtistCreditReleaseGroup): MusicBrainzReleaseGroup {
  return {
    id: group.id,
    title: group.title,
    "primary-type": group.primaryType || undefined,
    "secondary-types": group.secondaryTypes || [],
    "first-release-date": group.firstReleaseDate || undefined,
    disambiguation: group.disambiguation || undefined,
    "artist-credit": group.artistCredits.map((credit) => ({
      name: credit.name,
      joinphrase: credit.joinPhrase,
      artist: {
        id: credit.artistId,
        name: credit.name,
      },
    })),
  };
}

async function fetchCreditedReleaseGroups(artistMbid: string): Promise<MusicBrainzReleaseGroup[]> {
  const { catalogProviderRegistry } = await import("../catalog/index.js");
  const activeProvider = catalogProviderRegistry.getActive();
  if (typeof activeProvider.getCreditedReleaseGroupsForArtist === "function") {
    return (await activeProvider.getCreditedReleaseGroupsForArtist(artistMbid))
      .map(catalogReleaseGroupToMusicBrainzReleaseGroup);
  }

  // Servarr has no credited-release-group browse. Do not call musicbrainz.org:
  // a 503 there used to fail the whole RefreshArtist. Credits stay empty until
  // the selected catalog can serve them (MusicBrainz-local).
  return [];
}

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
      id, name, mbid, musicbrainz_status, musicbrainz_match_method, library_origin, monitored
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
    const seenArtists = new Set<string>();
    const releaseGroups = await fetchCreditedReleaseGroups(artistMbid);

    // A prolific artist's credited catalogue is hundreds of release groups and
    // roughly ten statements each. Chunked, and taking the process-global gate
    // per chunk: concurrent refresh workers then queue asynchronously (rather
    // than blocking their threads in SQLite's busy handler, which stops their
    // lease heartbeats) *and* get to interleave, rather than waiting out one
    // artist's entire catalogue. Each release group is an idempotent upsert, so
    // committing between chunks is safe.
    await runGatedChunkedWrite(releaseGroups, (releaseGroup) => {
      {
        const releaseGroupMbid = String(releaseGroup.id || "").trim();
        if (!releaseGroupMbid) {
          return;
        }

        const credits = parseArtistCredits(releaseGroup["artist-credit"], artistMbid);
        if (credits.length === 0) {
          return;
        }

        for (const credit of credits) {
          ensureArtist(credit);
          seenArtists.add(credit.artistId);
        }

        const owner = credits[0];
        db.prepare(`
          INSERT INTO Albums (
            mbid, artist_mbid, title, primary_type, secondary_types,
            first_release_date, disambiguation, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(mbid) DO UPDATE SET
            artist_mbid = excluded.artist_mbid,
            title = excluded.title,
            primary_type = excluded.primary_type,
            secondary_types = excluded.secondary_types,
            first_release_date = excluded.first_release_date,
            disambiguation = excluded.disambiguation,
            updated_at = CURRENT_TIMESTAMP
        `).run(
          releaseGroupMbid,
          owner.artistId,
          String(releaseGroup.title || ""),
          releaseGroup["primary-type"] || null,
          JSON.stringify(releaseGroup["secondary-types"] || []),
          releaseGroup["first-release-date"] || null,
          releaseGroup.disambiguation || null,
        );

        replaceAlbumArtists(releaseGroupMbid, credits);
        credits.forEach((credit, index) => {
          upsertScope(credit.artistId, releaseGroupMbid, index === 0 ? "primary" : "album-credit");
        });
        upsertScope(artistMbid, releaseGroupMbid, "credited");
      }
    }, 50, "credited-release-groups");

    return {
      releaseGroups: releaseGroups.length,
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

  static getAlbumArtistsMap(releaseGroupMbids: string[]): Map<string, CanonicalAlbumArtist[]> {
    const uniqueMbids = Array.from(new Set(releaseGroupMbids.filter(Boolean)));
    if (uniqueMbids.length === 0) {
      return new Map();
    }

    const marks = uniqueMbids.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT
        aa.release_group_mbid AS releaseGroupMbid,
        aa.artist_mbid AS artistId,
        aa.credited_name AS name,
        aa.join_phrase AS joinPhrase,
        a.picture,
        a.cover_image_url AS coverImageUrl
      FROM AlbumArtists aa
      LEFT JOIN Artists a ON a.mbid = aa.artist_mbid
      WHERE aa.release_group_mbid IN (${marks})
      ORDER BY aa.release_group_mbid ASC, aa.ord ASC
    `).all(...uniqueMbids) as Array<CanonicalAlbumArtist & { releaseGroupMbid: string }>;

    const result = new Map<string, CanonicalAlbumArtist[]>();
    for (const row of rows) {
      const artists = result.get(row.releaseGroupMbid) ?? [];
      artists.push({
        artistId: row.artistId,
        name: row.name,
        joinPhrase: row.joinPhrase,
        picture: row.picture,
        coverImageUrl: row.coverImageUrl,
      });
      result.set(row.releaseGroupMbid, artists);
    }
    return result;
  }
}
