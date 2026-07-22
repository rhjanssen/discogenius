import { test } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-tiddl-backend-test-"));
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const {
    parseTiddlProgressEvent,
    tiddlProgressEventToDownloadProgress,
    looksLikeTiddlTraceChrome,
    looksLikeTiddlExceptionLine,
    extractTiddlErrorDetail,
} = await import("./tiddl-backend.js");

test("parseTiddlProgressEvent extracts wrapper JSON after noisy stderr text", () => {
    const event = parseTiddlProgressEvent(
        'ffmpeg noise DISCOGENIUS_TIDDL_PROGRESS {"event":"track_progress","title":"Laura Palmer","providerTrackId":12345,"trackNumber":7,"volumeNumber":1,"bytesDownloaded":1024,"bytesTotal":2048,"bytesPerSecond":2048,"percent":50}',
    );

    assert.ok(event);
    assert.equal(event.event, "track_progress");
    assert.equal(event.title, "Laura Palmer");
    assert.equal(event.providerTrackId, 12345);
    assert.equal(event.trackNumber, 7);
    assert.equal(event.volumeNumber, 1);
    assert.equal(event.percent, 50);
});

test("tiddlProgressEventToDownloadProgress preserves provider track identity", () => {
    const progress = tiddlProgressEventToDownloadProgress({
        event: "track_progress",
        title: "Laura Palmer",
        providerTrackId: 12345,
        trackNumber: 7,
        volumeNumber: 1,
        bytesDownloaded: 1024,
        bytesTotal: 2048,
        bytesPerSecond: 2048,
        percent: 50,
    }, 33);

    assert.ok(progress);
    assert.equal(progress.progress, 33);
    assert.equal(progress.currentTrack, "Laura Palmer");
    assert.equal(progress.currentProviderTrackId, "12345");
    assert.equal(progress.currentTrackNum, 7);
    assert.equal(progress.currentVolumeNum, 1);
    assert.equal(progress.trackProgress, 50);
    assert.equal(progress.trackStatus, "downloading");
    assert.equal(progress.statusMessage, "Downloading Laura Palmer");
    assert.equal(progress.size, 2048);
    assert.equal(progress.sizeleft, 1024);
    assert.equal(progress.speed, "2.0 KB/s");
});

test("tiddlProgressEventToDownloadProgress maps item-result skips without losing identity", () => {
    const progress = tiddlProgressEventToDownloadProgress({
        event: "track_done",
        title: "Pompeii",
        providerTrackId: "67890",
        trackStatus: "skipped",
        percent: 100,
    }, 80);

    assert.ok(progress);
    assert.equal(progress.currentProviderTrackId, "67890");
    assert.equal(progress.trackProgress, 100);
    assert.equal(progress.trackStatus, "skipped");
    assert.equal(progress.statusMessage, "Skipped Pompeii");
});

test("looksLikeTiddlTraceChrome rejects Rich box headers and borders", () => {
    assert.equal(looksLikeTiddlTraceChrome("╭──────────────── Traceback (most recent call last) ─────────────────╮"), true);
    assert.equal(looksLikeTiddlTraceChrome("╰────────────────────────────────────────────────────────────────────╯"), true);
    assert.equal(looksLikeTiddlTraceChrome("│"), true);
    assert.equal(looksLikeTiddlTraceChrome("Traceback (most recent call last):"), true);
    assert.equal(looksLikeTiddlTraceChrome("AttributeError: 'NoneType' object is not iterable"), false);
    assert.equal(looksLikeTiddlExceptionLine("AttributeError: 'NoneType' object is not iterable"), true);
    assert.equal(looksLikeTiddlExceptionLine("Error: 'NoneType' object is not iterable (video/93036258)"), true);
    assert.equal(looksLikeTiddlExceptionLine("╭── Traceback ──╮"), false);
});

test("extractTiddlErrorDetail prefers first real exception over Rich chrome", () => {
    const detail = extractTiddlErrorDetail([
        "╭──────────────── Traceback (most recent call last) ─────────────────╮",
        "│ /opt/tiddl-venv/lib/python3.13/site-packages/tiddl/core/metadata/video.py:12 in add_video_metadata │",
        "╰────────────────────────────────────────────────────────────────────╯",
        "AttributeError: 'NoneType' object is not iterable",
    ]);
    assert.equal(detail, "AttributeError: 'NoneType' object is not iterable");
});

test("extractTiddlErrorDetail falls back to last useful stderr lines when no exception", () => {
    const detail = extractTiddlErrorDetail([
        "╭── Traceback ──╮",
        "loading config",
        "auth ok",
        "starting download",
        "connection reset by peer",
    ]);
    assert.match(detail, /connection reset by peer/);
    assert.doesNotMatch(detail, /╭/);
});