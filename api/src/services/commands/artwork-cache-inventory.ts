import fs from "node:fs";
import fsp from "node:fs/promises";
import { db, withSqliteWriteGate } from "../../database.js";

function directoryWitness(directory: string): string {
  const stat=fs.lstatSync(directory,{bigint:true});
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Artwork inventory directory is unavailable or linked");
  return [stat.dev,stat.ino,stat.mtimeNs,stat.ctimeNs].join(":");
}

/** Stream each family once into indexed, bounded batches. A restarted unfinished
 * enumeration repeats the stream, not deletion; completed pages are DB ranges. */
export async function ensureArtworkFolderInventory(options: {
  commandId: number; family: number; directory: string; excluded?: readonly string[];
  checkpoint: (count: number)=>Promise<void>;
}): Promise<void> {
  const {commandId,family,directory}=options;
  const identity=directoryWitness(directory);
  const row=db.prepare("SELECT directory,directory_identity,complete FROM ArtworkCacheInventories WHERE command_id=? AND family=?")
    .get(commandId,family) as {directory:string;directory_identity:string;complete:number}|undefined;
  if (row && (row.directory!==directory || row.directory_identity!==identity)) throw new Error("Artwork folder inventory changed; start a fresh cleanup");
  if (row?.complete) return;
  await withSqliteWriteGate(()=>{
    db.prepare(`INSERT INTO ArtworkCacheInventories(command_id,family,directory,directory_identity)
      VALUES (?,?,?,?) ON CONFLICT DO NOTHING`).run(commandId,family,directory,identity);
  },"start artwork folder inventory");
  let batch:string[]=[];
  let count=0;
  const flush=async()=>{
    const names=batch; batch=[];
    await withSqliteWriteGate(()=>{
      if (directoryWitness(directory)!==identity) throw new Error("Artwork directory changed during inventory");
      const insert=db.prepare("INSERT INTO ArtworkCacheFolders(command_id,family,name) VALUES (?,?,?) ON CONFLICT DO NOTHING");
      db.transaction(()=>{for (const name of names) insert.run(commandId,family,name);})();
    },"index artwork folder batch");
    await options.checkpoint(count);
  };
  const stream=await fsp.opendir(directory);
  for await (const entry of stream) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".") || options.excluded?.includes(entry.name)) continue;
    batch.push(entry.name); count++;
    if (batch.length===128) await flush();
  }
  if (batch.length) await flush();
  await withSqliteWriteGate(()=>{
    if (directoryWitness(directory)!==identity) throw new Error("Artwork directory changed during inventory");
    db.prepare("UPDATE ArtworkCacheInventories SET complete=1 WHERE command_id=? AND family=?").run(commandId,family);
  },"complete artwork folder inventory");
}

export function nextInventoriedArtworkFolders(commandId: number, family: number, after: string, limit=25): string[] {
  return (db.prepare(`SELECT name FROM ArtworkCacheFolders WHERE command_id=? AND family=? AND name>?
    ORDER BY name LIMIT ?`).all(commandId,family,after,limit) as Array<{name:string}>).map(row=>row.name);
}

/** Directory timestamps can share a filesystem clock tick. Compare membership
 * once at completion as well, without re-enumerating for every work page. */
export async function validateArtworkFolderInventory(options: {
  commandId:number;family:number;directory:string;excluded?:readonly string[];checkpoint:()=>Promise<void>;
}):Promise<void> {
  const row=db.prepare("SELECT directory,directory_identity,complete FROM ArtworkCacheInventories WHERE command_id=? AND family=?")
    .get(options.commandId,options.family) as {directory:string;directory_identity:string;complete:number}|undefined;
  if (!row) return;
  if (!row.complete || row.directory!==options.directory || row.directory_identity!==directoryWitness(options.directory)) throw new Error("Artwork folder inventory changed before completion");
  const find=db.prepare("SELECT 1 FROM ArtworkCacheFolders WHERE command_id=? AND family=? AND name=?");
  let count=0;
  const stream=await fsp.opendir(options.directory);
  for await(const entry of stream) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".") || options.excluded?.includes(entry.name)) continue;
    if (!find.get(options.commandId,options.family,entry.name)) throw new Error("Artwork folder membership changed before completion");
    count++;
    if (count%128===0) await options.checkpoint();
  }
  const expected=db.prepare("SELECT COUNT(*) AS count FROM ArtworkCacheFolders WHERE command_id=? AND family=?")
    .get(options.commandId,options.family) as {count:number};
  if (count!==expected.count || row.directory_identity!==directoryWitness(options.directory)) throw new Error("Artwork folder membership changed before completion");
}
