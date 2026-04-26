import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEditionIdentityKey,
  buildIsrcSet,
  buildMusicBrainzReleaseGroupKey,
  buildNormalizedTrackTitleSet,
} from "./release-identity.js";

test("edition identity keeps MusicBrainz release groups out of fine-grained curation", () => {
  const standard = {
    id: 1,
    title: "Album",
    mbid: "release-standard",
    mb_release_group_id: "rg-1",
  };
  const deluxe = {
    id: 2,
    title: "Album",
    version: "Deluxe Edition",
    mbid: "release-deluxe",
    mb_release_group_id: "rg-1",
  };

  assert.equal(buildMusicBrainzReleaseGroupKey(standard), "mb-release-group:rg-1");
  assert.equal(buildMusicBrainzReleaseGroupKey(deluxe), "mb-release-group:rg-1");
  assert.notEqual(buildEditionIdentityKey(standard), buildEditionIdentityKey(deluxe));
});

test("edition identity prefers shared exact-release identifiers before provider fallback", () => {
  assert.equal(
    buildEditionIdentityKey({ id: 1, title: "Album", version_group_id: 123, mbid: "MB-Release" }),
    "mb-release:mb-release",
  );
  assert.equal(
    buildEditionIdentityKey({ id: 1, title: "Album", version_group_id: 123, upc: "012345678901" }),
    "upc:012345678901",
  );
  assert.equal(
    buildEditionIdentityKey({ id: 1, title: "Album", version_group_id: 123 }),
    "provider-version:123",
  );
  assert.equal(
    buildEditionIdentityKey({ id: 1, title: "Album", version: "Deluxe Edition" }),
    "title-version:album:deluxe edition",
  );
});

test("track identity sets normalize ISRCs and titles for redundancy checks", () => {
  const tracks = [
    { isrc: " US-ABC-24-00001 ", title: "Song One" },
    { isrc: null, title: "Song Two (Remastered)" },
    { isrc: "us-abc-24-00001", title: "Song One" },
  ];

  assert.deepEqual([...buildIsrcSet(tracks)], ["us-abc-24-00001"]);
  assert.deepEqual([...buildNormalizedTrackTitleSet(tracks)].sort(), ["songone", "songtwo"].sort());
});
