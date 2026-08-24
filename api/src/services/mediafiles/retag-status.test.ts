import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-retag-status-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let configModule: typeof import("../config/config.js");
let audioTagServiceModule: typeof import("./audio-tag-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  configModule = await import("../config/config.js");
  audioTagServiceModule = await import("./audio-tag-service.js");
  dbModule.initDatabase();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("retag status uses a bounded fast scan by default", async () => {
  const { db } = dbModule;
  db.prepare("DELETE FROM TrackFiles").run();
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)
    RETURNING id
  `).get("artist-1", "Bastille") as { id: number };

  configModule.updateConfig("metadata", {
    ...configModule.getConfigSection("metadata"),
    write_audio_tags_policy: "all_files",
  });

  const insertFile = db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, provider, provider_entity_type, provider_id, library_slot,
      file_path, relative_path, library_root, filename, extension, file_type
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertProviderTrack = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, duration_ms
    )
    VALUES (?, ?, ?, ?, ?)
  `);

  for (let i = 1; i <= 5; i += 1) {
    insertProviderTrack.run("tidal", "track", String(i), `Track ${i}`, 180_000);
    insertFile.run(
      artist.id,
      "tidal",
      "track",
      String(i),
      "stereo",
      path.join(tempDir, "missing", `track-${i}.flac`),
      `missing/track-${i}.flac`,
      "music",
      `track-${i}.flac`,
      "flac",
      "track",
    );
  }

  const status = await audioTagServiceModule.AudioTagService.getStatus({ limit: 2 }, 1);

  assert.equal(status.enabled, true);
  assert.equal(status.total, 5);
  assert.equal(status.scanned, 2);
  assert.equal(status.limited, true);
  assert.equal(status.missing, 2);
  assert.equal(status.sample.length, 1);
});
