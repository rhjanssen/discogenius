/**
 * What each catalogue mode can and cannot supply, and what happens when they
 * meet in one database.
 *
 * Discogenius runs against either the Servarr Metadata Server or a local
 * MusicBrainz mirror, behind one `CatalogProvider` seam. The modes are not
 * equivalent: MB-local exposes fields Servarr strips, and the *asymmetry* is
 * the dangerous part. A user who switches to MB-local, ingests ISRCs, barcodes
 * and recording comments, then switches back must not have them erased by the
 * next refresh — the poorer mode's silence is absence of evidence, not evidence
 * of absence.
 *
 * These are contract tests over the mapping and upsert layers, not integration
 * tests: they pin what each mode *claims* to produce and prove the merge rule
 * holds, without needing either server running.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { mapMbRecordingToCatalog, mapMbTrackToLidarr } from "./musicbrainz-ws-mapping.js";

/* ── What MB-local supplies that Servarr does not ───────────────────── */

test("MB-local carries the recording comment onto the catalog DTO", () => {
  const recording = mapMbRecordingToCatalog({
    id: "rec-1",
    title: "Pompeii",
    length: 214148,
    video: false,
    disambiguation: "dolby atmos mix",
    isrcs: ["GBARL1300302"],
  });
  assert.equal(recording.disambiguation, "dolby atmos mix");
  assert.deepEqual(recording.isrcs, ["GBARL1300302"]);
});

test("MB-local carries the recording comment through the Lidarr-shaped track", () => {
  // The MB-local read path maps to the Lidarr DTO before reaching the writer,
  // so a field dropped here is a field lost regardless of what the DB allows.
  const track = mapMbTrackToLidarr({
    id: "track-1",
    position: 1,
    number: "1",
    title: "Pompeii",
    length: 214148,
    recording: {
      id: "rec-1",
      title: "Pompeii",
      length: 214148,
      video: false,
      disambiguation: "live",
      isrcs: ["GBARL1300302"],
    },
  }, 1);
  assert.equal(track.RecordingDisambiguation, "live");
  assert.deepEqual(track.Isrcs, ["GBARL1300302"]);
});

test("an absent comment maps to null, never to an empty string", () => {
  // "" and null both mean "no comment", but only null survives the COALESCE
  // guard below — an empty string would overwrite a stored value.
  const recording = mapMbRecordingToCatalog({ id: "rec-2", title: "Pompeii", length: 1 });
  assert.equal(recording.disambiguation, null);
  const track = mapMbTrackToLidarr(
    { id: "t", position: 1, recording: { id: "rec-2", title: "Pompeii", disambiguation: "" } },
    1,
  );
  assert.equal(track.RecordingDisambiguation, null);
});

/* ── The mode-switch merge rule ─────────────────────────────────────── */

/**
 * The production upsert from `servarr-metadata.ts`, which serves both modes:
 * MB-local fills the extra columns, Servarr passes null for them.
 */
const RECORDING_UPSERT = `
  INSERT INTO Recordings (mbid, title, length_ms, disambiguation, isrcs, is_video, artist_mbid, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(mbid) DO UPDATE SET
    title = excluded.title,
    length_ms = excluded.length_ms,
    disambiguation = COALESCE(excluded.disambiguation, Recordings.disambiguation),
    isrcs = COALESCE(excluded.isrcs, Recordings.isrcs),
    is_video = CASE WHEN excluded.is_video = 1 THEN 1 ELSE Recordings.is_video END,
    artist_mbid = COALESCE(Recordings.artist_mbid, excluded.artist_mbid),
    updated_at = CURRENT_TIMESTAMP
`;

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE Recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mbid TEXT UNIQUE, title TEXT NOT NULL, length_ms INT,
      disambiguation TEXT, isrcs TEXT,
      is_video BOOLEAN NOT NULL DEFAULT 0, artist_mbid TEXT,
      updated_at DATETIME);
  `);
  return db;
}

const read = (db: Database.Database) =>
  db.prepare("SELECT title, disambiguation, isrcs FROM Recordings WHERE mbid = 'rec-1'")
    .get() as { title: string; disambiguation: string | null; isrcs: string | null };

test("a Servarr refresh does not erase what MB-local stored", () => {
  const db = freshDb();
  try {
    const upsert = db.prepare(RECORDING_UPSERT);
    // MB-local ingests first, with everything it knows.
    upsert.run("rec-1", "Pompeii", 214148, "live", JSON.stringify(["GBARL1300302"]), 0, "artist-1");
    // The user switches to Servarr, which supplies neither field.
    upsert.run("rec-1", "Pompeii", 214148, null, null, 0, "artist-1");

    const row = read(db);
    assert.equal(row.disambiguation, "live", "comment must survive the poorer mode");
    assert.equal(row.isrcs, JSON.stringify(["GBARL1300302"]));
  } finally {
    db.close();
  }
});

test("MB-local fills in what a Servarr-first ingest left empty", () => {
  const db = freshDb();
  try {
    const upsert = db.prepare(RECORDING_UPSERT);
    upsert.run("rec-1", "Pompeii", 214148, null, null, 0, "artist-1");
    assert.equal(read(db).disambiguation, null);

    upsert.run("rec-1", "Pompeii", 214148, "live", JSON.stringify(["GBARL1300302"]), 0, "artist-1");
    assert.equal(read(db).disambiguation, "live");
  } finally {
    db.close();
  }
});

test("MB-local may still correct a value it previously supplied", () => {
  // COALESCE protects against null, not against change. A MusicBrainz edit that
  // moves a recording from "live" to "live, 2005-05-19: …" must land.
  const db = freshDb();
  try {
    const upsert = db.prepare(RECORDING_UPSERT);
    upsert.run("rec-1", "Pompeii", 214148, "live", null, 0, "artist-1");
    upsert.run("rec-1", "Pompeii", 214148, "live, 2013-08-30: Reading Festival", null, 0, "artist-1");
    assert.equal(read(db).disambiguation, "live, 2013-08-30: Reading Festival");
  } finally {
    db.close();
  }
});

test("fields both modes supply are overwritten, not merged", () => {
  // The guard is deliberately narrow: title and length are authoritative in
  // both modes, so a correction must win rather than be preserved.
  const db = freshDb();
  try {
    const upsert = db.prepare(RECORDING_UPSERT);
    upsert.run("rec-1", "Pompei", 214148, null, null, 0, "artist-1");
    upsert.run("rec-1", "Pompeii", 214148, null, null, 0, "artist-1");
    assert.equal(read(db).title, "Pompeii");
  } finally {
    db.close();
  }
});
