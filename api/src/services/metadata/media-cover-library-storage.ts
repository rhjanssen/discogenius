import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "../../database.js";

type StoredSidecar = { path: string; hash: string; metadataFileId?: number };

function manifestPath(folder: string, coverType: string): string {
  return path.join(folder, `.${coverType}.library.json`);
}

function readSidecars(folder: string, coverType: string): StoredSidecar[] {
  try {
    const value = JSON.parse(fs.readFileSync(manifestPath(folder, coverType), "utf8"));
    return Array.isArray(value.sidecars) ? value.sidecars : [];
  } catch { return []; }
}

function writeSidecars(folder: string, coverType: string, sidecars: StoredSidecar[]): void {
  const target = manifestPath(folder, coverType);
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify({ sidecars })); fs.renameSync(temp, target); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

/** Resolve the active full-resolution sidecar through its exact tracked row.
 * File hashes prevent another edition's art at a shared path masquerading as
 * this entity's selected master. No thumbnail is accepted as an original. */
export function findLibraryCoverMaster(folder: string, coverType: string, hash: string): string | null {
  for (const sidecar of readSidecars(folder, coverType)) {
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
export function rememberLibraryCoverSidecar(folder: string, coverType: string, outputPath: string, hash: string, metadataFileId?: number): void {
  const sidecars = readSidecars(folder, coverType).filter(item => item.path !== outputPath
    && (!metadataFileId || item.metadataFileId !== metadataFileId));
  sidecars.push({ path: outputPath, hash, metadataFileId });
  writeSidecars(folder, coverType, sidecars);
}

export function linkLibraryCoverSidecar(folder: string, coverType: string, outputPath: string, metadataFileId: number): void {
  const sidecars = readSidecars(folder, coverType);
  const current = sidecars.find(item => item.path === outputPath);
  if (!current || current.metadataFileId === metadataFileId) return;
  current.metadataFileId = metadataFileId;
  writeSidecars(folder, coverType, sidecars);
}
