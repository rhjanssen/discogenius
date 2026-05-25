import assert from "node:assert/strict";
import test from "node:test";

import { getMetadataRewriteContainerArgs, requiresBrowserCompatibleAudioStream } from "./audioUtils.js";

test("requiresBrowserCompatibleAudioStream flags spatial tracks for browser-safe transcoding", () => {
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

test("getMetadataRewriteContainerArgs uses MP4 metadata mode for MP4-family files", () => {
    assert.deepEqual(getMetadataRewriteContainerArgs("/music/track.flac"), []);
    assert.deepEqual(getMetadataRewriteContainerArgs("/music/track.m4a"), ["-movflags", "use_metadata_tags", "-f", "mp4"]);
    assert.deepEqual(getMetadataRewriteContainerArgs("/videos/video.mp4"), ["-movflags", "use_metadata_tags", "-f", "mp4"]);
});
