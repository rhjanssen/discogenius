import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import jpeg from "jpeg-js";
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
  for(let unit=0;unit<5 && !complete;unit++) {
    try {await work.runArtworkCacheWork(j,ctx);}
    catch(error) {
      assert.ok(error instanceof continuations.CommandContinuation);
      j.payload={...j.payload,...error.payloadPatch};continuationCount++;
      database.db.prepare("UPDATE commands SET payload=? WHERE id=?").run(JSON.stringify(j.payload),j.id);
    }
  }
  assert.ok(continuationCount>=2,"both admission and retirement are bounded work passes");
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


test("legacy edition selections are admitted before a release-group original can replace library artwork",async()=>{
  const j=job();
  database.db.prepare("INSERT INTO ArtistMetadata(mbid,name) VALUES ('legacy-artist','Legacy')").run();
  database.db.prepare("INSERT INTO Albums(mbid,artist_mbid,title) VALUES ('legacy-album','legacy-artist','Legacy')").run();
  const folder=covers.getMediaCoverFolder("legacy-album","Album");fs.mkdirSync(folder,{recursive:true});
  const master=path.join(root,"legacy-cover.jpg");
  const selected=jpeg.encode({width:4,height:4,data:Buffer.alloc(4*4*4,255)},70).data;
  const original=jpeg.encode({width:8,height:8,data:Buffer.alloc(8*8*4,255)},95).data;
  const hash=(bytes:Buffer|Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(master,selected);fs.writeFileSync(path.join(folder,"cover.jpg"),original);
  const owner=Number(database.db.prepare(`INSERT INTO MetadataFiles(artist_id,file_path,relative_path,library_root,
    extension,type,file_type,canonical_release_group_mbid) VALUES ('legacy-artist',?,'legacy-cover.jpg',?,'jpg','artwork','cover','legacy-album')`)
    .run(master,root).lastInsertRowid);
  database.db.prepare("INSERT INTO AlbumEditions(mbid,release_group_mbid,artist_mbid,title) VALUES ('legacy-edition','legacy-album','legacy-artist','Legacy edition')").run();
  database.db.prepare("UPDATE MetadataFiles SET canonical_release_mbid='legacy-edition' WHERE id=?").run(owner);
  const editionFolder=covers.getMediaCoverFolder("legacy-edition","Edition");fs.mkdirSync(editionFolder,{recursive:true});
  // Edition family follows Album, and has no original. Its currently selected
  // physical artwork must be visible before release-group retirement starts.
  for(const [assetFolder,assetBytes] of [[folder,original],[editionFolder,selected]] as const) {
    fs.writeFileSync(path.join(assetFolder,".cover.library.json"),JSON.stringify({sidecars:[{path:master,hash:hash(selected),metadataFileId:owner}]}));
    fs.writeFileSync(path.join(assetFolder,".cover.source.json"),JSON.stringify({url:"https://example.test/cover.jpg",preference:"canonical",
      fulfilledBy:"canonical",contentHash:hash(assetBytes)}));
  }
  let failure:unknown;
  for(let unit=0;unit<15;unit++) {
    try {await work.runArtworkCacheWork(j,{updateCommandDescription:()=>{},yieldToEventLoop:async()=>{}});assert.fail("conflicting asset must not report cleanup completion");}
    catch(error) {
      if (!(error instanceof continuations.CommandContinuation)) {failure=error;break;}
      j.payload={...j.payload,...error.payloadPatch};
      database.db.prepare("UPDATE commands SET payload=? WHERE id=?").run(JSON.stringify(j.payload),j.id);
    }
  }
  assert.match(String(failure),/another selected artwork asset/);
  assert.deepEqual(fs.readFileSync(master),selected);
  assert.deepEqual(fs.readFileSync(path.join(folder,"cover.jpg")),original);
  assert.equal((database.db.prepare("SELECT content_hash FROM ArtworkSources WHERE entity_id='legacy-edition' AND cover_entity='Edition'").get() as {content_hash:string}).content_hash,hash(selected));
});
