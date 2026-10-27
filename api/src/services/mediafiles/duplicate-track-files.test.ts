import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTrackPathCollision, type TrackFileClaim } from "./duplicate-track-files.js";

const edition = 7;
const root = "/library/stereo-music/Thompson Twins {mbid-228af6b5}";
const claim = (over: Partial<TrackFileClaim>): TrackFileClaim => ({
  id: 1, library_id: 1, album_edition_id: edition, track_id: null,
  artist_metadata_id: 79815, file_path: "", manual: false, ...over,
});

test("Thompson Twins disc 3: unlinked copy in the old-title folder is deleted, linked file stays", () => {
  const target = `${root}/Industry & Seduction (2025) {mbid-c95493b7}/301 - Intro.flac`;
  const mover = claim({ id: 43248, file_path: `${root}/Industry & Seduction (3CD) (2025) {mbid-c95493b7}/301 - Intro.flac` });
  const occupant = claim({ id: 41447, track_id: 900, file_path: target });
  assert.deepEqual(classifyTrackPathCollision(mover, occupant, target), {
    kind: "delete-unlinked", deleteIds: [43248], keepId: 41447,
  });
});

test("The Who Summertime Blues: linked file must move onto an unlinked copy, so both go and the track is re-downloaded", () => {
  const folder = "/library/stereo-music/The Who {mbid-9fdaa16b}/Live at Leeds (2010) {mbid-8d05900c}";
  const target = `${folder}/503 - Summertime Blues.flac`;
  const mover = claim({ id: 30088, track_id: 503, artist_metadata_id: 79486, file_path: `${folder}/110 - Summertime Blues.flac` });
  const occupant = claim({ id: 30913, track_id: null, artist_metadata_id: 79486, file_path: target });
  assert.deepEqual(classifyTrackPathCollision(mover, occupant, target), {
    kind: "ambiguous", deleteIds: [30088, 30913], artistIds: ["79486"],
  });
});

test("Thompson Twins disc 3: a linked copy in the old-title folder is also a clear duplicate", () => {
  const target = `${root}/Industry & Seduction (2025) {mbid-c95493b7}/314 - Love on Your Side.flac`;
  const mover = claim({ id: 43263, track_id: 914, file_path: `${root}/Industry & Seduction (3CD) (2025) {mbid-c95493b7}/314 - Love on Your Side.flac` });
  const occupant = claim({ id: 41460, track_id: 914, file_path: target });
  assert.deepEqual(classifyTrackPathCollision(mover, occupant, target), {
    kind: "delete-unlinked", deleteIds: [43263], keepId: 41460,
  });
});

test("a manually imported file claiming an occupied track goes to unmapped files, not deleted", () => {
  const target = `${root}/A (2025) {mbid-x}/101 - A.flac`;
  const mover = claim({ id: 5, manual: true, file_path: `${root}/import/a.flac` });
  const occupant = claim({ id: 6, track_id: 1, file_path: target });
  assert.deepEqual(classifyTrackPathCollision(mover, occupant, target), { kind: "unmapped", unmapIds: [5], keepId: 6 });
});

test("other editions and the spatial library are never treated as duplicates", () => {
  const target = `${root}/A/101 - A.flac`;
  const occupant = claim({ id: 6, track_id: 1, file_path: target });
  assert.equal(classifyTrackPathCollision(claim({ id: 5, album_edition_id: 8 }), occupant, target), null);
  assert.equal(classifyTrackPathCollision(claim({ id: 5, library_id: 2 }), occupant, target), null);
});
