import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareVideoAlbumAssociations,
  videoAlbumAssociationKind,
  videoAlbumAssociationKindRank,
} from "./video-album-association.js";

test("album association kind ranks studio before compilation before live", () => {
  assert.equal(videoAlbumAssociationKindRank("Album", "[]"), 0);
  assert.equal(videoAlbumAssociationKindRank("Album", '["Compilation"]'), 2);
  assert.equal(videoAlbumAssociationKindRank("Album", '["Compilation","Live"]'), 3);
  assert.equal(videoAlbumAssociationKindRank("EP", null), 0);
  assert.equal(videoAlbumAssociationKind("Album", '["Live"]'), "live");
  assert.equal(videoAlbumAssociationKind("Album", '["Compilation"]'), "compilation");
  assert.equal(videoAlbumAssociationKind("Album", "[]"), "studio");
});

test("preferred ranking: studio beats larger monitored compilation", () => {
  const studio = { kindRank: 0, wanted: false, trackCount: 12, title: "Back to Black" };
  const compilation = { kindRank: 2, wanted: true, trackCount: 52, title: "At the BBC" };
  assert.ok(compareVideoAlbumAssociations(studio, compilation) < 0);
});

test("preferred ranking: among monitored studios prefer largest", () => {
  const small = { kindRank: 0, wanted: true, trackCount: 3, title: "Single" };
  const large = { kindRank: 0, wanted: true, trackCount: 12, title: "Album" };
  assert.ok(compareVideoAlbumAssociations(large, small) < 0);
});

test("preferred ranking: larger compilation does not beat smaller studio", () => {
  const studio = { kindRank: 0, wanted: true, trackCount: 11, title: "Studio" };
  const compilation = { kindRank: 2, wanted: true, trackCount: 40, title: "Hits" };
  assert.ok(compareVideoAlbumAssociations(studio, compilation) < 0);
});
