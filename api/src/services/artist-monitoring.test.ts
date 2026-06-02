import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-artist-monitoring-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let monitoringModule: typeof import("./artist-monitoring.js");

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  monitoringModule = await import("./artist-monitoring.js");
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("monitoring a named MusicBrainz search result queues hydration without inline metadata fetch", async () => {
  const artistMbid = "b53cab0a-f355-41eb-9bce-bf619b6d760e";
  const result = await monitoringModule.monitorArtistAndQueueIntake({
    artistId: artistMbid,
    artistName: "Bastille",
    priority: 1,
    trigger: 1,
  });

  const artist = dbModule.db.prepare(`
    SELECT id, name, mbid, monitor, musicbrainz_status
    FROM Artists
    WHERE id = ?
  `).get(artistMbid) as {
    id: string;
    name: string;
    mbid: string;
    monitor: number;
    musicbrainz_status: string;
  };
  const job = dbModule.db.prepare(`
    SELECT type, ref_id, status
    FROM job_queue
    WHERE id = ?
  `).get(result.jobId) as { type: string; ref_id: string; status: string };

  assert.equal(artist.id, artistMbid);
  assert.equal(artist.name, "Bastille");
  assert.equal(artist.mbid, artistMbid);
  assert.equal(artist.monitor, 1);
  assert.equal(artist.musicbrainz_status, "pending");
  assert.equal(job.type, "RefreshArtist");
  assert.equal(job.ref_id, artistMbid);
  assert.equal(job.status, "pending");
});
