import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-provider-tag-supplements-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

test("provider tag supplements retain negative ReplayGain, zero values, peak, and copyright", async () => {
  const { providerTrackTagSupplements } = await import("./provider-track-tag-supplement-service.js");
  assert.deepEqual(providerTrackTagSupplements({
    providerId: "track-1",
    title: "Track",
    artist: { providerId: "artist", name: "Artist" },
    album: { providerId: "album", title: "Album", artist: { providerId: "artist", name: "Artist" } },
    duration: 180,
    trackNumber: 1,
    raw: {
      replay_gain: -7.42,
      peak: 0.982341,
      copyright: "(P) 2026 Label",
    },
  }), {
    providerId: "track-1",
    replayGain: -7.42,
    peak: 0.982341,
    copyright: "(P) 2026 Label",
  });

  const zero = providerTrackTagSupplements({
    providerId: "track-2",
    title: "Silence",
    artist: { providerId: "artist", name: "Artist" },
    album: { providerId: "album", title: "Album", artist: { providerId: "artist", name: "Artist" } },
    duration: 1,
    trackNumber: 2,
    replayGain: 0,
    peak: 0,
  });
  assert.equal(zero.replayGain, 0);
  assert.equal(zero.peak, 0);
  fs.rmSync(tempDir, { recursive: true, force: true });
});
