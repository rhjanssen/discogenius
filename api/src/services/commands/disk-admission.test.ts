import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  configureHddIoLimit,
  diskAdmissionSnapshot,
  diskAdmissionWorkerData,
  DISK_ADMISSION_OWNER_KEY,
  enterWriteGate,
  hddIoLimit,
  releaseExitedDiskAdmissionOwner,
  albumFolderLane,
  withAlbumFolder,
  withAlbumFolders,
  withHddIoPermit,
  type DiskAdmissionMeta,
} from "./disk-admission.js";

function distinctFolders(prefix: string, count: number): string[] {
  const chosen: string[] = [];
  const lanes = new Set<number>();
  for (let index = 0; chosen.length < count && index < 10000; index += 1) {
    const folder = `${prefix}-${index}`;
    const lane = albumFolderLane(folder);
    if (lanes.has(lane)) continue;
    lanes.add(lane);
    chosen.push(folder);
  }
  if (chosen.length !== count) throw new Error(`could not find ${count} distinct folder lanes`);
  return chosen;
}

const retag = (commandId: number): DiskAdmissionMeta => ({ role: "retag", commandId, reason: "retag file" });
const importing = (commandId: number): DiskAdmissionMeta => ({ role: "import", commandId, reason: "import file" });
const renaming = (commandId: number): DiskAdmissionMeta => ({ role: "rename", commandId });

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2000) throw new Error(`timed out waiting for ${label}`);
    await delay(5);
  }
}

test("a retag and an import of a different album both progress", async () => {
  const [albumA, albumB] = distinctFolders("/library/parallel", 2);
  let retagHolding = false;
  let sawRetagHolding = false;
  const retagTask = withAlbumFolder(albumA, retag(1), async () => {
    retagHolding = true;
    await delay(60);
    retagHolding = false;
  });
  await waitFor(() => diskAdmissionSnapshot().holders.some((holder) => holder.commandId === 1), "retag holder");
  await withAlbumFolder(albumB, importing(2), async () => {
    sawRetagHolding = retagHolding;
  });
  assert.equal(sawRetagHolding, true);
  await retagTask;
  assert.equal(diskAdmissionSnapshot().holders.length, 0);
});

test("the same album folder never has two writers, and a waiting import goes first", async () => {
  const folder = "/library/shared-album";
  let writers = 0;
  let maxWriters = 0;
  const order: string[] = [];
  let releaseHold: () => void = () => {};
  const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
  const first = withAlbumFolder(folder, retag(11), async () => {
    writers += 1;
    maxWriters = Math.max(maxWriters, writers);
    order.push("hold");
    await hold;
    writers -= 1;
  });
  await waitFor(() => diskAdmissionSnapshot().holders.some((holder) => holder.commandId === 11), "first holder");
  let importEntered = false;
  const imported = withAlbumFolder(folder, importing(12), async () => {
    importEntered = true;
    writers += 1;
    maxWriters = Math.max(maxWriters, writers);
    order.push("import");
    await delay(20);
    writers -= 1;
  });
  const second = withAlbumFolder(folder, retag(13), async () => {
    writers += 1;
    maxWriters = Math.max(maxWriters, writers);
    order.push("retag");
    writers -= 1;
  });
  await waitFor(() => diskAdmissionSnapshot().waits.filter((wait) => wait.kind === "folder").length >= 2, "both waiters");
  const waiting = diskAdmissionSnapshot().waits.map((wait) => wait.reason);
  assert.ok(waiting.some((reason) => reason.includes("album folder lock held by retag command 11")));
  assert.equal(importEntered, false);
  releaseHold();
  await imported;
  assert.deepEqual(order, ["hold", "import"]);
  await second;
  await first;
  assert.deepEqual(order, ["hold", "import", "retag"]);
  assert.equal(maxWriters, 1);
  assert.equal(diskAdmissionSnapshot().holders.length, 0);
  assert.equal(diskAdmissionSnapshot().waits.length, 0);
});

test("the HDD I/O limit is a global cap across album folders", async () => {
  const previous = hddIoLimit();
  const [ioA, ioB] = distinctFolders("/library/io", 2);
  try {
    configureHddIoLimit(1);
    let inside = 0;
    let maxInside = 0;
    const run = (folder: string, commandId: number) => withAlbumFolder(folder, retag(commandId), () => withHddIoPermit(retag(commandId), async () => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      await delay(40);
      inside -= 1;
    }));
    const first = run(ioA, 21);
    await waitFor(() => diskAdmissionSnapshot().ioInUse === 1, "first permit");
    const second = run(ioB, 22);
    await waitFor(() => diskAdmissionSnapshot().waits.some((wait) => wait.kind === "io"), "io waiter");
    const reason = diskAdmissionSnapshot().waits.find((wait) => wait.kind === "io")?.reason ?? "";
    assert.match(reason, /HDD I\/O permit \(1\/1 in use\)/);
    await Promise.all([first, second]);
    assert.equal(maxInside, 1);

    configureHddIoLimit(2);
    maxInside = 0;
    await Promise.all([run(ioA, 23), run(ioB, 24)]);
    assert.equal(maxInside, 2);
    assert.equal(hddIoLimit(), 2);
    configureHddIoLimit(100);
    assert.equal(hddIoLimit(), 8);
    configureHddIoLimit(0);
    assert.equal(hddIoLimit(), 1);
  } finally {
    configureHddIoLimit(previous);
  }
});

test("lock order is folder, then I/O permit, then the write gate", async () => {
  const folder = "/library/order";
  await assert.rejects(withHddIoPermit(retag(1), async () => undefined), /without an album folder lock/);
  await withAlbumFolder(folder, retag(1), async () => {
    await withHddIoPermit(retag(1), async () => {
      assert.throws(() => enterWriteGate(() => undefined), /I\/O permit is held/);
      assert.throws(() => configureHddIoLimit(2), /permits are held/);
    });
    enterWriteGate(() => {
      assert.equal(diskAdmissionSnapshot().ioInUse, 0);
    });
    await assert.rejects(withAlbumFolder("/library/other", retag(1), async () => undefined), /nested album folder lock/);
    await withAlbumFolder(`${folder}/`, retag(1), async () => undefined);
  });
  await assert.rejects(
    enterWriteGate(() => withAlbumFolder("/library/from-gate", retag(1), async () => undefined)),
    /write gate is held/,
  );
  await withAlbumFolder(folder, retag(1), async () => {
    await withHddIoPermit(retag(1), async () => {
      await assert.rejects(withAlbumFolder("/library/other", importing(2), async () => undefined), /I\/O permit is held/);
    });
  });
  let reentered = false;
  await withHddIoPermitCallSite(folder);
  assert.equal(reentered, false);
  await withAlbumFolder(folder, retag(1), () => withHddIoPermit(retag(1), () => withHddIoPermit(retag(1), async () => {
    reentered = true;
  })));
  assert.equal(reentered, true);

  async function withHddIoPermitCallSite(target: string): Promise<void> {
    await withAlbumFolder(target, retag(4), async () => {
      await withHddIoPermit(retag(4), async () => undefined);
    });
  }
});

test("renames of the same folder pair lock in one order", async () => {
  const left = "/library/left";
  const right = "/library/right";
  let overlap = 0;
  let maxOverlap = 0;
  const run = (commandId: number, folders: string[]) => withAlbumFolders(folders, renaming(commandId), async () => {
    overlap += 1;
    maxOverlap = Math.max(maxOverlap, overlap);
    await delay(30);
    overlap -= 1;
  });
  await Promise.all([
    run(1, [right, left]),
    run(2, [left, right]),
  ]);
  assert.equal(maxOverlap, 1);
});

test("randomized folder and permit interleaving does not deadlock", async () => {
  const previous = hddIoLimit();
  configureHddIoLimit(2);
  const folders = distinctFolders("/library/rand", 4);
  const roles = ["import", "retag", "rename", "rescan", "other"] as const;
  try {
    const tasks = Array.from({ length: 80 }, (_, index) => (async () => {
      const role = roles[index % roles.length];
      const meta: DiskAdmissionMeta = { role, commandId: 1000 + index };
      const first = folders[index % folders.length];
      const second = folders[(index + 1 + (index % 3)) % folders.length];
      const body = async () => {
        if (index % 2 === 0) {
          await withHddIoPermit(meta, async () => {
            await delay(index % 4);
          });
        } else {
          await delay(index % 3);
        }
        enterWriteGate(() => undefined);
      };
      if (index % 3 === 0) await withAlbumFolders([second, first], meta, body);
      else await withAlbumFolder(first, meta, body);
    })());
    const finished = Promise.all(tasks);
    const timeout = delay(5000).then(() => {
      throw new Error(`deadlock: ${JSON.stringify(diskAdmissionSnapshot())}`);
    });
    await Promise.race([finished, timeout]);
    assert.equal(diskAdmissionSnapshot().holders.length, 0);
    assert.equal(diskAdmissionSnapshot().ioInUse, 0);
    assert.equal(diskAdmissionSnapshot().waits.length, 0);
  } finally {
    configureHddIoLimit(previous);
  }
});

test("a dead worker's folder lock and I/O permit are released", async () => {
  const folder = "/library/dead-owner";
  const data = diskAdmissionWorkerData();
  const entry = fileURLToPath(new URL("./disk-admission.ts", import.meta.url));
  const worker = new Worker(`
    require("tsx/cjs");
    const { parentPort, workerData } = require("node:worker_threads");
    const { withAlbumFolder, withHddIoPermit } = require(workerData.entry);
    setInterval(() => {}, 1000);
    withAlbumFolder(workerData.folder, { role: "retag", commandId: 7 }, () =>
      withHddIoPermit({ role: "retag", commandId: 7 }, async () => {
        parentPort.postMessage("held");
        await new Promise(() => {});
      })).catch((error) => parentPort.postMessage(String(error)));
  `, { eval: true, workerData: { ...data, entry, folder } });
  try {
    assert.deepEqual(await once(worker, "message"), ["held"]);
    let admitted = false;
    const next = withAlbumFolder(folder, importing(8), async () => {
      admitted = true;
    });
    await delay(40);
    assert.equal(admitted, false);
    const other = withAlbumFolder("/library/dead-owner-other", importing(9), async () => "open");
    assert.equal(await other, "open");
    await worker.terminate();
    releaseExitedDiskAdmissionOwner(Number(data[DISK_ADMISSION_OWNER_KEY]));
    await next;
    assert.equal(admitted, true);
    assert.equal(diskAdmissionSnapshot().ioInUse, 0);
  } finally {
    await worker.terminate();
    releaseExitedDiskAdmissionOwner(Number(data[DISK_ADMISSION_OWNER_KEY]));
  }
});
