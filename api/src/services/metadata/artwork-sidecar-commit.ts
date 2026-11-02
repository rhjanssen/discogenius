import fs from "node:fs";
import { db, isSqliteBusyError } from "../../database.js";
import { ArtworkMutationJournal } from "./artwork-mutation-journal.js";
import { claimPublishedArtworkRow, rememberLibraryCoverSidecar } from "./media-cover-library-storage.js";
import { storeArtworkSource, type ArtworkIdentity, type ArtworkSource } from "./media-cover-state.js";
import {
  discardArtworkMaterializeFollowUps,
  recordArtworkMaterializeFollowUp,
  tryShortSqliteWrite,
  type ArtworkMaterializeFollowUp,
} from "./artwork-materialize-followup.js";

export type ArtworkSidecarCommitResult = "unchanged" | "written" | "deferred";

/**
 * Publish a staged cover and record its provenance.
 *
 * Image hashes and the rename happen outside the SQLite write lock. The lock
 * covers only the intent insert and the provenance transaction, each retried
 * for a bounded time. If another writer keeps the lock, the original file is
 * left as it was (or restored) and a follow-up is recorded instead of failing
 * the caller.
 */
export function commitArtworkSidecar(options: {
  unchanged: boolean;
  stagedPath: string;
  destination: string;
  scope: ArtworkIdentity;
  folder: string;
  hash: string;
  source: ArtworkSource | null;
  originalIdentity: string | null;
  replacementIdentity: string | null;
  /** Lstat and selected-source checks. No image reads. */
  assertWitnesses: () => void;
  /** Selected-source check after the file has been renamed. */
  assertSource: () => void;
  followUp: ArtworkMaterializeFollowUp;
}): ArtworkSidecarCommitResult {
  let intentId: string | null = null;
  const restore = (id: string): void => {
    try { ArtworkMutationJournal.recoverOneSync(id); }
    catch (error) {
      if (!isSqliteBusyError(error)) throw error;
    }
  };
  try {
    if (!options.unchanged) {
      if (!options.replacementIdentity) throw new Error("Staged artwork is missing");
      const recorded = tryShortSqliteWrite(() => {
        options.assertWitnesses();
        return ArtworkMutationJournal.recordIntent(
          options.scope,
          options.destination,
          options.stagedPath,
          options.originalIdentity,
          options.replacementIdentity!,
        );
      }, "artwork:intent");
      if (!recorded.ok) {
        recordArtworkMaterializeFollowUp(options.followUp);
        return "deferred";
      }
      intentId = recorded.value;
      ArtworkMutationJournal.publish(intentId);
    }
    const wrote = tryShortSqliteWrite(() => {
      if (options.unchanged) options.assertWitnesses();
      else options.assertSource();
      db.transaction(() => {
        const rowId = claimPublishedArtworkRow(options.scope, options.destination);
        rememberLibraryCoverSidecar(options.scope, options.folder, options.destination, options.hash, rowId);
        if (options.source) storeArtworkSource(options.scope, { ...options.source, contentHash: options.hash });
        if (intentId) ArtworkMutationJournal.markCommitted(intentId);
      })();
    }, "artwork:provenance");
    if (!wrote.ok) {
      if (intentId) restore(intentId);
      recordArtworkMaterializeFollowUp(options.followUp);
      return "deferred";
    }
    if (intentId) {
      try { ArtworkMutationJournal.recoverOneSync(intentId); }
      catch (error) {
        if (!isSqliteBusyError(error)) throw error;
      }
    }
    discardArtworkMaterializeFollowUps(options.destination);
    return options.unchanged ? "unchanged" : "written";
  } catch (error) {
    if (intentId && ArtworkMutationJournal.hasPending()) {
      try { ArtworkMutationJournal.recoverOneSync(intentId); }
      catch (restoreError) {
        throw new AggregateError([error, restoreError], `Artwork replacement needs recovery; intent ${intentId} retained`);
      }
    }
    throw error;
  } finally {
    // Once an intent exists, recovery owns its paths, including a failed restore.
    if (!intentId) fs.rmSync(options.stagedPath, { force: true });
  }
}
