import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeStoredModuleToCanonical,
  resolveAlbumModuleClassification,
  resolveVersionGroupModule,
} from "./module-fixer.js";

test("version-group propagation does not spread compilation-only buckets", () => {
  assert.equal(resolveVersionGroupModule(["COMPILATION", "APPEARS_ON"]), null);
  assert.equal(resolveVersionGroupModule(["ALBUM", "COMPILATION"]), "ALBUM");
});

test("version-group propagation keeps stable release-family buckets", () => {
  assert.equal(resolveVersionGroupModule(["LIVE", "ALBUM"]), "LIVE");
  assert.equal(resolveVersionGroupModule(["REMIX", "EP"]), "REMIX");
  assert.equal(resolveVersionGroupModule(["SINGLE"]), "SINGLE");
});

test("module normalization preserves canonical values from stored classifications", () => {
  assert.equal(normalizeStoredModuleToCanonical("ARTIST_ALBUMS", "ALBUM"), "ALBUM");
  assert.equal(normalizeStoredModuleToCanonical("ARTIST_SINGLE", "SINGLE"), "SINGLE");
  assert.equal(normalizeStoredModuleToCanonical("ARTIST_APPEARS_ON", "ALBUM"), "APPEARS_ON");
});

test("module resolution keeps existing managed sections when page data is missing", () => {
  assert.equal(resolveAlbumModuleClassification({
    currentModule: "ALBUM",
    groupType: "COMPILATIONS",
    albumType: "ALBUM",
  }), "ALBUM");
  assert.equal(resolveAlbumModuleClassification({
    currentModule: "REMIX",
    groupType: "ALBUMS",
    albumType: "EP",
  }), "REMIX");
});
