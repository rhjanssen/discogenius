import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-media-servers-"));
const configDir = path.join(tempRoot, "config");
fs.mkdirSync(configDir, { recursive: true });

process.env.DB_PATH = path.join(tempRoot, "active.db");
process.env.DISCOGENIUS_CONFIG_DIR = configDir;
process.env.DISCOGENIUS_DISABLE_DOWNLOADS = "1";

let database: typeof import("../../database.js");
let configModule: typeof import("../config/config.js");
let notifier: typeof import("./media-server-notifier.js");
let reconcile: typeof import("./media-server-reconcile.js");

const PLEX_TOKEN = "super-secret-plex-token-123";
const JELLYFIN_KEY = "super-secret-jellyfin-key-456";

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let plexServer: http.Server;
let jellyfinServer: http.Server;
let plexUrl = "";
let jellyfinUrl = "";
let plexRequests: RecordedRequest[] = [];
let jellyfinRequests: RecordedRequest[] = [];

const AFROJACK_MBID = "11111111-1111-4111-8111-111111111111";
const PRIVATE_INV_MBID = "22222222-2222-4222-8222-222222222222";

function startServer(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        handler(req, body, res);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

before(async () => {
  database = await import("../../database.js");
  database.initDatabase();
  configModule = await import("../config/config.js");
  notifier = await import("./media-server-notifier.js");
  reconcile = await import("./media-server-reconcile.js");

  const plex = await startServer((req, body, res) => {
    plexRequests.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers,
      body,
    });
    assert.equal(req.headers["x-plex-token"], PLEX_TOKEN);
    assert.equal((req.url ?? "").includes(PLEX_TOKEN), false, "Plex token must never appear in URL");

    if (req.url === "/library/sections") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        MediaContainer: {
          Directory: [{ key: "1", title: "Music", type: "artist", Location: [{ path: "/music" }] }],
        },
      }));
      return;
    }

    if (req.url === "/library/sections/1/all?type=8&includeGuids=1") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: "101",
              title: "AFROJACK",
              guid: `mbid://${AFROJACK_MBID}`,
              Guid: [{ id: `mbid://${AFROJACK_MBID}` }],
              Location: [{ path: "/music/AFROJACK" }],
            },
            {
              ratingKey: "102",
              title: "AFROJACK",
              guid: "local://999",
              Guid: [],
              Location: [{ path: "/music/AFROJACK" }],
            },
          ],
        },
      }));
      return;
    }

    if (req.url === "/library/sections/1/all?type=9&includeGuids=1") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: "201",
              title: "Private Investigations",
              guid: "local://album-1",
              Guid: [],
              Location: [{ path: "/music/Dire Straits/Private Investigations" }],
            },
            {
              ratingKey: "202",
              title: "Private Investigations",
              guid: `mbid://${PRIVATE_INV_MBID}`,
              Guid: [{ id: `mbid://${PRIVATE_INV_MBID}` }],
              Location: [{ path: "/music/Dire Straits/Private Investigations" }],
            },
          ],
        },
      }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  plexServer = plex.server;
  plexUrl = plex.url;

  const jellyfin = await startServer((req, body, res) => {
    jellyfinRequests.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers,
      body,
    });
    assert.equal(req.headers["x-emby-token"], JELLYFIN_KEY);
    assert.equal((req.url ?? "").includes(JELLYFIN_KEY), false, "Jellyfin API key must never appear in URL");

    if (req.url?.startsWith("/Items?")) {
      const includeType = new URL(`http://localhost${req.url}`).searchParams.get("IncludeItemTypes");
      res.writeHead(200, { "Content-Type": "application/json" });
      if (includeType === "MusicArtist") {
        res.end(JSON.stringify({
          Items: [
            {
              Id: "jf-artist-1",
              Name: "AFROJACK",
              Type: "MusicArtist",
              Path: "/music/AFROJACK",
              ProviderIds: { MusicBrainzArtist: AFROJACK_MBID },
            },
          ],
        }));
      } else {
        res.end(JSON.stringify({
          Items: [
            {
              Id: "jf-album-1",
              Name: "Private Investigations",
              Type: "MusicAlbum",
              Path: "/music/Dire Straits/Private Investigations",
              ProviderIds: { MusicBrainzAlbum: PRIVATE_INV_MBID },
            },
          ],
        }));
      }
      return;
    }

    res.writeHead(204);
    res.end();
  });
  jellyfinServer = jellyfin.server;
  jellyfinUrl = jellyfin.url;

  configModule.updateConfig("media_servers", {
    plex_enabled: true,
    plex_url: plexUrl,
    plex_token: PLEX_TOKEN,
    plex_music_section_id: "1",
    jellyfin_enabled: true,
    jellyfin_url: jellyfinUrl,
    jellyfin_api_key: JELLYFIN_KEY,
  });
});

beforeEach(() => {
  plexRequests = [];
  jellyfinRequests = [];
  database.db.prepare("DELETE FROM TrackFiles").run();
  database.db.prepare("DELETE FROM AlbumEditions").run();
  database.db.prepare("DELETE FROM Albums").run();
  database.db.prepare("DELETE FROM ArtistMetadata").run();
});

after(async () => {
  await Promise.all([
    new Promise<void>((resolve) => plexServer.close(() => resolve())),
    new Promise<void>((resolve) => jellyfinServer.close(() => resolve())),
  ]);
  database.closeDatabase();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function seedMediaServerCatalog() {
  database.db.prepare(`
    INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, ?, 'AFROJACK')
  `).run(AFROJACK_MBID);
  database.db.prepare(`
    INSERT INTO ArtistMetadata (id, mbid, name) VALUES (2, '33333333-3333-4333-8333-333333333333', 'Dire Straits')
  `).run();
  database.db.prepare(`
    INSERT INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title)
    VALUES (10, ?, 2, '33333333-3333-4333-8333-333333333333', 'Private Investigations')
  `).run(PRIVATE_INV_MBID);
  database.db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, release_group_id, file_path, relative_path, library_root,
      filename, extension, file_type, quality
    ) VALUES
      (1, NULL, '/music/AFROJACK/Singles/01 - Track.flac', 'AFROJACK/Singles/01 - Track.flac', 'music', '01 - Track.flac', 'flac', 'track', 'LOSSLESS'),
      (2, 10, '/music/Dire Straits/Private Investigations/01 - Sultans.flac', 'Dire Straits/Private Investigations/01 - Sultans.flac', 'music', '01 - Sultans.flac', 'flac', 'track', 'LOSSLESS')
  `).run();
}

test("notifyMediaServersForPaths issues targeted folder scans instead of full library scans", async () => {
  const result = await notifier.notifyMediaServersForPaths([
    "/music/AFROJACK/Album/01 - Track.flac",
    "/music/AFROJACK/Album/02 - Track.flac",
  ], "import");

  assert.equal(result.plexScanned, 1);
  assert.equal(result.jellyfinNotified, 1);

  assert.equal(plexRequests.length, 1);
  assert.equal(plexRequests[0].method, "GET");
  assert.equal(
    plexRequests[0].url,
    `/library/sections/1/refresh?path=${encodeURIComponent("/music/AFROJACK/Album")}`,
  );

  assert.equal(jellyfinRequests.length, 1);
  assert.equal(jellyfinRequests[0].method, "POST");
  assert.equal(jellyfinRequests[0].url, "/Library/Media/Updated");
  assert.deepEqual(JSON.parse(jellyfinRequests[0].body), {
    Updates: [{ Path: "/music/AFROJACK/Album", UpdateType: "Modified" }],
  });
});

test("reconcileMediaServers dry-run reports Plex duplicates and local:// mismatches without mutating servers", async () => {
  seedMediaServerCatalog();

  const report = await reconcile.reconcileMediaServers({ dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(report.plex.duplicateArtists.length, 1);
  assert.equal(report.plex.duplicateArtists[0].targetRatingKey, "101");
  assert.deepEqual(report.plex.duplicateArtists[0].sourceRatingKeys, ["102"]);
  assert.equal(report.plex.mismatchedArtists.length, 1);
  assert.equal(report.plex.mismatchedArtists[0].ratingKey, "102");
  assert.equal(report.plex.mismatchedArtists[0].targetMbid, AFROJACK_MBID);

  assert.equal(report.plex.duplicateAlbums.length, 1);
  assert.equal(report.plex.duplicateAlbums[0].targetRatingKey, "202");
  assert.deepEqual(report.plex.duplicateAlbums[0].sourceRatingKeys, ["201"]);
  assert.equal(report.plex.mismatchedAlbums.length, 1);
  assert.equal(report.plex.mismatchedAlbums[0].ratingKey, "201");
  assert.equal(report.plex.mismatchedAlbums[0].targetMbid, PRIVATE_INV_MBID);

  assert.equal(report.plex.mergesApplied, 0);
  assert.equal(report.plex.matchesFixed, 0);
  assert.equal(report.jellyfin.matchedItems, 2);
  assert.equal(report.jellyfin.itemsRefreshed, 0);

  // Zero mutating requests on dry-run
  assert.equal(plexRequests.some((r) => r.method !== "GET"), false);
  assert.equal(jellyfinRequests.some((r) => r.method !== "GET"), false);
});

test("reconcileMediaServers apply merges duplicates, fixes matches on Plex, and refreshes Jellyfin items", async () => {
  seedMediaServerCatalog();

  const report = await reconcile.reconcileMediaServers({ dryRun: false });
  assert.equal(report.dryRun, false);
  assert.equal(report.plex.mergesApplied, 2);
  assert.equal(report.plex.matchesFixed, 2);
  assert.equal(report.plex.itemsRefreshed, 4);
  assert.equal(report.jellyfin.itemsRefreshed, 2);

  assert.ok(plexRequests.some((r) => r.method === "PUT" && r.url === "/library/sections/1/merge?ids=101,102"));
  assert.ok(plexRequests.some((r) => r.method === "PUT" && r.url === "/library/sections/1/merge?ids=202,201"));
  assert.ok(plexRequests.some((r) => r.method === "PUT" && r.url.startsWith("/library/metadata/102/match?")));
  assert.ok(plexRequests.some((r) => r.method === "PUT" && r.url.startsWith("/library/metadata/201/match?")));

  assert.ok(jellyfinRequests.some((r) => r.method === "POST" && r.url.startsWith("/Items/jf-artist-1/Refresh")));
  assert.ok(jellyfinRequests.some((r) => r.method === "POST" && r.url.startsWith("/Items/jf-album-1/Refresh")));
});
