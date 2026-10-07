import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";
import type { CommandHandlerContext } from "../commands/handlers/handler-context.js";
import type { CommandModelOf } from "../commands/command-model.js";

const {tempDir}=prepareActiveSchemaEnv("library-cleanup-journal");
let database:Awaited<ReturnType<typeof openActiveSchemaDb>>;
let journal:typeof import("./library-cleanup-journal.js").LibraryCleanupJournal;
let config:typeof import("../config/config.js");
let queue:typeof import("../commands/command-queue-manager.js");
let root:string,file:string,inventoryId:number;
const ctx:CommandHandlerContext={updateCommandDescription:()=>{},formatArtistPhaseDescription:()=>"",formatWorkflowCommandLabel:()=>"",
    resolveArtistLabel:()=>"",yieldToEventLoop:()=>new Promise(resolve=>setImmediate(resolve))};

before(async()=>{
    database=await openActiveSchemaDb(); journal=(await import("./library-cleanup-journal.js")).LibraryCleanupJournal;
    config=await import("../config/config.js"); queue=await import("../commands/command-queue-manager.js");
});
beforeEach(async()=>{
    for(const table of ["LibraryCleanupJournal","FileMutationJournal","commands","MetadataFiles","LyricFiles","ExtraFiles","TrackFiles","UnmappedFiles"])
        database.db.prepare(`DELETE FROM ${table}`).run();
    root=fs.mkdtempSync(path.join(tempDir,"root-")); file=path.join(root,"leftover.json"); fs.writeFileSync(file,"original leftover");
    const cfg=config.readConfig(); cfg.path.music_path=root; cfg.path.spatial_path=path.join(root,"spatial"); cfg.path.video_path=path.join(root,"videos");
    fs.mkdirSync(cfg.path.spatial_path); fs.mkdirSync(cfg.path.video_path); config.writeConfig(cfg);
    inventoryId=queue.CommandQueueManager.push(queue.CommandNames.RescanFolders,{});
    const scan=await import("../commands/scan-work.js"),inventory=await import("../commands/root-inventory-work.js"),outcome=await import("../commands/command-context.js");
    for(let unit=0;unit<20;unit++){
        const job=queue.CommandQueueManager.claimForExecution(inventoryId,"cleanup-test",60_000)! as CommandModelOf<"RescanFolders">;
        try {
            await scan.runScanWorkUnit(job,()=>[],async()=>{throw new Error("No artists in fixture");},async()=>{await inventory.runRootInventoryWorkUnit(job,ctx);return 0;});
            assert.equal(queue.CommandQueueManager.complete(job.id,job.worker_id!),true);return;
        }catch(error){assert.equal(await outcome.persistCommandOutcome(job,error),"requeued");}
    }
    throw new Error("Fixture inventory did not settle");
});
afterEach(()=>{database.db.prepare("DELETE FROM LibraryCleanupJournal").run();fs.rmSync(root,{recursive:true,force:true});});
after(()=>closeActiveSchemaDb(database.dbModule,tempDir));
const prepare=()=>journal.prepare({inventoryCommandId:inventoryId,filePath:file,rootPath:root});
const review=()=>Number(database.db.prepare(`INSERT INTO UnmappedFiles(file_path,relative_path,filename,extension,library_root,file_size,ignored)
    VALUES (?,'leftover.json','leftover.json','json','music',17,1)`).run(file).lastInsertRowid);

test("cleanup staging survives restart and history removal, restoring uncommitted bytes",async()=>{
    const id=await prepare();journal.stage(id);
    const {FileMutationJournal}=await import("./file-mutation-journal.js");
    assert.equal(FileMutationJournal.hasPending(),true);
    const {CommandManager}=await import("../commands/command.js");
    assert.equal(CommandManager.canStartCommand("RetagFiles",{ids:[1]}).canStart,false);
    database.db.prepare("DELETE FROM commands WHERE id=?").run(inventoryId);
    database.dbModule.closeDatabase();database.dbModule.initDatabase();
    assert.deepEqual(await FileMutationJournal.recoverPending(),[]);
    assert.equal(fs.readFileSync(file,"utf8"),"original leftover");assert.equal(FileMutationJournal.hasPending(),false);
});

test("an abruptly exited real cleanup process leaves recoverable intent and exact original bytes",async()=>{
    const sourceRun=import.meta.url.endsWith(".ts");
    const extension=sourceRun ? "ts" : "js";
    const moduleUrl=new URL(`./library-cleanup-journal.${extension}`,import.meta.url);
    assert.equal(fs.existsSync(fileURLToPath(moduleUrl)),true);
    const dbUrl=new URL(`../../database.${extension}`,moduleUrl);
    const child=spawnSync(process.execPath,[...(sourceRun ? ["--import","tsx"] : []),"--input-type=module","-e",`
        const {initDatabase}=await import(${JSON.stringify(dbUrl.href)});initDatabase();
        const {LibraryCleanupJournal}=await import(${JSON.stringify(moduleUrl.href)});
        const id=await LibraryCleanupJournal.prepare(${JSON.stringify({inventoryCommandId:inventoryId,filePath:file,rootPath:root})});
        LibraryCleanupJournal.stage(id);process.exit(73);
    `],{env:process.env,encoding:"utf8",windowsHide:true,timeout:30_000});
    assert.equal(child.status,73,child.stderr);
    assert.equal(fs.existsSync(file),false);assert.equal(journal.hasPending(),true);
    database.dbModule.closeDatabase();database.dbModule.initDatabase();
    const {FileMutationJournal}=await import("./file-mutation-journal.js");
    assert.deepEqual(await FileMutationJournal.recoverPending(),[]);
    assert.equal(fs.readFileSync(file,"utf8"),"original leftover");assert.equal(journal.hasPending(),false);
});

test("cleanup protects existing review media unless its exact disposition is explicit",async()=>{
    const id=review();await assert.rejects(prepare(),/ownership changed/);
    const intent=await journal.prepare({inventoryCommandId:inventoryId,filePath:file,rootPath:root,discardReviewId:id});
    const staged=journal.stage(intent);await journal.commit(intent);
    assert.equal(database.db.prepare("SELECT id FROM UnmappedFiles WHERE id=?").get(id),undefined);
    database.dbModule.closeDatabase();database.dbModule.initDatabase();
    assert.deepEqual(await journal.recoverPending(),[]);assert.equal(fs.existsSync(staged),false);assert.equal(fs.existsSync(file),false);
});

test("cleanup cannot remove a cover or lyric awaiting sidecar reconciliation",async()=>{
    for(const name of ["cover.jpg","Unknown.lrc"]){
        const sidecar=path.join(root,name);fs.writeFileSync(sidecar,"original sidecar");
        await assert.rejects(journal.prepare({inventoryCommandId:inventoryId,filePath:sidecar,rootPath:root}),/sidecar ownership/);
        assert.equal(fs.readFileSync(sidecar,"utf8"),"original sidecar");
    }
    assert.equal(journal.hasPending(),false);
});
test("cleanup protects every media extension already recognized by artist scans",async()=>{
    for(const extension of ["ape","mp2","webm","ts"]){
        const media=path.join(root,`unidentified.${extension}`);fs.writeFileSync(media,"pending identification");
        await assert.rejects(journal.prepare({inventoryCommandId:inventoryId,filePath:media,rootPath:root}),/Applicable media/);
        assert.equal(fs.existsSync(media),true);
    }
});

test("a failed review deletion commit restores bytes and the ignored review identity",async()=>{
    const id=review();const intent=await journal.prepare({inventoryCommandId:inventoryId,filePath:file,rootPath:root,discardReviewId:id});journal.stage(intent);
    database.db.exec("CREATE TRIGGER fail_cleanup_review BEFORE DELETE ON UnmappedFiles BEGIN SELECT RAISE(ABORT,'cleanup commit fault'); END;");
    try{await assert.rejects(journal.commit(intent),/cleanup commit fault/);}finally{database.db.exec("DROP TRIGGER fail_cleanup_review");}
    await journal.recoverOne(intent);assert.equal(fs.readFileSync(file,"utf8"),"original leftover");
    assert.equal((database.db.prepare("SELECT ignored FROM UnmappedFiles WHERE id=?").get(id) as {ignored:number}).ignored,1);
});

test("a concurrent file ownership claim prevents cleanup and remains after restoration",async()=>{
    const intent=await prepare();
    database.db.prepare(`INSERT INTO TrackFiles(file_path,filename,relative_path,library_root,extension,file_type)
        VALUES (?,'leftover.json','leftover.json',?,'json','track')`).run(file,root);
    assert.throws(()=>journal.stage(intent),/ownership changed/);await journal.recoverOne(intent);
    assert.equal(fs.existsSync(file),true);assert.ok(database.db.prepare("SELECT id FROM TrackFiles WHERE file_path=?").get(file));
});

test("settings changes between staging and commit preserve the staged file",async()=>{
    const intent=await prepare();journal.stage(intent);const cfg=config.readConfig();cfg.naming.artist_folder="changed";
    // Naming is not a scan setting. Change a path that invalidates inventory.
    cfg.path.video_path=path.join(root,"new-video-root");fs.mkdirSync(cfg.path.video_path);config.writeConfig(cfg);
    await assert.rejects(journal.commit(intent),/complete current library inventory/);
    await journal.recoverOne(intent);assert.equal(fs.readFileSync(file,"utf8"),"original leftover");
});

test("replacing any inventoried root blocks cleanup, including unused roots",async()=>{
    const intent=await prepare(),spatial=config.Config.getSpatialPath(),saved=spatial+"-saved";
    fs.renameSync(spatial,saved);fs.mkdirSync(spatial);
    try{assert.throws(()=>journal.stage(intent),/root was replaced/);}finally{fs.rmdirSync(spatial);fs.renameSync(saved,spatial);}
    await journal.recoverOne(intent);assert.equal(fs.existsSync(file),true);
});

test("new applicable media without a review row cannot be treated as junk",async()=>{
    const media=path.join(root,"new.wav");fs.writeFileSync(media,"new media");
    await assert.rejects(journal.prepare({inventoryCommandId:inventoryId,filePath:media,rootPath:root}),/identified or registered/);
});

test("cleanup cannot select rewrite temporaries or reserved system folders",async()=>{
    for(const reserved of [path.join(root,".discogenius-tags-12345678-1234-1234-1234-123456789abc.flac"),path.join(root,".zfs","leftover.json")]){
        fs.mkdirSync(path.dirname(reserved),{recursive:true});fs.writeFileSync(reserved,"protected");
        await assert.rejects(journal.prepare({inventoryCommandId:inventoryId,filePath:reserved,rootPath:root}),/reserved or active rewrite/);
    }
});

test("an interrupted cleanup cannot overwrite a recreated source",async()=>{
    const intent=await prepare(),staged=journal.stage(intent);fs.writeFileSync(file,"external replacement");
    await assert.rejects(journal.recoverOne(intent),/source was replaced/);
    assert.equal(fs.readFileSync(file,"utf8"),"external replacement");assert.equal(fs.readFileSync(staged,"utf8"),"original leftover");
    assert.equal(journal.hasPending(),true);
});

test("cleanup preview uses candidates captured by the completed root inventory",async()=>{
    const {previewLibraryCleanup}=await import("./library-cleanup-plan.js");
    const preview=previewLibraryCleanup(inventoryId);
    assert.deepEqual(preview.entries,[{path:file,rootPath:root,reason:"unowned",eligible:true}]);
    assert.equal(preview.nextCursor,null);
    assert.equal(fs.readFileSync(file,"utf8"),"original leftover");
});
test("cleanup preview refuses incomplete or legacy candidate inventories",async()=>{
    const {previewLibraryCleanup}=await import("./library-cleanup-plan.js");
    database.db.prepare("UPDATE commands SET status='started' WHERE id=?").run(inventoryId);
    assert.throws(()=>previewLibraryCleanup(inventoryId),/complete current library inventory/);
    database.db.prepare("UPDATE commands SET status='completed' WHERE id=?").run(inventoryId);
    const command=queue.CommandQueueManager.get(inventoryId)!;
    delete (command.payload as any).rootInventory.cleanupPlanVersion;
    database.db.prepare("UPDATE commands SET payload=? WHERE id=?").run(JSON.stringify(command.payload),inventoryId);
    assert.throws(()=>previewLibraryCleanup(inventoryId),/fresh witnessed candidate inventory/);
});
test("cleanup preview rechecks newly claimed review paths and changed physical files",async()=>{
    const {previewLibraryCleanup}=await import("./library-cleanup-plan.js");
    fs.writeFileSync(file,"changed size and bytes after inventory");
    assert.equal(previewLibraryCleanup(inventoryId).entries[0].reason,"file_changed");
    review();
    assert.equal(previewLibraryCleanup(inventoryId).entries[0].reason,"now_owned_or_reviewed");
    assert.equal(previewLibraryCleanup(inventoryId).entries[0].eligible,false);
});
test("cleanup preview invalidates when the scan configuration changes",async()=>{
    const {previewLibraryCleanup}=await import("./library-cleanup-plan.js");
    const cfg=config.readConfig();cfg.metadata.album_cover_name="different.jpg";config.writeConfig(cfg);
    assert.throws(()=>previewLibraryCleanup(inventoryId),/complete current library inventory/);
});
test("candidate collection protects review companions and reports unresolved metadata",async()=>{
    const {recordCleanupCandidate}=await import("./library-cleanup-plan.js");
    const media=path.join(root,"Unknown.flac"),lyric=path.join(root,"Unknown.lrc"),cover=path.join(root,config.readConfig().metadata.album_cover_name || "cover.jpg");
    fs.writeFileSync(media,"unidentified audio");fs.writeFileSync(lyric,"lyrics");fs.writeFileSync(cover,"image");
    database.db.prepare("INSERT INTO UnmappedFiles(file_path,relative_path,library_root,filename,extension,ignored) VALUES (?,'Unknown.flac',?,'Unknown.flac','flac',1)").run(media,root);
    const siblings=[media,lyric,cover];
    await recordCleanupCandidate(inventoryId,media,root,siblings,()=>{});
    await recordCleanupCandidate(inventoryId,lyric,root,siblings,()=>{});
    await recordCleanupCandidate(inventoryId,cover,root,[cover],()=>{});
    assert.deepEqual(database.db.prepare("SELECT file_path,reason FROM LibraryCleanupCandidates WHERE file_path<>? ORDER BY file_path").all(file),
        [{file_path:lyric,reason:"review_sidecar"},{file_path:cover,reason:"unresolved_sidecar"}]);
    assert.equal(fs.readFileSync(media,"utf8"),"unidentified audio");
});
test("cleanup preview is bounded by a stable path cursor and cascades with inventory history",async()=>{
    const {recordCleanupCandidate,previewLibraryCleanup}=await import("./library-cleanup-plan.js");
    const extra=path.join(root,"another.json");fs.writeFileSync(extra,"extra");
    await recordCleanupCandidate(inventoryId,extra,root,[extra],()=>{});
    const first=previewLibraryCleanup(inventoryId,{limit:1}),second=previewLibraryCleanup(inventoryId,{limit:1,afterPath:first.nextCursor!});
    assert.equal(first.entries.length,1);assert.equal(second.entries.length,1);
    assert.notEqual(first.entries[0].path,second.entries[0].path);assert.equal(second.nextCursor,null);
    assert.throws(()=>previewLibraryCleanup(inventoryId,{limit:101}),/Invalid cleanup preview/);
    database.db.prepare("DELETE FROM commands WHERE id=?").run(inventoryId);
    assert.equal((database.db.prepare("SELECT COUNT(*) AS n FROM LibraryCleanupCandidates").get() as {n:number}).n,0);
});
test("cleanup preview rejects candidates from a root outside the current witnessed inventory",async()=>{
    const {previewLibraryCleanup}=await import("./library-cleanup-plan.js");
    database.db.prepare("UPDATE LibraryCleanupCandidates SET root_path=? WHERE inventory_command_id=?").run(path.dirname(root),inventoryId);
    assert.equal(previewLibraryCleanup(inventoryId).entries[0].reason,"outside_current_roots");
    assert.equal(previewLibraryCleanup(inventoryId).entries[0].eligible,false);
});
test("cleanup preview HTTP validates selectors and exposes only witnessed read-only plans",async()=>{
    const express=(await import("express")).default,router=(await import("../../routes/library-files.js")).default;
    const app=express();app.use("/files",router);
    const server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));
    try {
        const address=server.address() as {port:number},base=`http://127.0.0.1:${address.port}/files/cleanup/preview`;
        assert.equal((await fetch(base)).status,400);
        assert.equal((await fetch(base+`?inventoryCommandId=${inventoryId}&limit=101`)).status,400);
        assert.equal((await fetch(base+`?inventoryCommandId=${inventoryId+1}`)).status,409);
        const response=await fetch(base+`?inventoryCommandId=${inventoryId}&limit=1`);
        assert.equal(response.status,200);assert.equal((await response.json() as {entries:unknown[]}).entries.length,1);
        assert.equal(fs.readFileSync(file,"utf8"),"original leftover");
    } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve()));}
});
