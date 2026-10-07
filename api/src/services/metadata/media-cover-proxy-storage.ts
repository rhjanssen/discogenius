import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db, withSqliteWriteGate } from "../../database.js";
import { artworkKey, readArtworkSource, storeArtworkSource, type ArtworkIdentity, type ArtworkSource } from "./media-cover-state.js";

const hash = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

/** A source marker alone cannot prove a cache survived a partial write. Verify
 * every required derivative against the recorded source and JPEG byte hash. */
export function hasCurrentArtworkProxies(identity: ArtworkIdentity, folder: string, source: ArtworkSource, heights: readonly number[]): boolean {
  const rows = db.prepare(`SELECT height,source_hash,content_hash,byte_size FROM ArtworkProxyVariants
    WHERE cover_entity=? AND entity_id=? AND cover_type=?`).all(...artworkKey(identity)) as Array<{
      height:number;source_hash:string;content_hash:string;byte_size:number;
    }>;
  return heights.every(height => {
    const row=rows.find(candidate=>candidate.height===height);
    if (!row || row.source_hash!==source.contentHash) return false;
    try {
      const file=path.join(folder,`${identity.coverType}-${height}.jpg`),stat=fs.lstatSync(file);
      return stat.isFile() && !stat.isSymbolicLink() && stat.size===row.byte_size && hash(fs.readFileSync(file))===row.content_hash;
    } catch { return false; }
  });
}

/** Stage only disposable proxies outside writer admission. Source/proxy records
 * and file publication share a short admitted transaction. If a process dies
 * between file renames, stored hashes force repair on the next artwork refresh.
 * Legacy masters/JSON are retained for the separate witnessed migration. */
export async function commitArtworkProxies(options: {
  identity: ArtworkIdentity; folder: string; source: ArtworkSource; expectedSource: ArtworkSource|null;
  derivatives: Array<{height:number;buffer:Buffer}>; preferenceIsCurrent:()=>boolean;
}): Promise<boolean> {
  const {identity,folder,source}=options;
  if (!/^[a-z0-9_-]+$/i.test(identity.coverType) || !source.contentHash || !options.derivatives.length
    || options.derivatives.some(item=>![250,500].includes(item.height))) throw new Error("Invalid artwork proxy publication");
  fs.mkdirSync(folder,{recursive:true});
  const nonce=crypto.randomUUID();
  const files=options.derivatives.map(item=>({ ...item,contentHash:hash(item.buffer),
    target:path.join(folder,`${identity.coverType}-${item.height}.jpg`),
    temp:path.join(folder,`.${identity.coverType}-${item.height}.${nonce}.tmp`),
  }));
  try {
    for(const file of files) fs.writeFileSync(file.temp,file.buffer);
    return await withSqliteWriteGate(()=>{
      if (!options.preferenceIsCurrent() || JSON.stringify(readArtworkSource(identity,folder))!==JSON.stringify(options.expectedSource)) return false;
      db.transaction(()=>{
        storeArtworkSource(identity,source);
        db.prepare("DELETE FROM ArtworkProxyVariants WHERE cover_entity=? AND entity_id=? AND cover_type=?").run(...artworkKey(identity));
        const insert=db.prepare(`INSERT INTO ArtworkProxyVariants
          (cover_entity,entity_id,cover_type,height,source_hash,content_hash,byte_size) VALUES (?,?,?,?,?,?,?)`);
        for(const file of files) insert.run(...artworkKey(identity),file.height,source.contentHash,file.contentHash,file.buffer.length);
        for(const file of files) fs.renameSync(file.temp,file.target);
      })();
      return true;
    },"publish artwork display proxies");
  } finally {
    for(const file of files) fs.rmSync(file.temp,{force:true});
  }
}
