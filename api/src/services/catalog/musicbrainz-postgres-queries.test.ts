import assert from "node:assert/strict";
import { test } from "node:test";

import {
  splitDateSql,
  artistCreditJsonSql,
  artistByGidQuery,
  artistReleaseGroupsQuery,
  releaseGroupByGidQuery,
  releasesForReleaseGroupQuery,
  tracksForReleaseQuery,
  recordingByGidQuery,
  releasesByBarcodeQuery,
  recordingsByIsrcQuery,
  type PgQuery,
} from "./musicbrainz-postgres-queries.js";

const GID = "f27ec8db-af05-4f36-916e-3d57f91ecf5e";

/** Crude but effective parameterization + balance checks for a built query. */
function assertWellFormed(query: PgQuery, expectedValues: unknown[]): void {
  const text = query.text;
  assert.ok(text.trim().toUpperCase().startsWith("SELECT"), "query should be a SELECT");
  assert.deepEqual(query.values, expectedValues);
  // every `$n` placeholder must have a corresponding value
  const placeholders = new Set((text.match(/\$\d+/g) || []).map((p) => Number(p.slice(1))));
  for (const n of placeholders) {
    assert.ok(n >= 1 && n <= query.values.length, `placeholder $${n} out of range`);
  }
  // balanced parens
  const opens = (text.match(/\(/g) || []).length;
  const closes = (text.match(/\)/g) || []).length;
  assert.equal(opens, closes, "parentheses should balance");
  // read-only: no mutating verbs
  assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i.test(text), "must be read-only");
}

test("splitDateSql reconstructs partial dates from year/month/day", () => {
  const sql = splitDateSql("rgm.first_release_date", "first_release_date");
  assert.ok(sql.includes("rgm.first_release_date_year"));
  assert.ok(sql.includes("rgm.first_release_date_month"));
  assert.ok(sql.includes("rgm.first_release_date_day"));
  assert.ok(sql.includes("make_date"));
  assert.ok(sql.includes("AS first_release_date"));
});

test("artistCreditJsonSql joins artist_credit_name + artist ordered by position", () => {
  const sql = artistCreditJsonSql("rg.artist_credit");
  assert.ok(sql.includes("artist_credit_name acn"));
  assert.ok(sql.includes("JOIN artist a ON a.id = acn.artist"));
  assert.ok(sql.includes("ORDER BY acn.position"));
  assert.ok(sql.includes("WHERE acn.artist_credit = rg.artist_credit"));
});

test("artistByGidQuery is well-formed and joins artist_type", () => {
  const q = artistByGidQuery(GID);
  assertWellFormed(q, [GID]);
  assert.ok(q.text.includes("FROM artist ar"));
  assert.ok(q.text.includes("artist_type at"));
});

test("artistReleaseGroupsQuery joins credit + meta and groups by date parts", () => {
  const q = artistReleaseGroupsQuery(GID);
  assertWellFormed(q, [GID]);
  assert.ok(q.text.includes("release_group rg"));
  assert.ok(q.text.includes("release_group_meta rgm"));
  assert.ok(q.text.includes("GROUP BY"));
});

test("releaseGroupByGidQuery is well-formed", () => {
  assertWellFormed(releaseGroupByGidQuery(GID), [GID]);
});

test("releasesForReleaseGroupQuery joins release_group + status + country", () => {
  const q = releasesForReleaseGroupQuery(GID);
  assertWellFormed(q, [GID]);
  assert.ok(q.text.includes("release_status rs"));
  assert.ok(q.text.includes("release_country rc"));
});

test("tracksForReleaseQuery joins medium/track/recording and aggregates isrcs", () => {
  const q = tracksForReleaseQuery(GID);
  assertWellFormed(q, [GID]);
  assert.ok(q.text.includes("JOIN medium m ON m.release = r.id"));
  assert.ok(q.text.includes("JOIN track t ON t.medium = m.id"));
  assert.ok(q.text.includes("JOIN recording rec ON rec.id = t.recording"));
  assert.ok(q.text.includes("FROM isrc i"));
  assert.ok(q.text.includes("ORDER BY m.position, t.position"));
});

test("recordingByGidQuery aggregates isrcs + credit", () => {
  const q = recordingByGidQuery(GID);
  assertWellFormed(q, [GID]);
  assert.ok(q.text.includes("FROM recording rec"));
  assert.ok(q.text.includes("array_agg(i.isrc"));
});

test("releasesByBarcodeQuery filters on barcode param", () => {
  const q = releasesByBarcodeQuery("074643811224");
  assertWellFormed(q, ["074643811224"]);
  assert.ok(q.text.includes("WHERE r.barcode = $1"));
});

test("recordingsByIsrcQuery joins isrc + recording", () => {
  const q = recordingsByIsrcQuery("USSM18300001");
  assertWellFormed(q, ["USSM18300001"]);
  assert.ok(q.text.includes("FROM isrc i"));
  assert.ok(q.text.includes("JOIN recording rec ON rec.id = i.recording"));
});
