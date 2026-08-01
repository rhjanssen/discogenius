/**
 * A video's identity is a canonical Recording, and its link to audio is a
 * relation between two Recordings.
 *
 * The link is *performance*-specific, which is the whole point. Dire Straits'
 * "Tunnel of Love" exists as a studio recording on Making Movies and as a live
 * recording on Alchemy; the Alchemy video is a video of the live performance and
 * of nothing else. Title and duration alone would happily attach it to the
 * studio cut, and the result on disk is a live video sitting beside a studio
 * track claiming to be it.
 *
 * Provider edition membership is evidence for the relation, never the relation
 * itself: an Apple release listing five audio members and two video members says
 * those videos belong to that release, and the recording-level link is what
 * gets derived and kept.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
  resetActiveSchemaRows,
  selectVideoInVideoLibraries,
} from "../../test-support/active-schema-fixture.js";
import { getAlbumAssociatedVideos } from "./video-query-service.js";

const { tempDir } = prepareActiveSchemaEnv("video-recording-relations");
const { db, dbModule } = await openActiveSchemaDb();

after(() => closeActiveSchemaDb(dbModule, tempDir));

const STUDIO_ALBUM_MBID = "rg-making-movies";
const LIVE_ALBUM_MBID = "rg-alchemy";

/**
 * Making Movies (studio) and Alchemy (live), each carrying its own recording of
 * "Tunnel of Love", plus a video of the live performance.
 */
function seed(): void {
  resetActiveSchemaRows(db);
  db.exec(`
    INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-dire', 'Dire Straits');
    INSERT INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title, primary_type, secondary_types)
    VALUES
      (1, '${STUDIO_ALBUM_MBID}', 1, 'artist-dire', 'Making Movies', 'Album', NULL),
      (2, '${LIVE_ALBUM_MBID}', 1, 'artist-dire', 'Alchemy', 'Album', '["Live"]');
    INSERT INTO AlbumEditions (
      id, mbid, release_group_id, release_group_mbid, artist_mbid, title, track_count
    ) VALUES
      (10, 'edition-making-movies', 1, '${STUDIO_ALBUM_MBID}', 'artist-dire', 'Making Movies', 1),
      (20, 'edition-alchemy', 2, '${LIVE_ALBUM_MBID}', 'artist-dire', 'Alchemy', 1);
    INSERT INTO Recordings (id, mbid, title, artist_mbid, is_video, video_variant, length_ms)
    VALUES
      (100, 'rec-studio-tunnel', 'Tunnel of Love', 'artist-dire', 0, NULL, 480000),
      (110, 'rec-live-tunnel', 'Tunnel of Love (Live)', 'artist-dire', 0, NULL, 500000),
      (200, 'rec-video-live-tunnel', 'Tunnel of Love', 'artist-dire', 1, 'live', 500000);
    INSERT INTO Tracks (
      id, mbid, album_edition_id, recording_id, release_mbid, recording_mbid,
      medium_position, position, title
    ) VALUES
      (1000, 'track-studio-tunnel', 10, 100, 'edition-making-movies', 'rec-studio-tunnel', 1, 1, 'Tunnel of Love'),
      (1100, 'track-live-tunnel', 20, 110, 'edition-alchemy', 'rec-live-tunnel', 1, 1, 'Tunnel of Love');
  `);
  selectVideoInVideoLibraries(db, 200);
}

function relate(videoRecordingId: number, audioRecordingId: number): void {
  db.prepare(`
    INSERT INTO RecordingRelations (
      source_recording_id, target_recording_id, relation_type, source, confidence
    ) VALUES (?, ?, 'provider_video_for', 'tidal', 0.95)
  `).run(videoRecordingId, audioRecordingId);
}

function seedVideoOffer(recordingId: number, providerId: string): void {
  const item = db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability)
    VALUES ('tidal', 'video', ?, 'Tunnel of Love', 'available')
    RETURNING id
  `).get(providerId) as { id: number };
  db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'accepted', 'automatic', 0.95, 'fixture', 1)
  `).run(item.id, recordingId);
}

// ---------------------------------------------------------------------------
// Recording-level identity
// ---------------------------------------------------------------------------

test("a video relation is stored at Recording level, not as an Edition link", () => {
  seed();
  relate(200, 110);

  const relation = db.prepare(`
    SELECT source_recording_id, target_recording_id, relation_type
    FROM RecordingRelations WHERE source_recording_id = 200
  `).get() as { source_recording_id: number; target_recording_id: number; relation_type: string };
  assert.deepEqual(relation, {
    source_recording_id: 200,
    target_recording_id: 110,
    relation_type: "provider_video_for",
  });

  // There is deliberately no video-to-Edition association table to consult.
  const editionLinkTables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND (name LIKE '%VideoEdition%' OR name LIKE '%VideoAlbum%')
  `).all();
  assert.deepEqual(editionLinkTables, []);
});

test("the Alchemy live video does not attach to the Making Movies studio recording", () => {
  seed();
  relate(200, 110);
  seedVideoOffer(200, "provider-video-live");

  // The relation names the live recording, so the live album is where the video
  // appears — not the studio album that carries a same-titled studio cut.
  const onLive = getAlbumAssociatedVideos(LIVE_ALBUM_MBID);
  assert.deepEqual(onLive.map((video) => video.id), ["200"]);

  const onStudio = getAlbumAssociatedVideos(STUDIO_ALBUM_MBID);
  assert.deepEqual(onStudio.map((video) => video.id), [],
    "title and duration similarity is not performance identity",
  );
});

// ---------------------------------------------------------------------------
// Derived album associations
// ---------------------------------------------------------------------------

/**
 * KNOWN GAP (2.8.0): the association reader still picks ONE preferred album per
 * video rather than listing it on every album whose tracks carry the linked
 * recording. The rule this suite documents is that one canonical video may
 * appear on several album pages while owning exactly one physical file; the
 * second half of that is already true and enforced by LibraryVideos, the first
 * half is not yet. Kept as a skipped test rather than deleted so the gap is
 * visible where the rule is stated.
 */
test("one video appears on every album whose tracks carry its linked recording", { skip: "2.8.0: association reader still picks one preferred album per video" }, () => {
  seed();
  // A compilation that also carries the live recording.
  db.exec(`
    INSERT INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title, primary_type, secondary_types)
    VALUES (3, 'rg-live-best-of', 1, 'artist-dire', 'Live Best Of', 'Album', '["Live","Compilation"]');
    INSERT INTO AlbumEditions (
      id, mbid, release_group_id, release_group_mbid, artist_mbid, title, track_count
    ) VALUES (30, 'edition-live-best-of', 3, 'rg-live-best-of', 'artist-dire', 'Live Best Of', 1);
    INSERT INTO Tracks (
      id, mbid, album_edition_id, recording_id, release_mbid, recording_mbid,
      medium_position, position, title
    ) VALUES (1200, 'track-bestof-tunnel', 30, 110, 'edition-live-best-of', 'rec-live-tunnel', 1, 3, 'Tunnel of Love');
  `);
  relate(200, 110);
  seedVideoOffer(200, "provider-video-live");

  // One canonical video, two album pages, one video recording — and therefore
  // one physical file, whatever the pages suggest.
  assert.deepEqual(getAlbumAssociatedVideos(LIVE_ALBUM_MBID).map((video) => video.id), ["200"]);
  assert.deepEqual(getAlbumAssociatedVideos("rg-live-best-of").map((video) => video.id), ["200"]);
});

test("album-page associations deduplicate by canonical video recording", () => {
  seed();
  relate(200, 110);
  seedVideoOffer(200, "provider-video-live");
  // A second provider offering the identical canonical video.
  seedVideoOffer(200, "provider-video-live-apple");

  const associated = getAlbumAssociatedVideos(LIVE_ALBUM_MBID);
  assert.equal(associated.length, 1,
    "two provider offers for one canonical video are one video");
  assert.equal(associated[0]?.id, "200");
});

test("a video that is itself a canonical track of an edition is associated directly", () => {
  seed();
  // No relation at all: the video recording occurs as a track on the edition.
  db.prepare(`
    INSERT INTO Tracks (
      id, mbid, album_edition_id, recording_id, release_mbid, recording_mbid,
      medium_position, position, title
    ) VALUES (1300, 'track-alchemy-video', 20, 200, 'edition-alchemy', 'rec-video-live-tunnel', 2, 1, 'Tunnel of Love')
  `).run();
  seedVideoOffer(200, "provider-video-live");

  assert.deepEqual(getAlbumAssociatedVideos(LIVE_ALBUM_MBID).map((video) => video.id), ["200"]);
});

test("several videos may link to one audio recording", () => {
  seed();
  db.exec(`
    INSERT INTO Recordings (id, mbid, title, artist_mbid, is_video, video_variant, length_ms)
    VALUES
      (201, 'rec-video-live-tunnel-2', 'Tunnel of Love', 'artist-dire', 1, 'live', 501000),
      (202, 'rec-video-lyrics-tunnel', 'Tunnel of Love', 'artist-dire', 1, 'lyric', 500000);
  `);
  selectVideoInVideoLibraries(db, 201);
  selectVideoInVideoLibraries(db, 202);
  relate(200, 110);
  relate(201, 110);
  relate(202, 110);
  seedVideoOffer(200, "provider-video-a");
  seedVideoOffer(201, "provider-video-b");
  seedVideoOffer(202, "provider-video-c");

  // Every candidate relation is kept. Which of them a library actually takes is
  // curation's decision, recorded in LibraryVideos — not a reason to delete the
  // others.
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS n FROM RecordingRelations WHERE target_recording_id = 110
    `).get() as { n: number }).n,
    3,
  );
  assert.deepEqual(
    getAlbumAssociatedVideos(LIVE_ALBUM_MBID).map((video) => video.id).sort(),
    ["200", "201", "202"],
  );
});
