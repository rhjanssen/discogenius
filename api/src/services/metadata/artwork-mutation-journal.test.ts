import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { before, beforeEach, after, test } from "node:test";
import { createHash } from "node:crypto";
import * as jpeg from "jpeg-js";
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";

const {tempDir} = prepareActiveSchemaEnv("artwork-mutation-journal");
const folder = path.join(tempDir,"library"),destination = path.join(folder,"cover.jpg"),staged = path.join(folder,"new.tmp");
const scope = {coverEntity:"Album" as const,entityId:"journal-album",coverType:"cover"};
const image = (color:number) => Buffer.from(jpeg.encode({width:80,height:80,data:Buffer.alloc(80*80*4,color)},95).data);
const previous = image(60),replacement = image(180);
const hash = (bytes:Buffer) => createHash("sha256").update(bytes).digest("hex");
let database: Awaited<ReturnType<typeof openActiveSchemaDb>>;
let journal: typeof import("./artwork-mutation-journal.js").ArtworkMutationJournal;
let fileId: number;

before(async () => {
  database = await openActiveSchemaDb();
  journal = (await import("./artwork-mutation-journal.js")).ArtworkMutationJournal;
});
beforeEach(() => {
  for (const table of ["ArtworkMutationJournal","ArtworkLibraryLinks","ArtworkSources","FileMutationJournal","LibraryCleanupJournal","MetadataFiles"])
    database.db.prepare(`DELETE FROM ${table}`).run();
  fs.rmSync(folder,{recursive:true,force:true});fs.mkdirSync(folder);
  fs.writeFileSync(destination,previous);fs.writeFileSync(staged,replacement);
  fileId = Number(database.db.prepare(`INSERT INTO MetadataFiles
    (artist_id,file_path,relative_path,library_root,extension,type,file_type)
    VALUES ('artist',?,'cover.jpg',?,'jpg','AlbumImage','cover')`).run(destination,folder).lastInsertRowid);
  database.db.prepare(`INSERT INTO ArtworkSources(cover_entity,entity_id,cover_type,source_url,preference,content_hash)
    VALUES ('Album','journal-album','cover','https://example.com/new.jpg','canonical',?)`).run(hash(replacement));
  database.db.prepare(`INSERT INTO ArtworkLibraryLinks(cover_entity,entity_id,cover_type,file_path,content_hash,metadata_file_id)
    VALUES ('Album','journal-album','cover',?,?,?)`).run(destination,hash(previous),fileId);
});
after(() => closeActiveSchemaDb(database.dbModule,tempDir));
const prepare = () => database.dbModule.withSqliteWriteGate(() => journal.prepare(scope,destination,staged),"fixture artwork intent");
const reopen = () => { database.dbModule.closeDatabase();database.dbModule.initDatabase(); };
const recover = async () => (await import("../mediafiles/file-mutation-journal.js")).FileMutationJournal.recoverPending();

test("an unpublished artwork intent restores no bytes and removes only its staging file",async () => {
  await prepare();reopen();assert.deepEqual(await recover(),[]);
  assert.deepEqual(fs.readFileSync(destination),previous);
  assert.deepEqual(fs.readdirSync(folder),["cover.jpg"]);
  assert.equal(journal.hasPending(),false);
});

test("pending artwork recovery blocks further disk commands and restores the previous tracked image",async () => {
  const id=await prepare();journal.publish(id);
  const {CommandManager}=await import("../commands/command.js");
  assert.equal(CommandManager.canStartCommand("RetagFiles",{ids:[1]}).canStart,false);
  reopen();assert.deepEqual(await recover(),[]);
  assert.deepEqual(fs.readFileSync(destination),previous);
  const link = database.db.prepare("SELECT metadata_file_id FROM ArtworkLibraryLinks WHERE file_path=?").get(destination) as {metadata_file_id:number};
  assert.equal(link.metadata_file_id,fileId);
  assert.equal(CommandManager.canStartCommand("RetagFiles",{ids:[1]}).canStart,true);
});

test("a committed replacement retains the new image and removes its verified previous copy",async () => {
  const id=await prepare();journal.publish(id);
  database.db.transaction(() => {
    database.db.prepare("UPDATE ArtworkLibraryLinks SET content_hash=? WHERE file_path=?").run(hash(replacement),destination);
    journal.markCommitted(id);
  })();
  reopen();assert.deepEqual(await recover(),[]);
  assert.deepEqual(fs.readFileSync(destination),replacement);
  assert.deepEqual(fs.readdirSync(folder),["cover.jpg"]);
});

test("uncommitted newly created artwork disappears on recovery without removing a previous image",async () => {
  fs.unlinkSync(destination);
  const id=await prepare();journal.publish(id);
  reopen();assert.deepEqual(await recover(),[]);
  assert.deepEqual(fs.readdirSync(folder),[]);
});

test("external replacement with identical bytes is preserved and leaves actionable recovery evidence",async () => {
  const id=await prepare();journal.publish(id);
  const external=path.join(folder,"external.jpg");fs.writeFileSync(external,replacement);fs.renameSync(external,destination);
  reopen();const errors=await recover();assert.equal(errors.length,1);assert.match(errors[0],/destination changed/);
  assert.deepEqual(fs.readFileSync(destination),replacement);
  const row=database.db.prepare("SELECT backup_path,recovery_error FROM ArtworkMutationJournal WHERE id=?").get(id) as {backup_path:string;recovery_error:string};
  assert.deepEqual(fs.readFileSync(row.backup_path),previous);assert.match(row.recovery_error,/destination changed/);
  const {collectHealthDiagnosticsSnapshot}=await import("../commands/health.js");
  const health=collectHealthDiagnosticsSnapshot();
  const check=health.issues.find(check => check.scope === "files.recovery");
  assert.equal(check?.status,"error");assert.match(check!.message,/1 file mutation.*blocked/);
});

for (const column of ["canonical_release_mbid","artist_id"]) test(`changed ${column} ownership refuses rollback and preserves both image versions`,async () => {
  const id=await prepare();journal.publish(id);
  database.db.prepare(`UPDATE MetadataFiles SET ${column}='external-owner' WHERE id=?`).run(fileId);
  reopen();assert.match((await recover())[0],/ownership changed/);
  const row=database.db.prepare("SELECT backup_path FROM ArtworkMutationJournal WHERE id=?").get(id) as {backup_path:string};
  assert.deepEqual(fs.readFileSync(row.backup_path),previous);assert.deepEqual(fs.readFileSync(destination),replacement);
});

test("a newer catalogue source does not prevent file rollback or get reverted during recovery",async () => {
  const id=await prepare();journal.publish(id);
  database.db.prepare("UPDATE ArtworkSources SET source_url='https://example.com/newer.jpg' WHERE entity_id='journal-album'").run();
  reopen();assert.deepEqual(await recover(),[]);
  assert.deepEqual(fs.readFileSync(destination),previous);
  const source=database.db.prepare("SELECT source_url FROM ArtworkSources WHERE entity_id='journal-album'").get() as {source_url:string};
  assert.equal(source.source_url,"https://example.com/newer.jpg");
});

test("altered recovery copies are not discarded or copied over the selected image",async () => {
  const id=await prepare();journal.publish(id);
  const row=database.db.prepare("SELECT backup_path FROM ArtworkMutationJournal WHERE id=?").get(id) as {backup_path:string};
  fs.writeFileSync(row.backup_path,"externally edited artwork");
  reopen();assert.match((await recover())[0],/backup changed/);
  assert.equal(fs.readFileSync(row.backup_path,"utf8"),"externally edited artwork");
  assert.deepEqual(fs.readFileSync(destination),replacement);
});

test("publication refuses a file ownership change since intent",async () => {
  const id=await prepare();database.db.prepare("UPDATE MetadataFiles SET canonical_release_mbid='new-edition' WHERE id=?").run(fileId);
  assert.throws(() => journal.publish(id),/ownership changed/);
  assert.deepEqual(fs.readFileSync(destination),previous);assert.deepEqual(fs.readFileSync(staged),replacement);
});

for (const phase of ["before-publication","after-backup","before-provenance-commit","after-provenance-commit"]) {
  test(`real process exit ${phase} recovers selected artwork and its exact ownership`,async () => {
    // Exercise the production materializer, not a simulated file copy. A child
    // exiting with an open SQLite transaction must roll its provenance back.
    const sourceRun=import.meta.url.endsWith(".ts"),extension=sourceRun ? "ts" : "js";
    const journalUrl=new URL(`./artwork-mutation-journal.${extension}`,import.meta.url);
    const materializerUrl=new URL(`./media-cover-materialization.${extension}`,import.meta.url);
    const dbUrl=new URL(`../../database.${extension}`,import.meta.url);
    const child=spawnSync(process.execPath,[...(sourceRun ? ["--import","tsx"] : []),"--input-type=module","-e",`
      import fs from 'node:fs';
      const {initDatabase}=await import(${JSON.stringify(dbUrl.href)});initDatabase();
      const {ArtworkMutationJournal}=await import(${JSON.stringify(journalUrl.href)});
      const {materializeMediaCoverToFile}=await import(${JSON.stringify(materializerUrl.href)});
      globalThis.fetch=async()=>new Response(Buffer.from(${JSON.stringify(replacement.toString("base64"))},'base64'),{headers:{'content-type':'image/jpeg'}});
      const phase=${JSON.stringify(phase)};
      if(phase==='before-publication') ArtworkMutationJournal.publish=()=>process.exit(73);
      if(phase==='after-backup') fs.renameSync=()=>process.exit(73);
      if(phase==='before-provenance-commit') ArtworkMutationJournal.markCommitted=()=>process.exit(73);
      if(phase==='after-provenance-commit') ArtworkMutationJournal.recoverOneSync=()=>process.exit(73);
      await materializeMediaCoverToFile({...${JSON.stringify(scope)},outputPath:${JSON.stringify(destination)}});
      process.exit(74);
    `],{env:process.env,encoding:"utf8",windowsHide:true,timeout:30_000});
    assert.equal(child.status,73,child.stderr);
    reopen();assert.deepEqual(await recover(),[]);
    const committed=phase === "after-provenance-commit";
    assert.deepEqual(fs.readFileSync(destination),committed ? replacement : previous);
    const row=database.db.prepare("SELECT content_hash,metadata_file_id FROM ArtworkLibraryLinks WHERE file_path=?").get(destination) as {content_hash:string;metadata_file_id:number};
    assert.equal(row.content_hash,hash(committed ? replacement : previous));assert.equal(row.metadata_file_id,fileId);
    assert.deepEqual(fs.readdirSync(folder),["cover.jpg","new.tmp"],"The unrelated caller staging fixture remains untouched");
    assert.equal(journal.hasPending(),false);
  });
}

test("failed local-only artwork publication restores the old image without fetching",async () => {
  const {syncCachedMediaCoverToFile}=await import("./media-cover-service.js");
  // A tracked master in another folder supplies this local-only copy.
  const master=path.join(tempDir,"master.jpg");fs.writeFileSync(master,replacement);
  database.db.prepare(`INSERT INTO ArtworkLibraryLinks(cover_entity,entity_id,cover_type,file_path,content_hash)
    VALUES ('Album','journal-album','cover',?,?)`).run(master,hash(replacement));
  database.db.exec("CREATE TRIGGER reject_art_link BEFORE UPDATE ON ArtworkLibraryLinks BEGIN SELECT RAISE(ABORT,'fixture artwork provenance failure'); END");
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error("Local copy cannot fetch");};
  try {
    assert.throws(() => syncCachedMediaCoverToFile({...scope,outputPath:destination}),/fixture artwork provenance failure/);
    assert.deepEqual(fs.readFileSync(destination),previous);assert.equal(journal.hasPending(),false);
    assert.deepEqual(fs.readdirSync(folder),["cover.jpg","new.tmp"]);
  } finally {database.db.exec("DROP TRIGGER reject_art_link");globalThis.fetch=originalFetch;fs.rmSync(master,{force:true});}
});
