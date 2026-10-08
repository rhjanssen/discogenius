import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {before,after,test} from "node:test";
import type {CommandModelOf} from "./command-model.js";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"discogenius-artwork-work-"));
process.env.DB_PATH=path.join(root,"active.db");process.env.DISCOGENIUS_CONFIG_DIR=root;
let database: typeof import("../../database.js");
let work: typeof import("./artwork-cache-work.js");
let covers: typeof import("../metadata/media-cover-service.js");
let continuations: typeof import("./command-continuation.js");
before(async()=>{
  database=await import("../../database.js");database.initDatabase();
  work=await import("./artwork-cache-work.js");covers=await import("../metadata/media-cover-service.js");
  continuations=await import("./command-continuation.js");
});
after(()=>{database.closeDatabase();fs.rmSync(root,{recursive:true,force:true});});
function job():CommandModelOf<"ConfigPrune"> {
  const id=Number(database.db.prepare("INSERT INTO commands(name,payload) VALUES ('ConfigPrune',?)").run('{"cleanupArtworkCache":true}').lastInsertRowid);
  return {id,name:"ConfigPrune",payload:{cleanupArtworkCache:true},status:"started",progress:0,priority:0,attempts:0,attempt:1,created_at:new Date().toISOString()};
}

test("bounded work continues the same command and completes an indexed folder inventory",async()=>{
  const j=job();
  for(let index=0;index<30;index++) fs.mkdirSync(covers.getMediaCoverFolder(`empty-${index}`,"Album"),{recursive:true});
  let complete=false;
  let continuationCount=0;
  const ctx={updateCommandDescription:(update:{progress?:number})=>{if(update.progress===100)complete=true;},yieldToEventLoop:async()=>{}};
  try {await work.runArtworkCacheWork(j,ctx);assert.fail("first work unit must yield");}
  catch(error) {
    assert.ok(error instanceof continuations.CommandContinuation);
    j.payload={...j.payload,...error.payloadPatch};continuationCount++;
    database.db.prepare("UPDATE commands SET payload=? WHERE id=?").run(JSON.stringify(j.payload),j.id);
  }
  assert.equal(complete,false);assert.equal(continuationCount,1);
  await work.runArtworkCacheWork(j,ctx);
  assert.equal(complete,true);
  assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM commands").get() as {count:number}).count,1);
});

test("a disappeared cache root cannot complete a resumed cleanup",async()=>{
  const j=job();const cache=path.dirname(covers.getMediaCoverFolder("probe","Artist"));
  j.payload.artworkCacheWork={version:1,root:cache,rootIdentity:"previous",family:0,after:""};
  fs.renameSync(cache,`${cache}.offline`);
  try {
    await assert.rejects(work.runArtworkCacheWork(j,{updateCommandDescription:()=>assert.fail("must not report completion")}),/disappeared/);
  } finally {fs.renameSync(`${cache}.offline`,cache);}
});
