import assert from "node:assert/strict";
import { test } from "node:test";
import { deezerGwErrorMessage } from "./deezer-gw-api.js";

test("Deezer gw-light empty error envelopes are treated as success", () => {
  assert.equal(deezerGwErrorMessage([]), null);
  assert.equal(deezerGwErrorMessage({}), null);
  assert.equal(deezerGwErrorMessage(null), null);
  assert.equal(deezerGwErrorMessage(undefined), null);
});

test("Deezer gw-light non-empty error payloads produce a message", () => {
  assert.equal(deezerGwErrorMessage({ REQUEST_ERROR: "Invalid CSRF token" }), "Invalid CSRF token");
  assert.equal(deezerGwErrorMessage(["boom"]), "boom");
});
