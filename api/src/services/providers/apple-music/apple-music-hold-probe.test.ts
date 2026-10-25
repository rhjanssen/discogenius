import "./setup-test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";

import { runAppleWrapperHoldProbe } from "./apple-music-auth.js";

test("hold probe: no wrapper check while Apple is not held", async () => {
  let checks = 0;
  const result = await runAppleWrapperHoldProbe({ needsReauth: () => false, loginStatus: async () => (checks++, { status: "success", message: "" }) });
  assert.equal(result, "idle");
  assert.equal(checks, 0);
});

test("hold probe: clears the hold once the wrapper answers", async () => {
  let held = true;
  const result = await runAppleWrapperHoldProbe({
    needsReauth: () => held,
    loginStatus: async () => { held = false; return { status: "success", message: "" }; },
  });
  assert.equal(result, "cleared");
});

test("hold probe: stays held while the wrapper is down", async () => {
  const result = await runAppleWrapperHoldProbe({ needsReauth: () => true, loginStatus: async () => ({ status: "failed", message: "" }) });
  assert.equal(result, "still_held");
});
