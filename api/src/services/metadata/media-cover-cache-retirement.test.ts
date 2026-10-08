import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { before, after, test } from "node:test";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"discogenius-cache-retirement-"));
process.env.DB_PATH=path.join(root,"active.db");
process.env.DISCOGENIUS_CONFIG_DIR=root;
let database: typeof import("../../database.js");
let service: typeof import("./media-cover-cache-retirement.js");
let covers: typeof import("./media-cover-service.js");
let state: typeof import("./media-cover-state.js");
let proxies: typeof import("./media-cover-proxy-storage.js");
before(async()=>{
  database=await import("../../database.js"); database.initDatabase();
  database.db.prepare("INSERT INTO ArtistMetadata(mbid,name) VALUES ('fixture','Fixture')").run();
  service=await import("./media-cover-cache-retirement.js");
  covers=await import("./media-cover-service.js");
  state=await import("./media-cover-state.js");
  proxies=await import("./media-cover-proxy-storage.js");
});
after(()=>{database.closeDatabase();fs.rmSync(root,{recursive:true,force:true});});
const bytes=jpeg.encode({width:8,height:8,data:Buffer.alloc(8*8*4,255)},82).data;
const hash=createHash("sha256").update(bytes).digest("hex");
let sequence=0;
async function fixture(imported=false, entity:"Album"|"Artist"="Album", coverType="cover") {
  const mbid=`retirement-${++sequence}`;
  if (entity === "Album") database.db.prepare("INSERT INTO Albums(mbid,artist_mbid,title) VALUES (?,'fixture','Test')").run(mbid);
  else database.db.prepare("INSERT INTO ArtistMetadata(mbid,name) VALUES (?,'Test')").run(mbid);
  const commandId=Number(database.db.prepare("INSERT INTO commands(name,payload) VALUES ('ConfigPrune','{}')").run().lastInsertRowid);
  const identity={coverEntity:entity,entityId:mbid,coverType};
  const folder=covers.getMediaCoverFolder(mbid,entity);fs.mkdirSync(folder,{recursive:true});
  const origin=path.join(folder,`${coverType}.jpg`);fs.writeFileSync(origin,bytes);
  const source={url:"https://example.test/cover.jpg",preference:"canonical" as const,fulfilledBy:"canonical" as const,contentHash:hash};
  state.storeArtworkSource(identity,source);
  await proxies.commitArtworkProxies({identity,folder,source,expectedSource:source,preferenceIsCurrent:()=>true,
    derivatives:[250,500].map(height=>({height,buffer:bytes}))});
  const master=path.join(root,`${mbid}.jpg`);
  if(imported) {
    fs.writeFileSync(master,bytes);
    const metadataId=Number(database.db.prepare(`INSERT INTO MetadataFiles
      (artist_id,file_path,relative_path,library_root,extension,type,file_type,${entity === 'Album' ? 'canonical_release_group_mbid' : 'canonical_artist_mbid'})
      VALUES ('fixture',?,?,?,'jpg','artwork','cover',?)`).run(master,path.basename(master),root,mbid).lastInsertRowid);
    const storage=await import("./media-cover-library-storage.js");
    storage.rememberLibraryCoverSidecar(identity,folder,master,hash,metadataId);
  }
  return {identity,folder,origin,commandId,master};
}

test("catalogue-only origin retires with durable selected proxies and repeat accounting is exact",async()=>{
  const f=await fixture();
  await service.retireLegacyArtworkOrigin(f.commandId,f.identity,"cover.jpg");
  assert.equal(fs.existsSync(f.origin),false);
  assert.equal(fs.existsSync(f.master),false);
  assert.equal(fs.existsSync(path.join(f.folder,"cover-500.jpg")),true);
  await service.retireLegacyArtworkOrigin(f.commandId,f.identity,"cover.jpg");
  assert.deepEqual(database.db.prepare("SELECT retired,protected,bytes FROM ArtworkCacheRuns WHERE command_id=?").get(f.commandId),
    {retired:1,protected:0,bytes:bytes.length});
});

test("imported origin retires only while its exact tracked full-resolution master survives",async()=>{
  const f=await fixture(true);
  await service.retireLegacyArtworkOrigin(f.commandId,f.identity,"cover.jpg");
  assert.equal(fs.existsSync(f.origin),false);
  assert.deepEqual(fs.readFileSync(f.master),bytes);
});

test("a row-preserving library rename remains a valid retirement master",async()=>{
  const f=await fixture(true);
  const renamed=`${f.master}.renamed.jpg`;
  fs.renameSync(f.master,renamed);
  database.db.prepare("UPDATE MetadataFiles SET file_path=? WHERE file_path=?").run(renamed,f.master);
  await service.retireLegacyArtworkOrigin(f.commandId,f.identity,"cover.jpg");
  assert.equal(fs.existsSync(f.origin),false);
  assert.deepEqual(fs.readFileSync(renamed),bytes);
});

test("selected full-resolution origin upgrades a tracked lower-resolution sidecar before retirement",async()=>{
  const f=await fixture(true);
  const small=jpeg.encode({width:4,height:4,data:Buffer.alloc(4*4*4,255)},70).data;
  fs.writeFileSync(f.master,small);
  const smallHash=createHash("sha256").update(small).digest("hex");
  database.db.prepare("UPDATE ArtworkLibraryLinks SET content_hash=? WHERE metadata_file_id IS NOT NULL AND entity_id=?").run(smallHash,f.identity.entityId);
  const owner=database.db.prepare("SELECT id FROM MetadataFiles WHERE file_path=?").get(f.master);
  await service.retireLegacyArtworkOrigin(f.commandId,f.identity,"cover.jpg");
  assert.equal(fs.existsSync(f.origin),false);
  assert.deepEqual(fs.readFileSync(f.master),bytes);
  assert.deepEqual(database.db.prepare("SELECT id FROM MetadataFiles WHERE file_path=?").get(f.master),owner);
});

test("same-byte canonical owner transfer protects the origin",async()=>{
  const f=await fixture(true);
  // Keep this album imported through a separate sidecar, while transferring
  // the selected master to another canonical owner without changing its bytes.
  database.db.prepare("UPDATE MetadataFiles SET canonical_release_group_mbid='other' WHERE file_path=?").run(f.master);
  database.db.prepare(`INSERT INTO MetadataFiles
    (artist_id,file_path,relative_path,library_root,extension,type,file_type,canonical_release_group_mbid)
    VALUES ('fixture',?,'album.nfo',?,'nfo','metadata','nfo',?)`).run(path.join(root,"album.nfo"),root,f.identity.entityId);
  await service.retireLegacyArtworkOrigin(f.commandId,f.identity,"cover.jpg");
  assert.deepEqual(fs.readFileSync(f.origin),bytes);
  assert.match((database.db.prepare("SELECT reason FROM ArtworkCacheRetirement WHERE command_id=?").get(f.commandId) as {reason:string}).reason,/exact tracked/);
});

test("tampered selected proxy refuses retirement when origin cannot repair the selected source",async()=>{
  const f=await fixture();
  fs.writeFileSync(path.join(f.folder,"cover-250.jpg"),"tampered");
  fs.writeFileSync(f.origin,"different legacy image");
  await service.retireLegacyArtworkOrigin(f.commandId,f.identity,"cover.jpg");
  assert.equal(fs.readFileSync(f.origin,"utf8"),"different legacy image");
  assert.match((database.db.prepare("SELECT reason FROM ArtworkCacheRetirement WHERE command_id=?").get(f.commandId) as {reason:string}).reason,/proxies need repair/);
});

test("outcome failure after unlink preserves prepared evidence and recovery counts once",async()=>{
  const f=await fixture(true);
  database.db.exec(`CREATE TRIGGER reject_retirement_outcome BEFORE UPDATE OF phase ON ArtworkCacheRetirement
    WHEN NEW.phase='retired' BEGIN SELECT RAISE(ABORT,'injected outcome failure'); END;`);
  try {
    await assert.rejects(service.retireLegacyArtworkOrigin(f.commandId,f.identity,"cover.jpg"),/injected outcome failure/);
    assert.equal(fs.existsSync(f.origin),false);
    assert.deepEqual(fs.readFileSync(f.master),bytes);
    assert.equal((database.db.prepare("SELECT phase FROM ArtworkCacheRetirement WHERE command_id=?").get(f.commandId) as {phase:string}).phase,"prepared");
    assert.throws(()=>database.db.prepare("DELETE FROM commands WHERE id=?").run(f.commandId),/Recover prepared artwork/);
  } finally {database.db.exec("DROP TRIGGER reject_retirement_outcome");}
  const cacheRoot=path.dirname(covers.getMediaCoverFolder("probe","Artist"));
  assert.equal(await service.recoverPreparedArtworkRetirements(cacheRoot,async()=>{}),false);
  assert.deepEqual(database.db.prepare("SELECT retired,protected,bytes FROM ArtworkCacheRuns WHERE command_id=?").get(f.commandId),
    {retired:1,protected:0,bytes:bytes.length});
  database.db.prepare("DELETE FROM commands WHERE id=?").run(f.commandId);
  assert.equal(database.db.prepare("SELECT 1 FROM ArtworkCacheRetirement WHERE command_id=?").get(f.commandId),undefined);
});

test("cross-command recovery rejects another cache root and preserves the old intent",async()=>{
  const f=await fixture(true);
  database.db.exec(`CREATE TRIGGER reject_retirement_outcome BEFORE UPDATE OF phase ON ArtworkCacheRetirement
    WHEN NEW.phase='retired' BEGIN SELECT RAISE(ABORT,'injected outcome failure'); END;`);
  try {await assert.rejects(service.retireLegacyArtworkOrigin(f.commandId,f.identity,"cover.jpg"),/injected/);}
  finally {database.db.exec("DROP TRIGGER reject_retirement_outcome");}
  await assert.rejects(service.recoverPreparedArtworkRetirements(path.join(root,"other-cache"),async()=>{}),/escaped/);
  assert.equal((database.db.prepare("SELECT phase FROM ArtworkCacheRetirement WHERE command_id=?").get(f.commandId) as {phase:string}).phase,"prepared");
  // A subsequent legitimate source switch must not keep the already-finished
  // unlink unresolved, or cause recovery to overwrite the new selection.
  const changedSource={url:"https://example.test/new-cover.jpg",preference:"provider" as const,fulfilledBy:"provider" as const,contentHash:"new-selected-hash"};
  state.storeArtworkSource(f.identity,changedSource);
  assert.equal(await service.recoverPreparedArtworkRetirements(path.dirname(covers.getMediaCoverFolder("probe","Artist")),async()=>{}),false);
  assert.deepEqual(state.readArtworkSource(f.identity,f.folder),changedSource);
  assert.deepEqual(fs.readFileSync(f.master),bytes);
});


test("externally edited legacy sidecar is preserved with its selected cache origin",async()=>{
  const f=await fixture(true);
  const edited=jpeg.encode({width:4,height:4,data:Buffer.alloc(4*4*4,100)},70).data;
  database.db.prepare("UPDATE ArtworkLibraryLinks SET content_hash='previous-publication' WHERE entity_id=?").run(f.identity.entityId);
  fs.writeFileSync(f.master,edited);
  await service.retireLegacyArtworkOrigin(f.commandId,f.identity,"cover.jpg");
  assert.deepEqual(fs.readFileSync(f.master),edited);
  assert.deepEqual(fs.readFileSync(f.origin),bytes);
  assert.match((database.db.prepare("SELECT reason FROM ArtworkCacheRetirement WHERE command_id=?").get(f.commandId) as {reason:string}).reason,/changed outside/);
});

test("release-group adoption cannot overwrite another selected artwork role at the same tracked path",async()=>{
  const f=await fixture(true);
  const small=jpeg.encode({width:4,height:4,data:Buffer.alloc(4*4*4,255)},70).data;
  const smallHash=createHash("sha256").update(small).digest("hex");
  fs.writeFileSync(f.master,small);
  database.db.prepare("UPDATE ArtworkLibraryLinks SET content_hash=? WHERE entity_id=?").run(smallHash,f.identity.entityId);
  const competing={...f.identity,coverType:"alternate"};
  state.storeArtworkSource(competing,{url:"https://example.test/alternate.jpg",preference:"canonical",fulfilledBy:"canonical",contentHash:smallHash});
  const metadataId=(database.db.prepare("SELECT id FROM MetadataFiles WHERE file_path=?").get(f.master) as {id:number}).id;
  const storage=await import("./media-cover-library-storage.js");
  storage.rememberLibraryCoverSidecar(competing,f.folder,f.master,smallHash,metadataId);
  await service.retireLegacyArtworkOrigin(f.commandId,f.identity,"cover.jpg");
  assert.deepEqual(fs.readFileSync(f.master),small);
  assert.deepEqual(fs.readFileSync(f.origin),bytes);
  assert.match((database.db.prepare("SELECT reason FROM ArtworkCacheRetirement WHERE command_id=?").get(f.commandId) as {reason:string}).reason,/another selected artwork asset/);
});

test("PNG origin adoption retains full dimensions and repairs proxies against the converted JPEG master",async()=>{
  const f=await fixture(true);
  const png=PNG.sync.write({width:16,height:12,data:Buffer.alloc(16*12*4,255)} as PNG);
  const pngHash=createHash("sha256").update(png).digest("hex");
  fs.unlinkSync(f.origin);
  const origin=path.join(f.folder,"cover.png");fs.writeFileSync(origin,png);
  state.storeArtworkSource(f.identity,{url:"https://example.test/cover.png",preference:"canonical",fulfilledBy:"canonical",contentHash:pngHash});
  await service.retireLegacyArtworkOrigin(f.commandId,f.identity,"cover.png");
  assert.equal(fs.existsSync(origin),false);
  const master=fs.readFileSync(f.master);
  const decoded=jpeg.decode(master);
  assert.deepEqual([decoded.width,decoded.height],[16,12]);
  const selected=covers.getSelectedArtworkSource(f.identity.entityId,"Album","cover")!;
  assert.equal(selected.contentHash,createHash("sha256").update(master).digest("hex"));
  assert.equal(proxies.hasCurrentArtworkProxies(f.identity,f.folder,selected,[250,500]),true);
});


test("sidecar-only artist secondary artwork adopts the full master without creating extra images",async()=>{
  const f=await fixture(true,"Artist","fanart");
  const small=jpeg.encode({width:4,height:4,data:Buffer.alloc(4*4*4,255)},70).data;
  const smallHash=createHash("sha256").update(small).digest("hex");
  fs.writeFileSync(f.master,small);
  database.db.prepare("UPDATE ArtworkLibraryLinks SET content_hash=? WHERE entity_id=?").run(smallHash,f.identity.entityId);
  const owner=database.db.prepare("SELECT id FROM MetadataFiles WHERE file_path=?").get(f.master);
  const before=fs.readdirSync(root).sort();
  await service.retireLegacyArtworkOrigin(f.commandId,f.identity,"fanart.jpg");
  assert.equal(fs.existsSync(f.origin),false);
  assert.deepEqual(fs.readFileSync(f.master),bytes);
  assert.deepEqual(database.db.prepare("SELECT id FROM MetadataFiles WHERE file_path=?").get(f.master),owner);
  assert.deepEqual(fs.readdirSync(root).sort(),before);
});
