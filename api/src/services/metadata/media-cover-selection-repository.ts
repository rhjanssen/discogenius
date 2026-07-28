import crypto from "node:crypto";
import type Database from "better-sqlite3";

export type MediaCoverSourceKind = "manual" | "canonical" | "provider";

export interface MediaCoverSelection {
  releaseGroupId: number;
  sourceKind: MediaCoverSourceKind;
  selectionRevision: string;
  contentHash: string;
  sourceIdentity: string | null;
  updatedAt: string;
}

export interface SelectMediaCoverInput {
  releaseGroupId: number;
  sourceKind: MediaCoverSourceKind;
  contentHash: string;
  sourceIdentity?: string | null;
  supplemental?: boolean;
}

export type MediaCoverSelectionResult =
  | { applied: true; selection: MediaCoverSelection }
  | { applied: false; reason: "manual-authority" | "supplemental-source"; selection: MediaCoverSelection };

function normalizeRequired(value: string, field: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function normalizeIdentity(value: string | null | undefined): string | null {
  const normalized = String(value || "").trim();
  return normalized || null;
}

export function mediaCoverSelectionRevision(input: {
  sourceKind: MediaCoverSourceKind;
  contentHash: string;
  sourceIdentity?: string | null;
}): string {
  return crypto.createHash("sha256")
    .update(JSON.stringify([
      input.sourceKind,
      normalizeRequired(input.contentHash, "contentHash"),
      normalizeIdentity(input.sourceIdentity),
    ]))
    .digest("hex")
    .slice(0, 16);
}

export class MediaCoverSelectionRepository {
  constructor(private readonly db: Database.Database) {}

  get(releaseGroupId: number): MediaCoverSelection | null {
    const row = this.db.prepare(`
      SELECT release_group_id, source_kind, selection_revision, content_hash,
             source_identity, updated_at
      FROM MediaCoverSelections
      WHERE release_group_id = ?
    `).get(releaseGroupId) as {
      release_group_id: number;
      source_kind: MediaCoverSourceKind;
      selection_revision: string;
      content_hash: string;
      source_identity: string | null;
      updated_at: string;
    } | undefined;
    return row ? {
      releaseGroupId: row.release_group_id,
      sourceKind: row.source_kind,
      selectionRevision: row.selection_revision,
      contentHash: row.content_hash,
      sourceIdentity: row.source_identity,
      updatedAt: row.updated_at,
    } : null;
  }

  select(input: SelectMediaCoverInput): MediaCoverSelectionResult {
    const existing = this.get(input.releaseGroupId);
    if (existing?.sourceKind === "manual" && input.sourceKind !== "manual") {
      return { applied: false, reason: "manual-authority", selection: existing };
    }
    if (input.supplemental && existing) {
      return { applied: false, reason: "supplemental-source", selection: existing };
    }

    const contentHash = normalizeRequired(input.contentHash, "contentHash");
    const sourceIdentity = normalizeIdentity(input.sourceIdentity);
    const selectionRevision = mediaCoverSelectionRevision({
      sourceKind: input.sourceKind,
      contentHash,
      sourceIdentity,
    });
    this.db.prepare(`
      INSERT INTO MediaCoverSelections (
        release_group_id, source_kind, selection_revision, content_hash,
        source_identity, updated_at
      ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(release_group_id) DO UPDATE SET
        source_kind = excluded.source_kind,
        selection_revision = excluded.selection_revision,
        content_hash = excluded.content_hash,
        source_identity = excluded.source_identity,
        updated_at = CASE
          WHEN MediaCoverSelections.selection_revision = excluded.selection_revision
          THEN MediaCoverSelections.updated_at
          ELSE CURRENT_TIMESTAMP
        END
    `).run(
      input.releaseGroupId,
      input.sourceKind,
      selectionRevision,
      contentHash,
      sourceIdentity,
    );
    const selection = this.get(input.releaseGroupId);
    if (!selection) throw new Error("Media-cover selection was not persisted");
    return { applied: true, selection };
  }

  clearManual(releaseGroupId: number): boolean {
    return this.db.prepare(`
      DELETE FROM MediaCoverSelections
      WHERE release_group_id = ? AND source_kind = 'manual'
    `).run(releaseGroupId).changes > 0;
  }
}
