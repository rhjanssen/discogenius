import assert from "node:assert/strict";
import test from "node:test";
import { cleanPathLabel, extractNamingMbid } from "./import-discovery.js";

test("extractNamingMbid reads Discogenius folder tokens", () => {
  assert.equal(
    extractNamingMbid("Bad Blood (2012) {mbid-5bca186e-3dfb-4191-a3b1-8876d454c53c}"),
    "5bca186e-3dfb-4191-a3b1-8876d454c53c",
  );
  assert.equal(extractNamingMbid("Bad Blood (2012)"), null);
});

test("cleanPathLabel strips naming MBIDs from folder-derived artist names", () => {
  assert.equal(
    cleanPathLabel("Bastille {mbid-7808accb-6395-4b25-858c-678bbb73896b}"),
    "Bastille",
  );
});
