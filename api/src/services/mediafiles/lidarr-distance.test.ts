import assert from "node:assert/strict";
import test from "node:test";
import { cleanTrackTitle } from "./lidarr-distance.js";

test("track titles drop feat. credits and edition text like Lidarr's CleanTrackTitle", () => {
  assert.equal(cleanTrackTitle("Bad Blood (feat. Kendrick Lamar)"), "Bad Blood");
  assert.equal(cleanTrackTitle("Song ft. Someone"), "Song");
  assert.equal(cleanTrackTitle("Song featuring X"), "Song");
  assert.equal(cleanTrackTitle("Style (Remastered)"), "Style");
  assert.equal(cleanTrackTitle("Wildest Dreams"), "Wildest Dreams");
  assert.equal(cleanTrackTitle("Left Field"), "Left Field");
});
