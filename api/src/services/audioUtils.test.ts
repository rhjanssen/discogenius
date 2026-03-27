import assert from "node:assert/strict";
import test from "node:test";

import { requiresBrowserCompatibleAudioStream } from "./audioUtils.js";

test("requiresBrowserCompatibleAudioStream flags Atmos tracks for browser-safe transcoding", () => {
    assert.equal(requiresBrowserCompatibleAudioStream({
        fileType: "track",
        quality: "DOLBY_ATMOS",
        codec: "eac3",
        extension: ".m4a",
    }), true);

    assert.equal(requiresBrowserCompatibleAudioStream({
        fileType: "track",
        quality: "LOSSLESS",
        codec: "ac-4",
        extension: ".m4a",
    }), true);

    assert.equal(requiresBrowserCompatibleAudioStream({
        fileType: "track",
        quality: "LOSSLESS",
        codec: "EC-3",
        extension: ".m4a",
    }), true);

    assert.equal(requiresBrowserCompatibleAudioStream({
        fileType: "track",
        quality: "LOSSLESS",
        codec: "E-AC-3 JOC",
        extension: ".m4a",
    }), true);

    assert.equal(requiresBrowserCompatibleAudioStream({
        fileType: "track",
        quality: "LOSSLESS",
        codec: "AC 4",
        extension: ".m4a",
    }), true);

    assert.equal(requiresBrowserCompatibleAudioStream({
        fileType: "track",
        quality: "HIGH",
        codec: "aac",
        extension: ".m4a",
    }), false);

    assert.equal(requiresBrowserCompatibleAudioStream({
        fileType: "video",
        quality: "DOLBY_ATMOS",
        codec: "eac3",
        extension: ".mp4",
    }), false);
});