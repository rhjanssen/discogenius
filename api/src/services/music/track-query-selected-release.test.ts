import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-track-selected-release-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let trackQueryModule: typeof import("./track-query-service.js");
let trackIndexModule: typeof import("./track-library-index-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  trackQueryModule = await import("./track-query-service.js");
  trackIndexModule = await import("./track-library-index-service.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM TrackLibraryIndex").run();
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM AcquisitionPlanTracks").run();
  db.prepare("DELETE FROM AcquisitionPlanSources").run();
  // Release the deferred plan reference before its rows go.
  db.prepare("UPDATE LibraryEditions SET preferred_plan_key = NULL").run();
  db.prepare("DELETE FROM AcquisitionPlans").run();
  db.prepare("DELETE FROM LibraryEditions").run();
  db.prepare("DELETE FROM LibraryAlbums").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumEditions").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM Artists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * A monitored release group whose canonical release is selected into a library,
 * but with NO acquisition plan and NO imported files yet — the ordinary state
 * right after curation selects a release and before planning/downloading.
 */
function seedSelectedReleaseWithoutPlanOrFiles(): { trackIds: number[] } {
  const { db } = dbModule;
  db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES ('bastille-mbid', 'Bastille')").run();
  const artistMeta = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'bastille-mbid'").get() as { id: number };
  db.prepare(`
    INSERT INTO Artists (id, name, mbid, path, monitored)
    VALUES ('bastille', 'Bastille', 'bastille-mbid', 'Bastille', 1)
  `).run();
  db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, artist_metadata_id, title, primary_type, first_release_date)
    VALUES ('rg-bad-blood', 'bastille-mbid', ?, 'Bad Blood', 'Album', '2013-03-04')
  `).run(artistMeta.id);
  const releaseGroup = db.prepare("SELECT id FROM Albums WHERE mbid = 'rg-bad-blood'").get() as { id: number };
  db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_mbid, release_group_id, artist_mbid, artist_metadata_id,
      title, status, date, media_count, track_count
    ) VALUES ('rel-bad-blood', 'rg-bad-blood', ?, 'bastille-mbid', ?, 'Bad Blood', 'Official', '2013-03-04', 1, 2)
  `).run(releaseGroup.id, artistMeta.id);
  const release = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'rel-bad-blood'").get() as { id: number };

  const trackIds: number[] = [];
  [["rec-pompeii", "Pompeii"], ["rec-things", "Things We Lost in the Fire"]].forEach(([recMbid, title], index) => {
    db.prepare(`
      INSERT INTO Recordings (mbid, artist_mbid, artist_metadata_id, title, length_ms)
      VALUES (?, 'bastille-mbid', ?, ?, 214000)
    `).run(recMbid, artistMeta.id, title);
    const recording = db.prepare("SELECT id FROM Recordings WHERE mbid = ?").get(recMbid) as { id: number };
    const track = db.prepare(`
      INSERT INTO Tracks (
        mbid, release_mbid, album_edition_id, recording_mbid, recording_id,
        medium_position, position, number, title, length_ms
      ) VALUES (?, 'rel-bad-blood', ?, ?, ?, 1, ?, ?, ?, 214000)
      RETURNING id
    `).get(`trk-${recMbid}`, release.id, recMbid, recording.id, index + 1, String(index + 1), title) as { id: number };
    trackIds.push(track.id);
  });

  const library = db.prepare("SELECT id FROM Libraries ORDER BY id LIMIT 1").get() as { id: number };
  db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'auto', 0, 'test', 1)
  `).run(library.id, releaseGroup.id);
  db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, reason, curation_version
    ) VALUES (?, ?, 'auto', 'test', 1)
  `).run(library.id, release.id);

  return { trackIds };
}

test("a selected release's canonical tracks are listed before any plan or file exists", () => {
  const { db } = dbModule;
  const { trackIds } = seedSelectedReleaseWithoutPlanOrFiles();
  trackIndexModule.TrackLibraryIndexService.rebuild();

  // The projection that backs the fast COUNT path sees both tracks...
  const indexedIds = (db.prepare("SELECT track_id FROM TrackLibraryIndex ORDER BY track_id").all() as Array<{ track_id: number }>)
    .map((row) => Number(row.track_id));
  assert.deepEqual(indexedIds, trackIds, "TrackLibraryIndex should hold the selected release's tracks");

  // ...and every indexed id is a real canonical track row.
  for (const id of indexedIds) {
    const row = db.prepare("SELECT id, title FROM Tracks WHERE id = ?").get(id) as { id: number; title: string } | undefined;
    assert.ok(row, `indexed track ${id} must exist in Tracks`);
  }

  // There is deliberately no acquisition plan and no imported file.
  assert.equal((db.prepare("SELECT COUNT(*) c FROM AcquisitionPlanTracks").get() as { c: number }).c, 0);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM TrackFiles").get() as { c: number }).c, 0);

  const result = trackQueryModule.listTracks({
    monitored: true,
    libraryFilter: "all",
    limit: 100,
    offset: 0,
  } as any);

  // total and items must describe the same set: an unacquired canonical track on
  // a selected release stays visible (unavailable), it does not vanish.
  assert.equal(result.total, trackIds.length);
  assert.equal(result.items.length, trackIds.length, "listed items must agree with the reported total");
  assert.deepEqual(
    result.items.map((item: any) => item.title).sort(),
    ["Pompeii", "Things We Lost in the Fire"],
  );
  for (const item of result.items as any[]) {
    assert.equal(item.is_downloaded, false, "no files imported yet");
  }
});

test("tracks of an unmonitored release group stay out of the monitored listing", () => {
  const { db } = dbModule;
  seedSelectedReleaseWithoutPlanOrFiles();
  // Unmonitoring is the row going away, not a flag flipping.
  db.prepare("DELETE FROM LibraryEditions").run();
  db.prepare("DELETE FROM LibraryAlbums").run();
  trackIndexModule.TrackLibraryIndexService.rebuild();

  const result = trackQueryModule.listTracks({
    monitored: true,
    libraryFilter: "all",
    limit: 100,
    offset: 0,
  } as any);

  assert.equal(result.total, 0);
  assert.equal(result.items.length, 0);
});
