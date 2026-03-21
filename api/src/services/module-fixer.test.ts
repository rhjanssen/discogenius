import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeMusicBrainzSecondaryType,
  normalizeStoredModuleToCanonical,
  resolveAlbumModuleClassification,
  resolveVersionGroupModule,
} from "./module-fixer.js";

test("version-group propagation spreads secondary module buckets", () => {
  assert.equal(resolveVersionGroupModule(["LIVE"]), "LIVE");
  assert.equal(resolveVersionGroupModule(["COMPILATION"]), "COMPILATION");
  assert.equal(resolveVersionGroupModule(["REMIX"]), "REMIX");
  assert.equal(resolveVersionGroupModule(["SOUNDTRACK"]), "SOUNDTRACK");
  assert.equal(resolveVersionGroupModule(["DEMO"]), "DEMO");
  assert.equal(resolveVersionGroupModule(["APPEARS_ON"]), "APPEARS_ON");
});

test("version-group propagation keeps deterministic precedence", () => {
  assert.equal(resolveVersionGroupModule(["LIVE", "COMPILATION"]), "LIVE");
  assert.equal(resolveVersionGroupModule(["COMPILATION", "REMIX"]), "COMPILATION");
  assert.equal(resolveVersionGroupModule(["REMIX", "APPEARS_ON"]), "REMIX");
  assert.equal(resolveVersionGroupModule(["APPEARS_ON", "ALBUM"]), "APPEARS_ON");
  assert.equal(resolveVersionGroupModule(["SINGLE"]), "SINGLE");
});

test("module normalization preserves canonical values from stored classifications", () => {
  assert.equal(normalizeStoredModuleToCanonical("ARTIST_ALBUMS", "ALBUM"), "ALBUM");
  assert.equal(normalizeStoredModuleToCanonical("ARTIST_SINGLE", "SINGLE"), "SINGLE");
  assert.equal(normalizeStoredModuleToCanonical("ARTIST_APPEARS_ON", "ALBUM"), "APPEARS_ON");
  assert.equal(normalizeStoredModuleToCanonical("ARTIST_SOUNDTRACKS", "ALBUM"), "SOUNDTRACK");
  assert.equal(normalizeStoredModuleToCanonical("ARTIST_DEMOS", "ALBUM"), "DEMO");
});

test("module resolution uses page classification as authoritative source", () => {
  assert.equal(resolveAlbumModuleClassification({
    fromPage: "COMPILATION",
    groupType: "ALBUMS",
    albumType: "ALBUM",
  }), "COMPILATION");

  assert.equal(resolveAlbumModuleClassification({
    fromPage: "EPSANDSINGLES",
    groupType: "ALBUMS",
    albumType: "EP",
  }), "EP");
});

test("module resolution defaults deterministically when page bucket is absent", () => {
  assert.equal(resolveAlbumModuleClassification({
    fromPage: null,
    groupType: "COMPILATIONS",
    albumType: "ALBUM",
  }), "APPEARS_ON");

  assert.equal(resolveAlbumModuleClassification({
    fromPage: null,
    groupType: "ALBUMS",
    albumType: "SINGLE",
  }), "SINGLE");
});

test("musicbrainz secondary normalization rejects appears-on values", () => {
  assert.equal(normalizeMusicBrainzSecondaryType("live"), "live");
  assert.equal(normalizeMusicBrainzSecondaryType("dj-mix"), "dj-mix");
  assert.equal(normalizeMusicBrainzSecondaryType("soundtrack"), "soundtrack");
  assert.equal(normalizeMusicBrainzSecondaryType("demo"), "demo");
  assert.equal(normalizeMusicBrainzSecondaryType("appears_on"), null);
  assert.equal(normalizeMusicBrainzSecondaryType("appears on"), null);
  assert.equal(normalizeMusicBrainzSecondaryType("artist_appears_on"), null);
});

