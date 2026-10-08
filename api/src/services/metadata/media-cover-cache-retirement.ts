import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { db, withSqliteWriteGate } from "../../database.js";
import { acquireMediaFileLocks } from "../mediafiles/media-file-lock.js";
import { artworkKey, type ArtworkIdentity } from "./media-cover-state.js";
import { artworkLinkOwnsTrackedPath } from "./media-cover-library-storage.js";
import { commitArtworkProxies, hasCurrentArtworkProxies } from "./media-cover-proxy-storage.js";
import { decodeArtworkImage } from "./media-cover-image.js";
import { getMediaCoverFolder, getSelectedArtworkSource, normalizeArtworkUrl,
  prepareResizedMediaCovers } from "./media-cover-service.js";

type Witness = { stat: string; hash: string; size: number };
type Intent = { file_identity: string; source_snapshot: string; byte_size: number; phase: string };

/** Replay older failed attempts before a new sweep. The journal retains the old
 * command's identity/counters; a new command cannot erase or adopt its evidence. */
export async function recoverPreparedArtworkRetirements(root: string, checkpoint:()=>Promise<void>, limit=25):Promise<boolean> {
  const pending=db.prepare(`SELECT command_id,source_path FROM ArtworkCacheRetirement
    WHERE phase='prepared' ORDER BY command_id,source_path LIMIT ?`).all(limit) as Array<{command_id:number;source_path:string}>;
  for (const item of pending) {
    const relative=path.relative(root,item.source_path);
    const parts=relative.split(path.sep);
    const families:Record<string,ArtworkIdentity["coverEntity"]>={Albums:"Album",AlbumEditions:"Edition",Videos:"Video"};
    const family=parts.length===3 ? families[parts[0]] : parts.length===2 ? "Artist" : undefined;
    if (!family || path.isAbsolute(relative) || parts.some(part=>!part || part===".." || part===".")) throw new Error("Prepared artwork retirement escaped the current cache root");
    const filename=parts.at(-1)!;
    const identity:ArtworkIdentity={coverEntity:family,entityId:parts.at(-2)!,coverType:path.parse(filename).name};
    if (path.join(getMediaCoverFolder(identity.entityId,family),filename)!==item.source_path) throw new Error("Prepared artwork retirement does not match its canonical cache path");
    await checkpoint();
    await retireLegacyArtworkOrigin(item.command_id,identity,filename);
  }
  return Boolean(db.prepare("SELECT 1 FROM ArtworkCacheRetirement WHERE phase='prepared' LIMIT 1").get());
}

/** Constant-time counters commit with each file outcome, not repeated SUM scans
 * over an ever-growing retirement history. Caller owns writer admission. */
function outcome(commandId: number, origin: string, phase: "retired" | "protected", original: Witness|null, reason: string|null): void {
  db.transaction(()=>{
    const old=db.prepare("SELECT phase,byte_size FROM ArtworkCacheRetirement WHERE command_id=? AND source_path=?")
      .get(commandId,origin) as {phase:string;byte_size:number}|undefined;
    if (!old) db.prepare(`INSERT INTO ArtworkCacheRetirement(command_id,source_path,file_identity,source_snapshot,byte_size,phase,reason)
      VALUES (?,?,?,'',?,?,?)`).run(commandId,origin,JSON.stringify(original),original?.size??0,phase,reason);
    else db.prepare("UPDATE ArtworkCacheRetirement SET phase=?,reason=? WHERE command_id=? AND source_path=?").run(phase,reason,commandId,origin);
    const size=old?.byte_size??original?.size??0;
    db.prepare("INSERT INTO ArtworkCacheRuns(command_id) VALUES (?) ON CONFLICT DO NOTHING").run(commandId);
    db.prepare("UPDATE ArtworkCacheRuns SET retired=retired+?,protected=protected+?,bytes=bytes+? WHERE command_id=?")
      .run(Number(phase==="retired")-Number(old?.phase==="retired"),Number(phase==="protected")-Number(old?.phase==="protected"),
        (Number(phase==="retired")-Number(old?.phase==="retired"))*size,commandId);
  })();
}

function stat(file: string): string | null {
  try {
    const s = fs.lstatSync(file,{bigint:true});
    if (!s.isFile() || s.isSymbolicLink()) throw new Error("Artwork path is not a regular file");
    return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(":");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export function artworkDirectoryIdentity(directory: string): string {
  const s = fs.lstatSync(directory,{bigint:true});
  if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Artwork directory is unavailable or linked");
  return [s.dev,s.ino].join(":");
}

function ancestors(file: string, root: string): string {
  const relative = path.relative(root,file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Artwork path escaped its root");
  const evidence: string[] = [];
  let directory = path.dirname(file);
  while (true) {
    evidence.push(`${directory}:${artworkDirectoryIdentity(directory)}`);
    if (directory === root) return JSON.stringify(evidence);
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("Artwork ancestors escaped the root");
    directory = parent;
  }
}

async function witness(file: string): Promise<Witness | null> {
  const before = stat(file);
  if (!before) return null;
  const size = Number((await fsp.lstat(file)).size);
  if (size > 32 * 1024 * 1024) throw new Error("Artwork exceeds the 32 MiB admission limit");
  const bytes = await fsp.readFile(file);
  if (stat(file) !== before) throw new Error("Artwork changed while hashing");
  return {stat:before,hash:createHash("sha256").update(bytes).digest("hex"),size};
}

/** Indexed owner probes. A catalogue-only item may reacquire its selected
 * artwork at import; an imported item needs an exact tracked library master. */
function ownership(identity: ArtworkIdentity): { exists: boolean; owned: boolean } {
  const id = String(identity.entityId);
  const scope = {
    Artist: {table:"ArtistMetadata",media:"artist_metadata_id",sidecar:"canonical_artist_mbid"},
    Album: {table:"Albums",media:"release_group_id",sidecar:"canonical_release_group_mbid"},
    Edition: {table:"AlbumEditions",media:"album_edition_id",sidecar:"canonical_release_mbid"},
    Video: {table:"Recordings",media:"recording_id",sidecar:"canonical_recording_mbid"},
  }[identity.coverEntity];
  const row = db.prepare(`SELECT id,mbid FROM ${scope.table} WHERE ${identity.coverEntity === "Video" ? "id=? AND is_video=1" : "mbid=?"}`)
    .get(id) as {id:number;mbid:string|null} | undefined;
  if (!row) return {exists:false,owned:false};
  return {exists:true,owned:Boolean(db.prepare(`SELECT 1 FROM TrackFiles WHERE ${scope.media}=? LIMIT 1`).get(row.id)
    || db.prepare(`SELECT 1 FROM MetadataFiles WHERE ${scope.sidecar}=? LIMIT 1`).get(row.mbid))};
}

function links(identity: ArtworkIdentity) {
  return db.prepare(`SELECT file.file_path,link.content_hash,link.metadata_file_id,file.library_root
    FROM ArtworkLibraryLinks link JOIN MetadataFiles file ON file.id=link.metadata_file_id
    WHERE link.cover_entity=? AND link.entity_id=? AND link.cover_type=?
    ORDER BY link.metadata_file_id LIMIT 50`).all(...artworkKey(identity)) as Array<{
      file_path:string;content_hash:string;metadata_file_id:number;library_root:string;
    }>;
}

/** One regular cache origin only. Heavy reads/decoding/hashing occur outside
 * writer admission. The prepared intent survives a process exit after unlink. */
export async function retireLegacyArtworkOrigin(commandId: number, identity: ArtworkIdentity, filename: string): Promise<void> {
  if (!/^[a-z0-9_-]+\.(jpg|jpeg|png|webp|gif)$/i.test(filename)
    || /-\d+\.[^.]+$/i.test(filename) || path.parse(filename).name !== identity.coverType) throw new Error("Not an artwork origin filename");
  const folder = getMediaCoverFolder(identity.entityId,identity.coverEntity);
  const root = path.dirname(getMediaCoverFolder("__root_probe__","Artist"));
  const origin = path.join(folder,filename);
  const heights = identity.coverEntity === "Video" ? [250] : [250,500];
  const proxyPaths = heights.map(height=>path.join(folder,`${identity.coverType}-${height}.jpg`));
  const candidates = links(identity);
  const release = await acquireMediaFileLocks([origin,...proxyPaths,...candidates.map(row=>row.file_path)]);
  let original: Witness | null = null;
  try {
    const previous = db.prepare("SELECT file_identity,source_snapshot,byte_size,phase FROM ArtworkCacheRetirement WHERE command_id=? AND source_path=?")
      .get(commandId,origin) as Intent | undefined;
    if (previous?.phase === "protected") return;
    original = await witness(origin);
    // The unlink already happened. Settling its durable accounting must not
    // rewrite a newer selected source or require yesterday's owner to persist.
    // This branch performs no filesystem mutation; a replaced origin is handled
    // below by the original physical witness and current ownership checks.
    if (!original && previous?.phase === "prepared") {
      await withSqliteWriteGate(()=>{
        if (stat(origin)!==null) throw new Error("Prepared origin was replaced during recovery");
        outcome(commandId,origin,"retired",null,null);
      },"settle completed artwork cache unlink");
      return;
    }
    if (!original && previous?.phase !== "prepared") return;
    const directories = ancestors(origin,root);
    if (previous?.phase === "retired" && original) throw new Error("Previously retired origin was externally replaced");
    if (previous?.phase === "prepared" && original && JSON.stringify(original)!==previous.file_identity) throw new Error("Prepared origin was externally replaced");
    let source = getSelectedArtworkSource(identity.entityId,identity.coverEntity,identity.coverType);
    if (!source || !normalizeArtworkUrl(source.url) || !source.contentHash
      || !["canonical","provider"].includes(source.fulfilledBy ?? "")) throw new Error("No recoverable selected artwork source");
    const owners = ownership(identity);
    if (!owners.exists) throw new Error("No authoritative catalogue owner");
    if (!hasCurrentArtworkProxies(identity,folder,source,heights)) {
      if (!original || original.hash !== source.contentHash) throw new Error("Selected proxies need repair from a verified source");
      const bytes = await fsp.readFile(origin);
      if (stat(origin) !== original.stat || createHash("sha256").update(bytes).digest("hex") !== original.hash) throw new Error("Origin changed before proxy derivation");
      const decoded = await decodeArtworkImage(bytes,path.extname(origin).toLowerCase().replace(/^\.jpeg$/,".jpg"));
      const derivatives = prepareResizedMediaCovers(bytes,path.extname(origin),heights,decoded);
      if (derivatives.length !== heights.length || !await commitArtworkProxies({identity,folder,source,expectedSource:source,
        derivatives,preferenceIsCurrent:()=>true})) throw new Error("Selected source changed during proxy publication");
      source = getSelectedArtworkSource(identity.entityId,identity.coverEntity,identity.coverType)!;
    }
    const proxies = await Promise.all(proxyPaths.map(witness));
    if (proxies.some(item=>!item) || !hasCurrentArtworkProxies(identity,folder,source,heights)) throw new Error("Proxy bytes do not match durable provenance");
    const proxyRows = () => db.prepare(`SELECT height,source_hash,content_hash,byte_size FROM ArtworkProxyVariants
      WHERE cover_entity=? AND entity_id=? AND cover_type=? ORDER BY height`).all(...artworkKey(identity));
    const proxySnapshot = JSON.stringify(proxyRows());
    let master: {row:typeof candidates[number];file:Witness;ancestors:string} | null = null;
    if (owners.owned) {
      for (const row of candidates) {
        if (row.content_hash !== source.contentHash || !artworkLinkOwnsTrackedPath(identity,row.file_path,row.metadata_file_id)) continue;
        try {
          const directoryEvidence = ancestors(row.file_path,path.resolve(row.library_root));
          const file = await witness(row.file_path);
          if (file?.hash === source.contentHash) {master={row,file,ancestors:directoryEvidence};break;}
        } catch { /* Never use an offline, linked or externally edited master. */ }
      }
      if (!master) throw new Error("Imported artwork has no exact tracked full-resolution master");
    }
    const snapshot = JSON.stringify({source,owners,master:master?.row ?? null,proxies:proxySnapshot});
    if (previous?.phase === "prepared" && previous.source_snapshot !== snapshot) throw new Error("Prepared retirement ownership or source changed");
    const check = () => {
      if (ancestors(origin,root)!==directories || (original ? stat(origin)!==original.stat : stat(origin)!==null)
        || JSON.stringify(getSelectedArtworkSource(identity.entityId,identity.coverEntity,identity.coverType))!==JSON.stringify(source)
        || JSON.stringify(ownership(identity))!==JSON.stringify(owners)
        || JSON.stringify(proxyRows())!==proxySnapshot
        || proxies.some((file,index)=>stat(proxyPaths[index])!==file!.stat)) throw new Error("Artwork retirement witnesses changed");
      if (master && (stat(master.row.file_path)!==master.file.stat
        || ancestors(master.row.file_path,path.resolve(master.row.library_root))!==master.ancestors
        || !artworkLinkOwnsTrackedPath(identity,master.row.file_path,master.row.metadata_file_id)
        || JSON.stringify(links(identity).find(row=>row.metadata_file_id===master!.row.metadata_file_id))!==JSON.stringify(master.row))) throw new Error("Library master ownership changed");
    };
    if (!previous) await withSqliteWriteGate(()=>{
      check();
      db.prepare(`INSERT INTO ArtworkCacheRetirement(command_id,source_path,file_identity,source_snapshot,byte_size,phase)
        VALUES (?,?,?,?,?,'prepared')`).run(commandId,origin,JSON.stringify(original),snapshot,original!.size);
    },"artwork cache retirement intent");
    await withSqliteWriteGate(()=>{
      check();
      if (original) fs.unlinkSync(origin);
      outcome(commandId,origin,"retired",original,null);
    },"retire witnessed artwork origin");
  } catch (error) {
    // A missing origin after a prepared unlink may mean the outcome transaction
    // failed. Keep the intent retryable rather than converting it to a terminal
    // protected row and losing recovery accounting.
    const pending = db.prepare("SELECT phase FROM ArtworkCacheRetirement WHERE command_id=? AND source_path=?")
      .get(commandId,origin) as {phase:string}|undefined;
    if (pending?.phase === "prepared" && stat(origin) === null) throw error;
    await withSqliteWriteGate(()=>outcome(commandId,origin,"protected",original,error instanceof Error ? error.message : String(error)),"protect artwork origin");
  } finally {release();}
}

/** Keep only the next bounded page, never a whole cache inventory in memory. */
export async function nextArtworkOrigins(directory: string, after: string, limit = 10): Promise<string[]> {
  return nextEntries(directory,after,limit,entry=>entry.isFile() && !entry.isSymbolicLink()
    && /^[a-z0-9_-]+\.(jpg|jpeg|png|webp|gif)$/i.test(entry.name) && !/-\d+\.[^.]+$/i.test(entry.name));
}

async function nextEntries(directory: string, after: string, limit: number, accept: (entry: fs.Dirent)=>boolean): Promise<string[]> {
  const page: string[] = [];
  const stream = await fsp.opendir(directory);
  for await (const entry of stream) {
    if (!accept(entry) || entry.name <= after) continue;
    if (page.length === limit && entry.name >= page[page.length-1]) continue;
    page.push(entry.name);page.sort();
    if (page.length>limit) page.pop();
  }
  return page;
}
