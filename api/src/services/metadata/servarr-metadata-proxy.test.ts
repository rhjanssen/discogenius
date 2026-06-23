import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-servarr-metadata-proxy-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let servarrMetadataModule: typeof import("./servarr-metadata-proxy.js");
let originalFetch: typeof fetch;

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  servarrMetadataModule = await import("./servarr-metadata-proxy.js");
  originalFetch = globalThis.fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("syncReleaseGroup stores Servarr Metadata Server album detail release type fields", async () => {
  const { db } = dbModule;
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid", "Bastille");

  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      id: "release-group-mbid",
      title: "MTV Unplugged - Live in London",
      type: "Album",
      secondarytypes: ["Live"],
      releasedate: "2023-04-22",
      disambiguation: "",
      images: [],
      Releases: [],
    }),
  })) as unknown as typeof fetch;

  await servarrMetadataModule.servarrMetadataProxy.syncReleaseGroup("release-group-mbid", "artist-mbid");

  const releaseGroup = db.prepare(`
    SELECT title, primary_type, secondary_types, first_release_date
    FROM Albums
    WHERE mbid = ?
  `).get("release-group-mbid") as {
    title: string;
    primary_type: string;
    secondary_types: string;
    first_release_date: string;
  };

  assert.equal(releaseGroup.title, "MTV Unplugged - Live in London");
  assert.equal(releaseGroup.primary_type, "Album");
  assert.deepEqual(JSON.parse(releaseGroup.secondary_types), ["Live"]);
  assert.equal(releaseGroup.first_release_date, "2023-04-22");
});

test("syncReleaseGroup keeps the canonical Servarr Metadata Server album owner instead of the scanning artist", async () => {
  const { db } = dbModule;
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("bastille-mbid", "Bastille");

  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      id: "happier-release-group",
      artistid: "marshmello-mbid",
      title: "Happier",
      type: "Single",
      secondarytypes: [],
      images: [],
      Releases: [],
    }),
  })) as unknown as typeof fetch;

  await servarrMetadataModule.servarrMetadataProxy.syncReleaseGroup("happier-release-group", "bastille-mbid");

  const releaseGroup = db.prepare("SELECT artist_mbid FROM Albums WHERE mbid = ?")
    .get("happier-release-group") as { artist_mbid: string };
  assert.equal(releaseGroup.artist_mbid, "marshmello-mbid");
});

test("searchAll ranks the substantial exact-name artist ahead of same-name collisions", async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ([
      {
        artist: {
          id: "metal-band",
          artistname: "Bastille",
          disambiguation: "metal band",
          type: "Group",
          Albums: [{ Id: "one" }],
        },
      },
      {
        artist: {
          id: "indie-pop-band",
          artistname: "Bastille",
          disambiguation: "British indie pop band",
          type: "Group",
          Albums: Array.from({ length: 20 }, (_, index) => ({ Id: `album-${index}` })),
        },
      },
    ]),
  })) as unknown as typeof fetch;

  const results = await servarrMetadataModule.servarrMetadataProxy.searchAll("Bastille", 10);

  assert.equal(results[0].artist.id, "indie-pop-band");
  assert.equal(results[1].artist.id, "metal-band");
});
