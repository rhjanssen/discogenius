import assert from "node:assert/strict";
import { test } from "node:test";
import { assertTidalTrackAvailable, tidalTrackAvailability } from "./tidal-availability.js";
import { ProviderUnavailableError } from "../../download/provider-unavailable-error.js";

test("TIDAL stream restrictions override a positive listing flag", () => {
    assert.equal(tidalTrackAvailability({ streamReady: true, allowStreaming: false }), "unavailable");
    assert.equal(tidalTrackAvailability({ streamReady: false }), "unavailable");
    assert.equal(tidalTrackAvailability({ streamReady: true }), "available");
    assert.equal(tidalTrackAvailability({}), "unknown");
});

test("TIDAL preflight identifies a removed track before invoking the downloader", async () => {
    await assert.rejects(assertTidalTrackAvailable("37206273", async () => {
        throw Object.assign(new Error("Track not found"), { status: 404 });
    }), (error: unknown) => error instanceof ProviderUnavailableError
        && error.providerId === "37206273" && error.entityType === "track");
    await assert.rejects(assertTidalTrackAvailable("1", async () => ({ allowStreaming: false })), ProviderUnavailableError);
});

test("TIDAL preflight preserves transient and authentication failures without declaring unavailability", async () => {
    for (const status of [401, 403, 429, 500]) {
        const error = Object.assign(new Error("Provider request failed"), { status });
        await assert.rejects(assertTidalTrackAvailable("1", async () => { throw error; }), (actual: unknown) => actual === error);
    }
    await assertTidalTrackAvailable("1", async () => ({}));
});
