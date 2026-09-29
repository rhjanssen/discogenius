import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { before, beforeEach, after, test } from "node:test";
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";

const { tempDir } = prepareActiveSchemaEnv("file-mutation-journal");
let database: Awaited<ReturnType<typeof openActiveSchemaDb>>;
let journal: typeof import("./file-mutation-journal.js").FileMutationJournal;
const source = path.join(tempDir, "files", "source.flac");
const target = path.join(tempDir, "files", "target.flac");
let fileId: number;

before(async () => {
    database = await openActiveSchemaDb();
    journal = (await import("./file-mutation-journal.js")).FileMutationJournal;
});
beforeEach(() => {
    database.db.prepare("DELETE FROM FileMutationJournal").run();
    database.db.prepare("DELETE FROM TrackFiles").run();
    fs.rmSync(path.join(tempDir, "files"), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "untouched audio file fixture");
    fileId = Number(database.db.prepare(`INSERT INTO TrackFiles (file_path, filename, relative_path, library_root, extension, file_type, library_slot)
        VALUES (?, 'source.flac', 'source.flac', ?, 'flac', 'track', 'stereo')`).run(source, path.dirname(source)).lastInsertRowid);
});
after(() => closeActiveSchemaDb(database.dbModule, tempDir));
const prepare = () => journal.prepare("TrackFiles", fileId, source, source, target);

test("intent without a filesystem mutation clears safely after reopening the database", async () => {
    await prepare();
    database.dbModule.closeDatabase();
    database.dbModule.initDatabase();
    assert.deepEqual(await journal.recoverPending(), []);
    assert.equal(fs.readFileSync(source, "utf8"), "untouched audio file fixture");
    assert.equal(journal.hasPending(), false);
});

test("a process interruption after moving restores the exact original path before file jobs start", async () => {
    const id = await prepare();
    await journal.move(id);
    assert.equal(fs.existsSync(source), false);
    const { CommandManager } = await import("../commands/command.js");
    assert.equal(CommandManager.canStartCommand("RetagFiles", { ids: [fileId] }).canStart, false);
    database.dbModule.closeDatabase();
    database.dbModule.initDatabase();
    assert.deepEqual(await journal.recoverPending(), []);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.readFileSync(source, "utf8"), "untouched audio file fixture");
    assert.equal(CommandManager.canStartCommand("RetagFiles", { ids: [fileId] }).canStart, true);
});

test("an acknowledged move keeps its destination and never overwrites a recreated source", async () => {
    const id = await prepare();
    await journal.move(id);
    database.db.transaction(() => {
        journal.assertBeforeCommit(id);
        database.db.prepare("UPDATE TrackFiles SET file_path = ? WHERE id = ?").run(target, fileId);
        journal.markCommitted(id);
    })();
    fs.writeFileSync(source, "a new external file");
    assert.deepEqual(await journal.recoverPending(), []);
    assert.equal(fs.readFileSync(target, "utf8"), "untouched audio file fixture");
    assert.equal(fs.readFileSync(source, "utf8"), "a new external file");
});

test("interruption between link and unlink removes only the identical target link", async () => {
    const id = await prepare();
    fs.linkSync(source, target);
    await journal.recoverOne(id);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.readFileSync(source, "utf8"), "untouched audio file fixture");
});

test("duplicate deletion restores before commit and cleans only its staged file after commit", async () => {
    const first = await journal.prepare("TrackFiles", fileId, source, source, null);
    const staged = await journal.move(first);
    await journal.recoverOne(first);
    assert.equal(fs.existsSync(source), true);
    assert.equal(fs.existsSync(staged), false);
    const second = await journal.prepare("TrackFiles", fileId, source, source, null);
    const committedStage = await journal.move(second);
    database.db.transaction(() => {
        journal.assertBeforeCommit(second);
        database.db.prepare("DELETE FROM TrackFiles WHERE id = ?").run(fileId);
        journal.markCommitted(second);
    })();
    await journal.recoverOne(second);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.existsSync(committedStage), false);
    assert.equal(journal.hasPending(), false);
});

test("changed destination bytes are preserved and reported instead of guessed away", async () => {
    const id = await prepare();
    await journal.move(id);
    fs.writeFileSync(target, "changed externally");
    assert.equal((await journal.recoverPending()).length, 1);
    assert.equal(fs.readFileSync(target, "utf8"), "changed externally");
    assert.equal(fs.existsSync(source), false);
    assert.equal(journal.hasPending(), true);
    const row = database.db.prepare("SELECT recovery_error FROM FileMutationJournal WHERE id = ?").get(id) as { recovery_error: string };
    assert.match(row.recovery_error, /target changed/);
});

test("cross-device recovery verifies bytes and cleans an owned partial-copy path", async () => {
    const id = await prepare();
    const digest = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
    database.db.prepare("UPDATE FileMutationJournal SET source_sha256 = ? WHERE id = ?").run(digest, id);
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    const row = database.db.prepare("SELECT temporary_path FROM FileMutationJournal WHERE id = ?").get(id) as { temporary_path: string };
    fs.writeFileSync(row.temporary_path, "an interrupted copy");
    await journal.recoverOne(id);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(row.temporary_path), false);
    assert.equal(fs.readFileSync(source, "utf8"), "untouched audio file fixture");
});

test("changed database identity prevents acknowledgement and preserves recovery evidence", async () => {
    const id = await prepare();
    await journal.move(id);
    database.db.prepare("UPDATE TrackFiles SET canonical_recording_mbid = 'different-recording' WHERE id = ?").run(fileId);
    assert.throws(() => journal.assertBeforeCommit(id), /identity changed/);
    assert.equal((await journal.recoverPending()).length, 1);
    assert.equal(fs.existsSync(target), true);
    assert.equal(journal.hasPending(), true);
});
