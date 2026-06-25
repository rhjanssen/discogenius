import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-servarr-metadata-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let servarrMetadataModule: typeof import("./servarr-metadata.js");
let originalFetch: typeof fetch;

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  servarrMetadataModule = await import("./servarr-metadata.js");
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

  await servarrMetadataModule.servarrMetadata.syncReleaseGroup("release-group-mbid", "artist-mbid");

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

  await servarrMetadataModule.servarrMetadata.syncReleaseGroup("happier-release-group", "bastille-mbid");

  const releaseGroup = db.prepare("SELECT artist_mbid FROM Albums WHERE mbid = ?")
    .get("happier-release-group") as { artist_mbid: string };
  assert.equal(releaseGroup.artist_mbid, "marshmello-mbid");
});

const DOOM_DAYS_PAYLOAD = {
  id: "rg-skip",
  title: "Doom Days",
  type: "Album",
  secondarytypes: [] as string[],
  releasedate: "2019-06-14",
  images: [] as unknown[],
  Releases: [
    {
      Id: "rel-1",
      Title: "Doom Days",
      Status: "Official",
      Country: ["GB"],
      Media: [{ Position: 1, Format: "Digital", Name: "" }],
      ReleaseDate: "2019-06-14",
      TrackCount: 1,
      Tracks: [
        {
          Id: "trk-1",
          RecordingId: "rec-1",
          TrackName: "Quarter Past Midnight",
          TrackNumber: "1",
          TrackPosition: 1,
          MediumNumber: 1,
          DurationMs: 200000,
        },
      ],
    },
  ],
};

function fetchReturning(payload: unknown): void {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
  })) as unknown as typeof fetch;
}

function resetCatalog(): void {
  const { db } = dbModule;
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumReleases").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)").run("artist-mbid", "Bastille");
}

test("syncReleaseGroup skips rewriting an unchanged release group (diff-reconcile)", async () => {
  const { db } = dbModule;
  resetCatalog();
  fetchReturning(DOOM_DAYS_PAYLOAD);

  await servarrMetadataModule.servarrMetadata.syncReleaseGroup("rg-skip", "artist-mbid");

  // Mutate stored values; an unchanged re-sync must NOT overwrite them.
  db.prepare("UPDATE Albums SET title = 'SENTINEL' WHERE mbid = ?").run("rg-skip");
  db.prepare("UPDATE Tracks SET title = 'SENTINEL-TRACK' WHERE mbid = ?").run("trk-1");

  await servarrMetadataModule.servarrMetadata.syncReleaseGroup("rg-skip", "artist-mbid");

  const rg = db.prepare("SELECT title FROM Albums WHERE mbid = ?").get("rg-skip") as { title: string };
  const trk = db.prepare("SELECT title FROM Tracks WHERE mbid = ?").get("trk-1") as { title: string };
  assert.equal(rg.title, "SENTINEL", "unchanged release group should be skipped, not rewritten");
  assert.equal(trk.title, "SENTINEL-TRACK", "unchanged tracklist should be skipped, not rewritten");
});

test("syncReleaseGroup rewrites when the remote payload changes", async () => {
  const { db } = dbModule;
  resetCatalog();
  fetchReturning(DOOM_DAYS_PAYLOAD);
  await servarrMetadataModule.servarrMetadata.syncReleaseGroup("rg-skip", "artist-mbid");
  db.prepare("UPDATE Albums SET title = 'SENTINEL' WHERE mbid = ?").run("rg-skip");

  fetchReturning({ ...DOOM_DAYS_PAYLOAD, title: "Doom Days (Deluxe)" });
  await servarrMetadataModule.servarrMetadata.syncReleaseGroup("rg-skip", "artist-mbid");

  const rg = db.prepare("SELECT title FROM Albums WHERE mbid = ?").get("rg-skip") as { title: string };
  assert.equal(rg.title, "Doom Days (Deluxe)", "changed payload should rewrite the release group");
});

test("syncReleaseGroup re-hydrates missing releases even when the hash matches", async () => {
  const { db } = dbModule;
  resetCatalog();
  fetchReturning(DOOM_DAYS_PAYLOAD);
  await servarrMetadataModule.servarrMetadata.syncReleaseGroup("rg-skip", "artist-mbid");

  // Child rows pruned but the RG hash still present: an identical re-sync must
  // repair the tracklist rather than skip on the stale hash.
  db.prepare("DELETE FROM AlbumReleases WHERE release_group_mbid = ?").run("rg-skip");
  await servarrMetadataModule.servarrMetadata.syncReleaseGroup("rg-skip", "artist-mbid");

  const releaseCount = db.prepare("SELECT COUNT(*) AS count FROM AlbumReleases WHERE release_group_mbid = ?")
    .get("rg-skip") as { count: number };
  assert.equal(releaseCount.count, 1, "missing release should be re-hydrated despite a matching hash");
});

test("syncArtist skips rewriting an unchanged artist (diff-reconcile)", async () => {
  const { db } = dbModule;
  resetCatalog();
  const artistPayload = {
    id: "artist-mbid",
    artistname: "Bastille",
    sortname: "Bastille",
    images: [] as unknown[],
    Albums: [{ Id: "rg-a", Title: "Bad Blood", Type: "Album" }],
  };
  fetchReturning(artistPayload);

  await servarrMetadataModule.servarrMetadata.syncArtist("artist-mbid");
  db.prepare("UPDATE ArtistMetadata SET name = 'SENTINEL' WHERE mbid = ?").run("artist-mbid");

  await servarrMetadataModule.servarrMetadata.syncArtist("artist-mbid");

  const artist = db.prepare("SELECT name FROM ArtistMetadata WHERE mbid = ?").get("artist-mbid") as { name: string };
  assert.equal(artist.name, "SENTINEL", "unchanged artist should be skipped, not rewritten");
});

test("syncReleaseGroup populates curated release columns from the payload", async () => {
  const { db } = dbModule;
  resetCatalog();
  fetchReturning(DOOM_DAYS_PAYLOAD);
  await servarrMetadataModule.servarrMetadata.syncReleaseGroup("rg-skip", "artist-mbid");

  const rel = db.prepare("SELECT country, label, media FROM AlbumReleases WHERE mbid = ?")
    .get("rel-1") as { country: string; label: string; media: string };
  assert.deepEqual(JSON.parse(rel.country), ["GB"]);
  assert.deepEqual(JSON.parse(rel.label), []);
  assert.deepEqual(JSON.parse(rel.media), [{ Position: 1, Format: "Digital", Name: "" }]);
});

test("syncArtist populates curated artist columns from the payload", async () => {
  const { db } = dbModule;
  resetCatalog();
  fetchReturning({
    id: "artist-mbid",
    artistname: "Bastille",
    sortname: "Bastille",
    images: [],
    overview: "An English band",
    status: "active",
    links: [{ type: "apple", target: "https://music.apple.com/x" }],
    genres: ["indie pop"],
    artistaliases: ["BSTILLE"],
    oldids: ["old-1"],
    Albums: [],
  });

  await servarrMetadataModule.servarrMetadata.syncArtist("artist-mbid");

  const am = db.prepare(`
    SELECT overview, status, links, genres, aliases, old_foreign_ids
    FROM ArtistMetadata WHERE mbid = ?
  `).get("artist-mbid") as Record<string, string>;
  assert.equal(am.overview, "An English band");
  assert.equal(am.status, "active");
  assert.deepEqual(JSON.parse(am.links), [{ type: "apple", target: "https://music.apple.com/x" }]);
  assert.deepEqual(JSON.parse(am.genres), ["indie pop"]);
  assert.deepEqual(JSON.parse(am.aliases), ["BSTILLE"]);
  assert.deepEqual(JSON.parse(am.old_foreign_ids), ["old-1"]);
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

  const results = await servarrMetadataModule.servarrMetadata.searchAll("Bastille", 10);

  assert.equal(results[0].artist.id, "indie-pop-band");
  assert.equal(results[1].artist.id, "metal-band");
});
