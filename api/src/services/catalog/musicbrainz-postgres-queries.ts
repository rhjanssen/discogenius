/**
 * Direct-Postgres catalog path — the **performance follow-up** to the `:5000`
 * mirror (see `docs/DATA_MODEL_TARGET.md` §3 and `docs/MB_LOCAL_MODE.md`).
 *
 * The MB-docker Postgres schema (`:5432`) is heavily normalized and quite
 * different from Discogenius's SQLite shape:
 *  - MBIDs are UUID `gid` columns (not the integer PK `id`).
 *  - Artist credits are a join table: `artist_credit` → `artist_credit_name`
 *    (ordered `position`, with `join_phrase`) → `artist`.
 *  - Dates are split into `*_year` / `*_month` / `*_day` integer columns
 *    (e.g. `release_group_meta.first_release_date_year`), reconstructed to an
 *    ISO `YYYY-MM-DD` string by the adapter.
 *  - Track length is milliseconds (`track.length`); recording length too.
 *
 * This module is **pure SQL string building** — it performs NO I/O and adds NO
 * runtime dependency. A `pg` client is intentionally NOT imported here; the
 * optional scaffold in `musicbrainz-postgres-client.ts` is what would wire these
 * queries to a live connection, behind the un-wired MB-local stub.
 *
 * Each builder returns `{ text, values }` (node-postgres parameterized form).
 * The `$1` placeholder is always the entity `gid`.
 *
 * NOTE (U3 scaffolding): not used at runtime. Covered by a string-builder unit
 * test that asserts the queries are syntactically well-formed.
 */

export interface PgQuery {
  text: string;
  values: unknown[];
}

/**
 * Reconstruct an ISO date from MB's split year/month/day columns.
 * Mirrors how the adapter would post-process rows; expressed here as a SQL
 * fragment so callers can `SELECT` a ready-made `*_date` text column.
 *
 * MB stores partial dates (year only, year+month). We emit:
 *   - `YYYY-MM-DD` when all three present
 *   - `YYYY-MM`    when day is null
 *   - `YYYY`       when month+day null
 *   - NULL         when year is null
 */
export function splitDateSql(prefix: string, alias: string): string {
  const y = `${prefix}_year`;
  const m = `${prefix}_month`;
  const d = `${prefix}_day`;
  return `
    CASE
      WHEN ${y} IS NULL THEN NULL
      WHEN ${m} IS NULL THEN to_char(make_date(${y}, 1, 1), 'YYYY')
      WHEN ${d} IS NULL THEN to_char(make_date(${y}, ${m}, 1), 'YYYY-MM')
      ELSE to_char(make_date(${y}, ${m}, ${d}), 'YYYY-MM-DD')
    END AS ${alias}`.trim();
}

/**
 * Aggregate an `artist_credit` (by its integer id) into a flattened display
 * string and a JSON array of `{ gid, name, join_phrase, position }`. Used as a
 * correlated subquery so any entity row can carry its credit inline.
 */
export function artistCreditJsonSql(creditIdColumn: string): string {
  return `(
    SELECT json_agg(json_build_object(
      'gid', a.gid,
      'name', acn.name,
      'join_phrase', acn.join_phrase,
      'position', acn.position
    ) ORDER BY acn.position)
    FROM artist_credit_name acn
    JOIN artist a ON a.id = acn.artist
    WHERE acn.artist_credit = ${creditIdColumn}
  )`;
}

/** Artist by gid, with type. */
export function artistByGidQuery(gid: string): PgQuery {
  return {
    text: `
      SELECT
        ar.gid,
        ar.name,
        ar.sort_name,
        ar.comment AS disambiguation,
        at.name AS type
      FROM artist ar
      LEFT JOIN artist_type at ON at.id = ar.type
      WHERE ar.gid = $1`,
    values: [gid],
  };
}

/** Release groups for an artist gid, with primary type and reconstructed first-release date. */
export function artistReleaseGroupsQuery(artistGid: string): PgQuery {
  return {
    text: `
      SELECT
        rg.gid,
        rg.name AS title,
        rgpt.name AS primary_type,
        rg.comment AS disambiguation,
        ${splitDateSql("rgm.first_release_date", "first_release_date")},
        ${artistCreditJsonSql("rg.artist_credit")} AS artist_credit
      FROM release_group rg
      JOIN artist_credit_name acn ON acn.artist_credit = rg.artist_credit
      JOIN artist a ON a.id = acn.artist
      LEFT JOIN release_group_primary_type rgpt ON rgpt.id = rg.type
      LEFT JOIN release_group_meta rgm ON rgm.id = rg.id
      WHERE a.gid = $1
      GROUP BY rg.id, rgpt.name, rgm.first_release_date_year,
               rgm.first_release_date_month, rgm.first_release_date_day`,
    values: [artistGid],
  };
}

/** A single release group by gid. */
export function releaseGroupByGidQuery(gid: string): PgQuery {
  return {
    text: `
      SELECT
        rg.gid,
        rg.name AS title,
        rgpt.name AS primary_type,
        rg.comment AS disambiguation,
        ${splitDateSql("rgm.first_release_date", "first_release_date")},
        ${artistCreditJsonSql("rg.artist_credit")} AS artist_credit
      FROM release_group rg
      LEFT JOIN release_group_primary_type rgpt ON rgpt.id = rg.type
      LEFT JOIN release_group_meta rgm ON rgm.id = rg.id
      WHERE rg.gid = $1`,
    values: [gid],
  };
}

/** Releases belonging to a release group gid, with barcode and reconstructed date. */
export function releasesForReleaseGroupQuery(releaseGroupGid: string): PgQuery {
  return {
    text: `
      SELECT
        r.gid,
        r.name AS title,
        r.barcode,
        r.comment AS disambiguation,
        rs.name AS status,
        ${splitDateSql("rc.date", "date")}
      FROM release r
      JOIN release_group rg ON rg.id = r.release_group
      LEFT JOIN release_status rs ON rs.id = r.status
      LEFT JOIN release_country rc ON rc.release = r.id
      WHERE rg.gid = $1`,
    values: [releaseGroupGid],
  };
}

/**
 * Full track list for a release gid: medium → track → recording, with ISRCs.
 * Joins `medium`/`track`/`recording`, aggregates ISRCs per recording, and orders
 * by medium then track position.
 */
export function tracksForReleaseQuery(releaseGid: string): PgQuery {
  return {
    text: `
      SELECT
        m.position        AS medium_position,
        m.name            AS medium_title,
        mf.name           AS medium_format,
        t.gid             AS track_gid,
        t.position        AS track_position,
        t.number          AS track_number,
        t.name            AS track_name,
        t.length          AS track_length_ms,
        rec.gid           AS recording_gid,
        rec.name          AS recording_name,
        rec.length        AS recording_length_ms,
        rec.video         AS recording_video,
        (
          SELECT array_agg(i.isrc ORDER BY i.isrc)
          FROM isrc i
          WHERE i.recording = rec.id
        ) AS isrcs
      FROM release r
      JOIN medium m ON m.release = r.id
      LEFT JOIN medium_format mf ON mf.id = m.format
      JOIN track t ON t.medium = m.id
      JOIN recording rec ON rec.id = t.recording
      WHERE r.gid = $1
      ORDER BY m.position, t.position`,
    values: [releaseGid],
  };
}

/** A single recording by gid, with flattened artist credit and ISRCs. */
export function recordingByGidQuery(gid: string): PgQuery {
  return {
    text: `
      SELECT
        rec.gid,
        rec.name AS title,
        rec.length AS length_ms,
        rec.video,
        ${artistCreditJsonSql("rec.artist_credit")} AS artist_credit,
        (
          SELECT array_agg(i.isrc ORDER BY i.isrc)
          FROM isrc i
          WHERE i.recording = rec.id
        ) AS isrcs
      FROM recording rec
      WHERE rec.gid = $1`,
    values: [gid],
  };
}

/** Releases carrying a given barcode/UPC. */
export function releasesByBarcodeQuery(barcode: string): PgQuery {
  return {
    text: `
      SELECT
        r.gid AS release_gid,
        r.name AS title,
        rg.gid AS release_group_gid
      FROM release r
      LEFT JOIN release_group rg ON rg.id = r.release_group
      WHERE r.barcode = $1`,
    values: [barcode],
  };
}

/** Recordings carrying a given ISRC. */
export function recordingsByIsrcQuery(isrc: string): PgQuery {
  return {
    text: `
      SELECT
        rec.gid,
        rec.name AS title,
        rec.length AS length_ms,
        rec.video,
        ${artistCreditJsonSql("rec.artist_credit")} AS artist_credit
      FROM isrc i
      JOIN recording rec ON rec.id = i.recording
      WHERE i.isrc = $1`,
    values: [isrc],
  };
}
