import assert from "node:assert/strict";
import { test } from "node:test";

import {
  playlistCoversCanonicalTracklist,
  rankSoundCloudPlaylistCandidates,
  scorePlaylistTracklistCoverage,
  shouldWideSearchSoundCloudPlaylists,
  soundCloudPlaylistTrackTitleVariants,
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

test("playlist coverage accepts supersets and rejects sparse incomplete sets", () => {
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

test("playlist coverage accepts near-complete fan sets at 85%+", () => {
  const canonical = [
    { title: "Adagio for Strings", durationSec: 239, trackNumber: 1 },
    { title: "What Would You Do?", durationSec: 203, trackNumber: 2 },
    { title: "Requiem for Blue Jeans", durationSec: 237, trackNumber: 3 },
    { title: "Of the Night", durationSec: 213, trackNumber: 4 },
    { title: "Titanium", durationSec: 174, trackNumber: 5 },
    { title: "Love Don't Live Here", durationSec: 362, trackNumber: 6 },
    { title: "Falling", durationSec: 225, trackNumber: 7 },
  ];
  // Real emmatad set omits What Would You Do? but covers the other six.
  const nearComplete = [
    { title: ". ADAGIO FOR STRINGS (ft. Maiday)", duration: 239 },
    { title: "REQUIEM FOR BLUE JEANS", duration: 237 },
    { title: "OF THE NIGHT", duration: 213 },
    { title: "TITANIUM (ft. Barnaby Keen Band)", duration: 174 },
    { title: "LOVE DON'T LIVE HERE (ft. Rory Andrew)", duration: 362 },
    { title: "FALLING (ft. Ralph Of To Kill A King)", duration: 225 },
    { title: "TUNING IN [ft. HUMS Contemporary Choir]", duration: 63 },
  ];

  assert.equal(playlistCoversCanonicalTracklist(canonical, nearComplete), true);
  const coverage = scorePlaylistTracklistCoverage(canonical, nearComplete);
  assert.equal(coverage.covered, 6);
  assert.ok(coverage.ratio >= 0.85);
});

test("SoundCloud artist-prefix titles still cover the bare MB title", () => {
  const canonical = [
    { title: "Killer", durationSec: 181, trackNumber: 1 },
    { title: "Dreams", durationSec: 259, trackNumber: 2 },
    { title: "No Angels", durationSec: 240, trackNumber: 3 },
  ];
  const playlist = [
    { title: "Bastille - Killer [ft. F*U*G*Z]", duration: 181 },
    { title: "Bastille & Gabrielle Aplin - Dreams", duration: 259 },
    { title: "Bastille \"No Angels\" (ft. Ella)", duration: 241 },
  ];

  assert.deepEqual(
    soundCloudPlaylistTrackTitleVariants("Bastille & Gabrielle Aplin - Dreams"),
    [
      "Bastille & Gabrielle Aplin - Dreams",
      "Dreams",
    ],
  );
  assert.equal(playlistCoversCanonicalTracklist(canonical, playlist), true);
});

test("empty SoundCloud stubs are ranked out when a tracklist is preferred", () => {
  const artist = { providerId: "1", name: "Bastille" };
  const ranked = rankSoundCloudPlaylistCandidates(
    [
      { providerId: "2881942", title: "OTHER PEOPLE'S HEARTACHE, PT. 2", trackCount: 0, artist },
      {
        providerId: "653882871",
        title: "Other Peoples Heartache Pt. 1 & 2",
        trackCount: 15,
        artist,
      },
      {
        providerId: "984272287",
        title: "Other People's Heartache pt 2",
        trackCount: 11,
        artist,
      },
    ],
    "Other People's Heartache, Pt. 2",
    11,
  );

  assert.deepEqual(
    ranked.map((row) => row.providerId),
    ["984272287", "653882871"],
  );
});

test("truncated fan-set titles still rank for mixtape coverage search", () => {
  const artist = { providerId: "1", name: "Bastille" };
  const ranked = rankSoundCloudPlaylistCandidates(
    [
      {
        providerId: "hugo",
        title: "other-peoples-her",
        trackCount: 11,
        artist,
      },
      {
        providerId: "full",
        title: "Other People's Heartache Pt. 2",
        trackCount: 11,
        artist,
      },
    ],
    "Other People's Heartache, Pt. 2",
    11,
  );

  assert.deepEqual(
    ranked.map((row) => row.providerId),
    ["full", "hugo"],
  );
});
