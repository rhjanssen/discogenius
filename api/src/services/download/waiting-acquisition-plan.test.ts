import assert from "node:assert/strict";
import { after, test } from "node:test";
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from "../../test-support/active-schema-fixture.js";
import { seedTestLibrary } from "../../test-support/library-fixtures.js";
import { resolveWaitingAcquisitionPlan } from "./waiting-acquisition-plan.js";

const { tempDir } = prepareActiveSchemaEnv("waiting-plan-intent");
const { db, dbModule } = await openActiveSchemaDb();
const library = seedTestLibrary(db, { name: "Intent", rootPath: tempDir });
const otherLibrary = seedTestLibrary(db, { name: "Other intent", rootPath: `${tempDir}/other` });
after(() => closeActiveSchemaDb(dbModule, tempDir));

function fixture(run: (old: number, current: number) => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      INSERT INTO ArtistMetadata(id,mbid,name) VALUES(1,'artist','Artist');
      INSERT INTO Albums(id,mbid,artist_mbid,title) VALUES(1,'group','artist','Group');
      INSERT INTO AlbumEditions(id,mbid,release_group_mbid,artist_mbid,title)
        VALUES(1,'standard','group','artist','Standard'),(2,'deluxe','group','artist','Deluxe');
    `);
    const plan = (lib: number, edition: number, provider: string, key: string, state: string) => Number(db.prepare(`
      INSERT INTO AcquisitionPlans(library_id,edition_id,provider,composition,download_mode,state,plan_key,planner_version,policy_hash,computed_at)
      VALUES(?,?,?,'single_source','album',?,?,1,'policy',CURRENT_TIMESTAMP)
    `).run(lib, edition, provider, state, key).lastInsertRowid);
    const old = plan(library, 1, "tidal", "old", "stale");
    const current = plan(library, 1, "tidal", "current", "current");
    plan(library, 2, "tidal", "deluxe", "current");
    plan(otherLibrary, 1, "tidal", "other-library", "current");
    for (const [lib, edition, key] of [[library, 1, "current"], [library, 2, "deluxe"], [otherLibrary, 1, "other-library"]]) {
      db.prepare(`INSERT INTO LibraryEditions(library_id,edition_id,selection_mode,curation_version,preferred_plan_key)
        VALUES(?,?,'auto',1,?)`).run(lib, edition, key);
    }
    run(old, current);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db.exec("ROLLBACK"); }
}

test("waiting plan replacement retains exact edition, library and provider despite album alternatives", () => fixture((old, current) => {
  assert.equal(resolveWaitingAcquisitionPlan(db, old, {}, "tidal"), current);
}));

test("deleted waiting plan resolves only through its durable exact request", () => fixture((old, current) => {
  db.prepare("DELETE FROM AcquisitionPlans WHERE id=?").run(old);
  assert.equal(resolveWaitingAcquisitionPlan(db, old, { libraryId: library, releaseMbid: "standard" }, "tidal"), current);
  assert.equal(resolveWaitingAcquisitionPlan(db, old, { albumId: "group" }, "tidal"), null);
}));

test("waiting plan does not silently switch providers after a selected source change", () => fixture((old, current) => {
  db.prepare("UPDATE AcquisitionPlans SET provider='deezer' WHERE id=?").run(current);
  assert.equal(resolveWaitingAcquisitionPlan(db, old, {}, "tidal"), null);
}));

test("conflicting durable waiting plan identities fail closed", () => fixture(old => {
  for (const payload of [{ libraryId: otherLibrary }, { releaseMbid: "deluxe" }, { provider: "deezer" }, { libraryId: String(library) }]) {
    assert.equal(resolveWaitingAcquisitionPlan(db, old, payload, "tidal"), null);
  }
}));

test("unavailable or disabled exact plan does not select another library or edition", () => fixture((old, current) => {
  db.prepare("UPDATE AcquisitionPlans SET state='unavailable' WHERE id=?").run(current);
  assert.equal(resolveWaitingAcquisitionPlan(db, old, {}, "tidal"), null);
  db.prepare("UPDATE AcquisitionPlans SET state='current' WHERE id=?").run(current);
  db.prepare("UPDATE Libraries SET enabled=0 WHERE id=?").run(library);
  assert.equal(resolveWaitingAcquisitionPlan(db, old, {}, "tidal"), null);
}));
