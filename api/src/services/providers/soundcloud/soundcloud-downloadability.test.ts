import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifySoundCloudTrackDownloadability,
  filterDownloadableSoundCloudSearchTracks,
  isSoundCloudTrackDownloadable,
  isSoundCloudTrackKnownUndownloadable,
  scoreSoundCloudDownloadableCoverage,
  soundCloudOfferHasDownloadableMatch,
} from "./soundcloud-downloadability.js";
import {
  matchPlaylistTracksToCanonical,
  playlistCoversCanonicalTracklistDownloadable,
  scorePlaylistTracklistCoverage,
} from "./soundcloud-playlist-match.js";

const progressive = {
  id: 1,
  title: "Fan Upload",
  policy: "ALLOW",
  media: {
    transcodings: [{
      url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:1/progressive",
      snipped: false,
      format: { protocol: "progressive", mime_type: "audio/mpeg" },
    }],
  },
};

const drmEncrypted = {
  id: 2,
  title: "Official DRM",
  policy: "ALLOW",
  media: {
    transcodings: [{
      url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:2/enc",
      snipped: false,
      format: { protocol: "ctr-encrypted-hls", mime_type: "audio/mp4" },
    }],
  },
};

const phantomHlsBesideEncrypted = {
  id: 3,
  title: "Go+ phantom HLS",
  policy: "ALLOW",
  media: {
    transcodings: [
      {
        url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:3/hls",
        snipped: false,
        format: { protocol: "hls", mime_type: "audio/mpeg" },
      },
      {
        url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:3/enc",
        snipped: false,
        format: { protocol: "cbc-encrypted-hls", mime_type: "audio/mp4" },
      },
    ],
  },
};

const snipOnly = {
  id: 4,
  title: "SNIP preview",
  policy: "SNIP",
  media: {
    transcodings: [{
      url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:4/preview",
      snipped: true,
      format: { protocol: "progressive", mime_type: "audio/mpeg" },
    }],
  },
};

const plainHls = {
  id: 5,
  title: "Plain HLS",
  policy: "ALLOW",
  media: {
    transcodings: [{
      url: "https://api-v2.soundcloud.com/media/soundcloud:tracks:5/hls",
      snipped: false,
      format: { protocol: "hls", mime_type: "audio/mpeg" },
    }],
  },
};

test("classifies progressive, DRM, phantom HLS, and SNIP", () => {
  assert.equal(classifySoundCloudTrackDownloadability(progressive), "progressive");
  assert.equal(classifySoundCloudTrackDownloadability(drmEncrypted), "drm");
  assert.equal(classifySoundCloudTrackDownloadability(phantomHlsBesideEncrypted), "drm");
  assert.equal(classifySoundCloudTrackDownloadability(snipOnly), "snip");
  assert.equal(classifySoundCloudTrackDownloadability(plainHls), "hls");
  assert.equal(isSoundCloudTrackDownloadable(progressive), true);
  assert.equal(isSoundCloudTrackDownloadable(phantomHlsBesideEncrypted), false);
  assert.equal(isSoundCloudTrackKnownUndownloadable(drmEncrypted), true);
});

test("search filter drops DRM/SNIP/phantom but keeps progressive and unknowns", () => {
  const stub = { id: 9, title: "Stub" };
  const filtered = filterDownloadableSoundCloudSearchTracks([
    progressive,
    drmEncrypted,
    phantomHlsBesideEncrypted,
    snipOnly,
    plainHls,
    stub,
  ]);
  assert.deepEqual(
    filtered.map((track) => track.id),
    [1, 5, 9],
  );
});

test("DRM-only covering set is not a Discogenius match", () => {
  const canonical = [
    { title: "Adagio for Strings", durationSec: 239, trackNumber: 1 },
    { title: "Of the Night", durationSec: 213, trackNumber: 2 },
    { title: "Falling", durationSec: 225, trackNumber: 3 },
  ];
  const drmSet = [
    { title: "Adagio for Strings", duration: 239, raw: drmEncrypted },
    { title: "Of the Night", duration: 213, raw: { ...drmEncrypted, id: 22 } },
    { title: "Falling", duration: 225, raw: { ...drmEncrypted, id: 23 } },
  ];
  assert.equal(playlistCoversCanonicalTracklistDownloadable(canonical, drmSet), false);
});

test("fully progressive fan set matches; mixed DRM-heavy set does not", () => {
  const canonical = [
    { title: "Adagio for Strings", durationSec: 239, trackNumber: 1 },
    { title: "Of the Night", durationSec: 213, trackNumber: 2 },
    { title: "Falling", durationSec: 225, trackNumber: 3 },
    { title: "Titanium", durationSec: 174, trackNumber: 4 },
  ];
  const fanProgressive = [
    { title: "Adagio for Strings", duration: 239, raw: progressive },
    { title: "Of the Night", duration: 213, raw: { ...progressive, id: 11 } },
    { title: "Falling", duration: 225, raw: { ...progressive, id: 12 } },
    { title: "Titanium", duration: 174, raw: { ...progressive, id: 13 } },
  ];
  const mixedMostlyDrm = [
    { title: "Adagio for Strings", duration: 239, raw: progressive },
    { title: "Of the Night", duration: 213, raw: drmEncrypted },
    { title: "Falling", duration: 225, raw: { ...drmEncrypted, id: 32 } },
    { title: "Titanium", duration: 174, raw: { ...drmEncrypted, id: 33 } },
  ];
  assert.equal(playlistCoversCanonicalTracklistDownloadable(canonical, fanProgressive), true);
  assert.equal(playlistCoversCanonicalTracklistDownloadable(canonical, mixedMostlyDrm), false);
});

test("downloadable coverage prefers progressive assignments for ranking", () => {
  const assignments = [
    { playlistIndex: 0 },
    { playlistIndex: 1 },
    { playlistIndex: 2 },
  ];
  const coverage = scoreSoundCloudDownloadableCoverage(
    assignments,
    [progressive, drmEncrypted, plainHls],
    3,
  );
  assert.equal(coverage.downloadableCovered, 2);
  assert.equal(coverage.knownUndownloadableCovered, 1);
  // 2/3 is below the 85% floor — mixed DRM-heavy sets fail the match gate.
  assert.equal(soundCloudOfferHasDownloadableMatch(coverage), false);

  const mostlyProgressive = scoreSoundCloudDownloadableCoverage(
    assignments,
    [progressive, { ...progressive, id: 11 }, plainHls],
    3,
  );
  assert.equal(mostlyProgressive.downloadableCovered, 3);
  assert.equal(soundCloudOfferHasDownloadableMatch(mostlyProgressive), true);
});

test("playlist matching never assigns DRM/SNIP/BLOCK tracks", () => {
  const canonical = [
    { title: "Adagio for Strings", durationSec: 239, trackNumber: 1 },
    { title: "Of the Night", durationSec: 213, trackNumber: 2 },
    { title: "Falling", durationSec: 225, trackNumber: 3 },
  ];
  const playlist = [
    { title: "Adagio for Strings", duration: 239, raw: progressive },
    { title: "Of the Night", duration: 213, raw: drmEncrypted },
    { title: "Falling", duration: 225, raw: snipOnly },
  ];
  const assignments = matchPlaylistTracksToCanonical(canonical, playlist);
  assert.deepEqual(
    assignments.map((row) => row.playlistIndex),
    [0],
    "only the progressive track is assignable",
  );
  const coverage = scorePlaylistTracklistCoverage(canonical, playlist);
  assert.equal(coverage.covered, 1);
  assert.equal(coverage.downloadable?.downloadableCovered, 1);
  assert.equal(coverage.downloadable?.knownUndownloadableCovered, 0);
  assert.equal(playlistCoversCanonicalTracklistDownloadable(canonical, playlist), false);
});
