import assert from "node:assert/strict";
import { test } from "node:test";

import { buildMbPostgresDsn, buildMbSearchWebUrl, normalizeMbHost } from "./mb-connection.js";

test("normalizeMbHost accepts plain hosts and host:postgresPort", () => {
  assert.equal(normalizeMbHost("192.168.1.100"), "192.168.1.100");
  assert.equal(normalizeMbHost("musicbrainz.mydomain.com"), "musicbrainz.mydomain.com");
  assert.equal(normalizeMbHost("db"), "db");
  assert.equal(normalizeMbHost("db:15432"), "db:15432");
});

test("normalizeMbHost strips pasted URL and DSN noise", () => {
  assert.equal(normalizeMbHost("http://192.168.1.100:5000/ws/2"), "192.168.1.100");
  assert.equal(normalizeMbHost("postgresql://musicbrainz:musicbrainz@db:15432/musicbrainz_db"), "db:15432");
  assert.equal(normalizeMbHost("musicbrainz:musicbrainz@db:5432/musicbrainz_db"), "db:5432");
});

test("buildMbPostgresDsn derives the standard MusicBrainz-docker database connection", () => {
  assert.equal(
    buildMbPostgresDsn("192.168.1.100"),
    "postgresql://musicbrainz:musicbrainz@192.168.1.100:5432/musicbrainz_db",
  );
  assert.equal(
    buildMbPostgresDsn("db:15432"),
    "postgresql://musicbrainz:musicbrainz@db:15432/musicbrainz_db",
  );
});

test("buildMbSearchWebUrl derives the co-located ws/2 Solr endpoint from the host", () => {
  assert.equal(buildMbSearchWebUrl("192.168.1.100"), "http://192.168.1.100:5000/ws/2");
  assert.equal(buildMbSearchWebUrl("db:15432"), "http://db:5000/ws/2");
  assert.equal(buildMbSearchWebUrl(""), null);
});
