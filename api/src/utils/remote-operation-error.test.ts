/**
 * The next import must name the dependency that failed.
 *
 * The 500-artist run recorded only `Request failed with status code 503`, which
 * is consistent with the artwork service, a provider API and the metadata
 * server alike — so diagnosing it meant guessing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  asRemoteOperationError,
  isTransientHttpStatus,
  RemoteOperationError,
  withRemoteContext,
} from "./remote-operation-error.js";

test("a failure names the phase, the service and what it did", () => {
  const error = new RemoteOperationError({
    phase: "album-artwork", service: "cover-art-archive",
    host: "coverartarchive.org", status: 503, retryable: true,
  });
  assert.equal(error.message, "Album artwork: cover-art-archive returned HTTP 503");
  assert.equal(error.retryable, true);
  assert.equal(error.context.host, "coverartarchive.org");
});

test("detail is kept but never replaces the identification", () => {
  const error = new RemoteOperationError(
    { phase: "canonical.artist", service: "servarr-metadata", status: 500 },
    "/v0.4/artist/abc Internal Server Error",
  );
  assert.equal(
    error.message,
    "Artist metadata: servarr-metadata returned HTTP 500 (/v0.4/artist/abc Internal Server Error)",
  );
});

test("a failure with no status still says what broke", () => {
  const error = asRemoteOperationError(new Error("socket hang up"), {
    phase: "provider.album", service: "tidal", provider: "tidal",
  });
  assert.equal(error.message, "Provider album lookup: tidal socket hang up");
});

test("the innermost context wins", () => {
  // A caller that re-wraps would bury the specific phase behind a vaguer one.
  const inner = new RemoteOperationError({
    phase: "album-artwork", service: "cover-art-archive", status: 503,
  });
  const outer = asRemoteOperationError(inner, {
    phase: "canonical.release-groups", service: "servarr-metadata",
  });
  assert.equal(outer, inner);
});

test("withRemoteContext tags a throwing operation and passes results through", async () => {
  const context = { phase: "biography", service: "provider-x" } as const;
  assert.equal(await withRemoteContext(context, async () => 42), 42);
  await assert.rejects(
    () => withRemoteContext(context, async () => { throw new Error("timeout"); }),
    (error: unknown) => {
      assert.ok(error instanceof RemoteOperationError);
      assert.equal(error.message, "Artist biography: provider-x timeout");
      assert.equal(error.context.phase, "biography");
      return true;
    },
  );
});

test("transient means transient, not merely unsuccessful", () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isTransientHttpStatus(status), true, String(status));
  }
  for (const status of [400, 401, 403, 404, 410, 422]) {
    assert.equal(isTransientHttpStatus(status), false, String(status));
  }
});
