import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {before,after,test} from "node:test";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"discogenius-artwork-inventory-"));
process.env.DB_PATH=path.join(root,"active.db");
process.env.DISCOGENIUS_CONFIG_DIR=root;
let database: typeof import("../../database.js");
let inventory: typeof import("./artwork-cache-inventory.js");
before(async()=>{database=await import("../../database.js");database.initDatabase();inventory=await import("./artwork-cache-inventory.js");});
after(()=>{database.closeDatabase();fs.rmSync(root,{recursive:true,force:true});});
let sequence=0;
function fixture(count: number) {
  const commandId=Number(database.db.prepare("INSERT INTO commands(name,payload) VALUES ('ConfigPrune','{}')").run().lastInsertRowid);
  const directory=path.join(root,`folders-${++sequence}`);fs.mkdirSync(directory);
  for(let index=count-1;index>=0;index--) fs.mkdirSync(path.join(directory,`album-${String(index).padStart(6,"0")}`));
  return {commandId,family:0,directory};
}

test("bounded indexed folder pages are exact and completed inventory does not enumerate again",async()=>{
  const f=fixture(300);fs.mkdirSync(path.join(f.directory,".staging"));fs.mkdirSync(path.join(f.directory,"excluded"));
  let batches=0;
  await inventory.ensureArtworkFolderInventory({...f,excluded:["excluded"],checkpoint:async()=>{batches++;}});
  assert.equal(batches,3);
  const names:string[]=[];
  let after="";
  while(true) {
    const page=inventory.nextInventoriedArtworkFolders(f.commandId,f.family,after);
    if(!page.length) break;
    assert.ok(page.length<=25);names.push(...page);after=page.at(-1)!;
  }
  assert.equal(names.length,300);assert.equal(new Set(names).size,300);
  assert.equal(names[0],"album-000000");assert.equal(names.at(-1),"album-000299");
  await inventory.ensureArtworkFolderInventory({...f,checkpoint:async()=>{throw new Error("unexpected re-enumeration");}});
  const plan=database.db.prepare(`EXPLAIN QUERY PLAN SELECT name FROM ArtworkCacheFolders
    WHERE command_id=? AND family=? AND name>? ORDER BY name LIMIT 25`).all(f.commandId,0,"") as Array<{detail:string}>;
  assert.ok(plan.some(row=>row.detail.includes("SEARCH") && row.detail.includes("name>")),JSON.stringify(plan));
});

test("interrupted enumeration resumes without duplicate rows or false completion",async()=>{
  const f=fixture(260);
  await assert.rejects(inventory.ensureArtworkFolderInventory({...f,checkpoint:async()=>{throw new Error("cancel boundary");}}),/cancel boundary/);
  assert.equal((database.db.prepare("SELECT complete FROM ArtworkCacheInventories WHERE command_id=?").get(f.commandId) as {complete:number}).complete,0);
  await inventory.ensureArtworkFolderInventory({...f,checkpoint:async()=>{}});
  assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM ArtworkCacheFolders WHERE command_id=?").get(f.commandId) as {count:number}).count,260);
});

test("changed folder membership invalidates a completed inventory before more retirement",async()=>{
  const f=fixture(1);await inventory.ensureArtworkFolderInventory({...f,checkpoint:async()=>{}});
  fs.mkdirSync(path.join(f.directory,"new-external-owner"));
  await assert.rejects(inventory.validateArtworkFolderInventory({...f,checkpoint:async()=>{}}),/changed/);
});
