/**
 * The three layers of the video model, and why they are three.
 *
 *   canonical Recordings + ProviderVideoMatches   every video we know of
 *   LibraryVideos row exists                       this Library selected it
 *   LibraryVideos placement columns                where that one file lives
 *
 * Collapsing any two of them is what produced the failures this suite pins:
 * a video "monitored" globally rather than per Library, several videos claiming
 * the same Plex slot beside one track, and the same video copied into every
 * album folder that happened to reference it.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
  resetActiveSchemaRows,
} from "../../test-support/active-schema-fixture.js";

const { tempDir } = prepareActiveSchemaEnv("library-video-monitoring");

const {
  canonicalVideoType,
  inlineVideoSlot,
  videoTypeSuffix,
} = await import("./canonical-video-type.js");
const {
  applyManualVideoPlacement,
  isVideoMonitored,
  keepLibraryVideo,
  listRelatedInlineTracks,
  resolveVideoLibraryIds,
  selectLibraryVideo,
  unselectLibraryVideo,
  videoPlacement,
} = await import("./library-video-monitoring.js");

const { db, dbModule } = await openActiveSchemaDb();

after(() => closeActiveSchemaDb(dbModule, tempDir));

function seed(): { videoId: number; otherVideoId: number; trackId: number } {
  resetActiveSchemaRows(db, ["RecordingRelations"]);
  db.exec(`
    INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-dire', 'Dire Straits');
    INSERT INTO Artists (id, name, mbid) VALUES ('artist-dire', 'Dire Straits', 'artist-dire');
    INSERT INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title, primary_type)
    VALUES (1, 'rg-making-movies', 1, 'artist-dire', 'Making Movies', 'Album');
    INSERT INTO AlbumEditions (
      id, mbid, release_group_id, release_group_mbid, artist_mbid, title
    ) VALUES (10, 'edition-making-movies', 1, 'rg-making-movies', 'artist-dire', 'Making Movies');
    INSERT INTO Recordings (id, mbid, title, artist_mbid, is_video)
    VALUES
      (100, 'rec-audio-tunnel', 'Tunnel of Love', 'artist-dire', 0),
      (200, 'rec-video-tunnel', 'Tunnel of Love', 'artist-dire', 1),
      (201, 'rec-video-tunnel-lyrics', 'Tunnel of Love', 'artist-dire', 1);
    INSERT INTO Tracks (
      id, mbid, album_edition_id, recording_id, release_mbid, recording_mbid,
      medium_position, position, title
    ) VALUES (1000, 'track-tunnel', 10, 100, 'edition-making-movies', 'rec-audio-tunnel', 1, 1, 'Tunnel of Love');
    INSERT INTO RecordingRelations (
      source_recording_id, target_recording_id, relation_type, source
    ) VALUES (200, 100, 'music_video_for', 'musicbrainz');
  `);
  db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, curation_version)
    VALUES (?, 10, 'auto', 1)
  `).run(stereoLibraryId());
  return { videoId: 200, otherVideoId: 201, trackId: 1000 };
}

function stereoLibraryId(): number {
  return (db.prepare("SELECT id FROM Libraries WHERE name = 'Stereo'").get() as { id: number }).id;
}

// ---------------------------------------------------------------------------
// Canonical video types
// ---------------------------------------------------------------------------

test("visualizer and official audio are ordinary videos, not organisation types", () => {
  assert.equal(canonicalVideoType("visualizer"), "video");
  assert.equal(canonicalVideoType("audio"), "video");
  assert.equal(canonicalVideoType("official"), "video");
  assert.equal(canonicalVideoType("video"), "video");
  assert.equal(canonicalVideoType("lyric"), "lyrics");
  assert.equal(canonicalVideoType("live"), "live");
});

test("live and ordinary videos compete for one slot; lyrics has its own", () => {
  assert.equal(inlineVideoSlot("video"), "video");
  assert.equal(inlineVideoSlot("live"), "video");
  assert.equal(inlineVideoSlot("lyrics"), "lyrics");
});

test("a live video is -video inline beside its track, and -live on its own", () => {
  // Inline the suffix names the role beside the track; separated it names the
  // video. The canonical type never changes.
  assert.equal(videoTypeSuffix("live", "inline"), "-video");
  assert.equal(videoTypeSuffix("live", "separated"), "-live");
  assert.equal(videoTypeSuffix("video", "inline"), "-video");
  assert.equal(videoTypeSuffix("video", "separated"), "-video");
  assert.equal(videoTypeSuffix("lyrics", "inline"), "-lyrics");
  assert.equal(videoTypeSuffix("lyrics", "separated"), "-lyrics");
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test("the Video Library is the one that selects videos", () => {
  seed();
  const videoLibraryIds = resolveVideoLibraryIds(db);
  const names = videoLibraryIds.map((id) =>
    (db.prepare("SELECT name FROM Libraries WHERE id = ?").get(id) as { name: string }).name);
  assert.deepEqual(names, ["Video"], "audio libraries do not select videos");
});

test("a selected video is monitored; an unselected candidate is not", () => {
  const { videoId, otherVideoId } = seed();
  const [videoLibraryId] = resolveVideoLibraryIds(db);

  assert.equal(isVideoMonitored(db, videoId), false);

  selectLibraryVideo(db, {
    libraryId: videoLibraryId,
    videoRecordingId: videoId,
    placement: { mode: "separated" },
  });

  assert.equal(isVideoMonitored(db, videoId), true);
  assert.equal(isVideoMonitored(db, otherVideoId), false,
    "candidates that lost stay visible and unselected");
});

test("unselecting keeps the canonical recording and its provider matches", () => {
  const { videoId } = seed();
  const [videoLibraryId] = resolveVideoLibraryIds(db);
  selectLibraryVideo(db, {
    libraryId: videoLibraryId,
    videoRecordingId: videoId,
    placement: { mode: "separated" },
  });

  assert.equal(unselectLibraryVideo(db, videoLibraryId, videoId), true);

  assert.equal(isVideoMonitored(db, videoId), false);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM Recordings WHERE id = ?")
      .get(videoId) as { n: number }).n,
    1,
    "the video is still a video Discogenius knows about",
  );
});

test("only a canonical video recording can be selected as one", () => {
  seed();
  const [videoLibraryId] = resolveVideoLibraryIds(db);
  assert.throws(
    () => selectLibraryVideo(db, {
      libraryId: videoLibraryId,
      // 100 is the AUDIO recording.
      videoRecordingId: 100,
      placement: { mode: "separated" },
    }),
    /canonical video recording/i,
  );
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

test("applyManualVideoPlacement selects the video and stamps placement as manual", () => {
  const { videoId, trackId } = seed();
  const [videoLibraryId] = resolveVideoLibraryIds(db);

  const applied = applyManualVideoPlacement(db, videoId, { mode: "inline", inlineTrackId: trackId });
  assert.equal(applied.artistId, "artist-dire");

  assert.deepEqual(videoPlacement(db, videoLibraryId, videoId), {
    mode: "inline",
    placementLibraryId: stereoLibraryId(),
    inlineTrackId: trackId,
    inlineSlot: "video",
  });
  const row = db.prepare(`
    SELECT selection_mode, placement_selection_mode
    FROM LibraryVideos
    WHERE library_id = ? AND video_recording_id = ?
  `).get(videoLibraryId, videoId) as {
    selection_mode: string;
    placement_selection_mode: string;
  };
  assert.equal(row.selection_mode, "manual");
  assert.equal(row.placement_selection_mode, "manual");
});

test("applyManualVideoPlacement can move a video back to the Video Library", () => {
  const { videoId, trackId } = seed();
  const [videoLibraryId] = resolveVideoLibraryIds(db);
  applyManualVideoPlacement(db, videoId, { mode: "inline", inlineTrackId: trackId });
  applyManualVideoPlacement(db, videoId, { mode: "separated" });
  assert.deepEqual(videoPlacement(db, videoLibraryId, videoId), { mode: "separated" });
});

test("applyManualVideoPlacement rejects an unknown inline track", () => {
  const { videoId } = seed();
  assert.throws(
    () => applyManualVideoPlacement(db, videoId, { mode: "inline", inlineTrackId: 999999 }),
    /Inline track not found/i,
  );
});

test("listRelatedInlineTracks offers only exact related audio tracks in a library", () => {
  const { videoId, otherVideoId, trackId } = seed();
  const related = listRelatedInlineTracks(db, videoId);
  assert.equal(related.length, 1);
  assert.equal(related[0].id, trackId);
  assert.equal(related[0].title, "Tunnel of Love");
  assert.equal(related[0].albumTitle, "Making Movies");
  assert.deepEqual(listRelatedInlineTracks(db, otherVideoId), [],
    "a video with no exact recording relation does not offer a studio track");
});

test("keepLibraryVideo selects an unselected video as a manual choice", () => {
  const { videoId } = seed();
  const [videoLibraryId] = resolveVideoLibraryIds(db);

  keepLibraryVideo(db, videoId);

  assert.equal(isVideoMonitored(db, videoId), true);
  const row = db.prepare(`
    SELECT selection_mode, placement_mode, placement_selection_mode
    FROM LibraryVideos
    WHERE library_id = ? AND video_recording_id = ?
  `).get(videoLibraryId, videoId) as {
    selection_mode: string;
    placement_mode: string;
    placement_selection_mode: string;
  };
  assert.equal(row.selection_mode, "manual");
  assert.equal(row.placement_mode, "separated");
  assert.equal(row.placement_selection_mode, "auto",
    "keep freezes selection, not placement");
});

test("automatic curation does not move a manually placed video", () => {
  const { videoId, trackId } = seed();
  const [videoLibraryId] = resolveVideoLibraryIds(db);
  selectLibraryVideo(db, {
    libraryId: videoLibraryId,
    videoRecordingId: videoId,
    placement: {
      mode: "inline",
      placementLibraryId: stereoLibraryId(),
      inlineTrackId: trackId,
      inlineSlot: "video",
    },
    placementSelectionMode: "manual",
  });

  selectLibraryVideo(db, {
    libraryId: videoLibraryId,
    videoRecordingId: videoId,
    placement: { mode: "separated" },
    selectionMode: "auto",
    placementSelectionMode: "auto",
    reason: "curation",
  });

  assert.deepEqual(videoPlacement(db, videoLibraryId, videoId), {
    mode: "inline",
    placementLibraryId: stereoLibraryId(),
    inlineTrackId: trackId,
    inlineSlot: "video",
  });
  const row = db.prepare(`
    SELECT selection_mode, placement_selection_mode
    FROM LibraryVideos
    WHERE library_id = ? AND video_recording_id = ?
  `).get(videoLibraryId, videoId) as {
    selection_mode: string;
    placement_selection_mode: string;
  };
  assert.equal(row.placement_selection_mode, "manual");
});

test("placement is persisted, not re-derived", () => {
  const { videoId, trackId } = seed();
  const [videoLibraryId] = resolveVideoLibraryIds(db);
  selectLibraryVideo(db, {
    libraryId: videoLibraryId,
    videoRecordingId: videoId,
    placement: {
      mode: "inline",
      placementLibraryId: stereoLibraryId(),
      inlineTrackId: trackId,
      inlineSlot: "video",
    },
  });

  assert.deepEqual(videoPlacement(db, videoLibraryId, videoId), {
    mode: "inline",
    placementLibraryId: stereoLibraryId(),
    inlineTrackId: trackId,
    inlineSlot: "video",
  });
});

test("two videos cannot occupy the same Plex role beside one track", () => {
  const { videoId, otherVideoId, trackId } = seed();
  const [videoLibraryId] = resolveVideoLibraryIds(db);
  const inline = (recordingId: number, slot: "video" | "lyrics") => selectLibraryVideo(db, {
    libraryId: videoLibraryId,
    videoRecordingId: recordingId,
    placement: {
      mode: "inline",
      placementLibraryId: stereoLibraryId(),
      inlineTrackId: trackId,
      inlineSlot: slot,
    },
  });

  inline(videoId, "video");

  // A second occupant of the same role would resolve to the same filename and
  // silently overwrite the first. The partial unique index makes it impossible.
  assert.throws(() => inline(otherVideoId, "video"), /UNIQUE/i);

  // The lyrics role is a different one, and may be filled at the same time.
  inline(otherVideoId, "lyrics");
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS n FROM LibraryVideos
      WHERE placement_mode = 'inline' AND inline_track_id = ?
    `).get(trackId) as { n: number }).n,
    2,
  );
});

test("inline placement needs all of its columns, separated needs none of them", () => {
  const { videoId } = seed();
  const [videoLibraryId] = resolveVideoLibraryIds(db);
  // A half-written inline placement is a video monitored with no destination.
  assert.throws(
    () => db.prepare(`
      INSERT INTO LibraryVideos (
        library_id, video_recording_id, selection_mode, placement_mode, inline_slot
      ) VALUES (?, ?, 'auto', 'inline', 'video')
    `).run(videoLibraryId, videoId),
    /CHECK/i,
  );
});
