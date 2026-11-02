import type Database from "better-sqlite3";

/**
 * One album download per library and edition (E3, ADR-1), enforced by the DB.
 *
 * Album waits used to find their edition only through
 * `plan_id -> AcquisitionPlans`. A re-plan deletes the old plan row, so the
 * waiting row lost its identity and Download Missing appended a second row
 * for the same edition. The identity now lives on the queue row itself and a
 * unique partial index guards it.
 *
 * Additive and idempotent; user_version stays 46. On an existing queue:
 *   1. add nullable `library_id` / `edition_id` (O(1) in SQLite);
 *   2. delete waiting (unclaimed) duplicates per library+edition, keeping a
 *      running row first, then the earliest queue position;
 *   3. backfill the identity on the surviving row of each edition only, so a
 *      rare pair of already-running duplicates cannot fail the index (the
 *      extra running row keeps NULL identity and leaves when it finishes);
 *   4. create the unique partial index.
 * Rows whose plan was already deleted cannot be attributed and keep NULL;
 * they are outside the index and the existing prune endpoint clears them.
 */
export const DOWNLOAD_QUEUE_EDITION_INDEX = "idx_download_queue_album_edition";

export function createDownloadQueueEditionIndex(db: Database.Database): void {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${DOWNLOAD_QUEUE_EDITION_INDEX}
    ON DownloadQueue(library_id, edition_id)
    WHERE media_kind = 'album' AND track_ids IS NULL AND edition_id IS NOT NULL
  `);
}

export function migrateDownloadQueueEditionIdentity(db: Database.Database): { removed: number; backfilled: number } {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'DownloadQueue'").get();
  if (!hasTable) return { removed: 0, backfilled: 0 };
  const indexExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(DOWNLOAD_QUEUE_EDITION_INDEX);
  if (indexExists) return { removed: 0, backfilled: 0 };

  return db.transaction(() => {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(DownloadQueue)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!columns.has("library_id")) db.exec("ALTER TABLE DownloadQueue ADD COLUMN library_id INTEGER");
    if (!columns.has("edition_id")) db.exec("ALTER TABLE DownloadQueue ADD COLUMN edition_id INTEGER");

    const hasPlans = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'AcquisitionPlans'").get();
    let removed = 0;
    let backfilled = 0;
    if (hasPlans) {
      db.exec(`
        CREATE TEMP TABLE _dq_edition_rank AS
        SELECT queue.id AS id, queue.command_id AS command_id,
               plan.library_id AS library_id, plan.edition_id AS edition_id,
               ROW_NUMBER() OVER (
                 PARTITION BY plan.library_id, plan.edition_id
                 ORDER BY (queue.command_id IS NOT NULL) DESC, queue.queue_order, queue.id
               ) AS rn
        FROM DownloadQueue queue
        JOIN AcquisitionPlans plan ON plan.id = queue.plan_id
        WHERE queue.media_kind = 'album' AND queue.track_ids IS NULL
          AND plan.library_id IS NOT NULL AND plan.edition_id IS NOT NULL
      `);
      // Keyed lookups below; without this the backfill is quadratic.
      db.exec("CREATE UNIQUE INDEX temp._dq_edition_rank_id ON _dq_edition_rank(id)");
      removed = Number(db.prepare(`
        DELETE FROM DownloadQueue
        WHERE id IN (SELECT id FROM _dq_edition_rank WHERE rn > 1 AND command_id IS NULL)
      `).run().changes ?? 0);
      backfilled = Number(db.prepare(`
        UPDATE DownloadQueue
        SET library_id = (SELECT r.library_id FROM _dq_edition_rank r WHERE r.id = DownloadQueue.id),
            edition_id = (SELECT r.edition_id FROM _dq_edition_rank r WHERE r.id = DownloadQueue.id)
        WHERE id IN (SELECT id FROM _dq_edition_rank WHERE rn = 1)
      `).run().changes ?? 0);
      db.exec("DROP TABLE _dq_edition_rank");
    }
    createDownloadQueueEditionIndex(db);
    return { removed, backfilled };
  })();
}
