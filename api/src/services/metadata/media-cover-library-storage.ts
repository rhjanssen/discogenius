import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "../../database.js";
import { withSqliteWriteMutexSync } from "../../database/sqlite-write-mutex.js";
import { artworkKey, type ArtworkIdentity } from "./media-cover-state.js";

type StoredSidecar = { path: string; hash: string; metadataFileId?: number };

type ArtworkFileRow = {
  file_path: string; file_type: string; track_file_id: number | null;
  canonical_artist_mbid: string | null; canonical_release_group_mbid: string | null;
  canonical_release_mbid: string | null; canonical_recording_mbid: string | null;
};

/** A surviving row ID is not proof that its artwork still owns this scope.
 * Canonical reconciliation can transfer owners without changing file bytes. */
function ownsArtwork(row: ArtworkFileRow, identity: ArtworkIdentity): boolean {
  if (!["cover", "artwork", "video_thumbnail", "video_cover"].includes(row.file_type)) return false;
  const id = String(identity.entityId);
  if (identity.coverEntity !== "Video" && (row.track_file_id !== null
    || ["video_thumbnail","video_cover"].includes(row.file_type))) return false;
  switch (identity.coverEntity) {
    case "Artist": return row.canonical_artist_mbid === id
      && !row.canonical_release_group_mbid && !row.canonical_release_mbid && !row.canonical_recording_mbid;
    case "Album": return row.canonical_release_group_mbid === id && !row.canonical_recording_mbid;
    case "Edition": return row.canonical_release_mbid === id && !row.canonical_recording_mbid;
    case "Video": {
      // Video cache IDs are canonical recording row IDs, not provider IDs.
      const recording = db.prepare("SELECT id,mbid,youtube_video_id FROM Recordings WHERE id = ? AND is_video = 1")
        .get(id) as {id:number;mbid:string|null;youtube_video_id:string|null} | undefined;
      if (!recording || (row.canonical_recording_mbid !== null && row.canonical_recording_mbid !== recording.mbid)) return false;
      if (row.track_file_id !== null) {
        // A YouTube-only canonical recording has no MBID. Inventory sidecars
        // carry the exact media row instead; provider IDs never establish scope.
        const media=db.prepare(`SELECT f.recording_id,artist.mbid AS artist,album.mbid AS album,edition.mbid AS edition
          FROM TrackFiles f JOIN ArtistMetadata artist ON artist.id=f.artist_metadata_id
          LEFT JOIN AlbumEditions edition ON edition.id=f.album_edition_id
          LEFT JOIN Albums album ON album.id=f.release_group_id
          WHERE f.id=? AND f.file_type='video'`).get(row.track_file_id) as
          {recording_id:number|null;artist:string;album:string|null;edition:string|null}|undefined;
        return Boolean(media && media.recording_id===recording.id && (recording.mbid || recording.youtube_video_id)
          && (!row.canonical_artist_mbid || row.canonical_artist_mbid===media.artist)
          && (!row.canonical_release_group_mbid || row.canonical_release_group_mbid===media.album)
          && (!row.canonical_release_mbid || row.canonical_release_mbid===media.edition));
      }
      return Boolean(recording.mbid && recording.mbid === row.canonical_recording_mbid);
    }
  }
}

function trackedArtwork(identity: ArtworkIdentity, id: number): ArtworkFileRow | null {
  const row = db.prepare(`SELECT file_path,file_type,track_file_id,canonical_artist_mbid,
    canonical_release_group_mbid,canonical_release_mbid,canonical_recording_mbid
    FROM MetadataFiles WHERE id = ?`).get(id) as ArtworkFileRow | undefined;
  return row && ownsArtwork(row, identity) ? row : null;
}

/** Shared publication/recovery admission. Import may have no tracked row yet;
 * once there is one, provisional links must agree with its current owner. */
export function artworkLinkOwnsTrackedPath(identity: ArtworkIdentity, filePath: string, metadataFileId?: number | null): boolean {
  if (metadataFileId) {
    const row = trackedArtwork(identity, metadataFileId);
    return Boolean(row && row.file_path === filePath);
  }
  const row = db.prepare(`SELECT file_path,file_type,track_file_id,canonical_artist_mbid,
    canonical_release_group_mbid,canonical_release_mbid,canonical_recording_mbid
    FROM MetadataFiles WHERE file_path=?`).get(filePath) as ArtworkFileRow | undefined;
  return !row || ownsArtwork(row, identity);
}

function manifestPath(folder: string, coverType: string): string {
  return path.join(folder, `.${coverType}.library.json`);
}

export type LegacyArtworkLink = {file_path:string;content_hash:string;metadata_file_id:number;library_root:string};

/** Legacy paths are hints only. Resolve an explicit row ID, or an exact indexed
 * path, and apply the same canonical admission as normal publication. The
 * maintenance caller must still verify bytes, containment and fresh witnesses. */
export function readLegacyArtworkLinkCandidates(identity: ArtworkIdentity, folder: string): {
  file:string; witness:string|null; links:LegacyArtworkLink[]; hasMore:boolean;
} {
  const file=manifestPath(folder,identity.coverType);
  const witness=legacyArtworkManifestWitness(file);
  if (!witness) return {file,witness,links:[],hasMore:false};
  const value=JSON.parse(fs.readFileSync(file,"utf8"));
  if (legacyArtworkManifestWitness(file)!==witness) throw new Error("Legacy artwork manifest changed during reading");
  if (!Array.isArray(value.sidecars)) throw new Error("Invalid legacy artwork manifest");
  const links:LegacyArtworkLink[]=[];
  for (const item of value.sidecars) {
    if (!item || typeof item.path!=="string" || typeof item.hash!=="string" || !/^[a-f0-9]{64}$/.test(item.hash))
      throw new Error("Invalid legacy artwork link");
    if (item.metadataFileId !== undefined && (!Number.isSafeInteger(item.metadataFileId) || item.metadataFileId<=0))
      throw new Error("Invalid legacy artwork file identity");
    const row=db.prepare(`SELECT id,file_path,library_root FROM MetadataFiles WHERE ${item.metadataFileId ? "id=?" : "file_path=?"}`)
      .get(item.metadataFileId ?? item.path) as {id:number;file_path:string;library_root:string}|undefined;
    if (!row || !artworkLinkOwnsTrackedPath(identity,row.file_path,row.id)) continue;
    // Durable provenance wins over an old marker, including a proper rename.
    if (db.prepare(`SELECT 1 FROM ArtworkLibraryLinks WHERE cover_entity=? AND entity_id=? AND cover_type=?
      AND metadata_file_id=? LIMIT 1`).get(...artworkKey(identity),row.id)) continue;
    const existing=links.find(link=>link.metadata_file_id===row.id);
    if (existing && existing.content_hash!==item.hash) throw new Error("Conflicting legacy artwork hashes for one tracked file");
    if (!existing) links.push({file_path:row.file_path,library_root:row.library_root,metadata_file_id:row.id,content_hash:item.hash});
  }
  // The marker itself is capped at 512 KiB. Validate it completely before
  // admitting a page, then hash/lock no more than 50 destinations. Committed
  // exact links are the durable cursor, so a restart resumes the next page.
  return {file,witness,links:links.slice(0,50),hasMore:links.length>50};
}

export function legacyArtworkManifestWitness(file:string):string|null {
  try {
    const stat=fs.lstatSync(file,{bigint:true});
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size>512n*1024n) throw new Error("Legacy artwork marker is linked or exceeds 512 KiB");
    return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(":");
  } catch(error) {if ((error as NodeJS.ErrnoException).code==="ENOENT") return null;throw error;}
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
      if (sidecar.metadataFileId && !trackedArtwork(identity, sidecar.metadataFileId)) continue;
      importLegacy.run(...artworkKey(identity), sidecar.path, sidecar.hash, sidecar.metadataFileId ?? null);
    }
    if (current.metadataFileId) {
      const row = trackedArtwork(identity, current.metadataFileId);
      if (!row || row.file_path !== current.path) throw new Error("Artwork link does not match its exact MetadataFiles owner and path");
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
        const row = trackedArtwork(identity, sidecar.metadataFileId);
        if (!row) continue;
        target = row.file_path;
      } catch { continue; }
    } else {
      // Import may publish before registering the sidecar. Once a tracked row
      // exists, a provisional path-only link cannot bypass its canonical owner.
      if (!artworkLinkOwnsTrackedPath(identity, target)) continue;
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
  if (!current) return;
  const row = trackedArtwork(identity, metadataFileId);
  if (!row || row.file_path !== outputPath) throw new Error("Artwork link does not match its exact MetadataFiles owner and path");
  if (current.metadataFileId === metadataFileId) return;
  current.metadataFileId = metadataFileId;
  writeSidecars(identity, sidecars, current);
}
