import { db, runGatedChunkedWrite } from "../../database.js";
import type { CatalogArtistLocaleAlias, CatalogProvider, CatalogTrackArtistCredit } from "../catalog/catalog-provider.js";

/**
 * Keeps TrackArtistCreditNames (the published MusicBrainz credit of each
 * library track) in step with the catalogue, right before tags are planned.
 *
 * Only tracks that have files are synced: the credit exists to write tags, so
 * the cost follows the library (one indexed catalogue query per 500 tracks),
 * not the multi-million-track catalogue.
 *
 * The same pass repairs ArtistMetadata.name/sort_name for every credited
 * artist from the catalogue's own artist name. Older builds overwrote those
 * names with credited-as variants ("AFROJACK", "MJ", "The Golden Earrings"),
 * and ALBUMARTIST, folders and Plex/Jellyfin artists all read that column.
 *
 * A catalogue that has no per-track credits (Servarr Metadata Server) or is
 * unreachable leaves the table as it is; tag planning then falls back to the
 * recording credit or the owning artist. Syncing never fails an import or a
 * retag.
 */

export type TrackArtistCreditSyncResult = {
  supported: boolean;
  requested: number;
  /** Tracks whose stored credit was inserted or changed. */
  changed: number;
  /** ArtistMetadata rows whose name or sort name was repaired. */
  artistsRepaired: number;
  /** Artists whose stored locale aliases were inserted or changed. */
  aliasesChanged?: number;
  error?: string;
};

const WRITE_CHUNK = 100;

function normalizeMbid(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

async function activeCatalog(): Promise<CatalogProvider> {
  const { catalogProviderRegistry } = await import("../catalog/index.js");
  return catalogProviderRegistry.getActive();
}

function sameCredit(
  stored: Array<{ artist_mbid: string; artist_name: string; artist_sort_name: string | null; credited_name: string; join_phrase: string }>,
  fresh: CatalogTrackArtistCredit[],
): boolean {
  if (stored.length !== fresh.length) return false;
  return stored.every((row, index) => {
    const part = fresh[index];
    return row.artist_mbid === normalizeMbid(part.artistId)
      && row.artist_name === part.artistName
      && (row.artist_sort_name ?? null) === (part.artistSortName ?? null)
      && row.credited_name === part.creditedName
      && row.join_phrase === part.joinPhrase;
  });
}

export class TrackArtistCreditSync {
  /** Canonical track MBIDs of the given TrackFiles rows. */
  static trackMbidsForFiles(trackFileIds: number[]): string[] {
    const ids = [...new Set(trackFileIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (ids.length === 0) return [];
    const rows = db.prepare(`
      SELECT DISTINCT lower(COALESCE(lf.canonical_track_mbid, track.mbid)) AS mbid
      FROM TrackFiles lf
      LEFT JOIN Tracks track ON track.id = lf.track_id
      WHERE lf.id IN (SELECT value FROM json_each(?))
        AND COALESCE(lf.canonical_track_mbid, track.mbid) IS NOT NULL
    `).all(JSON.stringify(ids)) as Array<{ mbid: string }>;
    return rows.map((row) => row.mbid).filter(Boolean);
  }

  static async syncForTrackFiles(
    trackFileIds: number[],
    options: { catalog?: CatalogProvider } = {},
  ): Promise<TrackArtistCreditSyncResult> {
    return this.syncTrackMbids(this.trackMbidsForFiles(trackFileIds), {
      ...options,
      extraArtistMbids: this.ownerArtistMbidsForFiles(trackFileIds),
    });
  }

  /** Owning artists and release (album-artist) credits of the given files: ALBUMARTIST names are translated too. */
  static ownerArtistMbidsForFiles(trackFileIds: number[]): string[] {
    const ids = [...new Set(trackFileIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (ids.length === 0) return [];
    const rows = db.prepare(`
      SELECT DISTINCT lower(artist.mbid) AS mbid
      FROM TrackFiles lf
      JOIN ArtistMetadata artist ON artist.id = lf.artist_metadata_id
      WHERE lf.id IN (SELECT value FROM json_each(?)) AND artist.mbid IS NOT NULL
      UNION
      SELECT DISTINCT lower(artist.mbid)
      FROM TrackFiles lf
      JOIN AlbumEditions edition ON edition.mbid = lf.canonical_release_mbid
      JOIN ReleaseArtistCredits credit ON credit.edition_id = edition.id
      JOIN ArtistMetadata artist ON artist.id = credit.artist_id
      WHERE lf.id IN (SELECT value FROM json_each(?)) AND artist.mbid IS NOT NULL
    `).all(JSON.stringify(ids), JSON.stringify(ids)) as Array<{ mbid: string }>;
    return rows.map((row) => row.mbid).filter(Boolean);
  }

  /**
   * Store the locale aliases of these artists (ArtistLocaleAliases). Never
   * throws; a catalogue without aliases leaves the table as it is.
   */
  static async syncArtistLocaleAliases(artistMbids: string[], catalog: CatalogProvider): Promise<number> {
    const wanted = [...new Set(artistMbids.map(normalizeMbid).filter(Boolean))];
    if (wanted.length === 0 || typeof catalog.getArtistLocaleAliases !== "function") return 0;
    let fetched: Map<string, CatalogArtistLocaleAlias[]>;
    try {
      fetched = await catalog.getArtistLocaleAliases(wanted);
    } catch (error) {
      console.warn(`[TrackArtistCredits] Artist alias lookup failed for ${wanted.length} artist(s): ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
    const readStored = db.prepare(`
      SELECT name, sort_name, locale, primary_for_locale, alias_type
      FROM ArtistLocaleAliases WHERE artist_mbid = ? ORDER BY ordinal
    `);
    const deleteStored = db.prepare("DELETE FROM ArtistLocaleAliases WHERE artist_mbid = ?");
    const insert = db.prepare(`
      INSERT INTO ArtistLocaleAliases (artist_mbid, ordinal, name, sort_name, locale, primary_for_locale, alias_type, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    const mark = db.prepare(`
      INSERT INTO ArtistLocaleAliasSync (artist_mbid, synced_at) VALUES (?, CURRENT_TIMESTAMP)
      ON CONFLICT(artist_mbid) DO UPDATE SET synced_at = excluded.synced_at
    `);
    let changed = 0;
    const entries = [...fetched.entries()].map(([mbid, aliases]) => [normalizeMbid(mbid), aliases] as const).filter(([mbid]) => mbid);
    await runGatedChunkedWrite(entries, ([mbid, aliases]) => {
      const stored = readStored.all(mbid) as Array<{ name: string; sort_name: string | null; locale: string; primary_for_locale: number; alias_type: string | null }>;
      const same = stored.length === aliases.length && stored.every((row, index) => {
        const alias = aliases[index];
        return row.name === alias.name && (row.sort_name ?? null) === (alias.sortName ?? null)
          && row.locale === alias.locale && row.primary_for_locale === (alias.primaryForLocale ? 1 : 0)
          && (row.alias_type ?? null) === (alias.type ?? null);
      });
      mark.run(mbid);
      if (same) return;
      deleteStored.run(mbid);
      aliases.forEach((alias, ordinal) => {
        insert.run(mbid, ordinal, alias.name, alias.sortName ?? null, alias.locale, alias.primaryForLocale ? 1 : 0, alias.type ?? null);
      });
      changed += 1;
    }, WRITE_CHUNK, "track-artist-credits:artist-aliases");
    return changed;
  }

  static async syncTrackMbids(
    trackMbids: string[],
    options: { catalog?: CatalogProvider; extraArtistMbids?: string[] } = {},
  ): Promise<TrackArtistCreditSyncResult> {
    const wanted = [...new Set(trackMbids.map(normalizeMbid).filter(Boolean))];
    const result: TrackArtistCreditSyncResult = { supported: true, requested: wanted.length, changed: 0, artistsRepaired: 0 };
    if (wanted.length === 0) return result;

    let catalog: CatalogProvider;
    try {
      catalog = options.catalog ?? await activeCatalog();
    } catch (error) {
      return { ...result, supported: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (typeof catalog.getTrackArtistCredits !== "function") return { ...result, supported: false };

    let fetched: Map<string, CatalogTrackArtistCredit[]>;
    try {
      fetched = await catalog.getTrackArtistCredits(wanted);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[TrackArtistCredits] Catalogue credit lookup failed for ${wanted.length} track(s); tags use the stored credit: ${message}`);
      return { ...result, error: message };
    }

    const entries = [...fetched.entries()]
      .map(([mbid, credits]) => [normalizeMbid(mbid), credits.filter((credit) => normalizeMbid(credit.artistId) && (credit.creditedName || credit.artistName))] as const)
      .filter(([mbid, credits]) => mbid && credits.length > 0);

    const artists = new Map<string, { name: string; sortName: string | null }>();
    for (const [, credits] of entries) {
      for (const credit of credits) {
        const name = String(credit.artistName || "").trim();
        if (name) artists.set(normalizeMbid(credit.artistId), { name, sortName: credit.artistSortName || null });
      }
    }

    const readStored = db.prepare(`
      SELECT artist_mbid, artist_name, artist_sort_name, credited_name, join_phrase
      FROM TrackArtistCreditNames WHERE track_mbid = ? ORDER BY ordinal
    `);
    const deleteStored = db.prepare("DELETE FROM TrackArtistCreditNames WHERE track_mbid = ?");
    const insert = db.prepare(`
      INSERT INTO TrackArtistCreditNames (
        track_mbid, ordinal, artist_mbid, artist_name, artist_sort_name, credited_name, join_phrase, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    await runGatedChunkedWrite(entries, ([mbid, credits]) => {
      const stored = readStored.all(mbid) as Parameters<typeof sameCredit>[0];
      if (sameCredit(stored, credits)) return;
      deleteStored.run(mbid);
      credits.forEach((credit, ordinal) => {
        insert.run(
          mbid,
          ordinal,
          normalizeMbid(credit.artistId),
          String(credit.artistName || credit.creditedName).trim(),
          credit.artistSortName || null,
          String(credit.creditedName || credit.artistName).trim(),
          String(credit.joinPhrase ?? ""),
        );
      });
      result.changed += 1;
    }, WRITE_CHUNK, "track-artist-credits:sync");

    const repair = db.prepare(`
      UPDATE ArtistMetadata
      SET name = ?, sort_name = COALESCE(?, sort_name), updated_at = CURRENT_TIMESTAMP
      WHERE mbid = ?
        AND (name IS NOT ? OR (? IS NOT NULL AND sort_name IS NOT ?))
    `);
    await runGatedChunkedWrite([...artists.entries()], ([mbid, artist]) => {
      result.artistsRepaired += repair.run(artist.name, artist.sortName, mbid, artist.name, artist.sortName, artist.sortName).changes;
    }, WRITE_CHUNK, "track-artist-credits:artist-names");

    result.aliasesChanged = await this.syncArtistLocaleAliases(
      [...artists.keys(), ...(options.extraArtistMbids ?? [])],
      catalog,
    );

    return result;
  }
}
