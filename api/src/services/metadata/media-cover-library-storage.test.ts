import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { before, after, test } from "node:test";
import { seedTestLibrary } from "../../test-support/library-fixtures.js";
import type { ArtworkIdentity } from "./media-cover-state.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-artwork-ownership-"));
process.env.DB_PATH = path.join(root, "active.db");
process.env.DISCOGENIUS_CONFIG_DIR = root;
let database: typeof import("../../database.js");
let storage: typeof import("./media-cover-library-storage.js");
before(async () => {
  database = await import("../../database.js");
  database.initDatabase();
  storage = await import("./media-cover-library-storage.js");
});
after(() => { database.closeDatabase(); fs.rmSync(root, {recursive:true, force:true}); });

let sequence = 0;
function fixture(scope: ArtworkIdentity["coverEntity"]) {
  const mbid = `ownership-${scope}-${++sequence}`;
  const entityId = scope === "Video"
    ? String(database.db.prepare("INSERT INTO Recordings(mbid,title,is_video) VALUES (?, 'Owned video',1)").run(mbid).lastInsertRowid)
    : mbid;
  const identity: ArtworkIdentity = {coverEntity:scope, entityId, coverType:"cover"};
  const folder = path.join(root, `cache-${mbid}`), file = path.join(root, `${mbid}.jpg`);
  fs.mkdirSync(folder);
  fs.writeFileSync(file, `full resolution ${scope}`);
  const hash = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const column = {Artist:"canonical_artist_mbid", Album:"canonical_release_group_mbid",
    Edition:"canonical_release_mbid", Video:"canonical_recording_mbid"}[scope];
  const id = Number(database.db.prepare(`INSERT INTO MetadataFiles
    (artist_id,file_path,relative_path,library_root,extension,type,file_type,${column})
    VALUES ('fixture',?,?,?,'jpg','artwork','cover',?)`).run(file,path.basename(file),root,mbid).lastInsertRowid);
  return {identity,folder,file,hash,column,id};
}

for (const scope of ["Artist","Album","Edition","Video"] as const) {
  test(`${scope} master ownership survives a rename but rejects same-byte owner transfer`, () => {
    const f = fixture(scope);
    storage.rememberLibraryCoverSidecar(f.identity,f.folder,f.file,f.hash,f.id);
    const renamed = `${f.file}.renamed.jpg`;
    fs.renameSync(f.file,renamed);
    database.db.prepare("UPDATE MetadataFiles SET file_path=? WHERE id=?").run(renamed,f.id);
    assert.equal(storage.findLibraryCoverMaster(f.identity,f.folder,f.hash),renamed);
    database.db.prepare(`UPDATE MetadataFiles SET ${f.column}=? WHERE id=?`).run("another-canonical-owner",f.id);
    assert.equal(storage.findLibraryCoverMaster(f.identity,f.folder,f.hash),null);
    assert.throws(() => storage.linkLibraryCoverSidecar(f.identity,f.folder,f.file,f.id),/owner and path/);
    assert.equal(fs.existsSync(renamed),true,"an owner conflict must preserve physical artwork");
  });
}

test("legacy manifest cannot adopt a reused row belonging to another album", () => {
  const f = fixture("Album");
  // The first Album fixture transferred its row above; reuse its file ID in a
  // different cache marker to reproduce stale legacy ownership, not a byte mismatch.
  const wrong = {...f.identity,entityId:"wrong-album"};
  fs.writeFileSync(path.join(f.folder,".cover.library.json"),JSON.stringify({sidecars:[{path:f.file,hash:f.hash,metadataFileId:f.id}]}));
  assert.equal(storage.findLibraryCoverMaster(wrong,f.folder,f.hash),null);
  storage.rememberLibraryCoverSidecar(wrong,f.folder,`${f.file}.pending`,f.hash);
  const imported = database.db.prepare("SELECT metadata_file_id FROM ArtworkLibraryLinks WHERE entity_id=? AND metadata_file_id IS NOT NULL").all(wrong.entityId);
  assert.deepEqual(imported,[]);
});

function youtubeArtworkFixture() {
  const key=`youtube-art-${++sequence}`;
  const artist=Number(database.db.prepare("INSERT INTO ArtistMetadata(mbid,name) VALUES (?,'Video artist')").run(key).lastInsertRowid);
  const recording=Number(database.db.prepare("INSERT INTO Recordings(title,is_video,youtube_video_id,artist_metadata_id) VALUES ('YouTube video',1,?,?)").run(key,artist).lastInsertRowid);
  const library=seedTestLibrary(database.db,{name:key,rootPath:path.join(root,key)});
  const video=Number(database.db.prepare(`INSERT INTO TrackFiles(library_id,artist_metadata_id,recording_id,file_path,relative_path,filename,extension,file_type,library_root)
    VALUES (?,?,?,?,'clip.mp4','clip.mp4','mp4','video',?)`).run(library,artist,recording,path.join(root,key,'clip.mp4'),path.join(root,key)).lastInsertRowid);
  const file=path.join(root,key+'.jpg'),folder=path.join(root,key+'-cache');fs.mkdirSync(folder);fs.writeFileSync(file,'full video art');
  const hash=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const id=Number(database.db.prepare(`INSERT INTO MetadataFiles(artist_id,track_file_id,file_path,relative_path,library_root,extension,type,file_type,canonical_artist_mbid)
    VALUES (?,?,?,? ,?,'jpg','artwork','video_thumbnail',?)`).run(key,video,file,path.basename(file),root,key).lastInsertRowid);
  return {key,recording,video,id,file,folder,hash,identity:{coverEntity:'Video',entityId:String(recording),coverType:'cover'} as ArtworkIdentity};
}

test('canonical YouTube-only video art follows its exact TrackFile recording owner',()=>{
  const f=youtubeArtworkFixture();
  assert.equal(storage.artworkLinkOwnsTrackedPath(f.identity,f.file,f.id),true);
  storage.rememberLibraryCoverSidecar(f.identity,f.folder,f.file,f.hash,f.id);
  assert.equal(storage.findLibraryCoverMaster(f.identity,f.folder,f.hash),f.file);
  const other=Number(database.db.prepare("INSERT INTO Recordings(title,is_video,youtube_video_id) VALUES ('Other video',1,?)").run(f.key+'-other').lastInsertRowid);
  database.db.prepare('UPDATE TrackFiles SET recording_id=? WHERE id=?').run(other,f.video);
  assert.equal(storage.findLibraryCoverMaster(f.identity,f.folder,f.hash),null);
  assert.equal(fs.existsSync(f.file),true);
});

test('recording-less video artwork cannot become artist or album art through null MBID',()=>{
  const f=youtubeArtworkFixture();
  database.db.prepare('UPDATE MetadataFiles SET canonical_release_group_mbid=?,canonical_release_mbid=? WHERE id=?').run('video-group','video-edition',f.id);
  for(const [coverEntity,entityId] of [['Artist',f.key],['Album','video-group'],['Edition','video-edition']] as const)
    assert.equal(storage.artworkLinkOwnsTrackedPath({coverEntity,entityId,coverType:'cover'},f.file,f.id),false);
});

test('video artwork refuses conflicting canonical tags and audio or dangling anchors',()=>{
  const f=youtubeArtworkFixture();
  database.db.prepare('UPDATE MetadataFiles SET canonical_artist_mbid=? WHERE id=?').run('wrong-artist',f.id);
  assert.equal(storage.artworkLinkOwnsTrackedPath(f.identity,f.file,f.id),false);
  database.db.prepare('UPDATE MetadataFiles SET canonical_artist_mbid=? WHERE id=?').run(f.key,f.id);
  database.db.prepare('UPDATE MetadataFiles SET canonical_recording_mbid=? WHERE id=?').run('wrong-recording',f.id);
  assert.equal(storage.artworkLinkOwnsTrackedPath(f.identity,f.file,f.id),false);
  database.db.prepare('UPDATE MetadataFiles SET canonical_recording_mbid=NULL WHERE id=?').run(f.id);
  database.db.prepare("UPDATE TrackFiles SET file_type='track' WHERE id=?").run(f.video);
  assert.equal(storage.artworkLinkOwnsTrackedPath(f.identity,f.file,f.id),false);
  database.db.prepare('UPDATE MetadataFiles SET track_file_id=NULL WHERE id=?').run(f.id);
  assert.equal(storage.artworkLinkOwnsTrackedPath(f.identity,f.file,f.id),false);
});

test("publishing an edition cover takes over the row a sibling edition left at the shared album path", () => {
  const key = `shared-folder-${++sequence}`;
  const artist = Number(database.db.prepare("INSERT INTO ArtistMetadata(mbid,name) VALUES (?,'Shared artist')").run(key).lastInsertRowid);
  const album = Number(database.db.prepare("INSERT INTO Albums(mbid,title,artist_metadata_id,artist_mbid) VALUES (?,'Shared album',?,?)").run(`${key}-rg`,artist,key).lastInsertRowid);
  for (const suffix of ["a","b"]) database.db.prepare("INSERT INTO AlbumEditions(mbid,release_group_id,release_group_mbid,artist_mbid,title) VALUES (?,?,?,?,'Edition')").run(`${key}-${suffix}`,album,`${key}-rg`,key);
  const file = path.join(root,`${key}-cover.jpg`), folder = path.join(root,`${key}-cache`);
  fs.mkdirSync(folder); fs.writeFileSync(file,"edition b bytes");
  const hash = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const id = Number(database.db.prepare(`INSERT INTO MetadataFiles
    (artist_id,file_path,relative_path,library_root,extension,type,file_type,canonical_release_group_mbid,canonical_release_mbid)
    VALUES ('fixture',?,?,?,'jpg','artwork','cover',?,?)`).run(file,path.basename(file),root,`${key}-rg`,`${key}-a`).lastInsertRowid);
  const editionB: ArtworkIdentity = {coverEntity:"Edition",entityId:`${key}-b`,coverType:"cover"};

  const claimed = storage.claimPublishedArtworkRow(editionB,file);
  assert.equal(claimed,id);
  storage.rememberLibraryCoverSidecar(editionB,folder,file,hash,claimed);
  assert.equal(storage.findLibraryCoverMaster(editionB,folder,hash),file);
  assert.equal(storage.findLibraryCoverMaster({coverEntity:"Album",entityId:`${key}-rg`,coverType:"cover"},folder,hash),null,
    "claiming for an edition does not invent album links");
  const row = database.db.prepare("SELECT canonical_release_group_mbid AS rg, canonical_release_mbid AS rel FROM MetadataFiles WHERE id=?").get(id);
  assert.deepEqual({...row as object},{rg:`${key}-rg`,rel:`${key}-b`});
  assert.equal(storage.artworkLinkOwnsTrackedPath({coverEntity:"Edition",entityId:`${key}-a`,coverType:"cover"},file,id),false,
    "the previous edition no longer owns bytes it did not write");
});

test("publishing album art keeps a matching edition owner and drops a foreign one", () => {
  const key = `album-claim-${++sequence}`;
  const artist = Number(database.db.prepare("INSERT INTO ArtistMetadata(mbid,name) VALUES (?,'Album artist')").run(key).lastInsertRowid);
  const album = Number(database.db.prepare("INSERT INTO Albums(mbid,title,artist_metadata_id,artist_mbid) VALUES (?,'Album',?,?)").run(`${key}-rg`,artist,key).lastInsertRowid);
  database.db.prepare("INSERT INTO AlbumEditions(mbid,release_group_id,release_group_mbid,artist_mbid,title) VALUES (?,?,?,?,'Edition')").run(`${key}-ed`,album,`${key}-rg`,key);
  const file = path.join(root,`${key}.jpg`);
  fs.writeFileSync(file,"album bytes");
  const id = Number(database.db.prepare(`INSERT INTO MetadataFiles
    (artist_id,file_path,relative_path,library_root,extension,type,file_type,canonical_release_group_mbid,canonical_release_mbid)
    VALUES ('fixture',?,?,?,'jpg','artwork','cover','stale-rg','stale-edition')`).run(file,path.basename(file),root).lastInsertRowid);
  const identity: ArtworkIdentity = {coverEntity:"Album",entityId:`${key}-rg`,coverType:"cover"};
  assert.equal(storage.claimPublishedArtworkRow(identity,file),id);
  assert.deepEqual({...database.db.prepare("SELECT canonical_release_group_mbid AS rg, canonical_release_mbid AS rel FROM MetadataFiles WHERE id=?").get(id) as object},
    {rg:`${key}-rg`,rel:null});
  database.db.prepare("UPDATE MetadataFiles SET canonical_release_group_mbid='other', canonical_release_mbid=? WHERE id=?").run(`${key}-ed`,id);
  storage.claimPublishedArtworkRow(identity,file);
  assert.deepEqual({...database.db.prepare("SELECT canonical_release_group_mbid AS rg, canonical_release_mbid AS rel FROM MetadataFiles WHERE id=?").get(id) as object},
    {rg:`${key}-rg`,rel:`${key}-ed`});
});

test("publishing never rewrites video art owners and has no row to claim on a fresh path", () => {
  const f = youtubeArtworkFixture();
  const other = Number(database.db.prepare("INSERT INTO Recordings(title,is_video,youtube_video_id) VALUES ('Unrelated',1,?)").run(f.key+'-x').lastInsertRowid);
  assert.equal(storage.claimPublishedArtworkRow({coverEntity:"Video",entityId:String(other),coverType:"cover"},f.file),undefined);
  assert.equal(storage.claimPublishedArtworkRow({coverEntity:"Edition",entityId:"none",coverType:"cover"},path.join(root,"absent.jpg")),undefined);
});
