import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProviderFilenameToken } from "./path-utils.js";

test("parseProviderFilenameToken reads Discogenius {PROVIDER-id} filename tokens", () => {
  assert.deepEqual(
    parseProviderFilenameToken("Flaws (live at Abbey Road)-video {TIDAL-25701976}"),
    { provider: "tidal", providerId: "25701976" },
  );
  assert.deepEqual(
    parseProviderFilenameToken("Pompeii-live {TIDAL-93155190}"),
    { provider: "tidal", providerId: "93155190" },
  );
  assert.equal(parseProviderFilenameToken("01 - Living-video"), null);
  assert.equal(parseProviderFilenameToken("101 - Pompeii MMXXIII"), null);
});
