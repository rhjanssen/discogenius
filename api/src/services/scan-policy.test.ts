import assert from "node:assert/strict";
import test from "node:test";

import { shouldHydrateArtistAlbumTracks, shouldHydrateArtistCatalog } from "./scan-policy.js";

test("artist metadata refresh skips inline track hydration when monitorAlbums is false", () => {
  assert.equal(shouldHydrateArtistAlbumTracks({ monitorAlbums: false }), false);
  assert.equal(shouldHydrateArtistAlbumTracks({ monitorAlbums: true }), true);
  assert.equal(shouldHydrateArtistAlbumTracks({}), true);
});

test("artist metadata refresh skips broad catalog hydration once managed metadata exists", () => {
  assert.equal(shouldHydrateArtistCatalog({ monitorAlbums: false }, { hasManagedMetadata: true }), false);
  assert.equal(shouldHydrateArtistCatalog({ monitorAlbums: false }, { hasManagedMetadata: false }), true);
  assert.equal(shouldHydrateArtistCatalog({ monitorAlbums: true }, { hasManagedMetadata: true }), true);
  assert.equal(shouldHydrateArtistCatalog({}, { hasManagedMetadata: true }), true);
});
