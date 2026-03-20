import assert from "node:assert/strict";
import test from "node:test";

import { shouldHydrateArtistAlbumTracks } from "./scan-policy.js";

test("artist metadata refresh skips inline track hydration when monitorAlbums is false", () => {
  assert.equal(shouldHydrateArtistAlbumTracks({ monitorAlbums: false }), false);
  assert.equal(shouldHydrateArtistAlbumTracks({ monitorAlbums: true }), true);
  assert.equal(shouldHydrateArtistAlbumTracks({}), true);
});
