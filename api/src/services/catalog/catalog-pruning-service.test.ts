import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
  resetActiveSchemaRows,
  seedLibraryArtistMonitoring,
} from "../../test-support/active-schema-fixture.js";
import { VARIOUS_ARTISTS_MBID } from "../mediafiles/audio-tag-service.js";

const { tempDir } = prepareActiveSchemaEnv("catalog-pruning");
const { db, dbModule } = await openActiveSchemaDb();
const { pruneUnreferencedCatalog } = await import("./catalog-pruning-service.js");
const { updateConfig } = await import("../config/config.js");

after(() => closeActiveSchemaDb(dbModule, tempDir));

beforeEach(() => {
  resetActiveSchemaRows(db);
  updateConfig("filtering", {
    include_album: true,
    include_single: true,
    include_ep: true,
    include_compilation: false,
    include_live: false,
  });
});

function stereoLibraryId(): number {
  return (db.prepare("SELECT id FROM Libraries WHERE name = 'Stereo'").get() as { id: number }).id;
}

function seedAlbumWithTrack(input: {
  artistMbid: string;
  artistName: string;
  albumMbid: string;
  albumTitle: string;
  primaryType?: string;
  secondaryTypes?: string[];
  editionMbid: string;
  recordingMbid: string;
  trackMbid: string;
  isVideo?: number;
}) {
  db.prepare(`
    INSERT OR IGNORE INTO ArtistMetadata (mbid, name) VALUES (?, ?)
  `).run(input.artistMbid, input.artistName);
  const artist = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = ?").get(input.artistMbid) as { id: number };
  const album = db.prepare(`
    INSERT INTO Albums (mbid, artist_metadata_id, artist_mbid, title, primary_type, secondary_types, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, 'hash-v1')
    RETURNING id
  `).get(
    input.albumMbid,
    artist.id,
    input.artistMbid,
    input.albumTitle,
    input.primaryType ?? "Album",
    JSON.stringify(input.secondaryTypes ?? []),
  ) as { id: number };
  const edition = db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_id, release_group_mbid, artist_metadata_id, artist_mbid, title, status)
    VALUES (?, ?, ?, ?, ?, ?, 'Official')
    RETURNING id
  `).get(input.editionMbid, album.id, input.albumMbid, artist.id, input.artistMbid, input.albumTitle) as { id: number };
  const recording = db.prepare(`
    INSERT INTO Recordings (mbid, artist_metadata_id, artist_mbid, title, is_video)
    VALUES (?, ?, ?, ?, ?)
    RETURNING id
  `).get(input.recordingMbid, artist.id, input.artistMbid, `${input.albumTitle} Track`, input.isVideo ?? 0) as { id: number };
  const track = db.prepare(`
    INSERT INTO Tracks (mbid, album_edition_id, release_mbid, recording_id, recording_mbid, medium_position, position, title)
    VALUES (?, ?, ?, ?, ?, 1, 1, ?)
    RETURNING id
  `).get(input.trackMbid, edition.id, input.editionMbid, recording.id, input.recordingMbid, `${input.albumTitle} Track`) as { id: number };
  return { artistId: artist.id, albumId: album.id, editionId: edition.id, recordingId: recording.id, trackId: track.id };
}

test("pruneUnreferencedCatalog removes unselected plans, VA & unmonitored catalogs, excluded editions, orphan recordings & artists while keeping library & file-backed rows", async () => {
  const libId = stereoLibraryId();

  // 1. Monitored artist + monitored album (MUST BE KEPT)
  const monitored = seedAlbumWithTrack({
    artistMbid: "11111111-1111-4111-8111-111111111111",
    artistName: "Bastille",
    albumMbid: "rg-monitored",
    albumTitle: "Bad Blood",
    editionMbid: "ed-monitored",
    recordingMbid: "rec-monitored",
    trackMbid: "trk-monitored",
  });
  seedLibraryArtistMonitoring(db, "11111111-1111-4111-8111-111111111111");
  db.prepare(`
    INSERT INTO LibraryAlbums (library_id, release_group_id, selection_mode, curation_version)
    VALUES (?, ?, 'auto', 1)
  `).run(libId, monitored.albumId);
  db.prepare(`
    INSERT INTO LibraryEditions (library_id, edition_id, selection_mode, curation_version)
    VALUES (?, ?, 'auto', 1)
  `).run(libId, monitored.editionId);
  const keptPlan = db.prepare(`
    INSERT INTO AcquisitionPlans (
      library_id, edition_id, provider, composition, download_mode, state,
      plan_key, rank, coverage, target_track_count, planner_version, policy_hash, computed_at
    ) VALUES (?, ?, 'tidal', 'single_source', 'album', 'current', 'kept-plan', 0, 1, 1, 3, 'h1', CURRENT_TIMESTAMP)
    RETURNING id
  `).get(libId, monitored.editionId) as { id: number };
  assert.ok(keptPlan.id > 0);

  // 2. Monitored artist's filtering-excluded compilation (KEEP album stub, PRUNE unreferenced edition + reset content_hash)
  const excludedOwned = seedAlbumWithTrack({
    artistMbid: "11111111-1111-4111-8111-111111111111",
    artistName: "Bastille",
    albumMbid: "rg-excluded-comp",
    albumTitle: "Greatest Hits",
    primaryType: "Album",
    secondaryTypes: ["Compilation"],
    editionMbid: "ed-excluded-comp",
    recordingMbid: "rec-excluded-comp",
    trackMbid: "trk-excluded-comp",
  });

  // 3. Various Artists compilation with unselected AcquisitionPlan (MUST BE PRUNED completely)
  const vaComp = seedAlbumWithTrack({
    artistMbid: VARIOUS_ARTISTS_MBID,
    artistName: "Various Artists",
    albumMbid: "rg-va-comp",
    albumTitle: "Now 99",
    primaryType: "Album",
    secondaryTypes: ["Compilation"],
    editionMbid: "ed-va-comp",
    recordingMbid: "rec-va-comp",
    trackMbid: "trk-va-comp",
  });
  db.prepare(`
    INSERT INTO AcquisitionPlans (
      library_id, edition_id, provider, composition, download_mode, state,
      plan_key, rank, coverage, target_track_count, planner_version, policy_hash, computed_at
    ) VALUES (?, ?, 'tidal', 'single_source', 'album', 'current', 'unselected-va-plan', 0, 1, 1, 3, 'h2', CURRENT_TIMESTAMP)
  `).run(libId, vaComp.editionId);

  // 4. Unmonitored collaborator's unrelated album (MUST BE PRUNED along with its orphan artist & recording)
  const unmonitored = seedAlbumWithTrack({
    artistMbid: "22222222-2222-4222-8222-222222222222",
    artistName: "Unmonitored Collaborator",
    albumMbid: "rg-unmonitored",
    albumTitle: "Unrelated Album",
    editionMbid: "ed-unmonitored",
    recordingMbid: "rec-unmonitored",
    trackMbid: "trk-unmonitored",
  });

  // 5. Unmonitored artist's file-backed album (MUST BE KEPT because TrackFiles references it)
  const fileBacked = seedAlbumWithTrack({
    artistMbid: "33333333-3333-4333-8333-333333333333",
    artistName: "File Backed Artist",
    albumMbid: "rg-file-backed",
    albumTitle: "On Disk Album",
    editionMbid: "ed-file-backed",
    recordingMbid: "rec-file-backed",
    trackMbid: "trk-file-backed",
  });
  db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, release_group_id, album_edition_id, track_id, recording_id,
      library_id, library_slot, library_root, file_path, relative_path, filename, extension, file_type, file_class
    ) VALUES (?, ?, ?, ?, ?, ?, 'stereo', '/music', '/music/on-disk.flac', 'on-disk.flac', 'on-disk.flac', 'flac', 'track', 'audio')
  `).run(fileBacked.artistId, fileBacked.albumId, fileBacked.editionId, fileBacked.trackId, fileBacked.recordingId, libId);

  // 6. Active included collaboration owned by unmonitored collaborator (MUST BE KEPT)
  const activeCollab = seedAlbumWithTrack({
    artistMbid: "44444444-4444-4444-8444-444444444444",
    artistName: "Marshmello",
    albumMbid: "rg-happier",
    albumTitle: "Happier",
    primaryType: "Single",
    editionMbid: "ed-happier",
    recordingMbid: "rec-happier",
    trackMbid: "trk-happier",
  });
  db.prepare(`
    INSERT INTO ReleaseGroupArtistCredits (release_group_id, artist_id, ordinal, credited_name, join_phrase)
    VALUES (?, ?, 0, 'Marshmello', ' & '), (?, ?, 1, 'Bastille', '')
  `).run(activeCollab.albumId, activeCollab.artistId, activeCollab.albumId, monitored.artistId);

  // 7. User-excluded album owned by unmonitored artist (MUST BE KEPT so exclusion survives)
  const userExcluded = seedAlbumWithTrack({
    artistMbid: "55555555-5555-4555-8555-555555555555",
    artistName: "Excluded Owner",
    albumMbid: "rg-user-excluded",
    albumTitle: "User Excluded",
    editionMbid: "ed-user-excluded",
    recordingMbid: "rec-user-excluded",
    trackMbid: "trk-user-excluded",
  });
  db.prepare(`
    INSERT INTO LibraryUserExclusions (library_id, release_group_id)
    VALUES (?, ?)
  `).run(libId, userExcluded.albumId);

  // 8. Standalone video recording (MUST BE KEPT)
  db.prepare(`
    INSERT INTO Recordings (mbid, title, is_video) VALUES ('rec-video-keep', 'Official Video', 1)
  `).run();

  const summary = await pruneUnreferencedCatalog();
  assert.equal(summary.timedOut, false);
  assert.equal(summary.acquisitionPlansPruned, 1, "unselected VA plan pruned");
  assert.equal(summary.albumsPruned, 2, "VA album + unmonitored unrelated album pruned");
  assert.equal(summary.editionsPruned, 1, "excluded compilation edition pruned");
  assert.equal(summary.recordingsPruned, 3, "orphaned audio recordings pruned");
  assert.equal(summary.artistsPruned, 2, "VA + unmonitored orphan artists pruned");

  // Verify kept rows
  assert.ok(db.prepare("SELECT 1 FROM AcquisitionPlans WHERE id = ?").get(keptPlan.id), "monitored plan kept");
  assert.ok(db.prepare("SELECT 1 FROM Albums WHERE id = ?").get(monitored.albumId), "monitored album kept");
  const excludedStub = db.prepare("SELECT content_hash FROM Albums WHERE id = ?").get(excludedOwned.albumId) as { content_hash: string | null } | undefined;
  assert.ok(excludedStub, "excluded album stub kept for monitored artist");
  assert.equal(excludedStub.content_hash, null, "excluded album content_hash reset for on-demand rehydration");
  assert.equal(db.prepare("SELECT 1 FROM AlbumEditions WHERE id = ?").get(excludedOwned.editionId), undefined, "excluded album edition pruned");
  assert.equal(db.prepare("SELECT 1 FROM Albums WHERE id = ?").get(vaComp.albumId), undefined, "VA album pruned");
  assert.equal(db.prepare("SELECT 1 FROM Albums WHERE id = ?").get(unmonitored.albumId), undefined, "unmonitored album pruned");
  assert.ok(db.prepare("SELECT 1 FROM Albums WHERE id = ?").get(fileBacked.albumId), "file-backed album kept");
  assert.ok(db.prepare("SELECT 1 FROM Albums WHERE id = ?").get(activeCollab.albumId), "active collaboration kept");
  assert.ok(db.prepare("SELECT 1 FROM Albums WHERE id = ?").get(userExcluded.albumId), "user-excluded album kept");
  assert.ok(db.prepare("SELECT 1 FROM Recordings WHERE mbid = 'rec-video-keep'").get(), "video recording kept");
  assert.deepEqual(db.pragma("foreign_key_check"), [], "no foreign key violations after pruning");
});

test("pruneUnreferencedCatalog preserves unselected plans referenced by DownloadQueue or active commands", async () => {
  const libId = stereoLibraryId();
  const album = seedAlbumWithTrack({
    artistMbid: "66666666-6666-4666-8666-666666666666",
    artistName: "Queued Artist",
    albumMbid: "rg-queued",
    albumTitle: "Queued Album",
    editionMbid: "ed-queued",
    recordingMbid: "rec-queued",
    trackMbid: "trk-queued",
  });
  const plan = db.prepare(`
    INSERT INTO AcquisitionPlans (
      library_id, edition_id, provider, composition, download_mode, state,
      plan_key, rank, coverage, target_track_count, planner_version, policy_hash, computed_at
    ) VALUES (?, ?, 'tidal', 'single_source', 'album', 'current', 'active-cmd-plan', 0, 1, 1, 3, 'h3', CURRENT_TIMESTAMP)
    RETURNING id
  `).get(libId, album.editionId) as { id: number };
  db.prepare(`
    INSERT INTO commands (name, status, payload, ref_id)
    VALUES ('DownloadAlbum', 'started', ?, 'rg-queued')
  `).run(JSON.stringify({ acquisitionPlanId: plan.id }));

  const summary = await pruneUnreferencedCatalog();
  assert.equal(summary.acquisitionPlansPruned, 0, "plan referenced by active command must not be pruned");
  assert.equal(summary.albumsPruned, 0, "album with active plan must not be pruned");
  assert.ok(db.prepare("SELECT 1 FROM AcquisitionPlans WHERE id = ?").get(plan.id));
});

test("pruneUnreferencedCatalog respects per-pass bounds and timeout", async () => {
  for (let i = 0; i < 4; i += 1) {
    seedAlbumWithTrack({
      artistMbid: `7777777${i}-7777-4777-8777-777777777777`,
      artistName: `Orphan Artist ${i}`,
      albumMbid: `rg-orphan-${i}`,
      albumTitle: `Orphan Album ${i}`,
      editionMbid: `ed-orphan-${i}`,
      recordingMbid: `rec-orphan-${i}`,
      trackMbid: `trk-orphan-${i}`,
    });
  }

  const bounded = await pruneUnreferencedCatalog({ maxAlbumsPerPass: 2, maxRecordingsPerPass: 1, maxArtistsPerPass: 1 });
  assert.equal(bounded.albumsPruned, 2);
  assert.equal(bounded.recordingsPruned, 1);
  assert.equal(bounded.artistsPruned, 1);

  const timedOut = await pruneUnreferencedCatalog({ isTimedOut: () => true });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.albumsPruned, 0);
});
