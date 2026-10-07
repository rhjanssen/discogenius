import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";
import { seedTestLibrary } from "../../test-support/library-fixtures.js";
import { withSqliteWriteMutexAsync } from "../../database/sqlite-write-mutex.js";

const { tempDir } = prepareActiveSchemaEnv("inventory-sidecars");
let database: Awaited<ReturnType<typeof openActiveSchemaDb>>;
let service: typeof import("./inventory-sidecars.js");
let root: string, library: number;
before(async () => { database=await openActiveSchemaDb(); service=await import("./inventory-sidecars.js"); });
beforeEach(() => {
    for (const table of ["MetadataFiles","LyricFiles","ExtraFiles","UnmappedFiles","TrackFiles","Tracks","AlbumEditions","Recordings","Albums","LibraryArtists","ArtistMetadata","Libraries"])
        database.db.prepare(`DELETE FROM ${table}`).run();
    root=fs.mkdtempSync(path.join(tempDir,"root-"));
    library=seedTestLibrary(database.db,{name:"Fixture",rootPath:root});
    database.db.prepare("INSERT INTO ArtistMetadata(id,mbid,name) VALUES (1,'artist','Artist')").run();
    database.db.prepare("INSERT INTO Albums(id,mbid,artist_mbid,title) VALUES (1,'album','artist','Album')").run();
    for (const id of [1,2]) {
        database.db.prepare("INSERT INTO AlbumEditions(id,mbid,release_group_id,release_group_mbid,artist_metadata_id,artist_mbid,title) VALUES (?, ?,1,'album',1,'artist','Edition')").run(id,`edition-${id}`);
        database.db.prepare("INSERT INTO Recordings(id,mbid,title) VALUES (?,?,'Recording')").run(id,`recording-${id}`);
        database.db.prepare("INSERT INTO Tracks(id,mbid,album_edition_id,release_mbid,recording_id,recording_mbid,medium_position,position,title) VALUES (?,?,?,?,?,?,1,1,'Track')")
            .run(id,`track-${id}`,id,`edition-${id}`,id,`recording-${id}`);
    }
});
afterEach(() => fs.rmSync(root,{recursive:true,force:true}));
after(() => closeActiveSchemaDb(database.dbModule,tempDir));

function file(name: string): string { const target=path.join(root,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,name);return target; }
function track(name="01 Song.flac",edition=1): {path:string;id:number} {
    const target=file(name);
    const id=Number(database.db.prepare(`INSERT INTO TrackFiles(artist_metadata_id,library_id,file_path,relative_path,library_root,filename,extension,file_type,
        release_group_id,album_edition_id,track_id,recording_id) VALUES (1,?,?,?,?,?,?,'track',1,?,?,?)`)
        .run(library,target,name,"music",path.basename(target),path.extname(target).slice(1),edition,edition,edition).lastInsertRowid);
    return {path:target,id};
}
function inspect(target:string,peers:string[]) { return service.inspectInventorySidecar(target,root,[target,...peers]); }
function reconcile(target:string,peers:string[]) { return service.reconcileInventorySidecar(target,root,[target,...peers]); }

async function artistPath(folder:string,libraryId=library,artistId=1): Promise<void> {
    const config = await import("../config/config.js");
    const value=config.readConfig();value.path.music_path=root;value.path.spatial_path=path.join(root,"spatial");
    value.path.video_path=path.join(root,"videos");config.writeConfig(value);
    database.db.prepare("INSERT INTO LibraryArtists(library_id,artist_metadata_id,path) VALUES(?,?,?)")
        .run(libraryId,artistId,folder);
}

test("artist artwork and NFO follow a persisted custom directory without playable siblings",async()=>{
    await artistPath("Custom/Artist");
    const cover=file("Custom/Artist/folder.jpg"),nfo=file("Custom/Artist/artist.nfo");
    assert.equal(await reconcile(cover,[]),true);assert.equal(await reconcile(nfo,[]),true);
    assert.deepEqual(database.db.prepare(`SELECT type,track_file_id,canonical_artist_mbid,canonical_release_mbid
        FROM MetadataFiles ORDER BY type`).all(),[
        {type:"ArtistImage",track_file_id:null,canonical_artist_mbid:"artist",canonical_release_mbid:null},
        {type:"ArtistMetadata",track_file_id:null,canonical_artist_mbid:"artist",canonical_release_mbid:null}]);
    assert.equal(await reconcile(cover,[]),false);assert.equal(await reconcile(nfo,[]),false);
});
test("artist basename, library-root assets and album-level folder images do not invent artist ownership",async()=>{
    await artistPath("Custom/Artist");
    assert.equal(inspect(file("Artist/artist.nfo"),[]).status,"unresolved");
    assert.equal(inspect(file("artist.nfo"),[]).status,"unresolved");
    const owner=track("Custom/Artist/Edition/01 Song.flac"),cover=file("Custom/Artist/Edition/folder.jpg");
    assert.equal(await reconcile(cover,[owner.path]),true);
    assert.deepEqual(database.db.prepare("SELECT type,canonical_release_mbid FROM MetadataFiles").get(),
        {type:"AlbumImage",canonical_release_mbid:"edition-1"});
});
test("shared artist directory associates only confirmed libraries and conflicting artists remain unresolved",async()=>{
    await artistPath("Custom/Artist");
    const shared=seedTestLibrary(database.db,{name:"Shared",rootPath:root});
    const unrelated=seedTestLibrary(database.db,{name:"Unrelated",rootPath:root});
    await artistPath("Custom/Artist",shared);
    await artistPath("Other/Artist",unrelated);
    const cover=file("Custom/Artist/folder.jpg");
    assert.equal(await reconcile(cover,[]),true);
    assert.deepEqual(database.db.prepare("SELECT library_id FROM MetadataFileLibraries ORDER BY library_id").all(),
        [{library_id:library},{library_id:shared}]);
    database.db.prepare("INSERT INTO ArtistMetadata(id,mbid,name) VALUES(2,'different','Artist')").run();
    database.db.prepare("UPDATE LibraryArtists SET artist_metadata_id=2 WHERE library_id=?").run(shared);
    assert.equal(inspect(cover,[]).status,"unresolved");
    assert.equal(await reconcile(cover,[]),false);
});
test("artist paths from a different root cannot claim local artwork",async()=>{
    const elsewhere=seedTestLibrary(database.db,{name:"Elsewhere",rootPath:path.join(root,"other")});
    await artistPath("Custom/Artist",elsewhere);
    assert.equal(inspect(file("Custom/Artist/artist.nfo"),[]).status,"unresolved");
});
test("artist ownership is rechecked when its directory changes while awaiting writer admission",async()=>{
    await artistPath("Custom/Artist");const cover=file("Custom/Artist/folder.jpg");
    let entered!:()=>void,release!:()=>void;
    const admitted=new Promise<void>(resolve=>entered=resolve),barrier=new Promise<void>(resolve=>release=resolve);
    const holder=withSqliteWriteMutexAsync(async()=>{entered();await barrier;
        database.db.prepare("UPDATE LibraryArtists SET path='Moved/Artist'").run();});
    await admitted;
    const pending=reconcile(cover,[]);release();await holder;
    await assert.rejects(pending,/Sidecar ownership changed/);
    assert.equal(database.db.prepare("SELECT 1 FROM MetadataFiles").get(),undefined);
    assert.equal(fs.readFileSync(cover,"utf8"),"Custom/Artist/folder.jpg");
});
test("artist path ownership uses its index instead of scanning all membership rows",()=>{
    const plan=database.db.prepare("EXPLAIN QUERY PLAN SELECT library_id FROM LibraryArtists WHERE path IN (?)")
        .all("Custom/Artist") as Array<{detail:string}>;
    assert.ok(plan.some(row=>row.detail.includes("idx_library_artists_path")));
});

test("scan deduplication preserves artist artwork and incomplete edition covers at distinct paths",async()=>{
    const owner=track("Artist/Edition/01 Song.flac");
    const artistImage=file("Artist/folder.jpg"),albumImage=file("Artist/Edition/cover.jpg");
    const rows=[artistImage,albumImage].map(target=>Number(database.db.prepare(`INSERT INTO MetadataFiles
        (artist_id,file_path,relative_path,library_root,extension,type,file_type,canonical_artist_mbid)
        VALUES('artist',?,?,?,'jpg','ArtistImage','cover','artist')`).run(target,path.relative(root,target),root).lastInsertRowid));
    const libraryFiles=await import("./library-files.js");
    assert.equal(libraryFiles.LibraryFilesService.enforceTrackedAssetIdentity({artistId:"artist",fileType:"cover",libraryRoot:root}).removed,0);
    assert.equal(libraryFiles.LibraryFilesService.pruneDuplicateTrackedAssets("artist").removed,0);
    assert.deepEqual(database.db.prepare("SELECT id FROM MetadataFiles ORDER BY id").all(),rows.map(id=>({id})));
    assert.equal(fs.readFileSync(artistImage,"utf8"),"Artist/folder.jpg");
    assert.equal(fs.readFileSync(albumImage,"utf8"),"Artist/Edition/cover.jpg");
    assert.ok(fs.existsSync(owner.path));
});
test("distinct artwork contents in one folder remain tracked until verified cleanup",async()=>{
    const targets=[file("Edition/cover.jpg"),file("Edition/alternate.jpg")];
    for (const target of targets) database.db.prepare(`INSERT INTO MetadataFiles
        (artist_id,file_path,relative_path,library_root,extension,type,file_type,canonical_release_group_mbid,canonical_release_mbid)
        VALUES('artist',?,?,?,'jpg','AlbumImage','cover','album','edition-1')`).run(target,path.relative(root,target),root);
    const libraryFiles=await import("./library-files.js");
    assert.equal(libraryFiles.LibraryFilesService.enforceTrackedAssetIdentity({artistId:"artist",albumId:"album",fileType:"cover",libraryRoot:root}).removed,0);
    assert.equal((database.db.prepare("SELECT COUNT(*) AS n FROM MetadataFiles").get() as {n:number}).n,2);
    for (const target of targets) assert.equal(fs.readFileSync(target,"utf8"),path.relative(root,target).replace(/\\/g,"/"));
});

test("inventory links lyrics to the exact physical file and repeats without new writes",async()=>{
    const owner=track(),lyric=file("01 Song.lrc");
    assert.equal(await reconcile(lyric,[owner.path]),true);
    const before=database.db.prepare("SELECT * FROM LyricFiles").get() as {id:number;track_file_id:number;canonical_release_mbid:string};
    assert.equal(before.track_file_id,owner.id);assert.equal(before.canonical_release_mbid,"edition-1");
    assert.deepEqual(database.db.prepare("SELECT library_id FROM LyricFileLibraries").all(),[{library_id:library}]);
    assert.equal(await reconcile(lyric,[owner.path]),false);
    assert.deepEqual(database.db.prepare("SELECT * FROM LyricFiles").get(),before);
    assert.equal(fs.readFileSync(lyric,"utf8"),"01 Song.lrc");
});
test("same stems in different edition folders retain separate physical ownership",async()=>{
    const a=track("Standard/01 Song.flac"),b=track("Deluxe/01 Song.flac",2);
    const lyric=file("Deluxe/01 Song.txt");
    assert.equal(await reconcile(lyric,[a.path,b.path]),true);
    assert.equal((database.db.prepare("SELECT track_file_id FROM LyricFiles").get() as {track_file_id:number}).track_file_id,b.id);
});
test("two physical versions with the same stem leave the lyric unresolved",async()=>{
    const a=track(),b=track("01 Song.mp3"),lyric=file("01 Song.lrc");
    assert.equal(inspect(lyric,[a.path,b.path]).status,"unresolved");
    assert.equal(await reconcile(lyric,[a.path,b.path]),false);
    assert.equal(database.db.prepare("SELECT 1 FROM LyricFiles").get(),undefined);
});
test("video thumbnails follow their physical video and audio images remain unresolved",async()=>{
    const owner=track("Clip.mp4"),thumbnail=file("Clip.jpg");
    assert.equal(inspect(thumbnail,[owner.path]).status,"unresolved");
    database.db.prepare("UPDATE Recordings SET is_video=1 WHERE id=1").run();
    database.db.prepare("UPDATE TrackFiles SET file_type='video',library_slot='video' WHERE id=?").run(owner.id);
    assert.equal(await reconcile(thumbnail,[owner.path]),true);
    assert.deepEqual(database.db.prepare("SELECT file_type,track_file_id,canonical_recording_mbid FROM MetadataFiles").get(),
        {file_type:"video_thumbnail",track_file_id:owner.id,canonical_recording_mbid:"recording-1"});
});
test("standalone catalogue video thumbnails do not require an invented album edition",async()=>{
    const owner=track("Standalone.mp4"),thumbnail=file("Standalone.jpg");
    database.db.prepare("UPDATE Recordings SET is_video=1 WHERE id=1").run();
    database.db.prepare("UPDATE TrackFiles SET file_type='video',library_slot='video',album_edition_id=NULL,release_group_id=NULL,track_id=NULL WHERE id=?").run(owner.id);
    assert.equal(await reconcile(thumbnail,[owner.path]),true);
    assert.deepEqual(database.db.prepare("SELECT track_file_id,canonical_release_mbid,canonical_release_group_mbid,canonical_recording_mbid FROM MetadataFiles").get(),
        {track_file_id:owner.id,canonical_release_mbid:null,canonical_release_group_mbid:null,canonical_recording_mbid:"recording-1"});
});
test("YouTube catalogue video thumbnails retain physical ownership without inventing a MusicBrainz ID",async()=>{
    const owner=track("YouTube.mp4"),thumbnail=file("YouTube.jpg");
    database.db.prepare("INSERT INTO Recordings(id,youtube_video_id,artist_metadata_id,artist_mbid,title,is_video) VALUES(3,'abcdefghijk',1,'artist','Video',1)").run();
    database.db.prepare("UPDATE TrackFiles SET file_type='video',library_slot='video',album_edition_id=NULL,release_group_id=NULL,track_id=NULL,recording_id=3 WHERE id=?").run(owner.id);
    assert.equal(await reconcile(thumbnail,[owner.path]),true);
    assert.deepEqual(database.db.prepare("SELECT track_file_id,canonical_release_mbid,canonical_recording_mbid FROM MetadataFiles").get(),
        {track_file_id:owner.id,canonical_release_mbid:null,canonical_recording_mbid:null});
});
test("Windows root casing does not prevent sidecar admission",{skip:process.platform!=="win32"},async()=>{
    const owner=track(),lyric=file("01 Song.lrc");
    assert.equal(await service.reconcileInventorySidecar(lyric,root.toUpperCase(),[lyric,owner.path]),true);
});
test("folder artwork and NFO inherit an unambiguous edition without a track link",async()=>{
    const owner=track(),cover=file("cover.jpg"),nfo=file("album.nfo");
    assert.equal(await reconcile(cover,[owner.path]),true);assert.equal(await reconcile(nfo,[owner.path]),true);
    assert.deepEqual(database.db.prepare("SELECT file_type,track_file_id,canonical_release_mbid FROM MetadataFiles ORDER BY file_type").all(),[
        {file_type:"cover",track_file_id:null,canonical_release_mbid:"edition-1"},
        {file_type:"nfo",track_file_id:null,canonical_release_mbid:"edition-1"}]);
});
test("existing incomplete sidecar ownership is repaired without replacing IDs or rename information",async()=>{
    const owner=track(),cover=file("cover.jpg");
    const id=Number(database.db.prepare(`INSERT INTO MetadataFiles(artist_id,track_file_id,relative_path,file_path,library_root,extension,type,file_type,provider,expected_path,needs_rename)
        VALUES ('artist',?,'cover.jpg',?,?,'jpg','ArtistImage','cover','tidal','future-cover.jpg',1)`).run(owner.id,cover,root).lastInsertRowid);
    assert.equal(await reconcile(cover,[owner.path]),true);
    assert.deepEqual(database.db.prepare("SELECT id,track_file_id,canonical_release_mbid,type,provider,expected_path,needs_rename FROM MetadataFiles").get(),
        {id,track_file_id:null,canonical_release_mbid:"edition-1",type:"AlbumImage",provider:"tidal",expected_path:"future-cover.jpg",needs_rename:1});
    assert.equal(await reconcile(cover,[owner.path]),false);
});
test("existing conflicting canonical sidecar ownership requires review",async()=>{
    const owner=track(),cover=file("cover.jpg");
    database.db.prepare(`INSERT INTO MetadataFiles(artist_id,relative_path,file_path,library_root,extension,type,file_type,canonical_release_mbid)
        VALUES ('artist','cover.jpg',?,?,'jpg','AlbumImage','cover','edition-2')`).run(cover,root);
    assert.equal(inspect(cover,[owner.path]).status,"unresolved");
    assert.equal(await reconcile(cover,[owner.path]),false);
    assert.equal((database.db.prepare("SELECT canonical_release_mbid FROM MetadataFiles").get() as {canonical_release_mbid:string}).canonical_release_mbid,"edition-2");
});
test("shared-folder artwork cannot choose between two editions",async()=>{
    const a=track(),b=track("02 Other.flac",2),cover=file("cover.jpg");
    assert.equal(inspect(cover,[a.path,b.path]).status,"unresolved");
    assert.equal(await reconcile(cover,[a.path,b.path]),false);
});
test("a shared edition cover keeps every confirmed library association",async()=>{
    const a=track(),b=track("02 Other.flac"),cover=file("cover.jpg");
    const second=seedTestLibrary(database.db,{name:"Second",rootPath:root});
    database.db.prepare("UPDATE TrackFiles SET library_id=? WHERE id=?").run(second,b.id);
    assert.equal(await reconcile(cover,[a.path,b.path]),true);
    assert.deepEqual(database.db.prepare("SELECT library_id FROM MetadataFileLibraries ORDER BY library_id").all(),[
        {library_id:library},{library_id:second}]);
    assert.equal((database.db.prepare("SELECT COUNT(*) AS count FROM MetadataFiles").get() as {count:number}).count,1);
});
test("unmapped media protects its applicable sidecars without inventing catalogue ownership",async()=>{
    const media=file("Unknown.wav"),lyric=file("Unknown.lrc"),cover=file("cover.jpg");
    database.db.prepare("INSERT INTO UnmappedFiles(file_path,relative_path,filename,extension,library_root,ignored) VALUES (?,'Unknown.wav','Unknown.wav','wav','music',1)").run(media);
    assert.equal(inspect(lyric,[media]).status,"review_sidecar");assert.equal(inspect(cover,[media]).status,"review_sidecar");
    assert.equal(await reconcile(cover,[media]),false);
    assert.equal(database.db.prepare("SELECT 1 FROM MetadataFiles").get(),undefined);
});
test("sidecar ownership is resolved again after writer admission",async()=>{
    const owner=track(),lyric=file("01 Song.lrc");
    let release!:()=>void,entered!:()=>void;
    const waiting=new Promise<void>(resolve=>{release=resolve;});
    const ready=new Promise<void>(resolve=>{entered=resolve;});
    const holder=withSqliteWriteMutexAsync(async()=>{
        entered();await waiting;
        database.db.prepare("UPDATE TrackFiles SET album_edition_id=2,track_id=2,recording_id=2 WHERE id=?").run(owner.id);
    });await ready;
    const attempt=reconcile(lyric,[owner.path]);
    const result=assert.rejects(attempt,/ownership changed/);
    release();await holder;await result;
    assert.equal(database.db.prepare("SELECT 1 FROM LyricFiles").get(),undefined);
    assert.equal(fs.existsSync(lyric),true);
});
test("failed library association rolls back ownership without altering the sidecar",async()=>{
    const owner=track(),cover=file("cover.jpg");
    database.db.exec("CREATE TRIGGER fail_sidecar_association BEFORE INSERT ON MetadataFileLibraries BEGIN SELECT RAISE(ABORT,'injected association failure'); END");
    try { await assert.rejects(reconcile(cover,[owner.path]),/injected association failure/); }
    finally { database.db.exec("DROP TRIGGER fail_sidecar_association"); }
    assert.equal(database.db.prepare("SELECT 1 FROM MetadataFiles").get(),undefined);assert.equal(fs.existsSync(cover),true);
});

test("whole-root inventory registers sidecars once and preserves their IDs on repeat",async()=>{
    const owner=track();file("01 Song.lrc");file("cover.jpg");
    const config=await import("../config/config.js"),queue=await import("../commands/command-queue-manager.js");
    const inventory=await import("../commands/root-inventory-work.js");
    const old=[config.Config.getMusicPath,config.Config.getSpatialPath,config.Config.getVideoPath];
    const spatial=path.join(root,"spatial"),videos=path.join(root,"videos");fs.mkdirSync(spatial);fs.mkdirSync(videos);
    config.Config.getMusicPath=()=>root;config.Config.getSpatialPath=()=>spatial;config.Config.getVideoPath=()=>videos;
    const context={updateCommandDescription:()=>{},formatArtistPhaseDescription:()=>"",formatWorkflowCommandLabel:()=>"",resolveArtistLabel:()=>"",
        yieldToEventLoop:()=>new Promise<void>(resolve=>setImmediate(resolve))};
    async function scan(){
        const id=queue.CommandQueueManager.push(queue.CommandNames.RescanFolders,{});
        const job=queue.CommandQueueManager.claimForExecution(id,"sidecar-inventory",60_000)! as import("../commands/command-model.js").CommandModelOf<"RescanFolders">;
        const result=await inventory.runRootInventoryWorkUnit(job,context);
        assert.equal(queue.CommandQueueManager.complete(job.id,job.worker_id!),true);return result;
    }
    try {
        assert.equal((await scan()).sidecarFiles,2);
        const before=database.db.prepare("SELECT id,track_file_id FROM LyricFiles").all();
        assert.deepEqual(before,[{id:(before[0] as {id:number}).id,track_file_id:owner.id}]);
        assert.equal((await scan()).sidecarFiles??0,0);
        assert.deepEqual(database.db.prepare("SELECT id,track_file_id FROM LyricFiles").all(),before);
    } finally {
        [config.Config.getMusicPath,config.Config.getSpatialPath,config.Config.getVideoPath]=old;
    }
});
