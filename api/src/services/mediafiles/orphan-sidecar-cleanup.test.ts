import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
} from "../../test-support/active-schema-fixture.js";
import { seedTestLibrary } from "../../test-support/library-fixtures.js";
import type { CommandModelOf } from "../commands/command-model.js";
import type { CommandHandlerContext } from "../commands/handlers/handler-context.js";

const { tempDir } = prepareActiveSchemaEnv("orphan-sidecar-cleanup");
let database: Awaited<ReturnType<typeof openActiveSchemaDb>>;
let configModule: typeof import("../config/config.js");
let cleanupModule: typeof import("./orphan-sidecar-cleanup.js");
let pathUtils: typeof import("./path-utils.js");
let queueModule: typeof import("../commands/command-queue-manager.js");
let executorModule: typeof import("../commands/executors/cleanup-orphan-sidecars-command.js");

let musicRoot: string;
let spatialRoot: string;
let videoRoot: string;
let libraryId: number;

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
  for (const table of [
    "commands",
    "LyricFileLibraries",
    "MetadataFileLibraries",
    "ExtraFileLibraries",
    "LyricFiles",
    "MetadataFiles",
    "ExtraFiles",
    "UnmappedFiles",
    "TrackFiles",
    "LibraryArtists",
    "ArtistMetadata",
    "Libraries",
  ]) {
    database.db.prepare(`DELETE FROM ${table}`).run();
  }

  const runRoot = fs.mkdtempSync(path.join(tempDir, "roots-"));
  musicRoot = path.join(runRoot, "stereo-music");
  spatialRoot = path.join(runRoot, "spatial-music");
  videoRoot = path.join(runRoot, "music-videos");
  fs.mkdirSync(musicRoot, { recursive: true });
  fs.mkdirSync(spatialRoot, { recursive: true });
  fs.mkdirSync(videoRoot, { recursive: true });

  const cfg = configModule.readConfig();
  cfg.path.music_path = musicRoot;
  cfg.path.spatial_path = spatialRoot;
  cfg.path.video_path = videoRoot;
  configModule.writeConfig(cfg);

  libraryId = seedTestLibrary(database.db, { name: "Stereo", rootPath: musicRoot });
  database.db.prepare("INSERT INTO ArtistMetadata(id, mbid, name) VALUES (1, '1386778e-0000-0000-0000-000000000001', 'Racoon')").run();
  database.db.prepare("INSERT INTO ArtistMetadata(id, mbid, name) VALUES (2, '17b53d9f-0000-0000-0000-000000000002', 'The Kinks')").run();
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

function insertTrackFile(filePath: string, artistId = 1, root = musicRoot): number {
  const row = database.db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, library_id, file_path, relative_path, library_root,
      filename, extension, file_type, library_slot
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'track', 'stereo')
    RETURNING id
  `).get(
    artistId,
    libraryId,
    filePath,
    path.relative(root, filePath),
    root,
    path.basename(filePath),
    path.extname(filePath).slice(1),
  ) as { id: number };
  return row.id;
}

test("dry-run lists orphan .lrc/.txt/.json sidecars (Racoon apostrophe + Kinks renumbering) without deleting anything", async () => {
  const racoonDir = "Racoon {mbid-1386778e-0000-0000-0000-000000000001}/Liverpool Rain (2011) {mbid-550d7003-0000-0000-0000-000000000001}";
  const kinksDir = "The Kinks {mbid-17b53d9f-0000-0000-0000-000000000002}/Everybody’s in Show‐Biz (2020) {mbid-aa134fa5-0000-0000-0000-000000000002}";

  const liveAudio = writeFile(musicRoot, `${racoonDir}/07 - Don’t Hold Me Down.m4a`, "audio");
  const liveLyric = writeFile(musicRoot, `${racoonDir}/07 - Don’t Hold Me Down.lrc`, "[00:01.00] live");
  const orphanRacoon = writeFile(musicRoot, `${racoonDir}/07 - Don't Hold Me Down.lrc`, "[00:01.00] old straight apostrophe");
  const orphanKinksTxt = writeFile(musicRoot, `${kinksDir}/101 - Here Comes Yet Another Day.txt`, "plain lyrics");
  const orphanKinksLrc = writeFile(musicRoot, `${kinksDir}/102 - Maximum Consumption.lrc`, "[00:02.00] old disc prefix");
  const orphanJson = writeFile(musicRoot, `${kinksDir}/103 - Unreal Reality.json`, "{\"old\":true}");
  const kinksLiveAudio = writeFile(musicRoot, `${kinksDir}/01 - Here Comes Yet Another Day.m4a`, "audio");

  const trackId = insertTrackFile(liveAudio, 1);
  insertTrackFile(kinksLiveAudio, 2);

  // Stale LyricFiles row with track_file_id = NULL (left by ON DELETE SET NULL on pre-2.27.0 upgrade).
  const staleLyricRow = database.db.prepare(`
    INSERT INTO LyricFiles (artist_id, track_file_id, relative_path, file_path, library_root, extension)
    VALUES ('1386778e-0000-0000-0000-000000000001', NULL, ?, ?, 'music', 'lrc')
    RETURNING id
  `).get(path.relative(musicRoot, orphanRacoon), orphanRacoon) as { id: number };

  // Live LyricFiles row pointing at the live TrackFiles row.
  database.db.prepare(`
    INSERT INTO LyricFiles (artist_id, track_file_id, relative_path, file_path, library_root, extension)
    VALUES ('1386778e-0000-0000-0000-000000000001', ?, ?, ?, 'music', 'lrc')
  `).run(trackId, path.relative(musicRoot, liveLyric), liveLyric);

  const report = await cleanupModule.previewOrphanSidecarCleanup();
  assert.equal(report.dryRun, true);
  assert.equal(report.orphanCount, 4);
  assert.equal(report.protectedCount, 1);
  assert.deepEqual(
    report.entries.map((entry) => entry.filePath),
    [orphanRacoon, orphanKinksTxt, orphanKinksLrc, orphanJson].sort((a, b) => a.localeCompare(b)),
  );
  const racoonEntry = report.entries.find((entry) => entry.filePath === orphanRacoon)!;
  assert.deepEqual(racoonEntry.staleDbRows, [{ table: "LyricFiles", id: staleLyricRow.id, filePath: orphanRacoon }]);

  // Dry run must leave every file and DB row untouched.
  for (const filePath of [liveAudio, liveLyric, orphanRacoon, orphanKinksTxt, orphanKinksLrc, orphanJson, kinksLiveAudio]) {
    assert.equal(fs.existsSync(filePath), true, `dry run must not delete ${filePath}`);
  }
  assert.equal((database.db.prepare("SELECT COUNT(*) AS n FROM LyricFiles").get() as { n: number }).n, 2);
});

test("case-insensitive stem comparison and inode/dev DB checks protect live sidecars (ZFS #42288 safety)", async () => {
  const albumDir = "Racoon/Liverpool Rain (2011)";
  const audio = writeFile(musicRoot, `${albumDir}/12 - Save a Prayer (2 Meter Sessie).m4a`, "audio");
  const lowerLyric = writeFile(musicRoot, `${albumDir}/12 - save a prayer (2 meter sessie).lrc`, "[00:01.00] case diff");
  const liveLinkedDifferentStem = writeFile(musicRoot, `${albumDir}/12 - Live Linked Sidecar.lrc`, "[00:01.00] linked");
  const liveExtraLinked = writeFile(musicRoot, `${albumDir}/12 - Linked Extra.json`, "{}");
  const liveMetadataBio = writeFile(musicRoot, `${albumDir}/bio.txt`, "artist bio");
  const hiddenCoverJson = writeFile(musicRoot, `${albumDir}/.cover.library.json`, "{}");
  const rootReadme = writeFile(musicRoot, "README.txt", "keep root file");
  const videoFile = writeFile(videoRoot, "Racoon/Save a Prayer.mp4", "video");
  const videoInfoJson = writeFile(videoRoot, "Racoon/save a prayer.info.json", "{}");
  const unmappedAudio = writeFile(musicRoot, "Unmapped/01 - Loose Track.flac", "audio");
  const unmappedLyric = writeFile(musicRoot, "Unmapped/01 - loose track.lrc", "[00:01.00] unmapped");

  const liveTrackId = insertTrackFile(audio, 1);

  // Use a symlink alias as stored DB path to prove inode/dev matching works even when path spellings differ.
  const rootAlias = path.join(path.dirname(musicRoot), "music-alias");
  fs.symlinkSync(musicRoot, rootAlias);
  const aliasedLinkedPath = path.join(rootAlias, albumDir, "12 - Live Linked Sidecar.lrc");
  const aliasedExtraPath = path.join(rootAlias, albumDir, "12 - Linked Extra.json");

  database.db.prepare(`
    INSERT INTO LyricFiles (artist_id, track_file_id, relative_path, file_path, library_root, extension)
    VALUES ('1386778e-0000-0000-0000-000000000001', ?, ?, ?, 'music', 'lrc')
  `).run(liveTrackId, path.relative(musicRoot, liveLinkedDifferentStem), aliasedLinkedPath);

  database.db.prepare(`
    INSERT INTO ExtraFiles (artist_id, track_file_id, relative_path, file_path, library_root, extension, file_type)
    VALUES ('1386778e-0000-0000-0000-000000000001', ?, '', ?, 'music', 'json', 'duplicate')
  `).run(liveTrackId, aliasedExtraPath);

  database.db.prepare(`
    INSERT INTO MetadataFiles (artist_id, track_file_id, relative_path, file_path, library_root, extension, type, file_type)
    VALUES ('1386778e-0000-0000-0000-000000000001', NULL, ?, ?, 'music', 'txt', 'ArtistMetadata', 'bio')
  `).run(path.relative(musicRoot, liveMetadataBio), liveMetadataBio);

  database.db.prepare(`
    INSERT INTO UnmappedFiles (file_path, relative_path, library_root, filename, extension)
    VALUES (?, ?, 'music', '01 - Loose Track.flac', 'flac')
  `).run(unmappedAudio, path.relative(musicRoot, unmappedAudio));

  const report = await cleanupModule.previewOrphanSidecarCleanup();
  assert.equal(report.orphanCount, 0, `expected 0 orphans, got: ${JSON.stringify(report.entries)}`);
  assert.ok(fs.existsSync(lowerLyric));
  assert.ok(fs.existsSync(liveLinkedDifferentStem));
  assert.ok(fs.existsSync(liveExtraLinked));
  assert.ok(fs.existsSync(liveMetadataBio));
  assert.ok(fs.existsSync(hiddenCoverJson));
  assert.ok(fs.existsSync(rootReadme));
  assert.ok(fs.existsSync(videoFile));
  assert.ok(fs.existsSync(videoInfoJson));
  assert.ok(fs.existsSync(unmappedLyric));
});

test("apply requires explicit confirm + matching confirmationToken, removes confirmed orphans and stale DB rows, and fails closed on drift", async () => {
  const albumDir = "Racoon/Liverpool Rain (2011)";
  const liveAudio = writeFile(musicRoot, `${albumDir}/07 - Don’t Hold Me Down.m4a`, "audio");
  const liveLyric = writeFile(musicRoot, `${albumDir}/07 - Don’t Hold Me Down.lrc`, "[00:01.00] live");
  const orphan = writeFile(musicRoot, `${albumDir}/07 - Don't Hold Me Down.lrc`, "[00:01.00] orphan");
  insertTrackFile(liveAudio, 1);

  const staleId = (database.db.prepare(`
    INSERT INTO LyricFiles (artist_id, track_file_id, relative_path, file_path, library_root, extension)
    VALUES ('1386778e-0000-0000-0000-000000000001', NULL, ?, ?, 'music', 'lrc')
    RETURNING id
  `).get(path.relative(musicRoot, orphan), orphan) as { id: number }).id;

  const preview = await cleanupModule.previewOrphanSidecarCleanup();
  assert.equal(preview.orphanCount, 1);

  // Without confirm: true -> rejected, nothing deleted.
  await assert.rejects(
    () => cleanupModule.applyOrphanSidecarCleanup({
      confirm: false,
      confirmationToken: preview.confirmationToken,
    }),
    /confirm: true/,
  );
  assert.equal(fs.existsSync(orphan), true);

  // Wrong confirmation token -> conflict, nothing deleted.
  await assert.rejects(
    () => cleanupModule.applyOrphanSidecarCleanup({
      confirm: true,
      confirmationToken: "0000000000000000",
    }),
    cleanupModule.OrphanSidecarConflictError,
  );
  assert.equal(fs.existsSync(orphan), true);

  // File content changes after preview -> token drifts -> conflict, nothing deleted.
  fs.writeFileSync(orphan, "[00:01.00] modified orphan content");
  await assert.rejects(
    () => cleanupModule.applyOrphanSidecarCleanup({
      confirm: true,
      confirmationToken: preview.confirmationToken,
    }),
    cleanupModule.OrphanSidecarConflictError,
  );
  assert.equal(fs.existsSync(orphan), true);

  // Re-preview and apply with the fresh token -> removes orphan + stale DB row, preserves live files.
  const fresh = await cleanupModule.previewOrphanSidecarCleanup();
  const applied = await cleanupModule.applyOrphanSidecarCleanup({
    confirm: true,
    confirmationToken: fresh.confirmationToken,
  });
  assert.equal(applied.deleted, 1);
  assert.equal(applied.deletedDbRows, 1);
  assert.equal(applied.errors.length, 0);
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(liveAudio), true);
  assert.equal(fs.existsSync(liveLyric), true);
  assert.equal(database.db.prepare("SELECT id FROM LyricFiles WHERE id = ?").get(staleId), undefined);
});

test("HTTP preview + apply enforces two-step dry-run confirmation and queues CleanupOrphanSidecars", async () => {
  const express = (await import("express")).default;
  const router = (await import("../../routes/library-files.js")).default;
  const app = express();
  app.use(express.json());
  app.use("/files", router);

  const albumDir = "The Kinks/Show-Biz (2020)";
  const liveAudio = writeFile(musicRoot, `${albumDir}/01 - Here Comes Yet Another Day.m4a`, "audio");
  const orphanTxt = writeFile(musicRoot, `${albumDir}/101 - Here Comes Yet Another Day.txt`, "old");
  insertTrackFile(liveAudio, 2);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}/files/orphan-sidecars`;

    const previewRes = await fetch(`${base}/preview`);
    assert.equal(previewRes.status, 200);
    const preview = await previewRes.json() as Awaited<ReturnType<typeof cleanupModule.previewOrphanSidecarCleanup>>;
    assert.equal(preview.dryRun, true);
    assert.equal(preview.orphanCount, 1);
    assert.equal(preview.entries[0].filePath, orphanTxt);
    assert.equal(fs.existsSync(orphanTxt), true);

    const noConfirmRes = await fetch(`${base}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmationToken: preview.confirmationToken }),
    });
    assert.equal(noConfirmRes.status, 400);

    const badTokenRes = await fetch(`${base}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, confirmationToken: "stale-token" }),
    });
    assert.equal(badTokenRes.status, 409);

    const applyRes = await fetch(`${base}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, confirmationToken: preview.confirmationToken }),
    });
    assert.equal(applyRes.status, 202);
    const { commandId } = await applyRes.json() as { commandId: number };
    assert.ok(Number.isInteger(commandId) && commandId > 0);
    // Route queues the work; file is not removed inline before the worker executes.
    assert.equal(fs.existsSync(orphanTxt), true);

    const job = queueModule.CommandQueueManager.claimForExecution(commandId, "orphan-test", 60_000)! as CommandModelOf<"CleanupOrphanSidecars">;
    await new executorModule.CleanupOrphanSidecarsCommand().execute(job, ctx);
    assert.equal(fs.existsSync(orphanTxt), false);
    assert.equal(fs.existsSync(liveAudio), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("hardlinked sidecar sharing inode with live track sidecar is protected, and artistId + filePaths scoping works", async () => {
  const racoonDir = "Racoon {mbid-1386778e-0000-0000-0000-000000000001}/Liverpool Rain (2011)";
  const kinksDir = "The Kinks {mbid-17b53d9f-0000-0000-0000-000000000002}/Empty Album";
  const liveAudio = writeFile(musicRoot, `${racoonDir}/07 - Don’t Hold Me Down.m4a`, "audio");
  const liveLyric = writeFile(musicRoot, `${racoonDir}/07 - Don’t Hold Me Down.lrc`, "[00:01.00] live");
  const hardlinkedAlias = path.join(musicRoot, racoonDir, "07 - Hardlink Alias.lrc");
  fs.linkSync(liveLyric, hardlinkedAlias);
  const racoonOrphan = writeFile(musicRoot, `${racoonDir}/07 - Don't Hold Me Down.lrc`, "orphan");
  const kinksOrphan = writeFile(musicRoot, `${kinksDir}/101 - Here Comes Yet Another Day.txt`, "orphan");
  insertTrackFile(liveAudio, 1);

  // Scoped to The Kinks only -> only kinksOrphan is listed.
  const kinksPreview = await cleanupModule.previewOrphanSidecarCleanup({
    artistId: "17b53d9f-0000-0000-0000-000000000002",
  });
  assert.deepEqual(kinksPreview.entries.map((entry) => entry.filePath), [kinksOrphan]);

  // Full preview -> hardlinkedAlias is protected by inode/dev (isSameFile), only the two true orphans appear.
  const fullPreview = await cleanupModule.previewOrphanSidecarCleanup();
  assert.deepEqual(
    fullPreview.entries.map((entry) => entry.filePath),
    [racoonOrphan, kinksOrphan].sort((a, b) => a.localeCompare(b)),
  );

  // Apply only kinksOrphan with pruneEmptyFolders: true -> removes kinksOrphan and its empty album folder, keeps racoonOrphan & hardlinkedAlias.
  const applied = await cleanupModule.applyOrphanSidecarCleanup({
    confirm: true,
    confirmationToken: fullPreview.confirmationToken,
    filePaths: [kinksOrphan],
    pruneEmptyFolders: true,
  });
  assert.equal(applied.deleted, 1);
  assert.equal(fs.existsSync(kinksOrphan), false);
  assert.equal(fs.existsSync(path.join(musicRoot, kinksDir)), false);
  assert.equal(fs.existsSync(racoonOrphan), true);
  assert.equal(fs.existsSync(hardlinkedAlias), true);
  assert.equal(fs.existsSync(liveLyric), true);
});
