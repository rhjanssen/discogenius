import assert from "node:assert/strict";
import test from "node:test";

import {
  dedupeNames,
  isTagValueEqual,
  parseArtistCreditString,
  planAlbumArtistTags,
  splitMultiValue,
} from "./audio-tag-service.js";

const AFROJACK = "a3ee920f-4e7f-4993-8aca-4b8538cfaa4a";
const EVA = "481cbdd9-02ac-46fd-825f-afed658bc505";

test("album artist defaults to the owning artist with a single MBID; full credit is kept separately", () => {
  const plan = planAlbumArtistTags({
    creditNames: ["Afrojack", "Eva Simons"],
    creditMbids: [AFROJACK, EVA],
    ownerMbid: AFROJACK,
    ownerName: "AFROJACK",
    fullCredit: false,
    fallbackName: "Unknown Artist",
  });
  assert.equal(plan.albumArtist, "AFROJACK");
  assert.deepEqual(plan.albumArtistMbids, [AFROJACK]);
  assert.deepEqual(plan.creditNames, ["Afrojack", "Eva Simons"]);
  assert.deepEqual(plan.creditMbids, [AFROJACK, EVA]);
});

test("album artist uses the owner even when the owner is not credited first", () => {
  const plan = planAlbumArtistTags({
    creditNames: ["Eva Simons", "Afrojack"],
    creditMbids: [EVA, AFROJACK],
    ownerMbid: AFROJACK,
    ownerName: "AFROJACK",
    fullCredit: false,
    fallbackName: "x",
  });
  assert.equal(plan.albumArtist, "AFROJACK");
  assert.deepEqual(plan.albumArtistMbids, [AFROJACK]);
});

test("album artist falls back to the first credit when the owner is unknown", () => {
  const plan = planAlbumArtistTags({
    creditNames: ["Eva Simons", "Afrojack"],
    creditMbids: [EVA, AFROJACK],
    ownerMbid: null,
    ownerName: null,
    fullCredit: false,
    fallbackName: "x",
  });
  assert.equal(plan.albumArtist, "Eva Simons");
  assert.deepEqual(plan.albumArtistMbids, [EVA]);
});

test("full-credit setting writes every credited artist and all MBIDs", () => {
  const plan = planAlbumArtistTags({
    creditNames: ["Afrojack", "Eva Simons", "eva simons"],
    creditMbids: [AFROJACK, EVA],
    ownerMbid: AFROJACK,
    ownerName: "AFROJACK",
    fullCredit: true,
    fallbackName: "x",
  });
  assert.equal(plan.albumArtist, "Afrojack, Eva Simons");
  assert.deepEqual(plan.albumArtistMbids, [AFROJACK, EVA]);
});

test("artist names are de-duplicated case-insensitively keeping the first spelling", () => {
  assert.deepEqual(dedupeNames(["Sharon Den Adel", "Sharon den Adel", " ", "Armin van Buuren"]), ["Sharon Den Adel", "Armin van Buuren"]);
});

test("track artist credit keeps MusicBrainz join phrases", () => {
  const data = JSON.stringify([
    { id: "1", name: "Armin van Buuren", join_phrase: " feat. " },
    { id: "2", name: "Sharon den Adel", join_phrase: "" },
  ]);
  assert.equal(parseArtistCreditString(data), "Armin van Buuren feat. Sharon den Adel");
  assert.equal(parseArtistCreditString(JSON.stringify([{ id: "1", name: "A" }])), null);
  assert.equal(parseArtistCreditString("not json"), null);
});

test("multi-value tags compare per value, in order, and keep names containing slashes", () => {
  assert.deepEqual(splitMultiValue("AC/DC; Brian Johnson"), ["AC/DC", "Brian Johnson"]);
  assert.equal(isTagValueEqual("artists", "A; B", "A;B"), true);
  assert.equal(isTagValueEqual("artists", "A", "A; B"), false);
  assert.equal(isTagValueEqual("album_artists", "B; A", "A; B"), false);
  assert.equal(isTagValueEqual("album_artist_mbids", `${EVA.toUpperCase()}; ${AFROJACK}`, `${AFROJACK}; ${EVA}`), true);
});

test("a full-credit album artist on disk differs from the primary-only target", () => {
  assert.equal(isTagValueEqual("album_artist", "Afrojack, Eva Simons", "AFROJACK"), false);
  assert.equal(isTagValueEqual("musicbrainz_albumartistid", `${AFROJACK}; ${EVA}`, AFROJACK), false);
});
