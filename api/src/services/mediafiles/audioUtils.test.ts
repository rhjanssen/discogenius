import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
    buildMetadataWriteArgs,
    embedAudioCover,
    embedVideoThumbnail,
    getMetadataRewriteContainerArgs,
    getVideoThumbnailProbeArgs,
    hasEmbeddedVideoThumbnail,
    requiresBrowserCompatibleAudioStream,
    writeMetadata,
} from "./audioUtils.js";

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

test("metadata rewrites preserve all streams, including attached video thumbnails", () => {
    const args = buildMetadataWriteArgs(
        "/videos/video.mp4",
        { title: "Canonical title" },
        [],
        "/videos/video.tmp.mp4",
    );
    const mapIndex = args.indexOf("-map");
    assert.notEqual(mapIndex, -1);
    assert.equal(args[mapIndex + 1], "0");
});

test("video thumbnail probing requests the attached_pic disposition", () => {
    assert.deepEqual(getVideoThumbnailProbeArgs("/videos/video.mp4"), [
        "-v", "error",
        "-select_streams", "v",
        "-show_entries", "stream_disposition=attached_pic",
        "-of", "json",
        "/videos/video.mp4",
    ]);
});

test("an embedded MP4 thumbnail survives the post-import metadata rewrite", {
    skip: spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status !== 0
        || spawnSync("python", ["-c", "import mutagen"], { windowsHide: true }).status !== 0,
}, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-video-thumbnail-"));
    const videoPath = path.join(tempDir, "sample.mp4");
    const thumbnailPath = path.join(tempDir, "thumbnail.jpg");

    try {
        const video = spawnSync("ffmpeg", [
            "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=24",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
            "-t", "1", "-c:v", "mpeg4", "-q:v", "5", "-c:a", "aac", "-shortest",
            videoPath,
        ], { windowsHide: true, encoding: "utf-8" });
        assert.equal(video.status, 0, video.stderr);

        const thumbnail = spawnSync("ffmpeg", [
            "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "color=c=red:s=600x600",
            "-frames:v", "1", thumbnailPath,
        ], { windowsHide: true, encoding: "utf-8" });
        assert.equal(thumbnail.status, 0, thumbnail.stderr);

        assert.equal(await embedVideoThumbnail(videoPath, thumbnailPath), true);
        assert.equal(await hasEmbeddedVideoThumbnail(videoPath), true);
        assert.equal(await writeMetadata(videoPath, {
            title: "Thumbnail round-trip",
            track: "2/9",
            disc: "1/2",
            "----:com.apple.iTunes:MusicBrainz Track Id": "video-recording-mbid",
            "----:com.apple.iTunes:PROVIDER": "apple-music",
        }), true);
        const afterProbe = spawnSync("ffprobe", [
            "-v", "error", "-show_entries", "stream=index,codec_name,codec_type:stream_disposition=attached_pic",
            "-of", "json", videoPath,
        ], { windowsHide: true, encoding: "utf-8" });
        assert.equal(await hasEmbeddedVideoThumbnail(videoPath), true, afterProbe.stdout || afterProbe.stderr);
        const tagProbe = spawnSync("python", [
            "-c",
            "from mutagen.mp4 import MP4; import sys; t=MP4(sys.argv[1]).tags; print(t['----:com.apple.iTunes:MusicBrainz Track Id'][0].decode()); print(t['----:com.apple.iTunes:PROVIDER'][0].decode()); print(t['trkn'][0]); print(t['disk'][0])",
            videoPath,
        ], { windowsHide: true, encoding: "utf-8" });
        assert.equal(tagProbe.status, 0, tagProbe.stderr);
        assert.deepEqual(tagProbe.stdout.trim().split(/\r?\n/), [
            "video-recording-mbid",
            "apple-music",
            "(2, 9)",
            "(1, 2)",
        ]);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("audio cover replacement preserves M4A MusicBrainz metadata", {
    skip: spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status !== 0
        || spawnSync("python", ["-c", "import mutagen"], { windowsHide: true }).status !== 0,
}, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-audio-cover-"));
    const audioPath = path.join(tempDir, "sample.m4a");
    const coverPath = path.join(tempDir, "cover.jpg");

    try {
        const audio = spawnSync("ffmpeg", [
            "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
            "-t", "1", "-c:a", "aac",
            "-metadata", "MUSICBRAINZ_TRACKID=recording-mbid",
            "-movflags", "use_metadata_tags", "-f", "mp4", audioPath,
        ], { windowsHide: true, encoding: "utf-8" });
        assert.equal(audio.status, 0, audio.stderr);
        const cover = spawnSync("ffmpeg", [
            "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "color=c=green:s=600x600",
            "-frames:v", "1", coverPath,
        ], { windowsHide: true, encoding: "utf-8" });
        assert.equal(cover.status, 0, cover.stderr);

        assert.equal(await embedAudioCover(audioPath, coverPath), true);
        const probe = spawnSync("ffprobe", [
            "-v", "error",
            "-show_entries", "stream=codec_type:stream_disposition=attached_pic",
            "-show_entries", "format_tags=MUSICBRAINZ_TRACKID",
            "-of", "json", audioPath,
        ], { windowsHide: true, encoding: "utf-8" });
        assert.equal(probe.status, 0, probe.stderr);
        const data = JSON.parse(probe.stdout);
        assert.equal(data.format?.tags?.MUSICBRAINZ_TRACKID, "recording-mbid");
        assert.equal(data.streams?.some((stream: any) => stream?.disposition?.attached_pic === 1), true);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
