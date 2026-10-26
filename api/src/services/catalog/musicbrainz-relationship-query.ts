import {
  creditsFromRelationRows,
  type CreditScope,
  type MbArtistRelationRow,
  type RecordingWorkLink,
  type RelationshipBundle,
  type RelationshipCredit,
} from "./relationship-credit-model.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH = 200;

export type MbQuery = <T>(sql: string, values: unknown[]) => Promise<T[]>;

function uuids(ids: string[]): string[] {
  return [...new Set(ids.map((id) => String(id || "").trim().toLowerCase()).filter((id) => UUID.test(id)))];
}

function chunks(ids: string[]): string[][] {
  const out: string[][] = [];
  for (let index = 0; index < ids.length; index += BATCH) out.push(ids.slice(index, index + BATCH));
  return out;
}

const ARTIST_RELATION_SQL = `
  SELECT entity.gid::text AS entity_mbid,
         rel.link AS link_id,
         rel.link_order AS link_order,
         lt.name AS link_type,
         artist.gid::text AS artist_mbid,
         COALESCE(NULLIF(btrim(rel.entity0_credit), ''), artist.name) AS credited_name,
         artist.sort_name AS sort_name,
         lat.name AS attribute_name,
         lac.credited_as AS attribute_credit
  FROM ENTITY_TABLE entity
  JOIN LINK_TABLE rel ON rel.entity1 = entity.id
  JOIN link l ON l.id = rel.link
  JOIN link_type lt ON lt.id = l.link_type
  JOIN artist ON artist.id = rel.entity0
  LEFT JOIN link_attribute la ON la.link = l.id
  LEFT JOIN link_attribute_type lat ON lat.id = la.attribute_type
  LEFT JOIN link_attribute_credit lac
    ON lac.link = l.id AND lac.attribute_type = la.attribute_type
  WHERE entity.gid = ANY($1::uuid[])
  ORDER BY entity.gid, rel.link_order, rel.link, lat.child_order, lat.id
`;

function relationSql(entityTable: "recording" | "work" | "release", linkTable: string): string {
  return ARTIST_RELATION_SQL
    .replace("ENTITY_TABLE", entityTable)
    .replace("LINK_TABLE", linkTable);
}

const WORK_LINK_SQL = `
  SELECT recording.gid::text AS recording_mbid,
         work.gid::text AS work_mbid,
         work.name AS work_title,
         lrw.link_order AS link_order,
         EXISTS (
           SELECT 1
           FROM link_attribute la
           JOIN link_attribute_type lat ON lat.id = la.attribute_type
           WHERE la.link = lrw.link AND lat.name = 'instrumental'
         ) AS instrumental
  FROM recording
  JOIN l_recording_work lrw ON lrw.entity0 = recording.id
  JOIN link l ON l.id = lrw.link
  JOIN link_type lt ON lt.id = l.link_type
  JOIN work ON work.id = lrw.entity1
  WHERE recording.gid = ANY($1::uuid[])
    AND lt.name = 'performance'
  ORDER BY recording.gid, lrw.link_order, work.gid
`;

async function loadRelations(
  query: MbQuery,
  scope: CreditScope,
  sql: string,
  ids: string[],
): Promise<RelationshipCredit[]> {
  const credits: RelationshipCredit[] = [];
  for (const batch of chunks(ids)) {
    const rows = await query<MbArtistRelationRow>(sql, [batch]);
    credits.push(...creditsFromRelationRows(scope, rows));
  }
  return credits;
}

/**
 * One mirror read of the relationship tables Picard uses. Callers pass id
 * lists as `uuid[]` batches, never as spread parameters. An empty input is
 * still a supplied bundle: the catalogue replace clears those rows.
 */
export async function fetchRelationshipBundle(
  query: MbQuery,
  recordingMbids: string[],
  releaseMbids: string[],
): Promise<RelationshipBundle> {
  const recordings = uuids(recordingMbids);
  const releases = uuids(releaseMbids);
  const recordingCredits = await loadRelations(
    query, "recording", relationSql("recording", "l_artist_recording"), recordings,
  );
  const releaseCredits = await loadRelations(
    query, "release", relationSql("release", "l_artist_release"), releases,
  );
  const works: RecordingWorkLink[] = [];
  for (const batch of chunks(recordings)) {
    const rows = await query<{
      recording_mbid: string;
      work_mbid: string;
      work_title: string;
      link_order: number;
      instrumental: boolean | number | string;
    }>(WORK_LINK_SQL, [batch]);
    for (const row of rows) {
      works.push({
        recordingMbid: row.recording_mbid.trim().toLowerCase(),
        workMbid: row.work_mbid.trim().toLowerCase(),
        title: row.work_title,
        order: row.link_order,
        instrumental: row.instrumental === true || row.instrumental === 1 || row.instrumental === "t",
      });
    }
  }
  const workIds = uuids(works.map((work) => work.workMbid));
  const workCredits = await loadRelations(
    query, "work", relationSql("work", "l_artist_work"), workIds,
  );
  return {
    queriedRecordingMbids: recordings,
    queriedReleaseMbids: releases,
    credits: [...releaseCredits, ...recordingCredits, ...workCredits],
    works,
  };
}
