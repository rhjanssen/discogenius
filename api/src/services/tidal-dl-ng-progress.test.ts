import assert from "node:assert/strict";
import test from "node:test";
import { parseProgress } from "./tidal-dl-ng.js";

test("parseProgress handles ANSI-decorated item progress output", () => {
  const progress = parseProgress("\u001b[34mItem 'Artist - Track Title'\u001b[0m ━━━━━━━━━━━ 42% 1.2 MiB/2.8 MiB 1.4 MiB/s");

  assert.ok(progress);
  assert.equal(progress.trackTitle, "Artist - Track Title");
  assert.equal(progress.progress, 42);
  assert.equal(progress.state, "downloading");
  assert.equal(progress.statusMessage, "Speed: 1.4 MiB/s");
});

test("parseProgress handles ANSI-decorated list progress output", () => {
  const progress = parseProgress("\u001b[32mList 'Album Name'\u001b[0m ━━━━━━━━━━━ 50% 5/10");

  assert.ok(progress);
  assert.equal(progress.listName, "Album Name");
  assert.equal(progress.progress, 50);
  assert.equal(progress.currentTrack, 5);
  assert.equal(progress.totalTracks, 10);
});

test("parseProgress handles rich-tag prefixed output", () => {
  const progress = parseProgress("[blue]Item 'Artist - Track Title'[/blue] ━━━━━━━━━━━ 100%");

  assert.ok(progress);
  assert.equal(progress.trackTitle, "Artist - Track Title");
  assert.equal(progress.progress, 100);
  assert.equal(progress.isComplete, true);
  assert.equal(progress.state, "completed");
});
