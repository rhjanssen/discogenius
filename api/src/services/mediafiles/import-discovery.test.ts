import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanPathLabel, extractNamingMbid, scanImportDirectory } from "./import-discovery.js";
import { mediaRewritePath } from "./media-file-rewrite.js";

test("directory import ignores unfinished tag and ffmpeg copies but keeps hidden user audio", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-import-working-copy-"));
  try {
    // A real PCM WAV ensures the discovery path probes actual media.
    const wav = Buffer.alloc(44 + 16000);
    wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(16000, 40);
    for (const file of [path.join(root, "song.wav"), path.join(root, ".my-song.wav"),
      mediaRewritePath(path.join(root, "song.wav"), "tags"), mediaRewritePath(path.join(root, "song.wav"))]) {
      fs.writeFileSync(file, wav);
    }
    const groups = await scanImportDirectory(root, root);
    assert.deepEqual(groups.flatMap(group => group.files.map(file => file.name)).sort(), [".my-song.wav", "song.wav"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("extractNamingMbid reads Discogenius folder tokens", () => {
  assert.equal(
    extractNamingMbid("Bad Blood (2012) {mbid-5bca186e-3dfb-4191-a3b1-8876d454c53c}"),
    "5bca186e-3dfb-4191-a3b1-8876d454c53c",
  );
  assert.equal(extractNamingMbid("Bad Blood (2012)"), null);
});

test("cleanPathLabel strips naming MBIDs from folder-derived artist names", () => {
  assert.equal(
    cleanPathLabel("Bastille {mbid-7808accb-6395-4b25-858c-678bbb73896b}"),
    "Bastille",
  );
});
