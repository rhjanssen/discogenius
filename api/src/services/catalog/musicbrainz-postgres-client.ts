/**
 * Read-only Postgres client scaffold for the direct MB-docker DB path.
 *
 * ⚠️ NOT WIRED INTO RUNTIME and NOT a hard dependency. This file does NOT import
 * `pg`; instead it defines the *structural* `PgPool` interface that
 * node-postgres' `Pool` satisfies. To use it, a future unit would:
 *
 *   1. add `pg` (and `@types/pg`) to `api/package.json`,
 *   2. `import { Pool } from "pg"` at the wiring site,
 *   3. pass `new Pool({ ... })` into `MusicBrainzPostgresCatalogReader`.
 *
 * Keeping `pg` out of the import graph here means this scaffold adds zero
 * runtime weight and zero install cost until MB-local Postgres mode is actually
 * turned on (the cheaper `:5000` mirror path ships first — see
 * `local-musicbrainz-catalog-provider.ts`).
 *
 * The reader maps MB Postgres rows → the same SkyHook/Lidarr DTOs as the mirror
 * path, reusing the split-date / artist-credit JSON the SQL builders already
 * produce. See `musicbrainz-postgres-queries.ts` and `docs/MB_LOCAL_MODE.md`.
 */
import type {
  LidarrArtist,
  LidarrReleaseGroupDetail,
} from "./catalog-provider.js";
import {
  artistByGidQuery,
  artistReleaseGroupsQuery,
  releaseGroupByGidQuery,
  type PgQuery,
} from "./musicbrainz-postgres-queries.js";

/** Structural subset of node-postgres' `Pool` we depend on (so no `pg` import). */
export interface PgQueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount?: number | null;
}

export interface PgPool {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgQueryResult<R>>;
  end?(): Promise<void>;
}

type ArtistCreditJson = Array<{
  gid: string;
  name: string;
  join_phrase: string;
  position: number;
}>;

function flattenCreditJson(credit: ArtistCreditJson | null | undefined): string | null {
  if (!Array.isArray(credit) || credit.length === 0) {
    return null;
  }
  const text = credit
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((part) => `${part.name}${part.join_phrase ?? ""}`)
    .join("")
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * Direct-Postgres catalog reader. Read-only — issues only SELECTs built by
 * `musicbrainz-postgres-queries.ts`. NOT instantiated anywhere live.
 */
export class MusicBrainzPostgresCatalogReader {
  constructor(private readonly pool: PgPool) {}

  private async run<R = Record<string, unknown>>(query: PgQuery): Promise<R[]> {
    const result = await this.pool.query<R>(query.text, query.values);
    return result.rows;
  }

  async getArtist(artistGid: string): Promise<LidarrArtist | null> {
    const [artistRow] = await this.run<{
      gid: string;
      name: string;
      sort_name: string;
      disambiguation: string | null;
      type: string | null;
    }>(artistByGidQuery(artistGid));
    if (!artistRow) {
      return null;
    }

    const rgRows = await this.run<{
      gid: string;
      title: string;
      primary_type: string | null;
      disambiguation: string | null;
      first_release_date: string | null;
    }>(artistReleaseGroupsQuery(artistGid));

    return {
      id: artistRow.gid,
      artistname: artistRow.name,
      sortname: artistRow.sort_name ?? artistRow.name,
      disambiguation: artistRow.disambiguation ?? undefined,
      type: artistRow.type ?? undefined,
      images: [],
      Albums: rgRows.map((rg) => ({
        Id: rg.gid,
        Title: rg.title,
        Type: rg.primary_type ?? undefined,
        SecondaryTypes: [],
        ReleaseDate: rg.first_release_date ?? undefined,
        Disambiguation: rg.disambiguation ?? undefined,
      })),
    };
  }

  async getReleaseGroup(releaseGroupGid: string): Promise<LidarrReleaseGroupDetail | null> {
    const [row] = await this.run<{
      gid: string;
      title: string;
      primary_type: string | null;
      disambiguation: string | null;
      first_release_date: string | null;
      artist_credit: ArtistCreditJson | null;
    }>(releaseGroupByGidQuery(releaseGroupGid));
    if (!row) {
      return null;
    }
    const primaryArtistGid = Array.isArray(row.artist_credit) ? row.artist_credit[0]?.gid : undefined;
    void flattenCreditJson(row.artist_credit); // available for callers needing the display string
    return {
      id: row.gid,
      artistid: primaryArtistGid,
      title: row.title,
      type: row.primary_type ?? undefined,
      secondarytypes: [],
      releasedate: row.first_release_date ?? undefined,
      disambiguation: row.disambiguation ?? undefined,
      // Release / track hydration would join releasesForReleaseGroupQuery +
      // tracksForReleaseQuery; left to the MB-local wiring unit.
      Releases: [],
    };
  }
}
