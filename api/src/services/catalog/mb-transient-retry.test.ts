import assert from "node:assert/strict";
import test from "node:test";
import {
  MbHttpError,
  isTransientMbFailure,
  withBoundedMbRetry,
} from "./mb-transient-retry.js";
import { LocalMusicBrainzCatalogProvider } from "./local-musicbrainz-catalog-provider.js";

/** Never actually wait in tests; record what the backoff asked for instead. */
function recordingSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

test("a mirror that is briefly busy is survived", async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;
  const result = await withBoundedMbRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new MbHttpError("busy", 503, "/artist/x");
      return "ok";
    },
    "/artist/x",
    { sleep },
  );

  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.equal(delays.length, 2, "one delay per retry");
  assert.ok(delays[1] > delays[0], "backoff grows");
});

test("a persistent outage still fails, and says it is persistent", async () => {
  const { sleep } = recordingSleep();
  let calls = 0;
  await assert.rejects(
    withBoundedMbRetry(
      async () => {
        calls += 1;
        throw new MbHttpError(
          "MB-local API /artist/x failed: 503 Service Unavailable",
          503,
          "/artist/x",
        );
      },
      "MB-local /artist/x",
      { sleep },
    ),
    (error: Error) => {
      // The caller must still see the real status, not a softened wrapper.
      assert.match(error.message, /503 Service Unavailable/);
      assert.match(error.message, /still failing after 3 attempt\(s\)/);
      assert.equal((error as MbHttpError).status, 503);
      return true;
    },
  );
  assert.equal(calls, 3, "the attempt budget is bounded, not open-ended");
});

test("a definite answer is never retried", async () => {
  const { sleep, delays } = recordingSleep();
  for (const status of [400, 404, 410]) {
    let calls = 0;
    await assert.rejects(
      withBoundedMbRetry(
        async () => {
          calls += 1;
          throw new MbHttpError(`gone: ${status}`, status, "/artist/x");
        },
        "/artist/x",
        { sleep },
      ),
      /gone/,
    );
    assert.equal(calls, 1, `status ${status} is an answer, not a wait`);
  }
  assert.equal(delays.length, 0);
  // A 404 must not acquire the "still failing after N attempts" suffix either:
  // it failed once, and saying otherwise would misdescribe the mirror.
  await assert.rejects(
    withBoundedMbRetry(
      async () => {
        throw new MbHttpError("MB-local API /artist/x failed: 404 Not Found", 404, "/artist/x");
      },
      "/artist/x",
      { sleep },
    ),
    (error: Error) => {
      assert.doesNotMatch(error.message, /still failing after/);
      return true;
    },
  );
});

test("network-level silence counts as transient, provider errors do not", () => {
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  assert.equal(isTransientMbFailure(timeout), true);
  assert.equal(isTransientMbFailure(new Error("timeout of 10000ms exceeded")), true);
  assert.equal(isTransientMbFailure(new MbHttpError("busy", 503, "/x")), true);
  assert.equal(isTransientMbFailure(new MbHttpError("nope", 404, "/x")), false);
  assert.equal(isTransientMbFailure(new Error("Unexpected token < in JSON")), false);
});

test("retry never runs more than the budget, however long the outage", async () => {
  const { sleep, delays } = recordingSleep();
  let calls = 0;
  await assert.rejects(
    withBoundedMbRetry(
      async () => {
        calls += 1;
        throw new MbHttpError("busy", 503, "/x");
      },
      "/x",
      { sleep, attempts: 5, baseDelayMs: 100, maxDelayMs: 250 },
    ),
    /busy/,
  );
  assert.equal(calls, 5);
  assert.deepEqual(delays, [100, 200, 250, 250], "backoff is capped");
});

test("the provider retries a busy mirror through its own transport", async () => {
  const { sleep } = recordingSleep();
  let calls = 0;
  const provider = new LocalMusicBrainzCatalogProvider({
    fetcher: async <T,>(): Promise<T> => {
      calls += 1;
      if (calls < 2) throw new MbHttpError("busy", 503, "/artist/x");
      return { id: "artist-x", name: "Bastille", "release-groups": [] } as unknown as T;
    },
    retry: { sleep, onRetry: () => undefined },
  });

  const artist = await provider.getArtist("artist-x");
  assert.equal(calls, 2);
  assert.equal(artist.artistname, "Bastille");
});

test("the provider surfaces a mirror that stays down", async () => {
  const { sleep } = recordingSleep();
  let calls = 0;
  const provider = new LocalMusicBrainzCatalogProvider({
    fetcher: async <T,>(): Promise<T> => {
      calls += 1;
      throw new MbHttpError(
        "MB-local API /artist/x failed: 503 Service Unavailable",
        503,
        "/artist/x",
      );
    },
    retry: { sleep, onRetry: () => undefined },
  });

  await assert.rejects(provider.getArtist("artist-x"), /503 Service Unavailable/);
  assert.equal(calls, 3);
});
