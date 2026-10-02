import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { acquireMediaFileLocks, mediaFileLockWorkerData, MEDIA_FILE_LOCK_OWNER_KEY, releaseExitedMediaFileOwner, withMediaFileLock } from "./media-file-lock.js";
import { rewriteMediaCopy } from "./media-file-rewrite.js";

test("overlapping copy/mutate/replace operations preserve both updates without blocking the event loop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-file-lock-"));
  const file = path.join(root, "file.flac");
  fs.writeFileSync(file, "audio");
  let heartbeats = 0;
  const timer = setInterval(() => heartbeats++, 5);
  try {
    await Promise.all(["first", "second"].map(value => rewriteMediaCopy(file, async working => {
      const previous = fs.readFileSync(working, "utf8");
      await new Promise(resolve => setTimeout(resolve, 40));
      fs.writeFileSync(working, `${previous}:${value}`);
      return true;
    })));
    assert.equal(fs.readFileSync(file, "utf8"), "audio:first:second");
    assert.ok(heartbeats >= 5);
    assert.deepEqual(fs.readdirSync(root), ["file.flac"]);
    await withMediaFileLock(file, () => withMediaFileLock(file, async () => true));
  } finally { clearInterval(timer); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a physical worker exit releases its shared file lock before the next writer", async () => {
  const file = path.join(os.tmpdir(), "discogenius-dead-file-owner.flac");
  const data = mediaFileLockWorkerData();
  const entry = fileURLToPath(new URL("./media-file-lock.ts", import.meta.url));
  const worker = new Worker(`
    require('tsx/cjs');
    const {parentPort,workerData}=require('node:worker_threads');
    const {acquireMediaFileLocks}=require(workerData.entry);
    setInterval(()=>{},1000);
    acquireMediaFileLocks([workerData.file]).then(()=>parentPort.postMessage('held'));
  `, { eval: true, workerData: { ...data, entry, file } });
  try {
    assert.deepEqual(await once(worker, "message"), ["held"]);
    let admitted = false;
    const next = acquireMediaFileLocks([file]).then(release => { admitted = true; release(); });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(admitted, false);
    await worker.terminate();
    releaseExitedMediaFileOwner(Number(data[MEDIA_FILE_LOCK_OWNER_KEY]));
    await next;
    assert.equal(admitted, true);
  } finally {
    await worker.terminate();
    releaseExitedMediaFileOwner(Number(data[MEDIA_FILE_LOCK_OWNER_KEY]));
  }
});
