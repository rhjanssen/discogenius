/**
 * Video curation end to end: candidates in, LibraryVideos rows with persisted
 * placement out.
 *
 * The pure ranking lives in `video-curation.test.ts`. This suite is about the
 * parts only a database can be wrong about — which Tracks count as placement
 * candidates, that the slot constraint really holds, that a losing video keeps
 * its candidacy, and that changing what is monitored moves a file rather than
 * cloning it.
 */
import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
  resetActiveSchemaRows,
} from "../../test-support/active-schema-fixture.js";
import { curateArtistVideos } from "./video-curation-service.js";
import { resolveVideoLibraryIds } from "./library-video-monitoring.js";

const { tempDir } = prepareActiveSchemaEnv("video-curation-service");
const { db, dbModule } = await openActiveSchemaDb();
const configModule = await import("../config/config.js");

after(() => closeActiveSchemaDb(dbModule, tempDir));

const ARTIST_MBID = "artist-curation";
const STUDIO_AUDIO = 100;
const OFFICIAL_VIDEO = 200;
const LIVE_VIDEO = 201;
const LYRIC_VIDEO = 202;
const STUDIO_EDITION = 10;
const STUDIO_TRACK = 1000;

function setLayout(layout: "separated" | "inline" | "inline_only"): void {
  configModule.updateConfig("path", { video_folder_layout: layout });
}

/**
 * One studio album monitored in Stereo, one audio track, and three videos of
 * that exact recording: an official, a live cut and a lyric video.
 */
function seed(options: { monitorEdition?: boolean } = {}): void {
  resetActiveSchemaRows(db);
  db.exec(`
    INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, '${ARTIST_MBID}', 'Test Artist');
    INSERT INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title, primary_type)
    VALUES (1, 'rg-studio', 1, '${ARTIST_MBID}', 'Studio Album', 'Album');
    INSERT INTO AlbumEditions (
      id, mbid, release_group_id, release_group_mbid, artist_mbid, title, track_count
    ) VALUES (${STUDIO_EDITION}, 'edition-studio', 1, 'rg-studio', '${ARTIST_MBID}', 'Studio Album', 12);
    INSERT INTO Recordings (id, mbid, title, artist_mbid, is_video, video_variant, length_ms)
    VALUES
      (${STUDIO_AUDIO}, 'rec-audio', 'Pompeii', '${ARTIST_MBID}', 0, NULL, 214000),
      (${OFFICIAL_VIDEO}, 'rec-video-official', 'Pompeii', '${ARTIST_MBID}', 1, 'official', 216000),
      (${LIVE_VIDEO}, 'rec-video-live', 'Pompeii', '${ARTIST_MBID}', 1, 'live', 220000),
      (${LYRIC_VIDEO}, 'rec-video-lyric', 'Pompeii', '${ARTIST_MBID}', 1, 'lyric', 214000);
    INSERT INTO Tracks (
      id, mbid, album_edition_id, recording_id, release_mbid, recording_mbid,
      medium_position, position, title
    ) VALUES (${STUDIO_TRACK}, 'track-audio', ${STUDIO_EDITION}, ${STUDIO_AUDIO},
              'edition-studio', 'rec-audio', 1, 1, 'Pompeii');
    INSERT INTO RecordingRelations (
      source_recording_id, target_recording_id, relation_type, source, confidence
    ) VALUES
      (${OFFICIAL_VIDEO}, ${STUDIO_AUDIO}, 'provider_video_for', 'tidal', 0.95),
      (${LIVE_VIDEO}, ${STUDIO_AUDIO}, 'provider_video_for', 'tidal', 0.9),
      (${LYRIC_VIDEO}, ${STUDIO_AUDIO}, 'provider_video_for', 'tidal', 0.93);
  `);
  for (const [recordingId, providerId] of [
    [OFFICIAL_VIDEO, "pv-official"], [LIVE_VIDEO, "pv-live"], [LYRIC_VIDEO, "pv-lyric"],
  ] as const) {
    const item = db.prepare(`
      INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability, video_quality)
      VALUES ('tidal', 'video', ?, 'Pompeii', 'available', '1080p')
      RETURNING id
    `).get(providerId) as { id: number };
    db.prepare(`
      INSERT INTO ProviderVideoMatches (
        provider_video_item_id, recording_id, match_state, decision_source,
        confidence, method, matcher_version
      ) VALUES (?, ?, 'accepted', 'automatic', 0.95, 'fixture', 1)
    `).run(item.id, recordingId);
  }
  if (options.monitorEdition !== false) {
    const stereo = (db.prepare("SELECT id FROM Libraries WHERE name = 'Stereo'")
      .get() as { id: number }).id;
    db.prepare(`
      INSERT INTO LibraryAlbums (library_id, release_group_id, selection_mode, locked, reason, curation_version)
      VALUES (?, 1, 'auto', 0, 'test', 1)
    `).run(stereo);
    db.prepare(`
      INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, representative, reason, curation_version)
      VALUES (?, ${STUDIO_EDITION}, 'auto', 1, 'test', 1)
    `).run(stereo);
  }
}

function selections(): Array<{
  video_recording_id: number;
  placement_mode: string;
  inline_track_id: number | null;
  inline_slot: string | null;
  selection_mode: string;
}> {
  return db.prepare(`
    SELECT video_recording_id, placement_mode, inline_track_id, inline_slot, selection_mode
    FROM LibraryVideos ORDER BY video_recording_id
  `).all() as never;
}

beforeEach(() => setLayout("separated"));

test("separated selects every eligible video and stores each in the video library", () => {
  seed();
  setLayout("separated");

  const [summary] = curateArtistVideos(db, ARTIST_MBID);
  assert.equal(summary.selected, 3);
  assert.equal(summary.inline, 0);
  assert.deepEqual(
    selections().map((row) => [row.video_recording_id, row.placement_mode]),
    [[OFFICIAL_VIDEO, "separated"], [LIVE_VIDEO, "separated"], [LYRIC_VIDEO, "separated"]],
  );
});

test("inline places one regular and one lyrics winner beside the exact track", () => {
  seed();
  setLayout("inline");

  const [summary] = curateArtistVideos(db, ARTIST_MBID);
  assert.equal(summary.selected, 3, "all three are still monitored");
  assert.equal(summary.inline, 2, "one video slot, one lyrics slot");

  const rows = selections();
  const official = rows.find((row) => row.video_recording_id === OFFICIAL_VIDEO);
  const lyric = rows.find((row) => row.video_recording_id === LYRIC_VIDEO);
  const live = rows.find((row) => row.video_recording_id === LIVE_VIDEO);

  assert.deepEqual(
    [official?.placement_mode, official?.inline_slot, official?.inline_track_id],
    ["inline", "video", STUDIO_TRACK],
  );
  assert.deepEqual(
    [lyric?.placement_mode, lyric?.inline_slot, lyric?.inline_track_id],
    ["inline", "lyrics", STUDIO_TRACK],
  );
  assert.equal(live?.placement_mode, "separated",
    "the live cut lost the regular slot beside a studio track and is stored separately");
});

test("inline_only monitors the winners and leaves the loser a visible candidate", () => {
  seed();
  setLayout("inline_only");

  const [summary] = curateArtistVideos(db, ARTIST_MBID);
  assert.equal(summary.unselected, 1);
  assert.deepEqual(
    selections().map((row) => row.video_recording_id),
    [OFFICIAL_VIDEO, LYRIC_VIDEO],
  );
  // The loser keeps its canonical recording and its provider offer; it simply
  // has no LibraryVideos row and will not be downloaded.
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM Recordings WHERE id = ?")
      .get(LIVE_VIDEO) as { n: number }).n,
    1,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM ProviderVideoMatches WHERE recording_id = ?")
      .get(LIVE_VIDEO) as { n: number }).n,
    1,
  );
});

test("nothing is placed inline beside a track the library does not monitor", () => {
  seed({ monitorEdition: false });
  setLayout("inline");

  const [summary] = curateArtistVideos(db, ARTIST_MBID);
  assert.equal(summary.inline, 0,
    "an unmonitored edition offers no track to sit beside");
  assert.ok(selections().every((row) => row.placement_mode === "separated"));
});

test("unmonitoring the placement edition moves the video rather than duplicating it", () => {
  seed();
  setLayout("inline");
  curateArtistVideos(db, ARTIST_MBID);
  assert.equal(
    selections().find((row) => row.video_recording_id === OFFICIAL_VIDEO)?.placement_mode,
    "inline",
  );

  // The library stops monitoring the edition the file was placed against.
  db.prepare("DELETE FROM LibraryEditions").run();
  curateArtistVideos(db, ARTIST_MBID);

  const rows = selections();
  assert.equal(rows.filter((row) => row.video_recording_id === OFFICIAL_VIDEO).length, 1,
    "one row, therefore one file — never a second copy");
  assert.equal(
    rows.find((row) => row.video_recording_id === OFFICIAL_VIDEO)?.placement_mode,
    "separated",
    "the placement moved to the separated library",
  );
});

test("re-running curation is stable and never collides on a slot", () => {
  seed();
  setLayout("inline");
  curateArtistVideos(db, ARTIST_MBID);
  const first = selections();
  curateArtistVideos(db, ARTIST_MBID);
  curateArtistVideos(db, ARTIST_MBID);
  assert.deepEqual(selections(), first);
});

test("a manual selection survives curation and keeps its slot", () => {
  seed();
  setLayout("inline");
  const [videoLibraryId] = resolveVideoLibraryIds(db);
  // The user pins the live cut into the regular slot themselves.
  db.prepare(`
    INSERT INTO LibraryVideos (
      library_id, video_recording_id, selection_mode, placement_mode,
      placement_library_id, inline_track_id, inline_slot, reason
    ) VALUES (?, ?, 'manual', 'inline', ?, ?, 'video', 'user')
  `).run(
    videoLibraryId,
    LIVE_VIDEO,
    (db.prepare("SELECT id FROM Libraries WHERE name = 'Stereo'").get() as { id: number }).id,
    STUDIO_TRACK,
  );

  curateArtistVideos(db, ARTIST_MBID);

  const rows = selections();
  const live = rows.find((row) => row.video_recording_id === LIVE_VIDEO);
  assert.equal(live?.selection_mode, "manual");
  assert.deepEqual([live?.placement_mode, live?.inline_slot], ["inline", "video"]);
  // The official video it displaced is still monitored, just not in that slot.
  const official = rows.find((row) => row.video_recording_id === OFFICIAL_VIDEO);
  assert.equal(official?.placement_mode, "separated");
});

test("the slot constraint is enforced by the database, not only by ranking", () => {
  seed();
  const [videoLibraryId] = resolveVideoLibraryIds(db);
  const stereo = (db.prepare("SELECT id FROM Libraries WHERE name = 'Stereo'")
    .get() as { id: number }).id;
  const claim = (recordingId: number) => db.prepare(`
    INSERT INTO LibraryVideos (
      library_id, video_recording_id, selection_mode, placement_mode,
      placement_library_id, inline_track_id, inline_slot, reason
    ) VALUES (?, ?, 'manual', 'inline', ?, ?, 'video', 'test')
  `).run(videoLibraryId, recordingId, stereo, STUDIO_TRACK);

  claim(OFFICIAL_VIDEO);
  assert.throws(() => claim(LIVE_VIDEO), /UNIQUE/i);
});
