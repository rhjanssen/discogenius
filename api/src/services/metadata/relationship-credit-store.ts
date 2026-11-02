import type Database from "better-sqlite3";
import type {
  RecordingWorkLink,
  RelationshipBundle,
  RelationshipCredit,
} from "../catalog/relationship-credit-model.js";
import { SQL_JSON_LIST, jsonList } from "../../utils/sql-id-list.js";

const BATCH = 200;

function chunks(ids: string[]): string[][] {
  const out: string[][] = [];
  for (let index = 0; index < ids.length; index += BATCH) out.push(ids.slice(index, index + BATCH));
  return out;
}

export type CreditSnapshot = {
  known: Set<string>;
  credits: RelationshipCredit[];
  works: RecordingWorkLink[];
};

/** Credits for retag. Null when this database has no relationship-credit tables yet. */
export function loadCreditSnapshot(
  db: Database.Database,
  recordingMbids: Array<string | null | undefined>,
  releaseMbids: Array<string | null | undefined>,
): CreditSnapshot | null {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'CatalogRelationshipCredits'").get();
  const column = db.prepare("SELECT 1 FROM pragma_table_info('Recordings') WHERE name = 'relationship_credits_at'").get();
  if (!table || !column) return null;
  const recordings = [...new Set(recordingMbids.map((id) => String(id || "").trim()).filter(Boolean))];
  const releases = [...new Set(releaseMbids.map((id) => String(id || "").trim()).filter(Boolean))];
  if (recordings.length === 0) return { known: new Set(), credits: [], works: [] };
  const knownRows = db.prepare(`
    SELECT mbid FROM Recordings
    WHERE relationship_credits_at IS NOT NULL
      AND mbid COLLATE NOCASE IN ${SQL_JSON_LIST}
  `).all(jsonList(recordings)) as Array<{ mbid: string }>;
  const credits = db.prepare(`
    SELECT scope, entity_mbid, role, attribute, artist_mbid, credited_name, sort_name, credit_order, medium_position
    FROM (
      SELECT c.scope AS scope, rec.mbid AS entity_mbid, c.role, c.attribute, c.artist_mbid,
             c.credited_name, c.sort_name, c.credit_order, c.medium_position
      FROM CatalogRelationshipCredits c
      JOIN Recordings rec ON rec.id = c.recording_id
      WHERE c.scope = 'recording' AND rec.mbid COLLATE NOCASE IN ${SQL_JSON_LIST}
      UNION ALL
      SELECT c.scope, ed.mbid, c.role, c.attribute, c.artist_mbid,
             c.credited_name, c.sort_name, c.credit_order, c.medium_position
      FROM CatalogRelationshipCredits c
      JOIN AlbumEditions ed ON ed.id = c.edition_id
      WHERE c.scope = 'release' AND ed.mbid COLLATE NOCASE IN ${SQL_JSON_LIST}
      UNION ALL
      SELECT c.scope, c.work_mbid, c.role, c.attribute, c.artist_mbid,
             c.credited_name, c.sort_name, c.credit_order, c.medium_position
      FROM CatalogRelationshipCredits c
      WHERE c.scope = 'work' AND c.work_mbid IN (
        SELECT w.work_mbid FROM RecordingWorks w
        JOIN Recordings rec ON rec.id = w.recording_id
        WHERE rec.mbid COLLATE NOCASE IN ${SQL_JSON_LIST}
      )
    )
  `).all(jsonList(recordings), jsonList(releases), jsonList(recordings)) as Array<{
    scope: RelationshipCredit["scope"];
    entity_mbid: string;
    role: string;
    attribute: string;
    artist_mbid: string;
    credited_name: string;
    sort_name: string | null;
    credit_order: number;
    medium_position: number | null;
  }>;
  const works = db.prepare(`
    SELECT rec.mbid AS recording_mbid, w.work_mbid, w.work_title, w.link_order, w.instrumental
    FROM RecordingWorks w
    JOIN Recordings rec ON rec.id = w.recording_id
    WHERE rec.mbid COLLATE NOCASE IN ${SQL_JSON_LIST}
  `).all(jsonList(recordings)) as Array<{
    recording_mbid: string;
    work_mbid: string;
    work_title: string;
    link_order: number;
    instrumental: number;
  }>;
  return {
    known: new Set(knownRows.map((row) => row.mbid.trim().toLowerCase())),
    credits: credits.map((row) => ({
      scope: row.scope,
      entityMbid: row.entity_mbid.trim().toLowerCase(),
      role: row.role,
      attribute: row.attribute || "",
      artistMbid: row.artist_mbid.trim().toLowerCase(),
      creditedName: row.credited_name,
      sortName: row.sort_name,
      order: row.credit_order,
      mediumPosition: row.medium_position,
    })),
    works: works.map((row) => ({
      recordingMbid: row.recording_mbid.trim().toLowerCase(),
      workMbid: row.work_mbid.trim().toLowerCase(),
      title: row.work_title,
      order: row.link_order,
      instrumental: row.instrumental === 1,
    })),
  };
}

/**
 * Replace relationship credits for the mbids the mirror just read.
 * A null bundle means the provider did not supply relationships (WS): keep
 * the stored rows. An empty credit list for a queried MBID clears them.
 * Does not insert ArtistMetadata rows.
 */
export function applyRelationshipRefresh(db: Database.Database, bundle: RelationshipBundle | null): void {
  if (!bundle) return;
  const insertCredit = db.prepare(`
    INSERT INTO CatalogRelationshipCredits (
      scope, recording_id, edition_id, work_mbid, role, attribute,
      artist_mbid, credited_name, sort_name, credit_order, medium_position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const recordingId = db.prepare(`SELECT id FROM Recordings WHERE mbid = ? COLLATE NOCASE`);
  const editionId = db.prepare(`SELECT id FROM AlbumEditions WHERE mbid = ? COLLATE NOCASE`);

  const writeCredit = (credit: RelationshipCredit, recording: number | null, edition: number | null): void => {
    if (!credit.artistMbid || !credit.creditedName) return;
    insertCredit.run(
      credit.scope,
      recording,
      edition,
      credit.scope === "work" ? credit.entityMbid : null,
      credit.role,
      credit.attribute || "",
      credit.artistMbid,
      credit.creditedName,
      credit.sortName,
      credit.order,
      credit.mediumPosition,
    );
  };

  for (const batch of chunks(bundle.queriedRecordingMbids)) {
    const present = batch.flatMap((mbid) => {
      const row = recordingId.get(mbid) as { id: number } | undefined;
      return row ? [{ mbid, id: row.id }] : [];
    });
    if (present.length === 0) continue;
    const ids = present.map((row) => row.id);
    const idJson = jsonList(ids);
    const byRecording = new Map(present.map((row) => [row.mbid.trim().toLowerCase(), row.id]));
    db.transaction(() => {
      db.prepare(`DELETE FROM CatalogRelationshipCredits WHERE scope = 'recording' AND recording_id IN ${SQL_JSON_LIST}`).run(idJson);
      db.prepare(`DELETE FROM RecordingWorks WHERE recording_id IN ${SQL_JSON_LIST}`).run(idJson);
      db.prepare(`UPDATE Recordings SET relationship_credits_at = CURRENT_TIMESTAMP WHERE id IN ${SQL_JSON_LIST}`).run(idJson);
      for (const credit of bundle.credits) {
        if (credit.scope !== "recording") continue;
        const id = byRecording.get(credit.entityMbid.trim().toLowerCase());
        if (id == null) continue;
        writeCredit(credit, id, null);
      }
      const insertWork = db.prepare(`
        INSERT OR REPLACE INTO RecordingWorks (recording_id, work_mbid, work_title, link_order, instrumental)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const work of bundle.works) {
        const id = byRecording.get(work.recordingMbid.trim().toLowerCase());
        if (id == null || !work.workMbid || !work.title) continue;
        insertWork.run(id, work.workMbid, work.title, work.order, work.instrumental ? 1 : 0);
      }
    })();
  }

  const workMbids = [...new Set(bundle.works.map((work) => work.workMbid.trim().toLowerCase()).filter(Boolean))];
  for (const batch of chunks(workMbids)) {
    const batchIds = new Set(batch);
    db.transaction(() => {
      db.prepare(`DELETE FROM CatalogRelationshipCredits WHERE scope = 'work' AND work_mbid IN ${SQL_JSON_LIST}`).run(jsonList(batch));
      for (const credit of bundle.credits) {
        if (credit.scope !== "work" || !batchIds.has(credit.entityMbid.trim().toLowerCase())) continue;
        writeCredit(credit, null, null);
      }
    })();
  }

  for (const batch of chunks(bundle.queriedReleaseMbids)) {
    const present = batch.flatMap((mbid) => {
      const row = editionId.get(mbid) as { id: number } | undefined;
      return row ? [{ mbid, id: row.id }] : [];
    });
    if (present.length === 0) continue;
    const byEdition = new Map(present.map((row) => [row.mbid.trim().toLowerCase(), row.id]));
    db.transaction(() => {
      db.prepare(`DELETE FROM CatalogRelationshipCredits WHERE scope = 'release' AND edition_id IN ${SQL_JSON_LIST}`)
        .run(jsonList(present.map((row) => row.id)));
      for (const credit of bundle.credits) {
        if (credit.scope !== "release") continue;
        const id = byEdition.get(credit.entityMbid.trim().toLowerCase());
        if (id == null) continue;
        writeCredit(credit, null, id);
      }
    })();
  }
}
