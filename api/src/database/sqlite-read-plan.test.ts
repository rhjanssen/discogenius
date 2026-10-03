import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import Database from "better-sqlite3";
import { prepareSqliteReadPlan } from "./sqlite-read-plan.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-read-plan-"));
process.env.DB_PATH = path.join(directory, "active.db");
process.env.DISCOGENIUS_CONFIG_DIR = directory;
let runtime: typeof import("../database.js");
let otherWriter: Database.Database;

before(async () => {
  runtime = await import("../database.js");
  runtime.initDatabase();
  otherWriter = new Database(process.env.DB_PATH!);
});
beforeEach(() => {
  runtime.db.prepare("DELETE FROM ArtistMetadata").run();
  runtime.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES ('bastille', 'Bastille'), ('bakermat', 'Bakermat')").run();
});
after(() => {
  otherWriter.close();
  runtime.closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("read plan rejects changed inputs from another connection before committing", () => {
  // A statement prepared before planning must still participate in validation.
  const lookup = runtime.db.prepare("SELECT name FROM ArtistMetadata WHERE mbid = ?");
  const plan = prepareSqliteReadPlan(() => lookup.get("bastille"));
  otherWriter.prepare("UPDATE ArtistMetadata SET name = 'Changed' WHERE mbid = 'bastille'").run();
  const committed = runtime.db.transaction(() => {
    if (!plan.isCurrent()) return false;
    runtime.db.prepare("UPDATE ArtistMetadata SET name = 'Stale decision' WHERE mbid = 'bastille'").run();
    return true;
  })();
  assert.equal(committed, false);
  assert.deepEqual(lookup.get("bastille"), { name: "Changed" });
});

test("read plan permits unrelated library writes without recomputing a decision", () => {
  const plan = prepareSqliteReadPlan(() => runtime.db.prepare("SELECT name FROM ArtistMetadata WHERE mbid = ?").get("bastille"));
  otherWriter.prepare("UPDATE ArtistMetadata SET name = 'Unrelated edit' WHERE mbid = 'bakermat'").run();
  assert.equal(runtime.db.transaction(() => plan.isCurrent())(), true);
});

test("read plan detects added candidates, removed rows and previously missing identity", () => {
  const candidates = prepareSqliteReadPlan(() => runtime.db.prepare("SELECT mbid FROM ArtistMetadata ORDER BY mbid").all());
  const missing = prepareSqliteReadPlan(() => runtime.db.prepare("SELECT name FROM ArtistMetadata WHERE mbid = 'new-artist'").get());
  otherWriter.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES ('new-artist', 'New')").run();
  assert.equal(runtime.db.transaction(() => candidates.isCurrent())(), false);
  assert.equal(runtime.db.transaction(() => missing.isCurrent())(), false);
  const existing = prepareSqliteReadPlan(() => runtime.db.prepare("SELECT name FROM ArtistMetadata WHERE mbid = 'bastille'").get());
  otherWriter.prepare("DELETE FROM ArtistMetadata WHERE mbid = 'bastille'").run();
  assert.equal(runtime.db.transaction(() => existing.isCurrent())(), false);
});

test("sorting returned candidates does not mutate their read witness", () => {
  const plan = prepareSqliteReadPlan(() => {
    const rows = runtime.db.prepare("SELECT name FROM ArtistMetadata ORDER BY mbid").all() as Array<{ name: string }>;
    rows.reverse();
    return rows;
  });
  assert.equal(runtime.db.transaction(() => plan.isCurrent())(), true);
});

test("read witnesses preserve SQLite blob values", () => {
  const plan = prepareSqliteReadPlan(() => runtime.db.prepare("SELECT X'010203' AS bytes").get());
  assert.equal(runtime.db.transaction(() => plan.isCurrent())(), true);
});

test("revision fast path detects writes on both the planning and external connection", () => {
  const prepare = () => prepareSqliteReadPlan(() => runtime.db.prepare("SELECT name FROM ArtistMetadata WHERE mbid = 'bastille'").get(), runtime.sqliteDataRevision);
  const unchanged = prepare();
  assert.equal(runtime.db.transaction(() => unchanged.isCurrent())(), true);
  runtime.db.prepare("UPDATE ArtistMetadata SET name = 'Local edit' WHERE mbid = 'bastille'").run();
  assert.equal(runtime.db.transaction(() => unchanged.isCurrent())(), false);
  const external = prepare();
  otherWriter.prepare("UPDATE ArtistMetadata SET name = 'External edit' WHERE mbid = 'bastille'").run();
  assert.equal(runtime.db.transaction(() => external.isCurrent())(), false);
  const unrelated = prepare();
  otherWriter.prepare("UPDATE ArtistMetadata SET name = 'Unrelated edit' WHERE mbid = 'bakermat'").run();
  assert.equal(runtime.db.transaction(() => unrelated.isCurrent())(), true);
});

test("decision phase rejects writes, returning writes, transactions and lazy queries", () => {
  assert.throws(() => prepareSqliteReadPlan(() => runtime.db.prepare("UPDATE ArtistMetadata SET name = 'Invalid'").run()), /must not write/);
  assert.throws(() => prepareSqliteReadPlan(() => runtime.db.prepare("UPDATE ArtistMetadata SET name = 'Invalid' RETURNING id").get()), /must not write/);
  assert.throws(() => prepareSqliteReadPlan(() => runtime.db.exec("DELETE FROM ArtistMetadata")), /must not write/);
  assert.throws(() => prepareSqliteReadPlan(() => runtime.db.transaction(() => 1)()), /must not write/);
  assert.throws(() => prepareSqliteReadPlan(() => runtime.db.prepare("SELECT name FROM ArtistMetadata").iterate()), /must not write/);
  assert.equal((runtime.db.prepare("SELECT COUNT(*) n FROM ArtistMetadata").get() as { n: number }).n, 2);
});
