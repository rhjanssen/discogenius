import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { closeActiveSchemaDb, openActiveSchemaDb, prepareActiveSchemaEnv } from "../../test-support/active-schema-fixture.js";
import { seedTestLibrary } from "../../test-support/library-fixtures.js";
import type { CommandModelOf } from "../commands/command-model.js";
import type { CommandHandlerContext } from "../commands/handlers/handler-context.js";
import type { OrphanSidecarPreviewReport } from "./orphan-sidecar-cleanup.js";

const { tempDir } = prepareActiveSchemaEnv("orphan-sidecar-cleanup");
let database: Awaited<ReturnType<typeof openActiveSchemaDb>>;
let configModule: typeof import("../config/config.js");
let cleanupModule: typeof import("./orphan-sidecar-cleanup.js");
let pathUtils: typeof import("./path-utils.js");
let queueModule: typeof import("../commands/command-queue-manager.js");
let executorModule: typeof import("../commands/executors/cleanup-orphan-sidecars-command.js");
let musicRoot: string, videoRoot: string, libraryId: number;

const RACOON_MBID = "1386778e-0000-0000-0000-000000000001";
const KINKS_MBID = "17b53d9f-0000-0000-0000-000000000002";
const ctx: CommandHandlerContext = {
  updateCommandDescription: () => {},
  formatArtistPhaseDescription: () => "",
  formatWorkflowCommandLabel: () => "",
  resolveArtistLabel: () => "",
  yieldToEventLoop: () => new Promise((resolve) => setImmediate(resolve)),
};

before(async () => {
  database = await openActiveSchemaDb();
  configModule = await import("../config/config.js");
  cleanupModule = await import("./orphan-sidecar-cleanup.js");
  pathUtils = await import("./path-utils.js");
  queueModule = await import("../commands/command-queue-manager.js");
  executorModule = await import("../commands/executors/cleanup-orphan-sidecars-command.js");
});

beforeEach(() => {
  pathUtils.clearCaseSensitivityCache();
  for (const t of ["commands", "LyricFileLibraries", "MetadataFileLibraries", "ExtraFileLibraries", "LyricFiles", "MetadataFiles", "ExtraFiles", "UnmappedFiles", "TrackFiles", "LibraryArtists", "ArtistMetadata", "Libraries"]) {
    database.db.prepare(`DELETE FROM ${t}`).run();
  }
  const runRoot = fs.mkdtempSync(path.join(tempDir, "roots-"));
  musicRoot = path.join(runRoot, "stereo-music");
  const spatialRoot = path.join(runRoot, "spatial-music");
  videoRoot = path.join(runRoot, "music-videos");
  for (const dir of [musicRoot, spatialRoot, videoRoot]) fs.mkdirSync(dir, { recursive: true });
  const cfg = configModule.readConfig();
  cfg.path.music_path = musicRoot;
  cfg.path.spatial_path = spatialRoot;
  cfg.path.video_path = videoRoot;
  configModule.writeConfig(cfg);
  libraryId = seedTestLibrary(database.db, { name: "Stereo", rootPath: musicRoot });
  database.db.prepare("INSERT INTO ArtistMetadata(id, mbid, name) VALUES (1, ?, 'Racoon'), (2, ?, 'The Kinks')").run(RACOON_MBID, KINKS_MBID);
});

afterEach(() => {
  pathUtils.clearCaseSensitivityCache();
  fs.rmSync(path.dirname(musicRoot), { recursive: true, force: true });
});
after(() => closeActiveSchemaDb(database.dbModule, tempDir));

function writeFile(root: string, rel: string, content = "data"): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function insertTrack(filePath: string, artistId = 1, artistMbid = RACOON_MBID): number {
  return (database.db.prepare(`
    INSERT INTO TrackFiles (artist_metadata_id, canonical_artist_mbid, library_id, file_path, relative_path, library_root, filename, extension, file_type, library_slot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'track', 'stereo') RETURNING id
  `).get(artistId, artistMbid, libraryId, filePath, path.relative(musicRoot, filePath), musicRoot, path.basename(filePath), path.extname(filePath).slice(1)) as { id: number }).id;
}

test("dry-run lists Racoon apostrophe & Kinks renumbering orphans without deleting anything", async () => {
  const racoonDir = `Racoon {mbid-${RACOON_MBID}}/Liverpool Rain (2011)`;
  const kinksDir = `The Kinks {mbid-${KINKS_MBID}}/Everybody’s in Show‐Biz (2020)`;
  const liveAudio = writeFile(musicRoot, `${racoonDir}/07 - Don’t Hold Me Down.m4a`, "audio");
  const liveLyric = writeFile(musicRoot, `${racoonDir}/07 - Don’t Hold Me Down.lrc`, "live");
  const orphanRacoon = writeFile(musicRoot, `${racoonDir}/07 - Don't Hold Me Down.lrc`, "old");
  const orphanKinksTxt = writeFile(musicRoot, `${kinksDir}/101 - Here Comes Yet Another Day.txt`, "old");
  const orphanKinksLrc = writeFile(musicRoot, `${kinksDir}/102 - Maximum Consumption.lrc`, "old");
  const orphanJson = writeFile(musicRoot, `${kinksDir}/103 - Unreal Reality.json`, "{}");
  const kinksAudio = writeFile(musicRoot, `${kinksDir}/01 - Here Comes Yet Another Day.m4a`, "audio");

  const trackId = insertTrack(liveAudio, 1, RACOON_MBID);
  insertTrack(kinksAudio, 2, KINKS_MBID);
  const staleId = (database.db.prepare("INSERT INTO LyricFiles (artist_id, track_file_id, relative_path, file_path, library_root, extension) VALUES (?, NULL, ?, ?, 'music', 'lrc') RETURNING id")
    .get(RACOON_MBID, path.relative(musicRoot, orphanRacoon), orphanRacoon) as { id: number }).id;
  database.db.prepare("INSERT INTO LyricFiles (artist_id, track_file_id, relative_path, file_path, library_root, extension) VALUES (?, ?, ?, ?, 'music', 'lrc')")
    .run(RACOON_MBID, trackId, path.relative(musicRoot, liveLyric), liveLyric);

  const report = await cleanupModule.previewOrphanSidecarCleanup();
  assert.equal(report.dryRun, true);
  assert.equal(report.orphanCount, 4);
  assert.deepEqual(report.entries.map((e) => e.filePath), [orphanRacoon, orphanKinksTxt, orphanKinksLrc, orphanJson].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(report.entries.find((e) => e.filePath === orphanRacoon)!.staleDbRows, [{ table: "LyricFiles", id: staleId }]);
  assert.ok([liveAudio, liveLyric, orphanRacoon, orphanKinksTxt, orphanKinksLrc, orphanJson, kinksAudio].every((p) => fs.existsSync(p)));
});

test("case-insensitive stems, inode/dev links, bio/hidden/root/video/unmapped files stay protected", async () => {
  const dir = "Racoon/Liverpool Rain (2011)";
  const audio = writeFile(musicRoot, `${dir}/12 - Save a Prayer.m4a`, "audio");
  const liveTrackId = insertTrack(audio);
  writeFile(musicRoot, `${dir}/12 - save a prayer.lrc`, "case diff");
  const linkedLyric = writeFile(musicRoot, `${dir}/12 - Linked.lrc`, "linked");
  const linkedExtra = writeFile(musicRoot, `${dir}/12 - Linked.json`, "{}");
  const bio = writeFile(musicRoot, `${dir}/bio.txt`, "bio");
  writeFile(musicRoot, `${dir}/.cover.library.json`, "{}");
  writeFile(musicRoot, "README.txt", "root");
  writeFile(videoRoot, "Racoon/Save a Prayer.mp4", "video");
  writeFile(videoRoot, "Racoon/save a prayer.info.json", "{}");
  const unmapped = writeFile(musicRoot, "Unmapped/01 - Loose.flac", "audio");
  writeFile(musicRoot, "Unmapped/01 - loose.lrc", "unmapped");

  const alias = path.join(path.dirname(musicRoot), "music-alias");
  fs.symlinkSync(musicRoot, alias);
  database.db.prepare("INSERT INTO LyricFiles (artist_id, track_file_id, relative_path, file_path, library_root, extension) VALUES (?, ?, ?, ?, 'music', 'lrc')")
    .run(RACOON_MBID, liveTrackId, path.relative(musicRoot, linkedLyric), path.join(alias, dir, "12 - Linked.lrc"));
  database.db.prepare("INSERT INTO ExtraFiles (artist_id, track_file_id, relative_path, file_path, library_root, extension, file_type) VALUES (?, ?, '', ?, 'music', 'json', 'duplicate')")
    .run(RACOON_MBID, liveTrackId, path.join(alias, dir, "12 - Linked.json"));
  database.db.prepare("INSERT INTO MetadataFiles (artist_id, track_file_id, relative_path, file_path, library_root, extension, type, file_type) VALUES (?, NULL, ?, ?, 'music', 'txt', 'ArtistMetadata', 'bio')")
    .run(RACOON_MBID, path.relative(musicRoot, bio), bio);
  database.db.prepare("INSERT INTO UnmappedFiles (file_path, relative_path, library_root, filename, extension) VALUES (?, ?, 'music', '01 - Loose.flac', 'flac')")
    .run(unmapped, path.relative(musicRoot, unmapped));

  const report = await cleanupModule.previewOrphanSidecarCleanup();
  assert.equal(report.orphanCount, 0, `unexpected orphans: ${JSON.stringify(report.entries)}`);
});

test("apply enforces confirm + token, fails closed on content drift or new media sibling, and cleans stale DB rows", async () => {
  const dir = "Racoon/Liverpool Rain (2011)";
  const liveAudio = writeFile(musicRoot, `${dir}/07 - Don’t Hold Me Down.m4a`, "audio");
  const orphan = writeFile(musicRoot, `${dir}/07 - Don't Hold Me Down.lrc`, "orphan");
  const newlyAdopted = writeFile(musicRoot, `${dir}/08 - New Track.lrc`, "adopted");
  insertTrack(liveAudio);
  const staleId = (database.db.prepare("INSERT INTO LyricFiles (artist_id, track_file_id, relative_path, file_path, library_root, extension) VALUES (?, NULL, ?, ?, 'music', 'lrc') RETURNING id")
    .get(RACOON_MBID, path.relative(musicRoot, orphan), orphan) as { id: number }).id;

  const preview = await cleanupModule.previewOrphanSidecarCleanup();
  assert.equal(preview.orphanCount, 2);

  await assert.rejects(() => cleanupModule.applyOrphanSidecarCleanup({ confirm: false, confirmationToken: preview.confirmationToken, preview }), /confirm: true/);
  await assert.rejects(() => cleanupModule.applyOrphanSidecarCleanup({ confirm: true, confirmationToken: "bad", preview }), cleanupModule.OrphanSidecarConflictError);

  // Modify one file and add a matching audio sibling for the other -> both skipped safely.
  fs.writeFileSync(orphan, "modified content");
  writeFile(musicRoot, `${dir}/08 - New Track.m4a`, "new audio");
  const drifted = await cleanupModule.applyOrphanSidecarCleanup({ confirm: true, confirmationToken: preview.confirmationToken, preview });
  assert.equal(drifted.deleted, 0);
  assert.equal(drifted.skippedChanged, 1);
  assert.equal(drifted.skippedProtected, 1);
  assert.ok(fs.existsSync(orphan) && fs.existsSync(newlyAdopted));

  const fresh = await cleanupModule.previewOrphanSidecarCleanup();
  const applied = await cleanupModule.applyOrphanSidecarCleanup({ confirm: true, confirmationToken: fresh.confirmationToken, preview: fresh });
  assert.equal(applied.deleted, 1);
  assert.equal(applied.deletedDbRows, 1);
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(newlyAdopted), true);
  assert.equal(database.db.prepare("SELECT id FROM LyricFiles WHERE id = ?").get(staleId), undefined);
});

test("HTTP preview + apply run via command queue (no inline walk) with two-step confirmation", async () => {
  const express = (await import("express")).default;
  const router = (await import("../../routes/library-files.js")).default;
  const app = express();
  app.use(express.json());
  app.use("/files", router);

  const dir = "The Kinks/Show-Biz (2020)";
  const liveAudio = writeFile(musicRoot, `${dir}/01 - Here Comes Yet Another Day.m4a`, "audio");
  const orphanTxt = writeFile(musicRoot, `${dir}/101 - Here Comes Yet Another Day.txt`, "old");
  insertTrack(liveAudio, 2, KINKS_MBID);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/files/orphan-sidecars`;
    assert.equal((await fetch(`${base}/preview`)).status, 404);

    const startRes = await fetch(`${base}/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(startRes.status, 202);
    const { commandId: previewCmdId } = await startRes.json() as { commandId: number };
    assert.equal((await fetch(`${base}/preview?commandId=${previewCmdId}`)).status, 202);

    const previewJob = queueModule.CommandQueueManager.claimForExecution(previewCmdId, "w1", 60_000)! as CommandModelOf<"CleanupOrphanSidecars">;
    await new executorModule.CleanupOrphanSidecarsCommand().execute(previewJob, ctx);
    queueModule.CommandQueueManager.complete(previewCmdId, "w1");

    const previewRes = await fetch(`${base}/preview?commandId=${previewCmdId}&limit=50`);
    assert.equal(previewRes.status, 200);
    const preview = await previewRes.json() as OrphanSidecarPreviewReport & { commandId: number };
    assert.equal(preview.orphanCount, 1);
    assert.equal(preview.entries[0].filePath, orphanTxt);
    assert.equal(fs.existsSync(orphanTxt), true);

    assert.equal((await fetch(`${base}/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmationToken: preview.confirmationToken }) })).status, 400);
    assert.equal((await fetch(`${base}/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true, confirmationToken: "stale", previewCommandId: previewCmdId }) })).status, 409);

    const applyRes = await fetch(`${base}/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true, confirmationToken: preview.confirmationToken, previewCommandId: previewCmdId }) });
    assert.equal(applyRes.status, 202);
    const { commandId } = await applyRes.json() as { commandId: number };
    assert.equal(fs.existsSync(orphanTxt), true);

    const applyJob = queueModule.CommandQueueManager.claimForExecution(commandId, "w2", 60_000)! as CommandModelOf<"CleanupOrphanSidecars">;
    await new executorModule.CleanupOrphanSidecarsCommand().execute(applyJob, ctx);
    assert.equal(fs.existsSync(orphanTxt), false);
    assert.equal(fs.existsSync(liveAudio), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("hardlinks are protected and artistId + filePaths + pruneEmptyFolders scoping works", async () => {
  const racoonDir = `Racoon {mbid-${RACOON_MBID}}/Liverpool Rain (2011)`;
  const kinksDir = `The Kinks {mbid-${KINKS_MBID}}/Empty Album`;
  const liveAudio = writeFile(musicRoot, `${racoonDir}/07 - Don’t Hold Me Down.m4a`, "audio");
  const liveLyric = writeFile(musicRoot, `${racoonDir}/07 - Don’t Hold Me Down.lrc`, "live");
  const hardlink = path.join(musicRoot, racoonDir, "07 - Hardlink.lrc");
  fs.linkSync(liveLyric, hardlink);
  const racoonOrphan = writeFile(musicRoot, `${racoonDir}/07 - Don't Hold Me Down.lrc`, "orphan");
  const kinksOrphan = writeFile(musicRoot, `${kinksDir}/101 - Here Comes Yet Another Day.txt`, "orphan");
  insertTrack(liveAudio);

  assert.deepEqual((await cleanupModule.previewOrphanSidecarCleanup({ artistId: KINKS_MBID })).entries.map((e) => e.filePath), [kinksOrphan]);
  const full = await cleanupModule.previewOrphanSidecarCleanup();
  assert.deepEqual(full.entries.map((e) => e.filePath), [racoonOrphan, kinksOrphan].sort((a, b) => a.localeCompare(b)));

  const applied = await cleanupModule.applyOrphanSidecarCleanup({
    confirm: true, confirmationToken: full.confirmationToken, preview: full, filePaths: [kinksOrphan], pruneEmptyFolders: true,
  });
  assert.equal(applied.deleted, 1);
  assert.equal(fs.existsSync(kinksOrphan), false);
  assert.equal(fs.existsSync(path.join(musicRoot, kinksDir)), false);
  assert.ok(fs.existsSync(racoonOrphan) && fs.existsSync(hardlink) && fs.existsSync(liveLyric));
});

test("all orphan-sidecar DB lookups use indexed SEARCH plans (zero table SCANs)", () => {
  const queries: Array<[string, string, unknown[]]> = [
    ["TrackFiles exact/folded", "SELECT id FROM TrackFiles WHERE file_path = ? OR LOWER(REPLACE(file_path, '\\', '/')) = ? LIMIT 1", ["/a/c.lrc", "/a/c.lrc"]],
    ["TrackFiles sibling folded IN", "SELECT id FROM TrackFiles WHERE LOWER(REPLACE(file_path, '\\', '/')) IN (SELECT value FROM json_each(?))", ["[\"/a/1.m4a\"]"]],
    ["TrackFiles by canonical_artist_mbid", "SELECT DISTINCT relative_path FROM TrackFiles WHERE canonical_artist_mbid = ?", [RACOON_MBID]],
    ["UnmappedFiles dir prefix", "SELECT file_path FROM UnmappedFiles WHERE file_path >= ? AND file_path < ?", ["/a/", "/a0"]],
    ["LyricFiles dir prefix", "SELECT id FROM LyricFiles WHERE file_path >= ? AND file_path < ?", ["/a/", "/a0"]],
    ["LyricFiles by track_file_id", "SELECT id FROM LyricFiles WHERE track_file_id IN (SELECT value FROM json_each(?))", ["[1]"]],
    ["MetadataFiles dir prefix", "SELECT id FROM MetadataFiles WHERE file_path >= ? AND file_path < ?", ["/a/", "/a0"]],
    ["MetadataFiles by track_file_id", "SELECT id FROM MetadataFiles WHERE track_file_id IN (SELECT value FROM json_each(?))", ["[1]"]],
    ["ExtraFiles dir prefix", "SELECT id FROM ExtraFiles WHERE file_path >= ? AND file_path < ?", ["/a/", "/a0"]],
    ["ExtraFiles by track_file_id", "SELECT id FROM ExtraFiles WHERE track_file_id IN (SELECT value FROM json_each(?))", ["[1]"]],
    ["commands latest preview", "SELECT id FROM commands WHERE name = ? ORDER BY id DESC LIMIT 25", ["CleanupOrphanSidecars"]],
  ];
  for (const [label, sql, args] of queries) {
    const details = (database.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
    assert.doesNotMatch(details, /\bSCAN\b(?! json_each\b)/i, `${label} must not table-scan: ${details}`);
    assert.match(details, /\bSEARCH\b/i, `${label} must use an index SEARCH: ${details}`);
  }
});
