import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { withSqliteWriteMutexAsync } from "./sqlite-write-mutex.js";

const port = parentPort!;
// Production workers keep their command message listener while awaiting a lock.
port.on("message", () => {});
if (workerData.mode === "hold") {
  const released = new Promise<void>((resolve) => port.once("message", () => resolve()));
  const run = withSqliteWriteMutexAsync(async () => {
    port.postMessage({ kind: "acquired", name: workerData.name });
    await released;
  }, workerData.name);
  port.postMessage({ kind: "queued", name: workerData.name });
  await run;
} else if (workerData.mode === "peer-write") {
  const db = new Database(workerData.dbPath, { timeout: 0 });
  try {
    await withSqliteWriteMutexAsync(async () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(workerData.sql).run(...workerData.params);
        port.postMessage("locked");
        await new Promise(resolve => setTimeout(resolve, 100));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }, "test:concurrent-queue-write");
  } finally {
    db.close();
  }
} else {
  const db = new Database(workerData.dbPath, { timeout: 0 });
  const write = db.transaction((sequence: number) => {
    db.prepare("INSERT INTO writes(owner, seq) VALUES (?, ?)").run(workerData.name, sequence);
    db.prepare("UPDATE writes SET committed = 1 WHERE owner = ? AND seq = ?").run(workerData.name, sequence);
  });
  const errors: string[] = [];
  for (let sequence = 0; sequence < workerData.iterations; sequence++) {
    try {
      await withSqliteWriteMutexAsync(() => write(sequence), workerData.name);
    } catch (error) {
      errors.push(String((error as { code?: string }).code || error));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  db.close();
  port.postMessage({ kind: "finished", name: workerData.name, errors });
}
port.close();
