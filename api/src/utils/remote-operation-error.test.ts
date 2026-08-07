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
  normalizeUnclassifiedRemoteError,
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

/* ── The net under everything else ──────────────────────────────────── */

test("a bare axios message still yields a host and a status", () => {
  // The exact shape that reached command history in the 500-artist run.
  const axiosLike = {
    message: "Request failed with status code 503",
    response: { status: 503 },
    config: { method: "get", url: "https://api.example.com/v1/artist/abc?apikey=secret" },
  };
  const normalized = normalizeUnclassifiedRemoteError(axiosLike);
  assert.ok(normalized);
  assert.equal(normalized.context.status, 503);
  assert.equal(normalized.context.host, "api.example.com");
  assert.equal(normalized.context.method, "GET");
  assert.equal(normalized.retryable, true);
  assert.equal(
    normalized.message,
    "Unclassified remote request: api.example.com returned HTTP 503 (/v1/artist/abc)",
  );
});

test("a persisted message never carries a query string", () => {
  // Base URLs routinely carry an api key, and this string goes into the
  // commands table and onto the History page.
  const normalized = normalizeUnclassifiedRemoteError({
    message: "Request failed with status code 401",
    config: { url: "https://svc.example.com/lookup?apikey=hunter2&token=abc" },
  });
  assert.ok(normalized);
  assert.equal(normalized.message.includes("hunter2"), false);
  assert.equal(normalized.message.includes("apikey"), false);
  assert.equal(normalized.message.includes("?"), false);
});

test("a status alone is enough, even with no url", () => {
  const normalized = normalizeUnclassifiedRemoteError({
    message: "Request failed with status code 429",
  });
  assert.ok(normalized);
  assert.equal(normalized.context.status, 429);
  assert.equal(normalized.message, "Unclassified remote request: an unnamed host returned HTTP 429");
});

test("a local failure is left alone rather than mislabelled as remote", () => {
  assert.equal(normalizeUnclassifiedRemoteError(new Error("no such column: foo")), null);
  assert.equal(normalizeUnclassifiedRemoteError("a string"), null);
  assert.equal(normalizeUnclassifiedRemoteError(null), null);
  assert.equal(normalizeUnclassifiedRemoteError({ message: "SQLITE_BUSY" }), null);
});

test("a properly wrapped error keeps its own better provenance", () => {
  const wrapped = new RemoteOperationError({
    phase: "provider.album", service: "tidal", status: 503, retryable: true,
  });
  assert.equal(normalizeUnclassifiedRemoteError(wrapped), wrapped);
});
