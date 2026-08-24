import { db, runGatedChunkedWrite } from "../../database.js";
import { CanonicalCatalogRepository } from "../catalog/canonical-catalog-repository.js";
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

function ensureArtist(artist: MusicBrainzArtistCredit, _origin = "musicbrainz-credit"): void {
  // Credits mint catalog rows only. Library membership is never created here.
  db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name, sort_name, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(mbid) DO UPDATE SET
      name = CASE WHEN excluded.name = excluded.mbid THEN ArtistMetadata.name ELSE excluded.name END,
      updated_at = CURRENT_TIMESTAMP
  `).run(artist.artistId, artist.name, artist.name);
}

function upsertScope(artistMbid: string, releaseGroupMbid: string, relationship: string): void {
  db.prepare(`
    INSERT INTO ArtistReleaseGroups (
      artist_metadata_id, artist_mbid, release_group_id, release_group_mbid, relationship, updated_at
    )
    SELECT
      canonical.id,
      ?,
      albums.id,
      ?,
      ?,
      CURRENT_TIMESTAMP
    FROM ArtistMetadata canonical
    LEFT JOIN Albums albums ON albums.mbid = ?
    WHERE canonical.mbid = ?
    ON CONFLICT(artist_mbid, release_group_mbid, relationship) DO UPDATE SET
      artist_metadata_id = excluded.artist_metadata_id,
      release_group_id = excluded.release_group_id,
      updated_at = CURRENT_TIMESTAMP
  `).run(artistMbid, releaseGroupMbid, relationship, releaseGroupMbid, artistMbid);
}

function integerCreditsForReleaseGroup(credits: MusicBrainzArtistCredit[]) {
  return credits.flatMap((credit, index) => {
    const artist = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = ?")
      .get(credit.artistId) as { id: number } | undefined;
    if (!artist) return [];
    return [{
      artistId: artist.id,
      ordinal: index,
      creditedName: credit.name,
      joinPhrase: credit.joinPhrase,
    }];
  });
}

function replaceAlbumArtists(releaseGroupMbid: string, credits: MusicBrainzArtistCredit[]): void {
  const releaseGroup = db.prepare("SELECT id FROM Albums WHERE mbid = ?")
    .get(releaseGroupMbid) as { id: number } | undefined;
  const integerCredits = integerCreditsForReleaseGroup(credits);
  if (releaseGroup && integerCredits.length > 0) {
    const catalog = new CanonicalCatalogRepository(db);
    catalog.replaceReleaseGroupCredits(releaseGroup.id, integerCredits);
    const editions = db.prepare(`
      SELECT id FROM AlbumEditions
      WHERE release_group_id = ? OR release_group_mbid = ?
    `).all(releaseGroup.id, releaseGroupMbid) as Array<{ id: number }>;
    for (const edition of editions) {
      catalog.replaceReleaseCredits(edition.id, integerCredits);
    }
  }

  db.prepare("DELETE FROM AlbumArtists WHERE release_group_mbid = ?").run(releaseGroupMbid);
  const insert = db.prepare(`
    INSERT INTO AlbumArtists (
      release_group_id, release_group_mbid, artist_metadata_id, artist_mbid,
      ord, credited_name, join_phrase, is_primary, updated_at
    )
    SELECT
      albums.id,
      ?,
      canonical.id,
      ?,
      ?,
      ?,
      ?,
      ?,
      CURRENT_TIMESTAMP
    FROM ArtistMetadata canonical
    LEFT JOIN Albums albums ON albums.mbid = ?
    WHERE canonical.mbid = ?
  `);

  credits.forEach((credit, index) => {
    insert.run(
      releaseGroupMbid,
      credit.artistId,
      index,
      credit.name,
      credit.joinPhrase,
      index === 0 ? 1 : 0,
      releaseGroupMbid,
      credit.artistId,
    );
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

    const existing = db.prepare(`
      SELECT 1
      FROM ReleaseGroupArtistCredits credit
      JOIN Albums release_group ON release_group.id = credit.release_group_id
      WHERE release_group.mbid = ?
      LIMIT 1
    `).get(releaseGroupMbid);
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
            mbid, artist_metadata_id, artist_mbid, title, primary_type, secondary_types,
            first_release_date, disambiguation, updated_at
          )
          SELECT
            ?,
            canonical.id,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            CURRENT_TIMESTAMP
          FROM ArtistMetadata canonical
          WHERE canonical.mbid = ?
          ON CONFLICT(mbid) DO UPDATE SET
            artist_metadata_id = excluded.artist_metadata_id,
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
          owner.artistId,
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
    const integerRows = db.prepare(`
      SELECT
        canonical.mbid AS artistId,
        credit.credited_name AS name,
        credit.join_phrase AS joinPhrase,
        a.picture,
        a.cover_image_url AS coverImageUrl
      FROM ReleaseGroupArtistCredits credit
      JOIN Albums release_group ON release_group.id = credit.release_group_id
      JOIN ArtistMetadata canonical ON canonical.id = credit.artist_id
      LEFT JOIN ArtistMetadata a ON a.mbid = canonical.mbid
      WHERE release_group.mbid = ?
      ORDER BY credit.ordinal ASC
    `).all(releaseGroupMbid) as CanonicalAlbumArtist[];
    if (integerRows.length > 0) {
      return integerRows;
    }

    return db.prepare(`
      SELECT
        aa.artist_mbid AS artistId,
        aa.credited_name AS name,
        aa.join_phrase AS joinPhrase,
        a.picture,
        a.cover_image_url AS coverImageUrl
      FROM AlbumArtists aa
      LEFT JOIN ArtistMetadata a ON a.mbid = aa.artist_mbid
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
    const integerRows = db.prepare(`
      SELECT
        release_group.mbid AS releaseGroupMbid,
        canonical.mbid AS artistId,
        credit.credited_name AS name,
        credit.join_phrase AS joinPhrase,
        a.picture,
        a.cover_image_url AS coverImageUrl
      FROM ReleaseGroupArtistCredits credit
      JOIN Albums release_group ON release_group.id = credit.release_group_id
      JOIN ArtistMetadata canonical ON canonical.id = credit.artist_id
      LEFT JOIN ArtistMetadata a ON a.mbid = canonical.mbid
      WHERE release_group.mbid IN (${marks})
      ORDER BY release_group.mbid ASC, credit.ordinal ASC
    `).all(...uniqueMbids) as Array<CanonicalAlbumArtist & { releaseGroupMbid: string }>;

    const result = new Map<string, CanonicalAlbumArtist[]>();
    for (const row of integerRows) {
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
    if (result.size === uniqueMbids.length) {
      return result;
    }

    const leftoverMbids = uniqueMbids.filter((mbid) => !result.has(mbid));
    if (leftoverMbids.length === 0) {
      return result;
    }
    const leftoverMarks = leftoverMbids.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT
        aa.release_group_mbid AS releaseGroupMbid,
        aa.artist_mbid AS artistId,
        aa.credited_name AS name,
        aa.join_phrase AS joinPhrase,
        a.picture,
        a.cover_image_url AS coverImageUrl
      FROM AlbumArtists aa
      LEFT JOIN ArtistMetadata a ON a.mbid = aa.artist_mbid
      WHERE aa.release_group_mbid IN (${leftoverMarks})
      ORDER BY aa.release_group_mbid ASC, aa.ord ASC
    `).all(...leftoverMbids) as Array<CanonicalAlbumArtist & { releaseGroupMbid: string }>;

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

  static materializeIntegerCreditsForReleaseGroup(releaseGroupMbid: string): void {
    const releaseGroup = db.prepare("SELECT id FROM Albums WHERE mbid = ?")
      .get(releaseGroupMbid) as { id: number } | undefined;
    if (!releaseGroup) return;

    db.prepare(`
      INSERT INTO ReleaseArtistCredits (
        edition_id, artist_id, ordinal, credited_name, join_phrase, role
      )
      SELECT e.id, credit.artist_id, credit.ordinal, credit.credited_name, credit.join_phrase, credit.role
      FROM ReleaseGroupArtistCredits credit
      JOIN AlbumEditions e ON e.release_group_id = credit.release_group_id
      WHERE credit.release_group_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM ReleaseArtistCredits existing WHERE existing.edition_id = e.id
        )
    `).run(releaseGroup.id);

    db.prepare(`
      INSERT INTO RecordingArtistCredits (
        recording_id, artist_id, ordinal, credited_name, join_phrase, role
      )
      SELECT r.id, credit.artist_id, credit.ordinal, credit.credited_name, credit.join_phrase, credit.role
      FROM ReleaseGroupArtistCredits credit
      JOIN AlbumEditions e ON e.release_group_id = credit.release_group_id
      JOIN Tracks t ON t.album_edition_id = e.id
      JOIN Recordings r ON r.id = t.recording_id
      WHERE credit.release_group_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM RecordingArtistCredits existing WHERE existing.recording_id = r.id
        )
      GROUP BY r.id, credit.artist_id, credit.ordinal, credit.credited_name, credit.join_phrase, credit.role
    `).run(releaseGroup.id);

    db.prepare(`
      INSERT INTO TrackArtistCredits (
        track_id, artist_id, ordinal, credited_name, join_phrase, role
      )
      SELECT t.id, credit.artist_id, credit.ordinal, credit.credited_name, credit.join_phrase, credit.role
      FROM ReleaseGroupArtistCredits credit
      JOIN AlbumEditions e ON e.release_group_id = credit.release_group_id
      JOIN Tracks t ON t.album_edition_id = e.id
      WHERE credit.release_group_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM TrackArtistCredits existing WHERE existing.track_id = t.id
        )
    `).run(releaseGroup.id);
  }
}
