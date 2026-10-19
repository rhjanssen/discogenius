/**
 * Two Opus retag errors on 19 Oct 2026 (TrackFiles 44117, 44911) ended in
 * mutagen's Vorbis `__getitem__` raising ValueError: the Xiph fallback was
 * handed the cross-format removal list ("\u00a9pub", ...), and a Vorbis
 * comment cannot hold such a field name.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-vorbis-keys-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const bridge = path.join(path.dirname(fileURLToPath(import.meta.url)), "mutagen-cover-bridge.py");
const python = process.env.DISCOGENIUS_MEDIA_TAGS_PYTHON || (fs.existsSync("/usr/local/bin/python3") ? "/usr/local/bin/python3" : "python3");

after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function opusFile(name: string): string {
  const file = path.join(tempDir, name);
  const made = spawnSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.3",
    "-metadata", "language=eng", "-c:a", "libopus", file,
  ], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  return file;
}

function readVorbis(file: string): Record<string, string[]> {
  const read = spawnSync(python, ["-c", [
    "import json, sys",
    "from mutagen.oggopus import OggOpus",
    "tags = OggOpus(sys.argv[1]).tags",
    "print(json.dumps({k.upper(): v for k, v in tags.as_dict().items()}))",
  ].join("\n"), file], { encoding: "utf8" });
  assert.equal(read.status, 0, read.stderr);
  return JSON.parse(read.stdout);
}

test("the Mutagen Xiph writer ignores removal names a Vorbis comment cannot hold", () => {
  const file = opusFile("fallback.opus");
  const payload = path.join(tempDir, "payload.json");
  fs.writeFileSync(payload, JSON.stringify({
    tags: { TITLE: "Lick a Shot", ARTIST: "Cypress Hill" },
    removeKeys: ["\u00a9pub", "----:com.apple.iTunes:RELEASETIME", "TXXX:Track Number", "UPC", "language", ""],
  }));
  const written = spawnSync(python, [bridge, "metadata", file, payload], { encoding: "utf8" });
  assert.equal(written.status, 0, written.stderr);
  const tags = readVorbis(file);
  assert.deepEqual(tags.TITLE, ["Lick a Shot"]);
  assert.deepEqual(tags.ARTIST, ["Cypress Hill"]);
  assert.equal(tags.LANGUAGE, undefined, "a valid removal name was not removed");
});

test("the Mutagen Xiph writer names an invalid field it is asked to write", () => {
  const file = opusFile("invalid-write.opus");
  const payload = path.join(tempDir, "invalid.json");
  fs.writeFileSync(payload, JSON.stringify({ tags: { "\u00a9nam": "x" }, removeKeys: [] }));
  const written = spawnSync(python, [bridge, "metadata", file, payload], { encoding: "utf8" });
  assert.notEqual(written.status, 0);
  assert.match(written.stderr, /invalid Vorbis comment field name/);
});

test("Opus retag removal keys contain only valid Vorbis field names", async () => {
  const dbModule = await import("../../database.js");
  dbModule.initDatabase();
  const configModule = await import("../config/config.js");
  const { AudioTagService } = await import("./audio-tag-service.js");
  const file = opusFile("planned.opus");
  const config = configModule.readConfig().metadata;
  // The Sony Classical Opus file (TrackFiles 44117) had a label and a date,
  // which adds the MP4 "\u00a9pub" and RELEASETIME removals.
  const row = { album_label: '["Sony Classical"]', media_release_date: "2019-11-01", artist_mbid: null };
  const removals = (AudioTagService as any).buildRowManagedTagRemovals(row, config);
  assert.ok(
    AudioTagService.buildAudioTagRemovalKeys(removals, ".opus").some((key) => !/^[\x20-\x3C\x3E-\x7D]+$/.test(key)),
    "fixture no longer exercises a cross-format removal name",
  );
  const { removalKeys } = await AudioTagService.evaluateFileTags(file, [], removals);
  assert.ok(removalKeys.length > 0);
  for (const key of removalKeys) {
    assert.match(key, /^[\x20-\x3C\x3E-\x7D]+$/, `invalid Vorbis removal key ${JSON.stringify(key)}`);
  }
  dbModule.closeDatabase();
});
