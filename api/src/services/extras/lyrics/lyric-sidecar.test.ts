import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  classifyLyricsForSidecar,
  findAdjacentLyricSidecar,
  isSynchronizedLyricContent,
} from "./lyric-sidecar.js";

const tempPaths: string[] = [];

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

test("lyric sidecars use LRC only for valid synchronized content", () => {
  assert.equal(isSynchronizedLyricContent("[01:02.34]Timed line"), true);
  assert.equal(isSynchronizedLyricContent("[01:99.34]Not a valid timestamp"), false);
  assert.equal(isSynchronizedLyricContent("[ar:Bastille]\nPlain line"), false);

  assert.deepEqual(classifyLyricsForSidecar({
    subtitles: "[00:03.20]Timed line",
    text: "Plain line",
  }), {
    content: "[00:03.20]Timed line",
    extension: ".lrc",
    synchronized: true,
    text: "Plain line",
    subtitles: "[00:03.20]Timed line",
  });

  assert.deepEqual(classifyLyricsForSidecar({
    subtitles: "Timestamp-free provider subtitle",
    text: "Plain provider lyric",
  }), {
    content: "Plain provider lyric",
    extension: ".txt",
    synchronized: false,
    text: "Plain provider lyric",
    subtitles: "",
  });
});

test("adjacent discovery normalizes a legacy timestamp-free LRC to plain text", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-plain-lyric-"));
  tempPaths.push(tempDir);
  const mediaPath = path.join(tempDir, "01 - Pompeii.flac");
  const legacyPath = path.join(tempDir, "01 - Pompeii.lrc");
  const plainPath = path.join(tempDir, "01 - Pompeii.txt");
  fs.writeFileSync(legacyPath, "How am I gonna be an optimist about this?\n", "utf8");

  const sidecar = findAdjacentLyricSidecar(mediaPath, { normalizeExtension: true });

  assert.equal(sidecar?.filePath, plainPath);
  assert.equal(sidecar?.synchronized, false);
  assert.equal(sidecar?.text, "How am I gonna be an optimist about this?");
  assert.equal(sidecar?.subtitles, "");
  assert.equal(fs.existsSync(legacyPath), false);
  assert.equal(fs.readFileSync(plainPath, "utf8"), "How am I gonna be an optimist about this?\n");
});
