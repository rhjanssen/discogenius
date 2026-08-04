/**
 * Which Album and Edition pages show a video — and why that is not the same
 * question as where its file goes.
 *
 *   association — derived, many-to-many, free. A video belongs on every Edition
 *                 that carries it as a Track, or carries a Track for the exact
 *                 audio Recording it is a video of.
 *   placement   — one persisted destination per selected video.
 *
 * The two were previously conflated: the album strip asked which single album
 * would host the file and hid the video everywhere else. One official video for
 * a song that appears on the album, the deluxe, the single and a compilation
 * then showed up on exactly one of those four pages.
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
const { tempDir } = prepareActiveSchemaEnv("video-album-display");

const { getAlbumAssociatedVideos } = await import("./video-query-service.js");
const { selectLibraryVideo, resolveVideoLibraryIds } = await import("./library-video-monitoring.js");

const { db, dbModule } = await openActiveSchemaDb();

after(() => closeActiveSchemaDb(dbModule, tempDir));

let nextId = 1;
const id = () => (nextId += 1);

function album(mbid: string, title: string, opts: { secondary?: string | null } = {}): number {
  const albumId = id();
  db.prepare(`
    INSERT INTO Albums (id, mbid, artist_metadata_id, artist_mbid, title, primary_type, secondary_types)
    VALUES (?, ?, 1, 'artist-x', ?, 'Album', ?)
  `).run(albumId, mbid, title, opts.secondary ?? null);
  return albumId;
}

function edition(albumId: number, mbid: string, title: string, trackCount: number): number {
  const editionId = id();
  db.prepare(`
    INSERT INTO AlbumEditions (
      id, mbid, release_group_id, release_group_mbid, artist_mbid, title, track_count
    ) VALUES (?, ?, ?, (SELECT mbid FROM Albums WHERE id = ?), 'artist-x', ?, ?)
  `).run(editionId, mbid, albumId, albumId, title, trackCount);
  return editionId;
}

function recording(mbid: string, title: string, opts: { video?: boolean; variant?: string | null } = {}): number {
  const recordingId = id();
  db.prepare(`
    INSERT INTO Recordings (id, mbid, title, artist_mbid, is_video, video_variant, length_ms)
    VALUES (?, ?, ?, 'artist-x', ?, ?, 200000)
  `).run(recordingId, mbid, title, opts.video ? 1 : 0, opts.variant ?? null);
  return recordingId;
}

function track(editionId: number, recordingId: number, position: number, title: string): number {
  const trackId = id();
  db.prepare(`
    INSERT INTO Tracks (
      id, mbid, album_edition_id, recording_id, release_mbid, recording_mbid,
      medium_position, position, title
    ) VALUES (
      ?, ?, ?, ?,
      (SELECT mbid FROM AlbumEditions WHERE id = ?),
      (SELECT mbid FROM Recordings WHERE id = ?),
      1, ?, ?
    )
  `).run(trackId, `track-${trackId}`, editionId, recordingId, editionId, recordingId, position, title);
  return trackId;
}

function relate(videoRecordingId: number, audioRecordingId: number): void {
  db.prepare(`
    INSERT INTO RecordingRelations (
      source_recording_id, target_recording_id, relation_type, source, confidence
    ) VALUES (?, ?, 'provider_video_for', 'apple-music', 0.97)
  `).run(videoRecordingId, audioRecordingId);
}

/** A selected video with an available provider offer, so the page will show it. */
function selectWithOffer(videoRecordingId: number, providerId: string): void {
  const item = db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, availability)
    VALUES ('apple-music', 'video', ?, 'Video', 'available')
    RETURNING id
  `).get(providerId) as { itemId?: number; id: number };
  db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'accepted', 'automatic', 0.97, 'fixture', 1)
  `).run(item.id, videoRecordingId);
  selectVideoInVideoLibraries(db, videoRecordingId);
}

function base(): void {
  resetActiveSchemaRows(db);
  nextId = 1;
  db.exec("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist-x', 'Test Artist');");
}

const videoIds = (mbid: string, editionId?: number) =>
  getAlbumAssociatedVideos(mbid, editionId).map((entry) => entry.id).sort();

// ---------------------------------------------------------------------------
// iTunes Festival: MusicBrainz represents the video tracks directly
// ---------------------------------------------------------------------------

test("canonical video tracks appear on their Edition through direct membership", () => {
  base();
  // Tracks 1-5 audio, tracks 6-7 video — the shape Apple ships and MusicBrainz
  // represents faithfully.
  const festival = album("rg-itunes-festival", "iTunes Festival: London");
  const festivalEdition = edition(festival, "edition-itunes-festival", "iTunes Festival: London", 7);

  const audio: number[] = [];
  for (let position = 1; position <= 5; position += 1) {
    const audioRecording = recording(`rec-audio-${position}`, `Song ${position}`);
    audio.push(audioRecording);
    track(festivalEdition, audioRecording, position, `Song ${position}`);
  }
  const videoOne = recording("rec-video-1", "Song 1", { video: true, variant: "live" });
  const videoFive = recording("rec-video-5", "Song 5", { video: true, variant: "live" });
  track(festivalEdition, videoOne, 6, "Song 1");
  track(festivalEdition, videoFive, 7, "Song 5");

  // Provider member linkage resolved to exact audio Recordings.
  relate(videoOne, audio[0]);
  relate(videoFive, audio[4]);
  selectWithOffer(videoOne, "festival-video-1");
  selectWithOffer(videoFive, "festival-video-5");

  const shown = getAlbumAssociatedVideos("rg-itunes-festival", festivalEdition);
  assert.deepEqual(
    shown.map((entry) => entry.id).sort(),
    [String(videoOne), String(videoFive)].sort(),
  );
  // Direct canonical membership needs no relation and no association table.
  assert.ok(shown.every((entry) => entry.association === "direct"));
  assert.deepEqual(
    db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND (name LIKE '%VideoEdition%' OR name LIKE '%VideoAlbum%')
    `).all(),
    [],
  );
});

// ---------------------------------------------------------------------------
// A studio recording reused across four releases
// ---------------------------------------------------------------------------

test("one official video appears on the album, the deluxe, the single and the compilation", () => {
  base();
  const studioRecording = recording("rec-studio", "Pompeii");
  const officialVideo = recording("rec-video-official", "Pompeii", { video: true, variant: "official" });
  relate(officialVideo, studioRecording);
  selectWithOffer(officialVideo, "official-video");

  const releases: Array<[string, string, number]> = [
    ["rg-original", "Bad Blood", 13],
    ["rg-deluxe", "All This Bad Blood", 30],
    ["rg-single", "Pompeii", 1],
    ["rg-compilation", "Hits", 40],
  ];
  const editions = new Map<string, number>();
  for (const [mbid, title, trackCount] of releases) {
    const albumId = album(mbid, title, { secondary: mbid === "rg-compilation" ? '["Compilation"]' : null });
    const editionId = edition(albumId, `edition-${mbid}`, title, trackCount);
    // Every one of them carries the SAME canonical studio recording.
    track(editionId, studioRecording, 1, "Pompeii");
    editions.set(mbid, editionId);
  }

  for (const [mbid] of releases) {
    assert.deepEqual(
      videoIds(mbid),
      [String(officialVideo)],
      `${mbid} carries the exact studio recording, so it shows the video`,
    );
    assert.equal(getAlbumAssociatedVideos(mbid)[0]?.association, "related_audio");
  }

  // Shown four times, downloaded once: exactly one LibraryVideos row exists,
  // and therefore exactly one physical destination.
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM LibraryVideos WHERE video_recording_id = ?")
      .get(officialVideo) as { n: number }).n,
    1,
  );
});

test("a video shown on many pages reports one placement, and display ignores it", () => {
  base();
  const studioRecording = recording("rec-studio", "Pompeii");
  const officialVideo = recording("rec-video-official", "Pompeii", { video: true, variant: "official" });
  relate(officialVideo, studioRecording);
  selectWithOffer(officialVideo, "official-video");

  const original = album("rg-original", "Bad Blood");
  const originalEdition = edition(original, "edition-original", "Bad Blood", 13);
  const originalTrack = track(originalEdition, studioRecording, 1, "Pompeii");
  const compilation = album("rg-compilation", "Hits", { secondary: '["Compilation"]' });
  const compilationEdition = edition(compilation, "edition-compilation", "Hits", 40);
  track(compilationEdition, studioRecording, 7, "Pompeii");

  // The file is placed inline beside the ORIGINAL album's track.
  const [videoLibraryId] = resolveVideoLibraryIds(db);
  const stereoLibraryId = (db.prepare("SELECT id FROM Libraries WHERE name = 'Stereo'")
    .get() as { id: number }).id;
  selectLibraryVideo(db, {
    libraryId: videoLibraryId,
    videoRecordingId: officialVideo,
    placement: {
      mode: "inline",
      placementLibraryId: stereoLibraryId,
      inlineTrackId: originalTrack,
      inlineSlot: "video",
    },
  });

  // Both pages still show it, and both report the same single destination.
  for (const mbid of ["rg-original", "rg-compilation"]) {
    const [shown] = getAlbumAssociatedVideos(mbid);
    assert.ok(shown, `${mbid} shows the video`);
    assert.equal(shown.placement?.mode, "inline");
    assert.equal(shown.placement?.inline_track_id, originalTrack);
  }
});

// ---------------------------------------------------------------------------
// Live versus studio
// ---------------------------------------------------------------------------

test("a live video follows the live recording only, and a studio video the studio one", () => {
  base();
  const studioRecording = recording("rec-tunnel-studio", "Tunnel of Love");
  const liveRecording = recording("rec-tunnel-live", "Tunnel of Love (live)");

  const makingMovies = album("rg-making-movies", "Making Movies");
  const makingMoviesEdition = edition(makingMovies, "edition-making-movies", "Making Movies", 7);
  track(makingMoviesEdition, studioRecording, 3, "Tunnel of Love");

  const alchemy = album("rg-alchemy", "Alchemy", { secondary: '["Live"]' });
  const alchemyEdition = edition(alchemy, "edition-alchemy", "Alchemy", 9);
  track(alchemyEdition, liveRecording, 2, "Tunnel of Love");

  const liveVideo = recording("rec-video-live", "Tunnel of Love", { video: true, variant: "live" });
  const studioVideo = recording("rec-video-studio", "Tunnel of Love", { video: true, variant: "official" });
  relate(liveVideo, liveRecording);
  relate(studioVideo, studioRecording);
  selectWithOffer(liveVideo, "live-video");
  selectWithOffer(studioVideo, "studio-video");

  // Same title, comparable duration, different performances — and that is the
  // only thing that decides which page each belongs on.
  assert.deepEqual(videoIds("rg-alchemy"), [String(liveVideo)]);
  assert.deepEqual(videoIds("rg-making-movies"), [String(studioVideo)]);
});

test("the live recording reused on a live compilation carries its video along", () => {
  base();
  const liveRecording = recording("rec-tunnel-live", "Tunnel of Love (live)");
  const liveVideo = recording("rec-video-live", "Tunnel of Love", { video: true, variant: "live" });
  relate(liveVideo, liveRecording);
  selectWithOffer(liveVideo, "live-video");

  for (const [mbid, title] of [["rg-alchemy", "Alchemy"], ["rg-live-best-of", "Live Best Of"]]) {
    const albumId = album(mbid, title, { secondary: '["Live"]' });
    const editionId = edition(albumId, `edition-${mbid}`, title, 12);
    track(editionId, liveRecording, 2, "Tunnel of Love");
  }

  assert.deepEqual(videoIds("rg-alchemy"), [String(liveVideo)]);
  assert.deepEqual(videoIds("rg-live-best-of"), [String(liveVideo)]);
});

// ---------------------------------------------------------------------------
// Edition scoping and deduplication
// ---------------------------------------------------------------------------

test("an Edition shows only the videos that Edition carries", () => {
  base();
  const studioRecording = recording("rec-studio", "Pompeii");
  const bonusRecording = recording("rec-bonus", "Bonus Song");
  const officialVideo = recording("rec-video-official", "Pompeii", { video: true, variant: "official" });
  const bonusVideo = recording("rec-video-bonus", "Bonus Song", { video: true, variant: "official" });
  relate(officialVideo, studioRecording);
  relate(bonusVideo, bonusRecording);
  selectWithOffer(officialVideo, "official-video");
  selectWithOffer(bonusVideo, "bonus-video");

  const albumId = album("rg-two-editions", "Bad Blood");
  const standard = edition(albumId, "edition-standard", "Bad Blood", 13);
  const deluxe = edition(albumId, "edition-deluxe", "All This Bad Blood", 30);
  track(standard, studioRecording, 1, "Pompeii");
  track(deluxe, studioRecording, 1, "Pompeii");
  track(deluxe, bonusRecording, 20, "Bonus Song");

  assert.deepEqual(videoIds("rg-two-editions", standard), [String(officialVideo)]);
  assert.deepEqual(
    videoIds("rg-two-editions", deluxe),
    [String(officialVideo), String(bonusVideo)].sort(),
  );
  // The album-wide view is the union of its editions.
  assert.deepEqual(
    videoIds("rg-two-editions"),
    [String(officialVideo), String(bonusVideo)].sort(),
  );
});

test("direct and derived associations for one video collapse to a single entry", () => {
  base();
  const audioRecording = recording("rec-audio", "Song");
  const video = recording("rec-video", "Song", { video: true, variant: "official" });
  relate(video, audioRecording);
  selectWithOffer(video, "the-video");

  const albumId = album("rg-both-paths", "Both Paths");
  const editionId = edition(albumId, "edition-both-paths", "Both Paths", 2);
  // The edition carries BOTH the audio recording and the video recording, so
  // the video qualifies twice over.
  track(editionId, audioRecording, 1, "Song");
  track(editionId, video, 2, "Song");

  const shown = getAlbumAssociatedVideos("rg-both-paths");
  assert.equal(shown.length, 1, "two qualifying paths are still one video");
  assert.equal(shown[0]?.association, "direct", "direct membership is the better label");
});
