import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { replaceMediaFile, runMediaRewrite } from "./media-file-rewrite.js";

test("media replacement installs complete output and preserves the original on invalid output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-rewrite-"));
  try {
    const original = path.join(root, "track.flac");
    const prepared = path.join(root, "prepared.flac");
    fs.writeFileSync(original, "original media");
    fs.writeFileSync(prepared, "");
    assert.throws(() => replaceMediaFile(original, prepared), /nonempty/);
    assert.equal(fs.readFileSync(original, "utf8"), "original media");
    fs.writeFileSync(prepared, "verified media");
    replaceMediaFile(original, prepared);
    assert.equal(fs.readFileSync(original, "utf8"), "verified media");
    assert.equal(fs.existsSync(prepared), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a timed-out writer has exited before cleanup and cannot overwrite the original later", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-rewrite-timeout-"));
  try {
    const originalPath = path.join(root, "track.flac");
    const temporaryPath = path.join(root, "prepared.flac");
    const pidPath = path.join(root, "writer.pid");
    fs.writeFileSync(originalPath, "original media");
    await assert.rejects(runMediaRewrite({ originalPath, temporaryPath,
      command: process.execPath,
      args: ["-e", "const fs=require('fs');fs.writeFileSync(process.argv[1],'partial');fs.writeFileSync(process.argv[2],String(process.pid));setInterval(()=>fs.appendFileSync(process.argv[1],'more'),10)", temporaryPath, pidPath],
      timeoutMs: 1000,
    }), /timed out/);
    assert.equal(fs.readFileSync(originalPath, "utf8"), "original media");
    assert.equal(fs.existsSync(temporaryPath), false);
    assert.ok(fs.existsSync(pidPath), "the test must actually start its writer");
    const pid = Number(fs.readFileSync(pidPath, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("successful and failed child writers use the same replacement lifecycle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-rewrite-child-"));
  try {
    const originalPath = path.join(root, "track.flac");
    const temporaryPath = path.join(root, "prepared.flac");
    fs.writeFileSync(originalPath, "original media");
    const options = { originalPath, temporaryPath, command: process.execPath,
      args: ["-e", "require('fs').writeFileSync(process.argv[1],'new media');process.exit(Number(process.argv[2]))", temporaryPath, "7"] };
    await assert.rejects(runMediaRewrite(options), /code 7/);
    assert.equal(fs.readFileSync(originalPath, "utf8"), "original media");
    options.args[options.args.length - 1] = "0";
    await runMediaRewrite(options);
    assert.equal(fs.readFileSync(originalPath, "utf8"), "new media");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
