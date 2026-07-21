import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveCatalogFileProgress } from "./download-processor.js";

test("deriveCatalogFileProgress uses catalog length, not provider queue size", () => {
  const tracks = [
    { status: "completed" },
    { status: "downloading" },
    { status: "queued" },
    { status: "queued" },
  ];
  assert.deepEqual(deriveCatalogFileProgress(tracks), {
    totalFiles: 4,
    currentFileNum: 2,
    completed: 1,
  });
});

test("deriveCatalogFileProgress points at next queued row", () => {
  const tracks = [
    { status: "skipped" },
    { status: "completed" },
    { status: "queued" },
  ];
  assert.deepEqual(deriveCatalogFileProgress(tracks), {
    totalFiles: 3,
    currentFileNum: 3,
    completed: 2,
  });
});

test("deriveCatalogFileProgress returns null without tracks", () => {
  assert.equal(deriveCatalogFileProgress([]), null);
  assert.equal(deriveCatalogFileProgress(null), null);
});
