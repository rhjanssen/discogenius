import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRefreshArtistJobPayload } from "./artist-workflow.js";

test("credited artist metadata refreshes can disable recursive credit expansion", () => {
  const payload = buildRefreshArtistJobPayload({
    artistId: "artist-mbid",
    artistName: "Collaborator",
    workflow: "metadata-refresh",
    forceUpdate: true,
    expandCreditedArtists: false,
  });

  assert.equal(payload.hydrateCatalog, true);
  assert.equal(payload.expandCreditedArtists, false);
});
