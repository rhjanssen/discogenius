import assert from "node:assert/strict";
import test from "node:test";
import { shouldDeferCatalogHydration } from "./command-ordering.js";

test("catalog hydration keeps the last worker free when operator work is queued", () => {
  assert.equal(shouldDeferCatalogHydration({
    candidateName: "RefreshArtist",
    remainingSlotsIncludingThis: 2,
    pendingNames: ["Housekeeping"],
  }), false);
  assert.equal(shouldDeferCatalogHydration({
    candidateName: "RefreshArtist",
    remainingSlotsIncludingThis: 1,
    pendingNames: ["Housekeeping", "CurateArtist"],
  }), true);
  assert.equal(shouldDeferCatalogHydration({
    candidateName: "Housekeeping",
    remainingSlotsIncludingThis: 1,
    pendingNames: ["RefreshArtist"],
  }), false);
  assert.equal(shouldDeferCatalogHydration({
    candidateName: "MatchArtistProviders",
    remainingSlotsIncludingThis: 1,
    pendingNames: ["RefreshArtist", "RefreshMetadata"],
  }), false);
});
