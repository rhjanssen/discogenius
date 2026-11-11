import type Database from "better-sqlite3";
import { withSqliteWriteGate } from "../../database.js";
import type {
  RecordingWorkLink,
  RelationshipBundle,
  RelationshipCredit,
} from "../catalog/relationship-credit-model.js";
import { SQL_JSON_LIST, jsonList } from "../../utils/sql-id-list.js";

const BATCH = 100;

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
      AND mbid IN ${SQL_JSON_LIST}
  `).all(jsonList(recordings)) as Array<{ mbid: string }>;
  const credits = db.prepare(`
    SELECT scope, entity_mbid, role, attribute, artist_mbid, credited_name, sort_name, credit_order, medium_position
    FROM (
      SELECT c.scope AS scope, rec.mbid AS entity_mbid, c.role, c.attribute, c.artist_mbid,
             c.credited_name, c.sort_name, c.credit_order, c.medium_position
      FROM CatalogRelationshipCredits c
      JOIN Recordings rec ON rec.id = c.recording_id
      WHERE c.scope = 'recording' AND rec.mbid IN ${SQL_JSON_LIST}
      UNION ALL
      SELECT c.scope, ed.mbid, c.role, c.attribute, c.artist_mbid,
             c.credited_name, c.sort_name, c.credit_order, c.medium_position
      FROM CatalogRelationshipCredits c
      JOIN AlbumEditions ed ON ed.id = c.edition_id
      WHERE c.scope = 'release' AND ed.mbid IN ${SQL_JSON_LIST}
      UNION ALL
      SELECT c.scope, c.work_mbid, c.role, c.attribute, c.artist_mbid,
             c.credited_name, c.sort_name, c.credit_order, c.medium_position
      FROM CatalogRelationshipCredits c
      WHERE c.scope = 'work' AND c.work_mbid IN (
        SELECT w.work_mbid FROM RecordingWorks w
        JOIN Recordings rec ON rec.id = w.recording_id
        WHERE rec.mbid IN ${SQL_JSON_LIST}
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
    WHERE rec.mbid IN ${SQL_JSON_LIST}
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

function groupCreditsAndWorks(bundle: RelationshipBundle) {
  const recordingCreditsByMbid = new Map<string, RelationshipCredit[]>();
  const workCreditsByMbid = new Map<string, RelationshipCredit[]>();
  const releaseCreditsByMbid = new Map<string, RelationshipCredit[]>();
  for (const credit of bundle.credits) {
    const key = credit.entityMbid.trim().toLowerCase();
    if (credit.scope === "recording") {
      let list = recordingCreditsByMbid.get(key);
      if (!list) recordingCreditsByMbid.set(key, (list = []));
      list.push(credit);
    } else if (credit.scope === "work") {
      let list = workCreditsByMbid.get(key);
      if (!list) workCreditsByMbid.set(key, (list = []));
      list.push(credit);
    } else if (credit.scope === "release") {
      let list = releaseCreditsByMbid.get(key);
      if (!list) releaseCreditsByMbid.set(key, (list = []));
      list.push(credit);
    }
  }

  const worksByRecordingMbid = new Map<string, RecordingWorkLink[]>();
  for (const work of bundle.works) {
    const key = work.recordingMbid.trim().toLowerCase();
    let list = worksByRecordingMbid.get(key);
    if (!list) worksByRecordingMbid.set(key, (list = []));
    list.push(work);
  }

  return { recordingCreditsByMbid, workCreditsByMbid, releaseCreditsByMbid, worksByRecordingMbid };
}

function prepareRelationshipStatements(db: Database.Database) {
  const insertCredit = db.prepare(`
    INSERT INTO CatalogRelationshipCredits (
      scope, recording_id, edition_id, work_mbid, role, attribute,
      artist_mbid, credited_name, sort_name, credit_order, medium_position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const recordingId = db.prepare(`SELECT id FROM Recordings WHERE mbid = ?`);
  const editionId = db.prepare(`SELECT id FROM AlbumEditions WHERE mbid = ?`);
  const deleteRecordingCredits = db.prepare(
    `DELETE FROM CatalogRelationshipCredits WHERE scope = 'recording' AND recording_id IN ${SQL_JSON_LIST}`,
  );
  const deleteRecordingWorks = db.prepare(
    `DELETE FROM RecordingWorks WHERE recording_id IN ${SQL_JSON_LIST}`,
  );
  const updateRecordings = db.prepare(
    `UPDATE Recordings SET relationship_credits_at = CURRENT_TIMESTAMP WHERE id IN ${SQL_JSON_LIST}`,
  );
  const insertWork = db.prepare(`
    INSERT OR REPLACE INTO RecordingWorks (recording_id, work_mbid, work_title, link_order, instrumental)
    VALUES (?, ?, ?, ?, ?)
  `);
  const deleteWorkCredits = db.prepare(
    `DELETE FROM CatalogRelationshipCredits WHERE scope = 'work' AND work_mbid IN ${SQL_JSON_LIST}`,
  );
  const deleteReleaseCredits = db.prepare(
    `DELETE FROM CatalogRelationshipCredits WHERE scope = 'release' AND edition_id IN ${SQL_JSON_LIST}`,
  );

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

  return {
    recordingId,
    editionId,
    deleteRecordingCredits,
    deleteRecordingWorks,
    updateRecordings,
    insertWork,
    deleteWorkCredits,
    deleteReleaseCredits,
    writeCredit,
  };
}

/**
 * Asynchronously apply relationship credit refresh, taking the SQLite write gate
 * per batch instead of across the entire refresh, and yielding to the event loop
 * between batches so peer writers (heartbeats, imports, downloads) are not starved.
 *
 * A null bundle means the provider did not supply relationships (WS): keep
 * the stored rows. An empty credit list for a queried MBID clears them.
 * Does not insert ArtistMetadata rows.
 */
export async function applyRelationshipRefreshAsync(
  db: Database.Database,
  bundle: RelationshipBundle | null,
): Promise<void> {
  if (!bundle) return;
  const {
    recordingId,
    editionId,
    deleteRecordingCredits,
    deleteRecordingWorks,
    updateRecordings,
    insertWork,
    deleteWorkCredits,
    deleteReleaseCredits,
    writeCredit,
  } = prepareRelationshipStatements(db);
  const { recordingCreditsByMbid, workCreditsByMbid, releaseCreditsByMbid, worksByRecordingMbid } =
    groupCreditsAndWorks(bundle);

  const recordingChunks = chunks(bundle.queriedRecordingMbids);
  for (let i = 0; i < recordingChunks.length; i++) {
    const batch = recordingChunks[i];
    const present = batch.flatMap((mbid) => {
      const normalized = mbid.trim().toLowerCase();
      const row = recordingId.get(normalized) as { id: number } | undefined;
      return row ? [{ mbid: normalized, id: row.id }] : [];
    });
    if (present.length > 0) {
      const idJson = jsonList(present.map((row) => row.id));
      await withSqliteWriteGate(() => {
        db.transaction(() => {
          deleteRecordingCredits.run(idJson);
          deleteRecordingWorks.run(idJson);
          updateRecordings.run(idJson);
          for (const item of present) {
            const credits = recordingCreditsByMbid.get(item.mbid);
            if (credits) {
              for (const credit of credits) writeCredit(credit, item.id, null);
            }
            const works = worksByRecordingMbid.get(item.mbid);
            if (works) {
              for (const work of works) {
                if (!work.workMbid || !work.title) continue;
                insertWork.run(item.id, work.workMbid, work.title, work.order, work.instrumental ? 1 : 0);
              }
            }
          }
        })();
      }, "servarr:relationship-credits");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const workMbids = [...new Set(bundle.works.map((work) => work.workMbid.trim().toLowerCase()).filter(Boolean))];
  const workChunks = chunks(workMbids);
  for (let i = 0; i < workChunks.length; i++) {
    const batch = workChunks[i];
    const idJson = jsonList(batch);
    await withSqliteWriteGate(() => {
      db.transaction(() => {
        deleteWorkCredits.run(idJson);
        for (const workMbid of batch) {
          const credits = workCreditsByMbid.get(workMbid);
          if (credits) {
            for (const credit of credits) writeCredit(credit, null, null);
          }
        }
      })();
    }, "servarr:relationship-credits");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const releaseChunks = chunks(bundle.queriedReleaseMbids);
  for (let i = 0; i < releaseChunks.length; i++) {
    const batch = releaseChunks[i];
    const present = batch.flatMap((mbid) => {
      const normalized = mbid.trim().toLowerCase();
      const row = editionId.get(normalized) as { id: number } | undefined;
      return row ? [{ mbid: normalized, id: row.id }] : [];
    });
    if (present.length > 0) {
      const idJson = jsonList(present.map((row) => row.id));
      await withSqliteWriteGate(() => {
        db.transaction(() => {
          deleteReleaseCredits.run(idJson);
          for (const item of present) {
            const credits = releaseCreditsByMbid.get(item.mbid);
            if (credits) {
              for (const credit of credits) writeCredit(credit, null, item.id);
            }
          }
        })();
      }, "servarr:relationship-credits");
    }
    if (i < releaseChunks.length - 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}
