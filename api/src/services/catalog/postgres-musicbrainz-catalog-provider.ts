/**
 * `PostgresMusicBrainzCatalogProvider` — reads the canonical catalog directly
 * from a local **MusicBrainz-docker Postgres** instance (the `db` service, schema
 * `musicbrainz`, seq 31). This is the primary MB-mode backend (see
 * docs/MB_LOCAL_MODE.md + the mb-docker-backend-decision memory).
 *
 * Why direct Postgres over the `/ws/2` web API: MB's release-group web endpoint
 * omits tracks, forcing an N+1 per-release fan-out. In SQL one JOIN
 * (`release_group → release → medium → track → recording → isrc`) returns an
 * entire release group's editions + tracklist + ISRCs in a single round-trip.
 * The db-only mirror is also far lighter to run (100GB/4GB, no Solr/web).
 *
 * It implements the same `CatalogProvider` interface and produces the exact same
 * `Lidarr*` DTOs as the Servarr path — by building the intermediate `Mb*` shapes
 * from SQL rows and running them through the existing `musicbrainz-ws-mapping`
 * mappers. So the `servarr-metadata.ts` write path is unchanged.
 *
 * Search: the MB DB alone has no full-text index. When a MB web server (`/ws/2`,
 * i.e. the full stack incl. Solr) is reachable it is used for Solr-ranked search;
 * otherwise this falls back to a Postgres name match (`pg_trgm` when the
 * extension is installed, else `ILIKE`).
 */
import pg from "pg";
import { getDiscogeniusUserAgent } from "../config/user-agent.js";
import type {
  CatalogProvider,
  CatalogSearchOptions,
  CatalogSearchResults,
  CatalogReleaseGroupSearchResult,
  CatalogRecording,
  CatalogUpcLookupResult,
  CatalogIsrcLookupResult,
  CatalogArtistCreditReleaseGroup,
  CatalogVideoRecording,
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
  type MbMedium,
  type MbTrack,
  type MbRecording,
  type MbReleaseGroupStub,
} from "./musicbrainz-ws-mapping.js";

export interface PostgresMusicBrainzCatalogProviderOptions {
  /** Postgres DSN, e.g. `postgresql://musicbrainz:musicbrainz@host:5432/musicbrainz_db`. */
  connectionString: string;
  /** Optional MB `/ws/2` base URL for Solr-backed search (full-stack mirror). */
  searchWebUrl?: string | null;
  /** Max pooled connections. */
  poolSize?: number;
  /** Per-statement timeout (ms). */
  statementTimeoutMs?: number;
}

/** Format MB's split (year, month, day) smallints into a partial ISO date. */
function formatMbDate(y?: number | null, m?: number | null, d?: number | null): string | null {
  if (!y) return null;
  const yy = String(y).padStart(4, "0");
  if (!m) return yy;
  const mm = String(m).padStart(2, "0");
  if (!d) return `${yy}-${mm}`;
  return `${yy}-${mm}-${String(d).padStart(2, "0")}`;
}

/** Sort partial ISO dates ascending; null/empty last. */
function earlierDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

export class PostgresMusicBrainzCatalogProvider implements CatalogProvider {
  readonly id = "musicbrainz-local";
  readonly name = "Local MusicBrainz (Postgres direct)";

  private readonly pool: pg.Pool;
  private readonly searchWebUrl: string | null;
  private pgTrgmChecked = false;
  private pgTrgmAvailable = false;

  constructor(options: PostgresMusicBrainzCatalogProviderOptions) {
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.poolSize ?? 4,
      statement_timeout: options.statementTimeoutMs ?? 20_000,
      // The MB tables live in the `musicbrainz` schema.
      options: "-c search_path=musicbrainz,public",
    });
    this.searchWebUrl = options.searchWebUrl?.replace(/\/+$/, "") || null;
  }

  async dispose(): Promise<void> {
    await this.pool.end();
  }

  private async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pool.query<T>(text, values as unknown[]);
    return result.rows;
  }

  // ---- artist ----

  async getArtist(artistMbid: string): Promise<LidarrArtist> {
    const [artistRow] = await this.query<{ id: number; gid: string; name: string; sort_name: string; comment: string | null; type_name: string | null }>(
      `SELECT a.id, a.gid, a.name, a.sort_name, a.comment, at.name AS type_name
       FROM artist a LEFT JOIN artist_type at ON at.id = a.type
       WHERE a.gid = $1`,
      [artistMbid],
    );
    if (!artistRow) {
      throw new Error(`MB-local: artist ${artistMbid} not found`);
    }

    const rgRows = await this.query<{
      gid: string; name: string; primary_type: string | null; comment: string | null;
      y: number | null; m: number | null; d: number | null; secondary_types: string[] | null;
    }>(
      `SELECT rg.gid, rg.name, rgpt.name AS primary_type, rg.comment,
          rgm.first_release_date_year AS y, rgm.first_release_date_month AS m, rgm.first_release_date_day AS d,
          (SELECT array_agg(st.name ORDER BY st.name)
             FROM release_group_secondary_type_join j
             JOIN release_group_secondary_type st ON st.id = j.secondary_type
             WHERE j.release_group = rg.id) AS secondary_types
       FROM release_group rg
       JOIN artist_credit_name acn ON acn.artist_credit = rg.artist_credit AND acn.artist = $1
       LEFT JOIN release_group_primary_type rgpt ON rgpt.id = rg.type
       LEFT JOIN release_group_meta rgm ON rgm.id = rg.id
       ORDER BY rgm.first_release_date_year NULLS LAST, rg.name`,
      [artistRow.id],
    );

    const releaseGroups: MbReleaseGroupStub[] = rgRows.map((row) => ({
      id: row.gid,
      title: row.name,
      "primary-type": row.primary_type,
      "secondary-types": Array.isArray(row.secondary_types) ? row.secondary_types.filter(Boolean) : [],
      "first-release-date": formatMbDate(row.y, row.m, row.d),
      disambiguation: row.comment || null,
    }));

    const mbArtist: MbArtist = {
      id: artistRow.gid,
      name: artistRow.name,
      "sort-name": artistRow.sort_name,
      disambiguation: artistRow.comment || null,
      type: artistRow.type_name || null,
      "release-groups": releaseGroups,
    };
    return mapMbArtistToLidarr(mbArtist);
  }

  async getArtistReleaseGroups(artistMbid: string): Promise<MusicBrainzReleaseGroupForMatching[]> {
    const artist = await this.getArtist(artistMbid);
    return releaseGroupsFromArtist(artist);
  }

  // ---- release group (with full tracklist — the N+1 killer) ----

  async getReleaseGroup(releaseGroupMbid: string): Promise<LidarrReleaseGroupDetail> {
    const [header] = await this.query<{
      id: number; gid: string; name: string; primary_type: string | null; comment: string | null;
      artist_gid: string | null; secondary_types: string[] | null;
      y: number | null; m: number | null; d: number | null;
    }>(
      `SELECT rg.id, rg.gid, rg.name, rgpt.name AS primary_type, rg.comment,
          rgm.first_release_date_year AS y, rgm.first_release_date_month AS m, rgm.first_release_date_day AS d,
          (SELECT a.gid FROM artist_credit_name acn JOIN artist a ON a.id = acn.artist
             WHERE acn.artist_credit = rg.artist_credit ORDER BY acn.position LIMIT 1) AS artist_gid,
          (SELECT array_agg(st.name ORDER BY st.name)
             FROM release_group_secondary_type_join j
             JOIN release_group_secondary_type st ON st.id = j.secondary_type
             WHERE j.release_group = rg.id) AS secondary_types
       FROM release_group rg
       LEFT JOIN release_group_primary_type rgpt ON rgpt.id = rg.type
       LEFT JOIN release_group_meta rgm ON rgm.id = rg.id
       WHERE rg.gid = $1`,
      [releaseGroupMbid],
    );
    if (!header) {
      throw new Error(`MB-local: release group ${releaseGroupMbid} not found`);
    }

    const releases = await this.loadReleasesForGroup(header.id);
    const curated = (await this.loadReleaseGroupCuratedFields([header.id])).get(header.id);

    const firstReleaseDate = earlierDate(
      releases
        .map((release) => release.date ?? null)
        .reduce<string | null>((acc, date) => earlierDate(acc, date), null),
      formatMbDate(header.y, header.m, header.d),
    );

    const mbReleaseGroup: MbReleaseGroup = {
      id: header.gid,
      title: header.name,
      "primary-type": header.primary_type,
      "secondary-types": Array.isArray(header.secondary_types) ? header.secondary_types.filter(Boolean) : [],
      "first-release-date": firstReleaseDate,
      disambiguation: header.comment || null,
      "artist-credit": header.artist_gid ? [{ artist: { id: header.artist_gid } }] : [],
      releases,
      genres: curated?.genres ?? [],
      aliases: curated?.aliases ?? [],
      relations: curated?.relations ?? [],
      rating: curated?.rating ?? null,
    };
    return mapMbReleaseGroupToLidarrDetail(mbReleaseGroup);
  }

  /**
   * Bulk variant of getReleaseGroup — full detail for many release groups in a
   * fixed number of set-based queries (one header query + two release/track
   * queries) instead of ~3 per group. This is the "one fetch per artist" path:
   * an 80-RG artist goes from ~240 round-trips to 3.
   */
  async getReleaseGroupDetails(
    releaseGroupMbids: string[],
  ): Promise<Array<{ releaseGroupMbid: string; detail: LidarrReleaseGroupDetail }>> {
    const mbids = Array.from(new Set(releaseGroupMbids.map((m) => String(m || "").trim()).filter(Boolean)));
    if (mbids.length === 0) {
      return [];
    }

    const headers = await this.query<{
      id: number; gid: string; name: string; primary_type: string | null; comment: string | null;
      artist_gid: string | null; secondary_types: string[] | null;
      y: number | null; m: number | null; d: number | null;
    }>(
      `SELECT rg.id, rg.gid, rg.name, rgpt.name AS primary_type, rg.comment,
          rgm.first_release_date_year AS y, rgm.first_release_date_month AS m, rgm.first_release_date_day AS d,
          (SELECT a.gid FROM artist_credit_name acn JOIN artist a ON a.id = acn.artist
             WHERE acn.artist_credit = rg.artist_credit ORDER BY acn.position LIMIT 1) AS artist_gid,
          (SELECT array_agg(st.name ORDER BY st.name)
             FROM release_group_secondary_type_join j
             JOIN release_group_secondary_type st ON st.id = j.secondary_type
             WHERE j.release_group = rg.id) AS secondary_types
       FROM release_group rg
       LEFT JOIN release_group_primary_type rgpt ON rgpt.id = rg.type
       LEFT JOIN release_group_meta rgm ON rgm.id = rg.id
       WHERE rg.gid = ANY($1::uuid[])`,
      [mbids],
    );
    if (headers.length === 0) {
      return [];
    }

    const releasesByRgId = await this.loadReleasesForGroups(headers.map((header) => header.id));
    const curatedByRgId = await this.loadReleaseGroupCuratedFields(headers.map((header) => header.id));

    return headers.map((header) => {
      const releases = releasesByRgId.get(header.id) ?? [];
      const curated = curatedByRgId.get(header.id);
      const firstReleaseDate = earlierDate(
        releases
          .map((release) => release.date ?? null)
          .reduce<string | null>((acc, date) => earlierDate(acc, date), null),
        formatMbDate(header.y, header.m, header.d),
      );
      const mbReleaseGroup: MbReleaseGroup = {
        id: header.gid,
        title: header.name,
        "primary-type": header.primary_type,
        "secondary-types": Array.isArray(header.secondary_types) ? header.secondary_types.filter(Boolean) : [],
        "first-release-date": firstReleaseDate,
        disambiguation: header.comment || null,
        "artist-credit": header.artist_gid ? [{ artist: { id: header.artist_gid } }] : [],
        releases,
        genres: curated?.genres ?? [],
        aliases: curated?.aliases ?? [],
        relations: curated?.relations ?? [],
        rating: curated?.rating ?? null,
      };
      return { releaseGroupMbid: header.gid, detail: mapMbReleaseGroupToLidarrDetail(mbReleaseGroup) };
    });
  }

  /**
   * Load every release in a release group WITH its media, tracks, recordings and
   * ISRCs. Delegates to the bulk loader so single and bulk fetches share one
   * assembly and can never diverge.
   */
  private async loadReleasesForGroup(releaseGroupId: number): Promise<MbRelease[]> {
    return (await this.loadReleasesForGroups([releaseGroupId])).get(releaseGroupId) ?? [];
  }

  /**
   * Bulk variant: all releases (media, tracks, recordings, ISRCs) for MANY
   * release groups in exactly two set-based queries, grouped by release_group id.
   * This is what turns the per-RG N+1 into a fixed number of round-trips per
   * artist.
   */
  private async loadReleasesForGroups(releaseGroupIds: number[]): Promise<Map<number, MbRelease[]>> {
    const result = new Map<number, MbRelease[]>();
    const ids = Array.from(new Set(releaseGroupIds.filter((id) => Number.isFinite(id))));
    if (ids.length === 0) {
      return result;
    }

    const rows = await this.query<{
      rg_id: number;
      edition_id: number; release_gid: string; release_name: string; status: string | null; barcode: string | null; release_comment: string | null;
      medium_pos: number; format: string | null; medium_name: string | null;
      track_gid: string; track_pos: number; track_number: string | null; track_name: string; track_length: number | null;
      recording_gid: string; recording_name: string; recording_length: number | null; video: boolean; isrcs: string | null;
    }>(
      `SELECT
          r.release_group AS rg_id,
          r.id AS edition_id, r.gid AS release_gid, r.name AS release_name, rst.name AS status,
          r.barcode, r.comment AS release_comment,
          m.position AS medium_pos, mf.name AS format, m.name AS medium_name,
          t.gid AS track_gid, t.position AS track_pos, t.number AS track_number, t.name AS track_name, t.length AS track_length,
          rec.gid AS recording_gid, rec.name AS recording_name, rec.length AS recording_length, rec.video,
          (SELECT string_agg(i.isrc::text, ',') FROM isrc i WHERE i.recording = rec.id) AS isrcs
       FROM release r
       LEFT JOIN release_status rst ON rst.id = r.status
       JOIN medium m ON m.release = r.id
       LEFT JOIN medium_format mf ON mf.id = m.format
       JOIN track t ON t.medium = m.id AND t.is_data_track = false
       JOIN recording rec ON rec.id = t.recording
       WHERE r.release_group = ANY($1::int[])
       ORDER BY r.release_group, r.id, m.position, t.position`,
      [ids],
    );

    const dateRows = await this.query<{ release_gid: string; y: number | null; m: number | null; d: number | null; code: string | null }>(
      `SELECT r.gid AS release_gid, rc.date_year AS y, rc.date_month AS m, rc.date_day AS d, iso.code
       FROM release r
       JOIN release_country rc ON rc.release = r.id
       LEFT JOIN iso_3166_1 iso ON iso.area = rc.country
       WHERE r.release_group = ANY($1::int[])
       UNION ALL
       SELECT r.gid AS release_gid, ruc.date_year AS y, ruc.date_month AS m, ruc.date_day AS d, NULL AS code
       FROM release r
       JOIN release_unknown_country ruc ON ruc.release = r.id
       WHERE r.release_group = ANY($1::int[])`,
      [ids],
    );
    const releaseDate = new Map<string, string | null>();
    const releaseCountry = new Map<string, string | null>();
    for (const row of dateRows) {
      const date = formatMbDate(row.y, row.m, row.d);
      releaseDate.set(row.release_gid, earlierDate(releaseDate.get(row.release_gid) ?? null, date));
      if (row.code && !releaseCountry.get(row.release_gid)) {
        releaseCountry.set(row.release_gid, row.code);
      }
    }

    const labelRows = await this.query<{ release_gid: string; label_name: string }>(
      `SELECT r.gid AS release_gid, lab.name AS label_name
       FROM release r
       JOIN release_label rl ON rl.release = r.id
       JOIN label lab ON lab.id = rl.label
       WHERE r.release_group = ANY($1::int[])
       ORDER BY r.gid, rl.id`,
      [ids],
    );
    const labelsByRelease = new Map<string, Array<{ label?: { name?: string } }>>();
    for (const row of labelRows) {
      const list = labelsByRelease.get(row.release_gid) ?? [];
      const name = String(row.label_name || "").trim();
      if (name && !list.some((entry) => entry.label?.name === name)) {
        list.push({ label: { name } });
      }
      labelsByRelease.set(row.release_gid, list);
    }

    const urlRows = await this.query<{ release_gid: string; rel_type: string | null; resource: string }>(
      `SELECT r.gid AS release_gid, lt.name AS rel_type, u.url AS resource
       FROM release r
       JOIN l_release_url lru ON lru.entity0 = r.id
       JOIN link l ON l.id = lru.link
       JOIN link_type lt ON lt.id = l.link_type
       JOIN url u ON u.id = lru.entity1
       WHERE r.release_group = ANY($1::int[])
       ORDER BY r.gid, lru.link_order, lt.name`,
      [ids],
    );
    const relationsByRelease = new Map<string, NonNullable<MbRelease["relations"]>>();
    for (const row of urlRows) {
      const resource = String(row.resource || "").trim();
      if (!resource) continue;
      const list = relationsByRelease.get(row.release_gid) ?? [];
      list.push({ type: row.rel_type ?? undefined, url: { resource } });
      relationsByRelease.set(row.release_gid, list);
    }

    // Assemble: release → media[] → tracks[] (grouped by the ordered rows),
    // bucketed into result by release_group id.
    const releaseMap = new Map<string, MbRelease>();
    const mediaMap = new Map<string, MbMedium>();
    for (const row of rows) {
      let release = releaseMap.get(row.release_gid);
      if (!release) {
        release = {
          id: row.release_gid,
          title: row.release_name,
          status: row.status,
          country: releaseCountry.get(row.release_gid) ?? null,
          barcode: row.barcode,
          date: releaseDate.get(row.release_gid) ?? null,
          disambiguation: row.release_comment || null,
          "label-info": labelsByRelease.get(row.release_gid) ?? [],
          relations: relationsByRelease.get(row.release_gid) ?? [],
          media: [],
        };
        releaseMap.set(row.release_gid, release);
        let list = result.get(row.rg_id);
        if (!list) {
          list = [];
          result.set(row.rg_id, list);
        }
        list.push(release);
      }
      const mediumKey = `${row.release_gid}:${row.medium_pos}`;
      let medium = mediaMap.get(mediumKey);
      if (!medium) {
        medium = { position: row.medium_pos, format: row.format, title: row.medium_name, tracks: [] };
        mediaMap.set(mediumKey, medium);
        release.media!.push(medium);
      }
      const track: MbTrack = {
        id: row.track_gid,
        number: row.track_number ?? String(row.track_pos),
        position: row.track_pos,
        title: row.track_name,
        length: row.track_length,
        recording: {
          id: row.recording_gid,
          title: row.recording_name,
          length: row.recording_length,
          video: row.video,
          isrcs: row.isrcs ? row.isrcs.split(",").filter(Boolean) : [],
        },
      };
      medium.tracks!.push(track);
    }
    return result;
  }

  /**
   * Load curated release-group fields (genres, url-rels, aliases, rating) for
   * many groups in a fixed number of set-based queries.
   */
  private async loadReleaseGroupCuratedFields(releaseGroupIds: number[]): Promise<Map<number, {
    genres: string[];
    aliases: string[];
    relations: NonNullable<MbReleaseGroup["relations"]>;
    rating: MbReleaseGroup["rating"];
  }>> {
    const curated = new Map<number, {
      genres: string[];
      aliases: string[];
      relations: NonNullable<MbReleaseGroup["relations"]>;
      rating: MbReleaseGroup["rating"];
    }>();
    const ids = Array.from(new Set(releaseGroupIds.filter((id) => Number.isFinite(id))));
    if (ids.length === 0) {
      return curated;
    }

    for (const id of ids) {
      curated.set(id, { genres: [], aliases: [], relations: [], rating: null });
    }

    const ratingRows = await this.query<{ id: number; rating: number | null; rating_count: number | null }>(
      `SELECT id, rating, rating_count
       FROM release_group_meta
       WHERE id = ANY($1::int[])`,
      [ids],
    );
    for (const row of ratingRows) {
      const entry = curated.get(row.id);
      if (!entry) continue;
      const voteCount = Number(row.rating_count ?? 0);
      const value = Number(row.rating ?? NaN);
      if (voteCount > 0 && Number.isFinite(value)) {
        entry.rating = { "votes-count": voteCount, value };
      }
    }

    const genreRows = await this.query<{ rg_id: number; genre_name: string }>(
      `SELECT rg.id AS rg_id, g.name AS genre_name
       FROM release_group rg
       JOIN l_genre_release_group lgrg ON lgrg.entity1 = rg.id
       JOIN genre g ON g.id = lgrg.entity0
       WHERE rg.id = ANY($1::int[])
       ORDER BY rg.id, lgrg.link_order, g.name`,
      [ids],
    );
    for (const row of genreRows) {
      const entry = curated.get(row.rg_id);
      const name = String(row.genre_name || "").trim();
      if (!entry || !name || entry.genres.includes(name)) continue;
      entry.genres.push(name);
    }

    const linkRows = await this.query<{ rg_id: number; rel_type: string | null; resource: string }>(
      `SELECT rg.id AS rg_id, lt.name AS rel_type, u.url AS resource
       FROM release_group rg
       JOIN l_release_group_url lrgu ON lrgu.entity0 = rg.id
       JOIN link l ON l.id = lrgu.link
       JOIN link_type lt ON lt.id = l.link_type
       JOIN url u ON u.id = lrgu.entity1
       WHERE rg.id = ANY($1::int[])
       ORDER BY rg.id, lrgu.link_order, lt.name`,
      [ids],
    );
    for (const row of linkRows) {
      const entry = curated.get(row.rg_id);
      const resource = String(row.resource || "").trim();
      if (!entry || !resource) continue;
      entry.relations.push({ type: row.rel_type ?? undefined, url: { resource } });
    }

    const aliasRows = await this.query<{ rg_id: number; alias_name: string }>(
      `SELECT rg.id AS rg_id, a.name AS alias_name
       FROM release_group rg
       JOIN release_group_alias a ON a.release_group = rg.id
       WHERE rg.id = ANY($1::int[])
       ORDER BY rg.id, a.name`,
      [ids],
    );
    for (const row of aliasRows) {
      const entry = curated.get(row.rg_id);
      const name = String(row.alias_name || "").trim();
      if (!entry || !name || entry.aliases.includes(name)) continue;
      entry.aliases.push(name);
    }

    return curated;
  }

  async getReleaseWithTracks(releaseMbid: string): Promise<LidarrRelease | null> {
    const [idRow] = await this.query<{ id: number; release_group: number }>(
      `SELECT id, release_group FROM release WHERE gid = $1`,
      [releaseMbid],
    );
    if (!idRow) return null;
    const releases = await this.loadReleasesForGroup(idRow.release_group);
    const match = releases.find((release) => release.id === releaseMbid);
    return match ? mapMbReleaseToLidarr(match) : null;
  }

  // ---- recording / ISRC / UPC ----

  async getRecording(recordingMbid: string): Promise<CatalogRecording | null> {
    const [row] = await this.query<{ gid: string; name: string; length: number | null; video: boolean; isrcs: string | null; artist_credit: string | null }>(
      `SELECT rec.gid, rec.name, rec.length, rec.video,
          (SELECT string_agg(i.isrc::text, ',') FROM isrc i WHERE i.recording = rec.id) AS isrcs,
          (SELECT string_agg(acn.name || COALESCE(acn.join_phrase, ''), '' ORDER BY acn.position)
             FROM artist_credit_name acn WHERE acn.artist_credit = rec.artist_credit) AS artist_credit
       FROM recording rec WHERE rec.gid = $1`,
      [recordingMbid],
    );
    if (!row) return null;
    const mbRecording: MbRecording = {
      id: row.gid,
      title: row.name,
      length: row.length,
      video: row.video,
      isrcs: row.isrcs ? row.isrcs.split(",").filter(Boolean) : [],
      "artist-credit": row.artist_credit ? [{ name: row.artist_credit }] : [],
    };
    return mapMbRecordingToCatalog(mbRecording);
  }

  async lookupByUPC(upc: string): Promise<CatalogUpcLookupResult> {
    const normalized = String(upc || "").replace(/[^0-9]/g, "");
    if (!normalized) return { upc, releases: [] };
    const rows = await this.query<{ release_gid: string; rg_gid: string | null; title: string | null }>(
      `SELECT r.gid AS release_gid, rg.gid AS rg_gid, r.name AS title
       FROM release r LEFT JOIN release_group rg ON rg.id = r.release_group
       WHERE r.barcode = $1`,
      [normalized],
    );
    return {
      upc: normalized,
      releases: rows.map((row) => ({ releaseMbid: row.release_gid, releaseGroupMbid: row.rg_gid, title: row.title })),
    };
  }

  async lookupByISRC(isrc: string): Promise<CatalogIsrcLookupResult> {
    const normalized = String(isrc || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!normalized) return { isrc, recordings: [] };
    const rows = await this.query<{ gid: string; name: string; length: number | null; video: boolean; artist_credit: string | null }>(
      `SELECT rec.gid, rec.name, rec.length, rec.video,
          (SELECT string_agg(acn.name || COALESCE(acn.join_phrase, ''), '' ORDER BY acn.position)
             FROM artist_credit_name acn WHERE acn.artist_credit = rec.artist_credit) AS artist_credit
       FROM isrc i JOIN recording rec ON rec.id = i.recording
       WHERE i.isrc = $1`,
      [normalized],
    );
    const recordings = rows.map((row) => mapMbRecordingToCatalog({
      id: row.gid,
      title: row.name,
      length: row.length,
      video: row.video,
      isrcs: [normalized],
      "artist-credit": row.artist_credit ? [{ name: row.artist_credit }] : [],
    }));
    return { isrc: normalized, recordings };
  }

  async getCreditedReleaseGroupsForArtist(artistMbid: string): Promise<CatalogArtistCreditReleaseGroup[]> {
    const rows = await this.query<{
      release_group_id: number;
      release_group_gid: string;
      title: string;
      primary_type: string | null;
      secondary_types: string[] | null;
      y: number | null;
      m: number | null;
      d: number | null;
      disambiguation: string | null;
      credit_artist_gid: string;
      credit_name: string;
      join_phrase: string | null;
      credit_position: number;
    }>(
      `SELECT
          rg.id AS release_group_id,
          rg.gid AS release_group_gid,
          rg.name AS title,
          rgpt.name AS primary_type,
          (
            SELECT array_agg(st.name ORDER BY st.name)
            FROM release_group_secondary_type_join j
            JOIN release_group_secondary_type st ON st.id = j.secondary_type
            WHERE j.release_group = rg.id
          ) AS secondary_types,
          rgm.first_release_date_year AS y,
          rgm.first_release_date_month AS m,
          rgm.first_release_date_day AS d,
          rg.comment AS disambiguation,
          credit_artist.gid AS credit_artist_gid,
          acn.name AS credit_name,
          acn.join_phrase,
          acn.position AS credit_position
       FROM release_group rg
       JOIN artist_credit_name filter_acn ON filter_acn.artist_credit = rg.artist_credit
       JOIN artist filter_artist ON filter_artist.id = filter_acn.artist
       JOIN artist_credit_name acn ON acn.artist_credit = rg.artist_credit
       JOIN artist credit_artist ON credit_artist.id = acn.artist
       LEFT JOIN release_group_primary_type rgpt ON rgpt.id = rg.type
       LEFT JOIN release_group_meta rgm ON rgm.id = rg.id
       WHERE filter_artist.gid = $1
       ORDER BY rgm.first_release_date_year NULLS LAST, rg.name, rg.id, acn.position`,
      [artistMbid],
    );

    const groups = new Map<number, CatalogArtistCreditReleaseGroup>();
    for (const row of rows) {
      let group = groups.get(row.release_group_id);
      if (!group) {
        group = {
          id: row.release_group_gid,
          title: row.title,
          primaryType: row.primary_type,
          secondaryTypes: Array.isArray(row.secondary_types) ? row.secondary_types.filter(Boolean) : [],
          firstReleaseDate: formatMbDate(row.y, row.m, row.d),
          disambiguation: row.disambiguation || null,
          artistCredits: [],
        };
        groups.set(row.release_group_id, group);
      }
      group.artistCredits.push({
        artistId: row.credit_artist_gid,
        name: row.credit_name,
        joinPhrase: row.join_phrase || "",
      });
    }

    return Array.from(groups.values());
  }

  // ---- video recordings (MB-owned enrichment for Discogenius-owned videos) ----

  async getArtistVideoRecordings(artistMbid: string): Promise<CatalogVideoRecording[]> {
    const [artistRow] = await this.query<{ id: number }>(
      `SELECT id FROM artist WHERE gid = $1`,
      [artistMbid],
    );
    if (!artistRow) return [];

    // Only recordings flagged video=true (cheap vs browsing every recording).
    const videos = await this.query<{ id: number; gid: string; name: string; length: number | null; artist_credit: number; isrcs: string | null }>(
      `SELECT rec.id, rec.gid, rec.name, rec.length, rec.artist_credit,
          (SELECT string_agg(i.isrc::text, ',') FROM isrc i WHERE i.recording = rec.id) AS isrcs
       FROM recording rec
       JOIN artist_credit_name acn ON acn.artist_credit = rec.artist_credit AND acn.artist = $1
       WHERE rec.video = true`,
      [artistRow.id],
    );
    if (videos.length === 0) return [];

    // Music-video relations → the underlying audio recording (link type ce3de655).
    const relations = await this.query<{ video_id: number; audio_gid: string; audio_name: string; audio_length: number | null; audio_credit: number }>(
      `SELECT v.id AS video_id, aud.gid AS audio_gid, aud.name AS audio_name, aud.length AS audio_length, aud.artist_credit AS audio_credit
       FROM recording v
       JOIN artist_credit_name acn ON acn.artist_credit = v.artist_credit AND acn.artist = $1
       JOIN l_recording_recording lrr ON (lrr.entity0 = v.id OR lrr.entity1 = v.id)
       JOIN link l ON l.id = lrr.link
       JOIN link_type lt ON lt.id = l.link_type AND lt.gid = 'ce3de655-7451-44d1-9224-87eb948c205d'
       JOIN recording aud ON aud.id = (CASE WHEN lrr.entity0 = v.id THEN lrr.entity1 ELSE lrr.entity0 END)
       WHERE v.video = true`,
      [artistRow.id],
    );

    // Free-streaming / streaming URL relations (YouTube watch links, etc.).
    const urlRelations = await this.query<{ video_id: number; link_type: string; url: string }>(
      `SELECT v.id AS video_id, lt.name AS link_type, u.url
       FROM recording v
       JOIN artist_credit_name acn ON acn.artist_credit = v.artist_credit AND acn.artist = $1
       JOIN l_recording_url lru ON lru.entity0 = v.id
       JOIN link l ON l.id = lru.link
       JOIN link_type lt ON lt.id = l.link_type AND lt.name IN ('free streaming', 'streaming')
       JOIN url u ON u.id = lru.entity1
       WHERE v.video = true`,
      [artistRow.id],
    );

    // Resolve artist-credit lists for every involved artist_credit id in one pass.
    const creditIds = new Set<number>();
    videos.forEach((row) => creditIds.add(row.artist_credit));
    relations.forEach((row) => creditIds.add(row.audio_credit));
    const creditRows = creditIds.size > 0
      ? await this.query<{ artist_credit: number; artist_gid: string; name: string; join_phrase: string | null }>(
        `SELECT acn.artist_credit, a.gid AS artist_gid, acn.name, acn.join_phrase
         FROM artist_credit_name acn JOIN artist a ON a.id = acn.artist
         WHERE acn.artist_credit = ANY($1)
         ORDER BY acn.artist_credit, acn.position`,
        [Array.from(creditIds)],
      )
      : [];
    const creditsByAc = new Map<number, CatalogVideoRecording["artist-credit"]>();
    for (const row of creditRows) {
      const list = creditsByAc.get(row.artist_credit) ?? [];
      list.push({ name: row.name, joinphrase: row.join_phrase ?? "", artist: { id: row.artist_gid, name: row.name } });
      creditsByAc.set(row.artist_credit, list);
    }

    const relationsByVideo = new Map<number, NonNullable<CatalogVideoRecording["relations"]>>();
    for (const row of relations) {
      const list = relationsByVideo.get(row.video_id) ?? [];
      list.push({
        type: "music video",
        recording: {
          id: row.audio_gid,
          title: row.audio_name,
          length: row.audio_length,
          video: false,
          "artist-credit": creditsByAc.get(row.audio_credit) ?? [],
        },
      });
      relationsByVideo.set(row.video_id, list);
    }
    for (const row of urlRelations) {
      const list = relationsByVideo.get(row.video_id) ?? [];
      list.push({
        type: row.link_type,
        url: { resource: row.url },
      });
      relationsByVideo.set(row.video_id, list);
    }

    return videos.map((row) => ({
      id: row.gid,
      title: row.name,
      length: row.length,
      video: true,
      isrcs: row.isrcs ? row.isrcs.split(",").filter(Boolean) : [],
      "artist-credit": creditsByAc.get(row.artist_credit) ?? [],
      relations: relationsByVideo.get(row.id) ?? [],
    }));
  }

  // ---- search (Solr when available, else Postgres name match) ----

  async search(query: string, options: CatalogSearchOptions = {}): Promise<CatalogSearchResults> {
    const trimmed = String(query || "").trim();
    if (!trimmed) return { artists: [] };
    const limit = options.limit ?? 20;

    let artists: CatalogSearchResults["artists"];
    if (this.searchWebUrl) {
      try {
        artists = (await this.searchViaSolr(trimmed, limit)).artists;
      } catch {
        artists = (await this.searchViaPostgres(trimmed, limit)).artists;
      }
    } else {
      artists = (await this.searchViaPostgres(trimmed, limit)).artists;
    }
    const releaseGroups = await this.searchReleaseGroupsViaPostgres(trimmed, limit);
    return { artists, releaseGroups };
  }

  private async searchViaSolr(query: string, limit: number): Promise<CatalogSearchResults> {
    const url = `${this.searchWebUrl}/artist?query=${encodeURIComponent(query)}&limit=${limit}&fmt=json`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": getDiscogeniusUserAgent("MB-local search") },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`MB search ${res.status}`);
    const data = (await res.json()) as { artists?: Array<{ id?: string; name?: string; "sort-name"?: string; disambiguation?: string | null; type?: string | null }> };
    const artistIds = (data.artists || [])
      .filter((artist) => artist.id && artist.name)
      .map((artist) => String(artist.id))
      .slice(0, limit);
    const artists = await Promise.all(
      artistIds.map(async (artistId) => {
        try {
          return await this.getArtist(artistId);
        } catch {
          const fallback = data.artists?.find((artist) => artist.id === artistId);
          return mapMbArtistToLidarr({
            id: artistId,
            name: fallback?.name ?? artistId,
            "sort-name": fallback?.["sort-name"] ?? fallback?.name ?? artistId,
            disambiguation: fallback?.disambiguation ?? null,
            type: fallback?.type ?? null,
            "release-groups": [],
          });
        }
      }),
    );
    return { artists };
  }

  private async searchViaPostgres(query: string, limit: number): Promise<CatalogSearchResults> {
    const useTrgm = await this.hasPgTrgm();
    // pg_trgm gives fuzzy ranking; without it, ILIKE prefix/substring ordering.
    const rows = useTrgm
      ? await this.query<{ gid: string; name: string; sort_name: string; comment: string | null; type_name: string | null }>(
          `SELECT a.gid, a.name, a.sort_name, a.comment, at.name AS type_name
           FROM artist a LEFT JOIN artist_type at ON at.id = a.type
           WHERE a.name % $1 OR a.name ILIKE $2
           ORDER BY similarity(a.name, $1) DESC
           LIMIT $3`,
          [query, `%${query}%`, limit],
        )
      : await this.query<{ gid: string; name: string; sort_name: string; comment: string | null; type_name: string | null }>(
          `SELECT a.gid, a.name, a.sort_name, a.comment, at.name AS type_name
           FROM artist a LEFT JOIN artist_type at ON at.id = a.type
           WHERE a.name ILIKE $1
           ORDER BY (lower(a.name) = lower($2)) DESC, (a.name ILIKE $3) DESC, length(a.name)
           LIMIT $4`,
          [`%${query}%`, query, `${query}%`, limit],
        );
    const artists = rows.map((row) => mapMbArtistToLidarr({
      id: row.gid,
      name: row.name,
      "sort-name": row.sort_name,
      disambiguation: row.comment || null,
      type: row.type_name || null,
      "release-groups": [],
    }));
    return { artists };
  }

  private async searchReleaseGroupsViaPostgres(
    query: string,
    limit: number,
  ): Promise<CatalogReleaseGroupSearchResult[]> {
    const useTrgm = await this.hasPgTrgm();
    const rows = useTrgm
      ? await this.query<{
          gid: string; name: string; comment: string | null;
          y: number | null; m: number | null; d: number | null;
          artist_gid: string | null; artist_name: string | null;
        }>(
          `SELECT rg.gid, rg.name, rg.comment,
              rgm.first_release_date_year AS y, rgm.first_release_date_month AS m, rgm.first_release_date_day AS d,
              a.gid AS artist_gid, acn.name AS artist_name
           FROM release_group rg
           LEFT JOIN release_group_meta rgm ON rgm.id = rg.id
           LEFT JOIN artist_credit_name acn ON acn.artist_credit = rg.artist_credit AND acn.position = 0
           LEFT JOIN artist a ON a.id = acn.artist
           WHERE rg.name % $1 OR rg.name ILIKE $2 OR (acn.name || ' ' || rg.name) ILIKE $2
           ORDER BY GREATEST(similarity(rg.name, $1), similarity(acn.name || ' ' || rg.name, $1)) DESC,
             rgm.first_release_date_year DESC NULLS LAST
           LIMIT $3`,
          [query, `%${query}%`, limit],
        )
      : await this.query<{
          gid: string; name: string; comment: string | null;
          y: number | null; m: number | null; d: number | null;
          artist_gid: string | null; artist_name: string | null;
        }>(
          `SELECT rg.gid, rg.name, rg.comment,
              rgm.first_release_date_year AS y, rgm.first_release_date_month AS m, rgm.first_release_date_day AS d,
              a.gid AS artist_gid, acn.name AS artist_name
           FROM release_group rg
           LEFT JOIN release_group_meta rgm ON rgm.id = rg.id
           LEFT JOIN artist_credit_name acn ON acn.artist_credit = rg.artist_credit AND acn.position = 0
           LEFT JOIN artist a ON a.id = acn.artist
           WHERE rg.name ILIKE $1 OR (acn.name || ' ' || rg.name) ILIKE $1
           ORDER BY (lower(rg.name) = lower($2)) DESC, (lower(acn.name || ' ' || rg.name) = lower($2)) DESC,
             (rg.name ILIKE $3) DESC,
             rgm.first_release_date_year DESC NULLS LAST, length(rg.name)
           LIMIT $4`,
          [`%${query}%`, query, `${query}%`, limit],
        );

    return rows.map((row) => ({
      mbid: row.gid,
      title: row.name,
      artistName: row.artist_name,
      artistMbid: row.artist_gid,
      releaseDate: formatMbDate(row.y, row.m, row.d),
      disambiguation: row.comment || null,
      images: [],
    }));
  }

  private async hasPgTrgm(): Promise<boolean> {
    if (this.pgTrgmChecked) return this.pgTrgmAvailable;
    try {
      const rows = await this.query<{ extname: string }>(`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`);
      this.pgTrgmAvailable = rows.length > 0;
    } catch {
      this.pgTrgmAvailable = false;
    }
    this.pgTrgmChecked = true;
    return this.pgTrgmAvailable;
  }
}

export function createPostgresMusicBrainzCatalogProvider(
  options: PostgresMusicBrainzCatalogProviderOptions,
): PostgresMusicBrainzCatalogProvider {
  return new PostgresMusicBrainzCatalogProvider(options);
}
