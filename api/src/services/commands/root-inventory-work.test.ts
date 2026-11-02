import assert from "node:assert/strict";
import { after, before, beforeEach, afterEach, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";
import type { CommandModelOf } from "./command-model.js";
import type { CommandHandlerContext } from "./handlers/handler-context.js";

const { tempDir } = prepareActiveSchemaEnv("root-inventory");
let database: Awaited<ReturnType<typeof openActiveSchemaDb>>;
let queue: typeof import("./command-queue-manager.js");
let outcome: typeof import("./command-context.js");
let inventory: typeof import("./root-inventory-work.js");
let config: typeof import("../config/config.js");
let root: string;
let restore: () => void;
const ctx: CommandHandlerContext = {
    updateCommandDescription: () => {}, formatArtistPhaseDescription: () => "", formatWorkflowCommandLabel: () => "",
    resolveArtistLabel: () => "", yieldToEventLoop: () => new Promise(resolve => setImmediate(resolve)),
};

before(async () => {
    database = await openActiveSchemaDb();
    queue = await import("./command-queue-manager.js");
    outcome = await import("./command-context.js");
    inventory = await import("./root-inventory-work.js");
    config = await import("../config/config.js");
});
beforeEach(() => {
    database.db.prepare("DELETE FROM commands").run();
    database.db.prepare("DELETE FROM UnmappedFiles").run();
    database.db.prepare("DELETE FROM TrackFiles").run();
    root = fs.mkdtempSync(path.join(tempDir, "library-"));
    const music = config.Config.getMusicPath, spatial = config.Config.getSpatialPath, video = config.Config.getVideoPath;
    config.Config.getMusicPath = () => root;
    config.Config.getSpatialPath = () => path.join(root, "disabled-spatial");
    config.Config.getVideoPath = () => path.join(root, "disabled-video");
    fs.mkdirSync(config.Config.getSpatialPath()); fs.mkdirSync(config.Config.getVideoPath());
    restore = () => { config.Config.getMusicPath = music; config.Config.getSpatialPath = spatial; config.Config.getVideoPath = video; };
});
afterEach(() => { restore(); fs.rmSync(root, { recursive: true, force: true }); });
after(() => closeActiveSchemaDb(database.dbModule, tempDir));

function claim(id?: number): CommandModelOf<"RescanFolders"> {
    return queue.CommandQueueManager.claimForExecution(id ?? queue.CommandQueueManager.push(queue.CommandNames.RescanFolders, {}), "inventory-test", 60_000)! as CommandModelOf<"RescanFolders">;
}
async function finish(job = claim()) {
    let current = job;
    for (let unit = 0; unit < 20; unit++) {
        try { return await inventory.runRootInventoryWorkUnit(current, ctx); }
        catch (error) {
            assert.equal(await outcome.persistCommandOutcome(current, error), "requeued");
            current = claim(current.id);
        }
    }
    throw new Error("Inventory failed to finish bounded work");
}
function wav(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const size = 8000 * 2;
    const buffer = Buffer.alloc(44 + size);
    buffer.write("RIFF"); buffer.writeUInt32LE(size + 36, 4); buffer.write("WAVEfmt ", 8);
    buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34); buffer.write("data", 36); buffer.writeUInt32LE(size, 40);
    fs.writeFileSync(file, buffer);
}

test("root inventory discovers loose media and unknown artist folders while preserving ignored review", async () => {
    const loose = path.join(root, "Loose.wav"); wav(loose);
    const album = path.join(root, "Unknown Artist", "Unknown Album", "Track.wav"); wav(album);
    const ignored = path.join(root, "Ignored.wav"); wav(ignored);
    database.db.prepare(`INSERT INTO UnmappedFiles (file_path,relative_path,filename,extension,library_root,file_size,ignored)
        VALUES (?, 'Ignored.wav', 'Ignored.wav', 'wav', 'music', ?, 1)`).run(ignored, fs.statSync(ignored).size);
    const json = path.join(root, "leftover.json"); fs.writeFileSync(json, "{}");
    const result = await finish();
    assert.equal(result.complete, true);
    assert.equal(result.reviewFiles, 2);
    assert.equal((database.db.prepare("SELECT ignored FROM UnmappedFiles WHERE file_path=?").get(ignored) as { ignored: number }).ignored, 1);
    const paths = (database.db.prepare("SELECT file_path FROM UnmappedFiles").all() as Array<{ file_path: string }>).map(row => row.file_path).sort();
    assert.deepEqual(paths, [loose, album, ignored].sort());
    assert.equal(fs.existsSync(json), true, "inventory alone must not authorize strict deletion");
    assert.equal(fs.existsSync(album), true);
    const second = await finish();
    assert.equal(second.reviewFiles, 0, "repeat inventory must not reset or re-probe existing review files");
});

test("inventory checkpoints large directories and resumes after database reopen", async () => {
    for (let n = 0; n < 210; n++) fs.writeFileSync(path.join(root, `${n}.txt`), "preserved");
    const job = claim();
    let continuation: unknown;
    try { await inventory.runRootInventoryWorkUnit(job, ctx); } catch (error) { continuation = error; }
    assert.equal(await outcome.persistCommandOutcome(job, continuation), "requeued");
    const checkpoint = queue.CommandQueueManager.get(job.id)!.payload.rootInventory!;
    assert.equal(checkpoint.complete, false);
    assert.ok(checkpoint.files > 0 && checkpoint.files < 210);
    database.dbModule.closeDatabase(); database.dbModule.initDatabase();
    const result = await finish(claim(job.id));
    assert.equal(result.files, 210);
    assert.equal(result.reviewFiles, 0);
});

test("checkpoint paths cannot escape the configured roots", async () => {
    const job = claim();
    const result = await inventory.runRootInventoryWorkUnit(job, ctx);
    queue.CommandQueueManager.updateState(job.id, { workerId: job.worker_id!, payloadPatch: {
        rootInventory: { ...result, complete: false, pending: [{ root: 0, directory: path.dirname(root) }] },
    } });
    await assert.rejects(inventory.runRootInventoryWorkUnit(queue.CommandQueueManager.get(job.id)! as typeof job, ctx), /outside its library root/);
});

test("directory read failure cannot mark the inventory complete", async () => {
    const job = claim();
    const read = fs.readdirSync;
    fs.readdirSync = ((directory: fs.PathLike, ...args: unknown[]) => {
        if (String(directory) === root) throw Object.assign(new Error("Read denied"), { code: "EACCES" });
        return (read as (...values: unknown[]) => unknown)(directory, ...args);
    }) as typeof fs.readdirSync;
    try { await assert.rejects(inventory.runRootInventoryWorkUnit(job, ctx), /Read denied/); }
    finally { fs.readdirSync = read; }
    assert.equal(queue.CommandQueueManager.get(job.id)!.payload.rootInventory!.complete, false);
});

test("a discovered directory disappearing cannot complete the inventory", async () => {
    const album = path.join(root, "Disappearing Album");
    wav(path.join(album, "Track.wav"));
    const job = claim();
    const read = fs.readdirSync;
    fs.readdirSync = ((directory: fs.PathLike, ...args: unknown[]) => {
        const entries = (read as (...values: unknown[]) => unknown)(directory, ...args);
        if (String(directory) === root) fs.rmSync(album, { recursive: true });
        return entries;
    }) as typeof fs.readdirSync;
    try {
        await assert.rejects(inventory.runRootInventoryWorkUnit(job, ctx), /directory disappeared during scan/);
    } finally { fs.readdirSync = read; }
    assert.equal(queue.CommandQueueManager.get(job.id)!.payload.rootInventory!.complete, false);
});

test("root replacement between batches invalidates the persisted inventory", async () => {
    for (let n = 0; n < 210; n++) fs.writeFileSync(path.join(root, `${n}.txt`), "original");
    const job = claim();
    let continuation: unknown;
    try { await inventory.runRootInventoryWorkUnit(job, ctx); } catch (error) { continuation = error; }
    assert.equal(await outcome.persistCommandOutcome(job, continuation), "requeued");
    const relocated = `${root}-original`;
    fs.renameSync(root, relocated);
    fs.mkdirSync(root);
    try {
        await assert.rejects(inventory.runRootInventoryWorkUnit(claim(job.id), ctx), /directory replaced during scan/);
        assert.equal(queue.CommandQueueManager.get(job.id)!.payload.rootInventory!.complete, false);
        assert.equal(fs.existsSync(path.join(relocated, "0.txt")), true);
    } finally { fs.rmSync(relocated, { recursive: true }); }
});

test("a listed album directory replacement cannot reuse its file cursor", async () => {
    const album = path.join(root, "Album");
    fs.mkdirSync(album);
    for (let n = 0; n < 210; n++) fs.writeFileSync(path.join(album, `${n}.txt`), "original");
    const job = claim();
    let continuation: unknown;
    try { await inventory.runRootInventoryWorkUnit(job, ctx); } catch (error) { continuation = error; }
    assert.equal(await outcome.persistCommandOutcome(job, continuation), "requeued");
    assert.equal(queue.CommandQueueManager.get(job.id)!.payload.rootInventory!.current!.directory, album);
    fs.renameSync(album, `${album}-original`);
    fs.mkdirSync(album);
    await assert.rejects(inventory.runRootInventoryWorkUnit(claim(job.id), ctx), /directory replaced during scan/);
    assert.equal(queue.CommandQueueManager.get(job.id)!.payload.rootInventory!.complete, false);
});

test("initially missing roots stay marked incomplete even if they appear during traversal", async () => {
    const spatial = config.Config.getSpatialPath();
    fs.rmdirSync(spatial);
    const read = fs.readdirSync;
    fs.readdirSync = ((directory: fs.PathLike, ...args: unknown[]) => {
        const entries = (read as (...values: unknown[]) => unknown)(directory, ...args);
        if (String(directory) === config.Config.getVideoPath()) fs.mkdirSync(spatial);
        return entries;
    }) as typeof fs.readdirSync;
    try {
        const result = await finish();
        assert.equal(result.complete, true, "traversal may finish without certifying every root as available");
        assert.deepEqual(result.missingRoots, [spatial]);
        assert.equal(result.rootIdentities![1], null);
    } finally { fs.readdirSync = read; }
});

test("an ancestor replaced by a link is refused before reading an empty directory", async t => {
    const artist = path.join(root, "Artist");
    const album = path.join(artist, "Empty Album");
    fs.mkdirSync(album, { recursive: true });
    const outside = fs.mkdtempSync(path.join(tempDir, "replacement-"));
    fs.mkdirSync(path.join(outside, "Empty Album"));
    const probe = path.join(root, "link-probe");
    try { fs.symlinkSync(outside, probe, "junction"); fs.unlinkSync(probe); }
    catch (error) { fs.rmSync(outside, { recursive: true }); t.skip(`Symlink unavailable: ${String(error)}`); return; }
    const job = claim();
    const read = fs.readdirSync;
    let escapedRead = false;
    fs.readdirSync = ((directory: fs.PathLike, ...args: unknown[]) => {
        if (String(directory) === album) escapedRead = true;
        const entries = (read as (...values: unknown[]) => unknown)(directory, ...args);
        if (String(directory) === artist) {
            fs.rmSync(artist, { recursive: true });
            fs.symlinkSync(outside, artist, "junction");
        }
        return entries;
    }) as typeof fs.readdirSync;
    try {
        await assert.rejects(inventory.runRootInventoryWorkUnit(job, ctx), /Inventory directory changed/);
        assert.equal(escapedRead, false);
        assert.equal(queue.CommandQueueManager.get(job.id)!.payload.rootInventory!.complete, false);
    } finally {
        fs.readdirSync = read;
        fs.unlinkSync(artist);
        fs.rmSync(outside, { recursive: true });
    }
});

test("symlinks outside a root are not traversed", async t => {
    const outside = fs.mkdtempSync(path.join(tempDir, "outside-"));
    const file = path.join(outside, "Private.wav"); wav(file);
    try {
        try { fs.symlinkSync(outside, path.join(root, "outside-link"), "junction"); }
        catch (error) { t.skip(`Symlink unavailable: ${String(error)}`); return; }
        const result = await finish();
        assert.equal(result.reviewFiles, 0);
        assert.equal(fs.existsSync(file), true);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});
