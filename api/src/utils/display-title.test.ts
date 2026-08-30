import assert from "node:assert/strict";
import test from "node:test";
import { formatTrackDisplayTitle } from "./display-title.js";

test("track display titles preserve and append the strongest available qualifier", () => {
  assert.equal(formatTrackDisplayTitle("Bye Bye (commentary)", "commentary", null), "Bye Bye (commentary)");
  assert.equal(formatTrackDisplayTitle("Bye Bye", "commentary", null), "Bye Bye (commentary)");
  assert.equal(formatTrackDisplayTitle("Bye Bye", null, "commentary"), "Bye Bye (commentary)");
  assert.equal(formatTrackDisplayTitle("Bye Bye", "commentary", "radio edit"), "Bye Bye (commentary)");
});
