import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "../../database.js";
import { withSqliteWriteMutexSync } from "../../database/sqlite-write-mutex.js";
import { artworkKey, type ArtworkIdentity } from "./media-cover-state.js";

type StoredSidecar = { path: string; hash: string; metadataFileId?: number };

function manifestPath(folder: string, coverType: string): string {
  return path.join(folder, `.${coverType}.library.json`);
}

function readSidecars(identity: ArtworkIdentity, folder: string): StoredSidecar[] {
  const stored = db.prepare(`SELECT file_path AS path, content_hash AS hash,
    metadata_file_id AS metadataFileId FROM ArtworkLibraryLinks
    WHERE cover_entity = ? AND entity_id = ? AND cover_type = ?`).all(...artworkKey(identity)) as StoredSidecar[];
  if (stored.length) return stored;
  try {
    const value = JSON.parse(fs.readFileSync(manifestPath(folder, identity.coverType), "utf8"));
    return Array.isArray(value.sidecars) ? value.sidecars.filter((item: StoredSidecar) =>
      typeof item.path === "string" && typeof item.hash === "string"
      && /^[a-f0-9]{64}$/.test(item.hash)) : [];
  } catch { return []; }
}

function writeSidecars(identity: ArtworkIdentity, sidecars: StoredSidecar[], current: StoredSidecar): void {
  withSqliteWriteMutexSync(() => db.transaction(() => {
    const insertSql = `INSERT INTO ArtworkLibraryLinks
      (cover_entity, entity_id, cover_type, file_path, content_hash, metadata_file_id)
      VALUES (?, ?, ?, ?, ?, ?)`;
    const importLegacy = db.prepare(`${insertSql} ON CONFLICT DO NOTHING`);
    for (const sidecar of sidecars) {
      // A stale old manifest must not resurrect a deleted tracked file.
      if (sidecar.metadataFileId && !db.prepare("SELECT 1 FROM MetadataFiles WHERE id = ? AND file_type = 'cover'").get(sidecar.metadataFileId)) continue;
      importLegacy.run(...artworkKey(identity), sidecar.path, sidecar.hash, sidecar.metadataFileId ?? null);
    }
    if (current.metadataFileId) {
      const row = db.prepare("SELECT file_path FROM MetadataFiles WHERE id = ? AND file_type = 'cover'").get(current.metadataFileId) as { file_path: string } | undefined;
      if (!row || row.file_path !== current.path) throw new Error("Artwork link does not match its exact MetadataFiles row");
      db.prepare(`DELETE FROM ArtworkLibraryLinks WHERE cover_entity = ? AND entity_id = ?
        AND cover_type = ? AND metadata_file_id = ? AND file_path <> ?`)
        .run(...artworkKey(identity), current.metadataFileId, current.path);
    }
    db.prepare(`${insertSql} ON CONFLICT(cover_entity, entity_id, cover_type, file_path)
      DO UPDATE SET content_hash = excluded.content_hash, metadata_file_id = excluded.metadata_file_id`)
      .run(...artworkKey(identity), current.path, current.hash, current.metadataFileId ?? null);
  })(), "artwork library links");
}

/** Resolve the active full-resolution sidecar through its exact tracked row.
 * File hashes prevent another edition's art at a shared path masquerading as
 * this entity's selected master. No thumbnail is accepted as an original. */
export function findLibraryCoverMaster(identity: ArtworkIdentity, folder: string, hash: string): string | null {
  for (const sidecar of readSidecars(identity, folder)) {
    if (sidecar.hash !== hash) continue;
    let target = sidecar.path;
    if (sidecar.metadataFileId) {
      try {
        const row = db.prepare("SELECT file_path FROM MetadataFiles WHERE id = ? AND file_type = 'cover'")
          .get(sidecar.metadataFileId) as { file_path: string } | undefined;
        if (!row) continue;
        target = row.file_path;
      } catch { continue; }
    }
    try {
      if (crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex") === hash) return target;
    } catch { /* Offline or removed library; try another copy. */ }
  }
  return null;
}

/** Record the sidecar itself as the master. This creates no additional image. */
export function rememberLibraryCoverSidecar(identity: ArtworkIdentity, folder: string, outputPath: string, hash: string, metadataFileId?: number): void {
  const sidecars = readSidecars(identity, folder).filter(item => item.path !== outputPath
    && (!metadataFileId || item.metadataFileId !== metadataFileId));
  writeSidecars(identity, sidecars, { path: outputPath, hash, metadataFileId });
}

export function linkLibraryCoverSidecar(identity: ArtworkIdentity, folder: string, outputPath: string, metadataFileId: number): void {
  const sidecars = readSidecars(identity, folder);
  const current = sidecars.find(item => item.path === outputPath);
  if (!current || current.metadataFileId === metadataFileId) return;
  current.metadataFileId = metadataFileId;
  writeSidecars(identity, sidecars, current);
}
