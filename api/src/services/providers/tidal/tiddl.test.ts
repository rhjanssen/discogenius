import { test } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-tiddl-test-"));
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const {
    mapAudioQualityToTiddl,
    mapVideoQualityToTiddl,
    nativeTiddlTrackQuality,
    syncTokenToTiddl,
    readTiddlAuth,
    clearTiddlAuth,
    buildTiddlEnv,
    TIDDL_CONFIG_DIR,
} = await import("./tiddl.js");

test("mapAudioQualityToTiddl maps provider quality tags to tiddl tiers", () => {
    assert.equal(mapAudioQualityToTiddl("LOW"), "low");
    assert.equal(mapAudioQualityToTiddl("HIGH"), "normal");
    assert.equal(mapAudioQualityToTiddl("LOSSLESS"), "high");
    assert.equal(mapAudioQualityToTiddl("HIRES_LOSSLESS"), "max");
    assert.equal(mapAudioQualityToTiddl("HI_RES_LOSSLESS"), "max");
    assert.equal(mapAudioQualityToTiddl("MQA"), "max");
    assert.equal(mapAudioQualityToTiddl("DOLBY_ATMOS"), "max");
    assert.equal(mapAudioQualityToTiddl("Sony 360"), "max");
});

test("mapAudioQualityToTiddl passes through unambiguous tiddl-native values", () => {
    assert.equal(mapAudioQualityToTiddl("low"), "low");
    assert.equal(mapAudioQualityToTiddl("normal"), "normal");
    assert.equal(mapAudioQualityToTiddl("max"), "max");
});

test("nativeTiddlTrackQuality keeps config values verbatim (tiddl 'high' is FLAC, not TIDAL's AAC tier)", () => {
    assert.equal(nativeTiddlTrackQuality("high"), "high");
    assert.equal(nativeTiddlTrackQuality("max"), "max");
    assert.equal(nativeTiddlTrackQuality("LOSSLESS"), null);
    assert.equal(nativeTiddlTrackQuality(undefined), null);
});

test("mapAudioQualityToTiddl falls back to configured audio quality", () => {
    const fallback = mapAudioQualityToTiddl(null);
    assert.ok(["low", "normal", "high", "max"].includes(fallback));
});

test("mapVideoQualityToTiddl accepts native values and falls back to config", () => {
    assert.equal(mapVideoQualityToTiddl("sd"), "sd");
    assert.equal(mapVideoQualityToTiddl("hd"), "hd");
    assert.equal(mapVideoQualityToTiddl("fhd"), "fhd");
    assert.ok(["sd", "hd", "fhd"].includes(mapVideoQualityToTiddl("1080p")));
});

test("syncTokenToTiddl writes the exact auth.json shape tiddl expects", () => {
    syncTokenToTiddl({
        access_token: "access-123",
        refresh_token: "refresh-456",
        expires_at: 1_900_000_000,
        user: { userId: 172571215, countryCode: "NL" },
    });

    const auth = readTiddlAuth();
    assert.ok(auth);
    assert.deepEqual(auth, {
        token: "access-123",
        refresh_token: "refresh-456",
        expires_at: 1_900_000_000,
        user_id: "172571215",
        country_code: "NL",
    });

    clearTiddlAuth();
    assert.equal(readTiddlAuth(), null);
});

test("buildTiddlEnv pins TIDDL_PATH and client credentials", () => {
    const env = buildTiddlEnv();
    assert.equal(env.TIDDL_PATH, TIDDL_CONFIG_DIR);
    assert.match(String(env.TIDDL_AUTH), /^[^;]+;[^;]+$/);
});
