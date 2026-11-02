import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { createRelationshipCreditSchema } from "../../database/schema/relationship-credits.js";
import { fetchRelationshipBundle } from "./musicbrainz-relationship-query.js";
import {
  creditsFromRelationRows,
  picardCreditTags,
  type RelationshipCredit,
} from "./relationship-credit-model.js";
import { applyRelationshipRefresh, loadCreditSnapshot } from "../metadata/relationship-credit-store.js";

const RECORDING = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const RELEASE = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const WORK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const COMPOSER = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";

function openDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE Recordings (id INTEGER PRIMARY KEY, mbid TEXT UNIQUE, relationship_credits_at TEXT);
    CREATE TABLE AlbumEditions (id INTEGER PRIMARY KEY, mbid TEXT UNIQUE);
  `);
  createRelationshipCreditSchema(db);
  return db;
}

test("relationship rows become Picard credits and skip mastering and instrumental lyricists", () => {
  const credits = creditsFromRelationRows("recording", [
    {
      entity_mbid: RECORDING, link_id: 1, link_order: 1, link_type: "instrument",
      artist_mbid: "a", credited_name: "Gus Guitar", sort_name: "Guitar, Gus",
      attribute_name: "guitar", attribute_credit: null,
    },
    {
      entity_mbid: RECORDING, link_id: 1, link_order: 1, link_type: "instrument",
      artist_mbid: "a", credited_name: "Gus Guitar", sort_name: "Guitar, Gus",
      attribute_name: "guest", attribute_credit: null,
    },
    {
      entity_mbid: RECORDING, link_id: 2, link_order: 2, link_type: "mastering",
      artist_mbid: "m", credited_name: "Master", sort_name: "Master",
      attribute_name: null, attribute_credit: null,
    },
    {
      entity_mbid: RECORDING, link_id: 3, link_order: 3, link_type: "mix-DJ",
      artist_mbid: "d", credited_name: "DJ Dee", sort_name: null,
      attribute_name: "medium 2", attribute_credit: null,
    },
  ]);
  assert.equal(credits.find((credit) => credit.role === "performer")?.attribute, "guest guitar");
  assert.equal(credits.some((credit) => credit.role === "mastering"), true);
  const tags = picardCreditTags({
    credits: [
      ...credits,
      {
        scope: "work", entityMbid: WORK, role: "lyricist", attribute: "",
        artistMbid: "l", creditedName: "Hidden Lyricist", sortName: null, order: 1, mediumPosition: null,
      },
      {
        scope: "recording", entityMbid: RECORDING, role: "composer", attribute: "",
        artistMbid: COMPOSER, creditedName: "Johann Sebastian Bach", sortName: "Bach, Johann Sebastian",
        order: 1, mediumPosition: null,
      },
    ],
    works: [{ recordingMbid: RECORDING, workMbid: WORK, title: "Prelude", order: 1, instrumental: true }],
    mediumPosition: 1,
  });
  assert.equal(tags.some((tag) => tag.value === "Hidden Lyricist"), false);
  assert.equal(tags.some((tag) => tag.tag === "mastering"), false);
  assert.equal(tags.some((tag) => tag.tag === "djmixer"), false);
  assert.deepEqual(
    tags.filter((tag) => tag.tag === "composer" || tag.tag === "composersort" || tag.tag === "work").map((tag) => tag.value),
    ["Johann Sebastian Bach", "Bach, Johann Sebastian", "Prelude"],
  );
  const onSecondDisc = picardCreditTags({
    credits,
    works: [],
    mediumPosition: 2,
  });
  assert.deepEqual(onSecondDisc.filter((tag) => tag.tag === "djmixer").map((tag) => tag.value), ["DJ Dee"]);
});

test("a missing relationship payload keeps credits and an empty mirror payload clears them", () => {
  const db = openDb();
  db.prepare("INSERT INTO Recordings (mbid) VALUES (?)").run(RECORDING);
  db.prepare("INSERT INTO AlbumEditions (mbid) VALUES (?)").run(RELEASE);
  const credit: RelationshipCredit = {
    scope: "recording", entityMbid: RECORDING, role: "composer", attribute: "",
    artistMbid: COMPOSER, creditedName: "Bach", sortName: "Bach, J.S.", order: 1, mediumPosition: null,
  };
  applyRelationshipRefresh(db, {
    queriedRecordingMbids: [RECORDING],
    queriedReleaseMbids: [RELEASE],
    credits: [credit],
    works: [{ recordingMbid: RECORDING, workMbid: WORK, title: "Prelude", order: 1, instrumental: false }],
  });
  applyRelationshipRefresh(db, null);
  const kept = loadCreditSnapshot(db, [RECORDING], [RELEASE]);
  assert.equal(kept?.known.has(RECORDING), true);
  assert.equal(kept?.credits.length, 1);
  assert.equal(kept?.works.length, 1);
  applyRelationshipRefresh(db, {
    queriedRecordingMbids: [RECORDING],
    queriedReleaseMbids: [RELEASE],
    credits: [],
    works: [],
  });
  const cleared = loadCreditSnapshot(db, [RECORDING], [RELEASE]);
  assert.equal(cleared?.known.has(RECORDING), true);
  assert.equal(cleared?.credits.length, 0);
  assert.equal(cleared?.works.length, 0);
  db.close();
});

test("replacing relationship credits for 500 recordings stays bounded", () => {
  const db = openDb();
  const insert = db.prepare("INSERT INTO Recordings (mbid) VALUES (?)");
  const mbids: string[] = [];
  const credits: RelationshipCredit[] = [];
  for (let index = 0; index < 500; index += 1) {
    const mbid = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    mbids.push(mbid);
    insert.run(mbid);
    credits.push({
      scope: "recording", entityMbid: mbid, role: "composer", attribute: "",
      artistMbid: COMPOSER, creditedName: "Bach", sortName: "Bach, Johann Sebastian",
      order: 1, mediumPosition: null,
    });
    credits.push({
      scope: "recording", entityMbid: mbid, role: "performer", attribute: "guitar",
      artistMbid: COMPOSER, creditedName: "Bach", sortName: null, order: 2, mediumPosition: null,
    });
  }
  const started = Date.now();
  applyRelationshipRefresh(db, {
    queriedRecordingMbids: mbids,
    queriedReleaseMbids: [],
    credits,
    works: [],
  });
  const elapsedMs = Date.now() - started;
  console.log(`relationship credit replace for 500 recordings: ${elapsedMs}ms`);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM CatalogRelationshipCredits").get() as { n: number }).n, 1000);
  assert.ok(elapsedMs < 3000, `credit replace took ${elapsedMs}ms`);
  db.close();
});

test("mirror relationship SQL uses uuid arrays", async () => {
  const calls: string[] = [];
  const bundle = await fetchRelationshipBundle(async (sql, values) => {
    calls.push(sql);
    assert.equal(Array.isArray(values[0]), true);
    assert.equal(sql.includes("ANY($1::uuid[])"), true);
    assert.equal(sql.includes("json_each"), false);
    return [];
  }, [RECORDING], [RELEASE]);
  assert.deepEqual(bundle.queriedRecordingMbids, [RECORDING]);
  assert.deepEqual(bundle.queriedReleaseMbids, [RELEASE]);
  assert.equal(bundle.credits.length, 0);
  assert.ok(calls.some((sql) => sql.includes("l_artist_recording")));
  assert.ok(calls.some((sql) => sql.includes("l_artist_release")));
  assert.ok(calls.some((sql) => sql.includes("l_recording_work")));
});
