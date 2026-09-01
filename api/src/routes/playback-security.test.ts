import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import express from "express";
import type { Server } from "node:http";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-playback-security-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.DISCOGENIUS_DISABLE_MONITORING = "1";
process.env.DISCOGENIUS_DISABLE_SCHEDULER = "1";

let closeDatabase: () => void;
let dbModule: typeof import("../database.js");
let server: Server;
let baseUrl: string;

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  closeDatabase = dbModule.closeDatabase;

  const playbackRouter = (await import("./playback.js")).default;
  const app = express();
  app.use("/api/playback", playbackRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("playback verification fails closed when the signing secret is unavailable", async () => {
  const previous = process.env.JWT_SECRET;
  try {
    delete process.env.JWT_SECRET;
    const expires = Math.floor(Date.now() / 1000) + 60;
    const response = await fetch(
      `${baseUrl}/api/playback/stream/play/track?provider=tidal&exp=${expires}&sig=${"a".repeat(64)}`,
    );
    assert.equal(response.status, 503);
  } finally {
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous;
  }
});

test("a valid HMAC cannot authorize an HLS URL that no provider playlist issued", async () => {
  const previous = process.env.JWT_SECRET;
  try {
    const secret = "known-test-secret";
    process.env.JWT_SECRET = secret;
    const provider = "tidal";
    const trackId = "track";
    const expires = Math.floor(Date.now() / 1000) + 60;
    const target = "http://127.0.0.1:3737/ping";
    const signature = crypto.createHmac("sha256", secret)
      .update(`${provider}:${trackId}::${expires}:${target}`)
      .digest("hex");
    const query = new URLSearchParams({
      provider,
      exp: String(expires),
      sig: signature,
      u: target,
    });
    const response = await fetch(
      `${baseUrl}/api/playback/stream/hls-proxy/${trackId}?${query.toString()}`,
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Unknown segment URL" });
  } finally {
    if (previous === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previous;
  }
});

test("preview signing normalizes hi-res aliases and falls back to another accepted provider match", async () => {
  const { db } = dbModule;
  const suffix = crypto.randomUUID();
  const artistMbid = crypto.randomUUID();
  const releaseGroupMbid = crypto.randomUUID();
  const releaseMbid = crypto.randomUUID();
  const recordingMbid = crypto.randomUUID();
  const trackMbid = crypto.randomUUID();
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES (?, 'Preview Artist') RETURNING id
  `).get(artistMbid) as { id: number };
  const releaseGroup = db.prepare(`
    INSERT INTO Albums (mbid, artist_metadata_id, artist_mbid, title)
    VALUES (?, ?, ?, 'Preview Album') RETURNING id
  `).get(releaseGroupMbid, artist.id, artistMbid) as { id: number };
  const release = db.prepare(`
    INSERT INTO AlbumEditions (
      mbid, release_group_id, release_group_mbid, artist_metadata_id, artist_mbid, title
    ) VALUES (?, ?, ?, ?, ?, 'Preview Album') RETURNING id
  `).get(releaseMbid, releaseGroup.id, releaseGroupMbid, artist.id, artistMbid) as { id: number };
  const recording = db.prepare(`
    INSERT INTO Recordings (mbid, artist_metadata_id, artist_mbid, title, is_video)
    VALUES (?, ?, ?, 'Preview Track', 0) RETURNING id
  `).get(recordingMbid, artist.id, artistMbid) as { id: number };
  const track = db.prepare(`
    INSERT INTO Tracks (
      mbid, album_edition_id, release_mbid, recording_id, recording_mbid, title,
      medium_position, position
    ) VALUES (?, ?, ?, ?, ?, 'Preview Track', 1, 1) RETURNING id
  `).get(trackMbid, release.id, releaseMbid, recording.id, recordingMbid) as { id: number };

  for (const provider of ["tidal", "apple-music"]) {
    const providerRelease = db.prepare(`
      INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
      VALUES (?, 'release', ?, 'Preview Album') RETURNING id
    `).get(provider, `${provider}-release-${suffix}`) as { id: number };
    const providerTrack = db.prepare(`
      INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
      VALUES (?, 'track', ?, 'Preview Track') RETURNING id
    `).get(provider, `${provider}-track-${suffix}`) as { id: number };
    const member = db.prepare(`
      INSERT INTO ProviderEditionMembers (
        provider_edition_item_id, member_item_id, medium_position, position
      ) VALUES (?, ?, 1, 1) RETURNING id
    `).get(providerRelease.id, providerTrack.id) as { id: number };
    const releaseMatch = db.prepare(`
      INSERT INTO ProviderEditionMatches (
        provider_edition_item_id, edition_id, relation, match_state,
        decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 0.99, 'test', 1)
      RETURNING id
    `).get(providerRelease.id, release.id) as { id: number };
    db.prepare(`
      INSERT INTO ProviderTrackMatches (
        provider_track_item_id, provider_edition_member_id, provider_edition_match_id,
        track_id, recording_id, match_state, decision_source, confidence, method,
        matcher_version
      ) VALUES (?, ?, ?, ?, ?, 'accepted', 'automatic', 0.99, 'test', 1)
    `).run(providerTrack.id, member.id, releaseMatch.id, track.id, recording.id);
  }

  const { streamingProviderManager } = await import("../services/providers/index.js");
  const tidal = streamingProviderManager.getStreamingProvider("tidal");
  const apple = streamingProviderManager.getStreamingProvider("apple-music");
  const originalTidalPlayback = tidal.getPlaybackInfo;
  const originalApplePlayback = apple.getPlaybackInfo;
  const attempted: Array<{ provider: string; quality: string | undefined }> = [];
  const previousSecret = process.env.JWT_SECRET;
  try {
    process.env.JWT_SECRET = "preview-fallback-test-secret";
    tidal.getPlaybackInfo = async (_id, quality) => {
      attempted.push({ provider: "tidal", quality });
      return null;
    };
    apple.getPlaybackInfo = async (_id, quality) => {
      attempted.push({ provider: "apple-music", quality });
      return { type: "bts", url: "https://example.com/preview.m4a" };
    };

    const query = new URLSearchParams({
      provider: "tidal",
      quality: "HI_RES_LOSSLESS",
      releaseGroupMbid,
      canonicalTrackMbid: trackMbid,
      canonicalRecordingMbid: recordingMbid,
      slot: "stereo",
    });
    const response = await fetch(
      `${baseUrl}/api/playback/stream/sign/${trackMbid}?${query.toString()}`,
    );
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const body = JSON.parse(responseText) as { url: string; hlsUrl: string };
    const signed = new URL(body.url, baseUrl);
    assert.match(signed.pathname, new RegExp(`apple-music-track-${suffix}$`));
    assert.equal(signed.searchParams.get("provider"), "apple-music");
    assert.equal(signed.searchParams.get("quality"), "HIRES_LOSSLESS");
    assert.deepEqual(attempted, [
      { provider: "tidal", quality: "HIRES_LOSSLESS" },
      { provider: "apple-music", quality: "HIRES_LOSSLESS" },
    ]);
  } finally {
    tidal.getPlaybackInfo = originalTidalPlayback;
    apple.getPlaybackInfo = originalApplePlayback;
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});
