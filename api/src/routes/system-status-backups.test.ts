import assert from "node:assert/strict";
import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-backup-route-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.backup-route.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let server: Server;
let baseUrl: string;

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();

  const systemStatusRouter = (await import("./system-status.js")).default;
  const app = express();
  app.use(express.json());
  app.use("/system/status", systemStatusRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind a TCP port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("backup routes create, list, download, and delete a database backup", async () => {
  const emptyList = await fetch(`${baseUrl}/system/status/backups`);
  assert.equal(emptyList.status, 200);
  assert.deepEqual(await emptyList.json(), []);

  const create = await fetch(`${baseUrl}/system/status/backups`, { method: "POST" });
  assert.equal(create.status, 200);
  const created = await create.json() as {
    success: boolean;
    fileName: string;
    backupPath: string;
    prunedCount: number;
  };
  assert.equal(created.success, true);
  assert.match(created.fileName, /^discogenius_backup_[A-Za-z0-9._-]+\.db$/);
  assert.equal(path.dirname(created.backupPath), path.join(tempDir, "Backups"));
  assert.equal(fs.existsSync(created.backupPath), true);

  const list = await fetch(`${baseUrl}/system/status/backups`);
  assert.equal(list.status, 200);
  const backups = await list.json() as Array<{ name: string; size: number; time: string }>;
  assert.equal(backups.length, 1);
  assert.equal(backups[0]?.name, created.fileName);
  assert.ok((backups[0]?.size ?? 0) > 0);
  assert.ok(Number.isFinite(Date.parse(backups[0]?.time ?? "")));

  const download = await fetch(
    `${baseUrl}/system/status/backups/${encodeURIComponent(created.fileName)}/download`,
  );
  assert.equal(download.status, 200);
  assert.ok((await download.arrayBuffer()).byteLength > 0);

  const remove = await fetch(
    `${baseUrl}/system/status/backups/${encodeURIComponent(created.fileName)}`,
    { method: "DELETE" },
  );
  assert.equal(remove.status, 200);
  assert.deepEqual(await remove.json(), { success: true });
  assert.equal(fs.existsSync(created.backupPath), false);
});

test("backup download and delete reject unrelated files", async () => {
  const backupsDir = path.join(tempDir, "Backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  const unrelatedFile = path.join(backupsDir, "provider-token.json");
  fs.writeFileSync(unrelatedFile, "keep me");

  const download = await fetch(
    `${baseUrl}/system/status/backups/${encodeURIComponent("provider-token.json")}/download`,
  );
  assert.equal(download.status, 404);

  const remove = await fetch(
    `${baseUrl}/system/status/backups/${encodeURIComponent("provider-token.json")}`,
    { method: "DELETE" },
  );
  assert.equal(remove.status, 404);
  assert.equal(fs.readFileSync(unrelatedFile, "utf8"), "keep me");
});
