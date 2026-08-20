import assert from "node:assert/strict";
import test from "node:test";
import { parseScanFileFilter, shouldRematchUnmatchedFiles } from "./scan-file-filter.js";

test("Known does not rematch unmatched existing files; Matched and None do", () => {
  assert.equal(shouldRematchUnmatchedFiles("known"), false);
  assert.equal(shouldRematchUnmatchedFiles("matched"), true);
  assert.equal(shouldRematchUnmatchedFiles("none"), true);
});

test("parseScanFileFilter keeps supported values and falls back otherwise", () => {
  assert.equal(parseScanFileFilter("known", "matched"), "known");
  assert.equal(parseScanFileFilter("whenever", "known"), "known");
  assert.equal(parseScanFileFilter(undefined, "matched"), "matched");
});
