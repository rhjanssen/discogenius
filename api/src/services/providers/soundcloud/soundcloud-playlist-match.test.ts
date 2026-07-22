import assert from "node:assert/strict";
import { test } from "node:test";

import {
  playlistCoversCanonicalTracklist,
  scorePlaylistTracklistCoverage,
  shouldWideSearchSoundCloudPlaylists,
} from "./soundcloud-playlist-match.js";

test("wide playlist search is limited to mixtape/dj-mix/demo/other", () => {
  assert.equal(shouldWideSearchSoundCloudPlaylists("EP", ["Mixtape/Street"]), true);
  assert.equal(shouldWideSearchSoundCloudPlaylists("Album", ["DJ-mix"]), true);
  assert.equal(shouldWideSearchSoundCloudPlaylists("Other", []), true);
  assert.equal(shouldWideSearchSoundCloudPlaylists("Album", ["Demo"]), true);

  assert.equal(shouldWideSearchSoundCloudPlaylists("Album", []), false);
  assert.equal(shouldWideSearchSoundCloudPlaylists("EP", []), false);
  assert.equal(shouldWideSearchSoundCloudPlaylists("Single", []), false);
  assert.equal(shouldWideSearchSoundCloudPlaylists("Album", ["Live"]), false);
  assert.equal(shouldWideSearchSoundCloudPlaylists("Album", ["Compilation"]), false);
  assert.equal(shouldWideSearchSoundCloudPlaylists("Album", ["Remix"]), false);
});

test("playlist coverage accepts supersets and rejects incomplete sets", () => {
  const canonical = [
    { title: "Adagio for Strings", durationSec: 239, trackNumber: 1 },
    { title: "Of the Night", durationSec: 213, trackNumber: 2 },
    { title: "Falling", durationSec: 225, trackNumber: 3 },
  ];
  const covering = [
    { title: "Adagio for Strings", duration: 239 },
    { title: "Bonus", duration: 90 },
    { title: "Of the Night", duration: 213 },
    { title: "Falling", duration: 225 },
    { title: "Extra", duration: 100 },
  ];
  const incomplete = [
    { title: "Adagio for Strings", duration: 239 },
    { title: "Of the Night", duration: 213 },
  ];

  assert.equal(playlistCoversCanonicalTracklist(canonical, covering), true);
  assert.equal(playlistCoversCanonicalTracklist(canonical, incomplete), false);

  const coverage = scorePlaylistTracklistCoverage(canonical, covering);
  assert.equal(coverage.covered, 3);
  assert.equal(coverage.total, 3);
  assert.equal(coverage.ratio, 1);
});
