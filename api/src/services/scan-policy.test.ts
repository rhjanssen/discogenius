import assert from "node:assert/strict";
import test from "node:test";

import { shouldHydrateArtistAlbumTracks, shouldHydrateArtistCatalog } from "./scan-policy.js";

test("artist metadata refresh skips inline track hydration when hydrateAlbumTracks is false", () => {
  assert.equal(shouldHydrateArtistAlbumTracks({ hydrateAlbumTracks: false }), false);
  assert.equal(shouldHydrateArtistAlbumTracks({ hydrateAlbumTracks: true }), true);
  assert.equal(shouldHydrateArtistAlbumTracks({ monitorAlbums: false }), false);
  assert.equal(shouldHydrateArtistAlbumTracks({}), true);
});

test("artist metadata refresh can hydrate catalog without forcing album track hydration", () => {
  assert.equal(shouldHydrateArtistCatalog({ hydrateCatalog: true, hydrateAlbumTracks: false }, { hasManagedMetadata: true }), true);
  assert.equal(shouldHydrateArtistAlbumTracks({ hydrateCatalog: true, hydrateAlbumTracks: false }), false);
});

test("artist metadata refresh skips broad catalog hydration once managed metadata exists only when explicitly disabled", () => {
  assert.equal(shouldHydrateArtistCatalog({ hydrateCatalog: false }, { hasManagedMetadata: true }), false);
  assert.equal(shouldHydrateArtistCatalog({ hydrateCatalog: false }, { hasManagedMetadata: false }), true);
  assert.equal(shouldHydrateArtistCatalog({ hydrateCatalog: true }, { hasManagedMetadata: true }), true);
  assert.equal(shouldHydrateArtistCatalog({ monitorAlbums: false }, { hasManagedMetadata: true }), false);
  assert.equal(shouldHydrateArtistCatalog({}, { hasManagedMetadata: true }), true);
});
