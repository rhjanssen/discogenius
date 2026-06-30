import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-video-route-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.video-route.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let videoRouter: typeof import("./video.js").default;

before(async () => {
  dbModule = await import("../../database.js");
  videoRouter = (await import("./video.js")).default;
  dbModule.initDatabase();
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM commands").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

type MockResponse = {
  statusCode: number;
  body: any;
  status: (code: number) => MockResponse;
  json: (payload: unknown) => MockResponse;
};

function createMockResponse(): MockResponse {
  return {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

function getPostHandler(pathName: string): (req: any, res: any) => Promise<void> | void {
  const layer = (videoRouter as any).stack.find((entry: any) => entry.route?.path === pathName && entry.route?.methods?.post);
  assert.ok(layer, `Expected POST handler for path ${pathName}`);
  return layer.route.stack[0].handle;
}

function getGetHandler(pathName: string): (req: any, res: any) => Promise<void> | void {
  const layer = (videoRouter as any).stack.find((entry: any) => entry.route?.path === pathName && entry.route?.methods?.get);
  assert.ok(layer, `Expected GET handler for path ${pathName}`);
  return layer.route.stack[0].handle;
}

test("video add queues provider seeding instead of running inline", async () => {
  const handler = getPostHandler("/");
  const res = createMockResponse();

  await handler({
    body: {
      id: "provider-video-1",
    },
  }, res);

  assert.equal(res.statusCode, 202);
  assert.equal(res.body.success, true);
  assert.equal(res.body.queued, true);
  assert.equal(typeof res.body.commandId, "number");

  const command = dbModule.db.prepare(`
    SELECT name, ref_id, payload
    FROM commands
    ORDER BY id DESC
    LIMIT 1
  `).get() as { name: string; ref_id: string | null; payload: string };

  assert.equal(command.name, "SeedVideo");
  assert.equal(command.ref_id, "provider-video-1");

  const payload = JSON.parse(command.payload);
  assert.equal(payload.providerId, "provider-video-1");
  assert.equal(payload.monitorArtist, true);
  assert.equal(payload.monitorVideo, true);
});

test("video detail does not seed unknown provider ids from GET", async () => {
  const handler = getGetHandler("/:videoId");
  const res = createMockResponse();

  await handler({
    params: {
      videoId: "provider-video-1",
    },
  }, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.detail, "Video not found");

  const count = dbModule.db.prepare("SELECT COUNT(*) AS count FROM commands").get() as { count: number };
  assert.equal(count.count, 0);
});
