import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { db, isSqliteBusyError } from "../../database.js";
import { tryShortSqliteWrite } from "./artwork-materialize-followup.js";
import { artworkKey, type ArtworkIdentity } from "./media-cover-state.js";
import { artworkLinkOwnsTrackedPath } from "./media-cover-library-storage.js";

/** Longer than any synchronous commit holding an intent: hashes, one rename,
 * and short bounded write retries. */
const ABANDONED_INTENT_AGE_MS = 2 * 60_000;

/** The row could not be settled because other writers held SQLite. */
class SqliteBusyRecoveryError extends Error {
  readonly code = "SQLITE_BUSY";
  constructor() { super("database is locked while settling artwork recovery"); }
}

type Intent = {
  id: string; cover_entity: ArtworkIdentity["coverEntity"]; entity_id: string; cover_type: string;
  destination_path: string; staged_path: string; backup_path: string;
  original_identity: string | null; replacement_identity: string;
  database_snapshot: string; phase: "prepared" | "committed";
};

/** Include the inode and bytes: another file with identical image content is
 * still an external replacement, not ours to remove during rollback. */
export function artworkFileIdentity(file: string): string | null {
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Artwork mutation requires a regular file: ${file}`);
    if (stat.size > 32n * 1024n * 1024n) throw new Error("Artwork mutation exceeds the 32 MiB limit");
    const hash = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const after = fs.lstatSync(file, { bigint: true });
    if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeNs !== after.mtimeNs) {
      throw new Error("Artwork changed while recording its identity");
    }
    return JSON.stringify({ dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtime: String(stat.mtimeNs), hash });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Same dev, inode, size, and mtime as a recorded identity. No byte read. */
export function artworkStatMatchesIdentity(file: string, identity: string | null): boolean {
  let stat: fs.BigIntStats | null = null;
  try {
    const found = fs.lstatSync(file, { bigint: true });
    if (!found.isFile() || found.isSymbolicLink()) return false;
    stat = found;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") stat = null;
    else throw error;
  }
  if (identity === null) return stat === null;
  if (!stat) return false;
  const parsed = JSON.parse(identity) as { dev?: string; ino?: string; size?: string; mtime?: string };
  return parsed.dev === String(stat.dev)
    && parsed.ino === String(stat.ino)
    && parsed.size === String(stat.size)
    && parsed.mtime === String(stat.mtimeNs);
}

function identity(intent: Intent): ArtworkIdentity {
  return { coverEntity: intent.cover_entity, entityId: intent.entity_id, coverType: intent.cover_type };
}

function databaseSnapshot(scope: ArtworkIdentity, destination: string): string {
  return JSON.stringify({
    source: db.prepare("SELECT * FROM ArtworkSources WHERE cover_entity=? AND entity_id=? AND cover_type=?").get(...artworkKey(scope)) ?? null,
    links: db.prepare("SELECT * FROM ArtworkLibraryLinks WHERE file_path=? ORDER BY cover_entity,entity_id,cover_type").all(destination),
    file: db.prepare(`SELECT id,artist_id,track_file_id,file_path,relative_path,library_root,library_slot,extension,type,file_type,
      canonical_artist_mbid,canonical_release_group_mbid,canonical_release_mbid,canonical_track_mbid,canonical_recording_mbid,
      provider,provider_entity_type,provider_id,consumer FROM MetadataFiles WHERE file_path=?`).get(destination) ?? null,
  });
}

function hasCommittedLibraryLink(intent: Intent): boolean {
  const link = db.prepare(`SELECT link.metadata_file_id FROM ArtworkLibraryLinks link
    WHERE link.cover_entity=? AND link.entity_id=? AND link.cover_type=?
    AND link.file_path=? AND link.content_hash=?`)
    .get(...artworkKey(identity(intent)),intent.destination_path,JSON.parse(intent.replacement_identity).hash) as {metadata_file_id:number|null} | undefined;
  return Boolean(link && artworkLinkOwnsTrackedPath(identity(intent),intent.destination_path,link.metadata_file_id));
}

function ownershipSnapshot(snapshot: string): string {
  const {links,file} = JSON.parse(snapshot);
  return JSON.stringify({links,file});
}

/** Persist intent BEFORE touching the old image; acknowledge it in the same
 * transaction as the source and link updates. File hashes and the rename stay
 * outside the write lock: the caller holds that lock only around `recordIntent`
 * and `markCommitted`. Startup recovery runs before disk commands. */
export class ArtworkMutationJournal {
  static hasPending(): boolean {
    return Boolean(db.prepare("SELECT 1 FROM ArtworkMutationJournal LIMIT 1").get());
  }

  /** Intents that must settle before library file work. An intent whose recovery
   * already failed is isolated: it concerns one image, keeps its reason in
   * recovery_error, is retried by abandoned recovery, and guards only its own
   * destination (recordIntent). It must never park every import. */
  static hasBlocking(): boolean {
    return Boolean(db.prepare("SELECT 1 FROM ArtworkMutationJournal WHERE recovery_error IS NULL LIMIT 1").get());
  }

  private static get(id: string): Intent {
    const row = db.prepare("SELECT * FROM ArtworkMutationJournal WHERE id=?").get(id) as Intent | undefined;
    if (!row) throw new Error("Artwork replacement intent is missing");
    return row;
  }

  /** Hash outside the write lock, then insert. Tests and recovery call this directly. */
  static prepare(scope: ArtworkIdentity, destination: string, staged: string): string {
    const replacement = artworkFileIdentity(staged);
    if (!replacement) throw new Error("Staged artwork is missing");
    return this.recordIntent(scope, destination, staged, artworkFileIdentity(destination), replacement);
  }

  /** SQL only. Caller holds the write lock. Identities were hashed before the lock. */
  static recordIntent(
    scope: ArtworkIdentity,
    destination: string,
    staged: string,
    originalIdentity: string | null,
    replacementIdentity: string,
  ): string {
    if (db.inTransaction) throw new Error("Artwork replacement intent must commit before file publication");
    if (db.prepare("SELECT 1 FROM FileMutationJournal WHERE source_path=? OR destination_path=? LIMIT 1").get(destination,destination)
      || db.prepare("SELECT 1 FROM LibraryCleanupJournal WHERE source_path=? LIMIT 1").get(destination)) {
      throw new Error("Recover pending file mutations at this artwork destination first");
    }
    if (db.prepare("SELECT 1 FROM ArtworkMutationJournal WHERE destination_path=? LIMIT 1").get(destination)) {
      throw new Error("An earlier artwork replacement at this destination still needs recovery");
    }
    if (path.resolve(destination) === path.resolve(staged) || path.dirname(destination) !== path.dirname(staged)) {
      throw new Error("Artwork staging must be a separate file beside its destination");
    }
    if (!artworkStatMatchesIdentity(staged, replacementIdentity)) throw new Error("Staged artwork is missing");
    if (!artworkStatMatchesIdentity(destination, originalIdentity)) throw new Error("Artwork or ownership changed before publication");
    const id = randomUUID();
    db.prepare(`INSERT INTO ArtworkMutationJournal
      (id,cover_entity,entity_id,cover_type,destination_path,staged_path,backup_path,original_identity,replacement_identity,database_snapshot)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,...artworkKey(scope),destination,staged,
      path.join(path.dirname(destination), `.discogenius-artwork-${id}.previous`),
      originalIdentity,replacementIdentity,databaseSnapshot(scope,destination));
    return id;
  }

  static publish(id: string): void {
    const intent = this.get(id);
    // Hash before the ownership re-read so the snapshot check sits next to the rename.
    if (intent.phase !== "prepared"
      || artworkFileIdentity(intent.destination_path) !== intent.original_identity
      || artworkFileIdentity(intent.staged_path) !== intent.replacement_identity
      || databaseSnapshot(identity(intent),intent.destination_path) !== intent.database_snapshot) {
      throw new Error("Artwork or ownership changed before publication");
    }
    if (intent.original_identity) fs.linkSync(intent.destination_path,intent.backup_path);
    fs.renameSync(intent.staged_path,intent.destination_path);
  }

  static markCommitted(id: string): void {
    if (!db.inTransaction) throw new Error("Artwork acknowledgement requires the provenance transaction");
    const intent = this.get(id);
    // Rename keeps the staged inode. Comparing that stat avoids hashing the
    // image inside the provenance transaction.
    if (!artworkStatMatchesIdentity(intent.destination_path, intent.replacement_identity)) {
      throw new Error("Published artwork changed before commit");
    }
    if (!hasCommittedLibraryLink(intent)) throw new Error("Artwork commit has no matching library link");
    if (db.prepare("UPDATE ArtworkMutationJournal SET phase='committed' WHERE id=? AND phase='prepared'").run(id).changes !== 1) {
      throw new Error("Artwork commit lost its intent");
    }
  }

  static recoverOneSync(id: string): void {
    try {
      const intent = this.get(id);
      const destination = artworkFileIdentity(intent.destination_path);
      const backup = artworkFileIdentity(intent.backup_path);
      const staged = artworkFileIdentity(intent.staged_path);
      // Inspect ALL paths before removing any evidence. Never resolve a conflict
      // by overwriting an image another app or the user has since replaced.
      if (staged && staged !== intent.replacement_identity) throw new Error("Artwork recovery staging file changed");
      if (backup && backup !== intent.original_identity) throw new Error("Artwork recovery backup changed");
      if (intent.phase === "prepared") {
        // Catalogue refresh may select a newer source after a worker dies.
        // Recover only this file mutation; never roll that newer selection back.
        if (ownershipSnapshot(databaseSnapshot(identity(intent),intent.destination_path)) !== ownershipSnapshot(intent.database_snapshot)) {
          throw new Error("Uncommitted artwork ownership changed");
        }
        if (destination !== intent.original_identity && destination !== intent.replacement_identity) {
          throw new Error("Artwork recovery destination changed");
        }
        if (destination === intent.replacement_identity) {
          if (intent.original_identity) {
            if (!backup) throw new Error("Previous artwork recovery copy is missing");
            fs.renameSync(intent.backup_path,intent.destination_path);
          } else fs.unlinkSync(intent.destination_path);
        }
      } else {
        // Ownership changed after commit: keep both versions as evidence. The
        // intent records the reason and is isolated (hasBlocking), not global.
        if (destination !== intent.replacement_identity) throw new Error("Committed artwork destination changed");
        if (!hasCommittedLibraryLink(intent)) throw new Error("Committed artwork has no matching library link");
      }
      if (backup && fs.existsSync(intent.backup_path)) fs.unlinkSync(intent.backup_path);
      if (staged) fs.unlinkSync(intent.staged_path);
      // The files are settled at this point. Settle the row through the shared
      // writer mutex: an ungated DELETE lost to busy writers and left a
      // restored intent behind that blocked every library file job.
      const deleted = tryShortSqliteWrite(() => db.prepare("DELETE FROM ArtworkMutationJournal WHERE id=?").run(id), "artwork:recovery");
      if (!deleted.ok) throw new SqliteBusyRecoveryError();
    } catch (error) {
      // A busy database is not a recovery problem: the files are consistent
      // and the next recovery pass deletes the row. Recording it as an error
      // would ask the operator to fix something that fixes itself.
      if (!isSqliteBusyError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        tryShortSqliteWrite(() => db.prepare("UPDATE ArtworkMutationJournal SET recovery_error=? WHERE id=?").run(message,id), "artwork:recovery-error");
        // The unsettled intent still blocks disk commands if recording the error fails.
      }
      throw error;
    }
  }

  /**
   * `abandonedOnly` is for recovery while commands still run. A commit owns its
   * intent only inside one synchronous call, so an intent its owner marked with
   * an error, or one older than that call can last, has no live owner.
   */
  static async recoverPending(options: { abandonedOnly?: boolean; now?: Date } = {}): Promise<string[]> {
    const rows = (options.abandonedOnly
      ? db.prepare(`SELECT id FROM ArtworkMutationJournal
          WHERE recovery_error IS NOT NULL OR julianday(created_at) <= julianday(?) - ?/86400000.0
          ORDER BY created_at,id`).all((options.now ?? new Date()).toISOString(), ABANDONED_INTENT_AGE_MS)
      : db.prepare("SELECT id FROM ArtworkMutationJournal ORDER BY created_at,id").all()) as Array<{id:string}>;
    const errors: string[] = [];
    for (const {id} of rows) {
      // Hashes and renames stay outside the write lock. Each statement takes it
      // only for its own write.
      try { this.recoverOneSync(id); }
      catch (error) { errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`); }
      // Recovery may inspect a full-size image; let requests run between intents.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    return errors;
  }
}
