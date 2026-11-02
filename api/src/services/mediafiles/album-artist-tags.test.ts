import assert from "node:assert/strict";
import test from "node:test";

import { resolveAlbumArtistMode } from "./album-artist-mode.js";
import {
  dedupeNames,
  isTagValueEqual,
  joinSortCredit,
  VARIOUS_ARTISTS_MBID,
  parseArtistCreditString,
  planAlbumArtistTags,
  splitMultiValue,
} from "./audio-tag-service.js";

const AFROJACK = "a3ee920f-4e7f-4993-8aca-4b8538cfaa4a";
const EVA = "481cbdd9-02ac-46fd-825f-afed658bc505";

test("album artist defaults to the owning artist with a single MBID; full credit is kept separately", () => {
  const plan = planAlbumArtistTags({
    creditNames: ["Afrojack", "Eva Simons"],
    artistNames: ["AFROJACK", "Eva Simons"],
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
    artistNames: ["Eva Simons", "AFROJACK"],
    creditMbids: [EVA, AFROJACK],
    ownerMbid: AFROJACK,
    ownerName: "AFROJACK",
    fullCredit: false,
    fallbackName: "x",
  });
  assert.equal(plan.albumArtist, "AFROJACK");
  assert.deepEqual(plan.albumArtistMbids, [AFROJACK]);
});

test("album artist falls back to the first artist's name, not the credited-as name", () => {
  const plan = planAlbumArtistTags({
    creditNames: ["The Eva Simons", "Afrojack"],
    artistNames: ["Eva Simons", "Afrojack"],
    creditMbids: [EVA, AFROJACK],
    ownerMbid: null,
    ownerName: null,
    fullCredit: false,
    fallbackName: "x",
  });
  assert.equal(plan.albumArtist, "Eva Simons");
  assert.deepEqual(plan.creditNames, ["The Eva Simons", "Afrojack"]);
  assert.deepEqual(plan.albumArtistMbids, [EVA]);
});

test("full-credit setting writes every credited artist and all MBIDs", () => {
  const plan = planAlbumArtistTags({
    creditNames: ["Afrojack", "Eva Simons", "eva simons"],
    artistNames: ["AFROJACK", "Eva Simons"],
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

test("default album artist is the MusicBrainz artist name when the credit differs", () => {
  const golden = "3cce09c5-5c6e-4f6a-a176-5a9d0b0a0a01";
  const plan = planAlbumArtistTags({
    creditNames: ["The Golden Earrings"],
    artistNames: ["Golden Earring"],
    creditMbids: [golden],
    ownerMbid: golden,
    ownerName: "Golden Earring",
    fullCredit: false,
    fallbackName: "The Golden Earrings",
  });
  assert.equal(plan.albumArtist, "Golden Earring");
  assert.deepEqual(plan.albumArtistMbids, [golden]);
  assert.deepEqual(plan.creditNames, ["The Golden Earrings"]);
  const full = planAlbumArtistTags({
    creditNames: ["The Golden Earrings"],
    artistNames: ["Golden Earring"],
    creditMbids: [golden],
    ownerMbid: golden,
    ownerName: "Golden Earring",
    fullCredit: true,
    fallbackName: "x",
  });
  assert.equal(full.albumArtist, "The Golden Earrings");
});

test("Picard mode prints MusicBrainz join phrases; Plex mode keeps one artist", () => {
  const shared = {
    creditNames: ["A", "B"],
    artistNames: ["A", "B"],
    creditMbids: [AFROJACK, EVA],
    joinPhrases: [" & ", ""],
    sortNames: ["A, Sort", "B, Sort"],
    ownerMbid: AFROJACK,
    ownerName: "A",
    fallbackName: "x",
  };
  const picard = planAlbumArtistTags({ ...shared, mode: "picard" });
  assert.equal(picard.albumArtist, "A & B");
  assert.equal(picard.albumArtistSort, "A, Sort & B, Sort");
  assert.deepEqual(picard.albumArtistMbids, [AFROJACK, EVA]);
  assert.deepEqual(picard.creditNames, ["A", "B"]);
  const plex = planAlbumArtistTags({ ...shared, mode: "plex_jellyfin" });
  assert.equal(plex.albumArtist, "A");
  assert.equal(plex.albumArtistSort, "A, Sort");
  assert.deepEqual(plex.albumArtistMbids, [AFROJACK]);
  assert.deepEqual(plex.creditNames, ["A", "B"]);
  const feat = planAlbumArtistTags({ ...shared, joinPhrases: [" feat. ", ""], mode: "picard" });
  assert.equal(feat.albumArtist, "A feat. B");
});

test("album artist mode migrates the old full-credit boolean to Picard", () => {
  assert.equal(resolveAlbumArtistMode(undefined), "plex_jellyfin");
  assert.equal(resolveAlbumArtistMode({ full_album_artist_credit: true }), "picard");
  assert.equal(resolveAlbumArtistMode({ album_artist_mode: "plex_jellyfin", full_album_artist_credit: true }), "picard");
  assert.equal(resolveAlbumArtistMode({ album_artist_mode: "picard" }), "picard");
  assert.equal(resolveAlbumArtistMode({ album_artist_mode: "plex_jellyfin" }), "plex_jellyfin");
});

test("a full-credit album artist on disk differs from the primary-only target", () => {
  assert.equal(isTagValueEqual("album_artist", "Afrojack, Eva Simons", "AFROJACK"), false);
  assert.equal(isTagValueEqual("musicbrainz_albumartistid", `${AFROJACK}; ${EVA}`, AFROJACK), false);
});

test("Various Artists releases keep 'Various Artists' as album artist and are flagged as compilation", () => {
  const plan = planAlbumArtistTags({
    creditNames: ["VA"],
    artistNames: ["Various Artists"],
    creditMbids: [VARIOUS_ARTISTS_MBID],
    ownerMbid: AFROJACK,
    ownerName: "AFROJACK",
    fullCredit: false,
    fallbackName: "x",
  });
  assert.equal(plan.albumArtist, "Various Artists");
  assert.deepEqual(plan.creditNames, ["VA"]);
  assert.deepEqual(plan.albumArtistMbids, [VARIOUS_ARTISTS_MBID]);
  assert.equal(plan.compilation, true);
  assert.equal(planAlbumArtistTags({
    creditNames: ["The A"],
    artistNames: ["A"],
    creditMbids: [AFROJACK],
    ownerMbid: AFROJACK,
    ownerName: "A",
    fullCredit: false,
    fallbackName: "x",
  }).compilation, false);
});

test("sort credit follows MusicBrainz join phrases when credits line up", () => {
  const data = JSON.stringify([{ id: "1", name: "Armin van Buuren", join_phrase: " feat. " }, { id: "2", name: "Sharon den Adel", join_phrase: "" }]);
  assert.equal(joinSortCredit(data, ["Buuren, Armin van", "Adel, Sharon den"]), "Buuren, Armin van feat. Adel, Sharon den");
  assert.equal(joinSortCredit(null, ["Who, The", "Doe, John"]), "Who, The, Doe, John");
});

test("label and catalog number compare as ordered multi-value fields", () => {
  assert.equal(isTagValueEqual("label", "Island; Virgin", "Island; Virgin"), true);
  assert.equal(isTagValueEqual("label", "Virgin; Island", "Island; Virgin"), false);
  assert.equal(isTagValueEqual("label", "Island/Def Jam", "Island; Def Jam"), false);
  assert.equal(isTagValueEqual("catalog_number", "ABC-1; ABC-2", "ABC-1; ABC-2"), true);
});

test("genre and release type compare as sets; compilation flags compare by truthiness", () => {
  assert.equal(isTagValueEqual("genre", "Rock, Pop", "Pop; Rock"), true);
  assert.equal(isTagValueEqual("compilation", "true", "1"), true);
  assert.equal(isTagValueEqual("compilation", null, "1"), false);
});
