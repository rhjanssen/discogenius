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
let server: Server;
let baseUrl: string;

before(async () => {
  const database = await import("../database.js");
  database.initDatabase();
  closeDatabase = database.closeDatabase;

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
