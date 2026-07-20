import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-acquisition-plan-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let acquisitionModule: typeof import("./release-group-acquisition-plan.js");
let queueModule: typeof import("../commands/command-names.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  acquisitionModule = await import("./release-group-acquisition-plan.js");
  queueModule = await import("../commands/command-names.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM commands").run();
  db.prepare("DELETE FROM TrackFiles").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("queueTrackAcquisitionPlan downloads both provider albums via per-track jobs for quality-optimized composites", () => {
  const evidence = JSON.stringify({
    matchKind: "composite",
    trackSources: [
      {
        canonicalTrackMbid: "t-softly",
        canonicalRecordingMbid: "rec-softly",
        providerTrackId: "trk-softly",
        providerAlbumId: "290132977",
        quality: "HIRES_LOSSLESS",
        title: "Killing Me Softly",
      },
      {
        canonicalTrackMbid: "t-pompeii",
        canonicalRecordingMbid: "rec-pompeii",
        providerTrackId: "trk-pompeii",
        providerAlbumId: "287367980",
        quality: "HIRES_LOSSLESS",
        title: "Pompeii",
      },
      {
        canonicalTrackMbid: "t-nirvana",
        canonicalRecordingMbid: "rec-nirvana",
        providerTrackId: "trk-nirvana",
        providerAlbumId: "287367980",
        quality: "HIRES_LOSSLESS",
        title: "Come as You Are",
      },
    ],
  });

  const result = acquisitionModule.queueTrackAcquisitionPlan({
    slot: "stereo",
    selected_provider: "tidal",
    selected_provider_id: "290132977;287367980",
    selected_release_mbid: "fab7ff68-52e8-45e4-9218-c4eb369c4bc2",
    release_group_mbid: "b1b81699-4273-492e-a8ce-7fa98fac7a93",
    match_method: "quality_optimized_composite_track_coverage",
    match_evidence: evidence,
    title: "Killing Me Softly With His Song (MTV Unplugged)",
    artist_name: "Bastille",
  });

  assert.equal(result.recognized, true);
  assert.equal(result.commandIds.length, 3);

  const { db } = dbModule;
  const jobs = db.prepare(`
    SELECT payload FROM commands WHERE name = ? ORDER BY id
  `).all(queueModule.CommandNames.DownloadTrack) as Array<{ payload: string }>;
  assert.equal(jobs.length, 3);
  const providerTrackIds = jobs.map((job) => JSON.parse(job.payload).providerId).sort();
  assert.deepEqual(providerTrackIds, ["trk-nirvana", "trk-pompeii", "trk-softly"]);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM commands WHERE name = ?")
      .get(queueModule.CommandNames.DownloadAlbum) as { count: number }).count,
    0,
  );
});

test("queueTrackAcquisitionPlan recognizes strict_composite_track_coverage with trackSources", () => {
  const evidence = JSON.stringify({
    matchKind: "composite",
    trackSources: [
      {
        canonicalTrackMbid: "t-a",
        canonicalRecordingMbid: "rec-a",
        providerTrackId: "trk-a",
        providerAlbumId: "album-a",
        title: "A",
      },
      {
        canonicalTrackMbid: "t-b",
        canonicalRecordingMbid: "rec-b",
        providerTrackId: "trk-b",
        providerAlbumId: "album-b",
        title: "B",
      },
    ],
  });

  const result = acquisitionModule.queueTrackAcquisitionPlan({
    slot: "stereo",
    selected_provider: "tidal",
    selected_provider_id: "album-a;album-b",
    match_method: "strict_composite_track_coverage",
    match_evidence: evidence,
    title: "Hybrid",
    artist_name: "Artist",
  });

  assert.equal(result.recognized, true);
  assert.equal(result.commandIds.length, 2);
});
