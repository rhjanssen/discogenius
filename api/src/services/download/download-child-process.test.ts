import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { superviseDownloadProcesses } from "./download-child-process.js";

test("terminating a download worker also terminates its native downloader", async () => {
  const source = import.meta.url.endsWith(".ts");
  const moduleUrl = new URL(source ? "./download-child-process.ts" : "./download-child-process.js", import.meta.url).href;
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    ${source ? "require('tsx/esm/api').register();" : ""}
    import(${JSON.stringify(moduleUrl)}).then(({ spawnDownloadProcess }) => {
      const child = spawnDownloadProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      child.once('spawn', () => parentPort.postMessage({ kind: 'testReady', pid: child.pid }));
    });
  `, { eval: true, workerData: { discogeniusDownloadWorker: true } });
  superviseDownloadProcesses(worker);
  let pid: number | undefined;
  try {
    while (true) {
      const [message] = await once(worker, "message");
      if (message.kind === "testReady") { pid = message.pid; break; }
    }
    assert.ok(pid);
    assert.doesNotThrow(() => process.kill(pid!, 0));
    await worker.terminate();
    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt++) {
      try {
        process.kill(pid, 0);
        // Linux retains an exited child's PID until waitpid reaps it. A zombie
        // cannot execute or retain an open provider/file descriptor.
        if (process.platform === "linux" && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"))) {
          alive = false;
        } else {
          await delay(20);
        }
      } catch { alive = false; }
    }
    assert.equal(alive, false, "a terminated worker must not leave a downloader alive");
  } finally {
    await worker.terminate();
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } }
  }
});
