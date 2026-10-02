import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-retag-route-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.retag-route.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let renameRouter: typeof import("./library-files.js").default;
let retagRouter: typeof import("./retag.js").default;

before(async () => {
  dbModule = await import("../database.js");
  retagRouter = (await import("./retag.js")).default;
  dbModule.initDatabase();
  renameRouter = (await import("./library-files.js")).default;
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

function getPostHandler(pathName: string, router = retagRouter): (req: any, res: any) => Promise<void> | void {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === pathName && entry.route?.methods?.post);
  assert.ok(layer, `Expected POST handler for path ${pathName}`);
  return layer.route.stack[0].handle;
}

test("bulk artist retag queues one RetagArtist command with every selected public id", async () => {
  const handler = getPostHandler("/apply");
  const res = createMockResponse();

  await handler({
    body: {
      applyAll: true,
      artistIds: ["artist-mbid-b", "artist-mbid-a", "artist-mbid-b"],
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.queued, true);

  const command = dbModule.db.prepare(`
    SELECT name, ref_id, payload
    FROM commands
    ORDER BY id DESC
    LIMIT 1
  `).get() as { name: string; ref_id: string; payload: string };

  assert.equal(command.name, "RetagArtist");
  assert.equal(command.ref_id, 'retag-artists:["artist-mbid-b","artist-mbid-a"]');
  assert.deepEqual(JSON.parse(command.payload).artistIds, ["artist-mbid-b", "artist-mbid-a"]);
});

test("applyAll retag rejects an unscoped library-wide request", async () => {
  const handler = getPostHandler("/apply");
  const res = createMockResponse();

  await handler({ body: { applyAll: true } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.detail, /artistId, artistIds, albumId, or editionId/);
  const commandCount = dbModule.db.prepare("SELECT COUNT(*) AS count FROM commands").get() as { count: number };
  assert.equal(commandCount.count, 0);
});

test("empty and malformed retag or strip selections never expand into a library-wide command", async () => {
  for (const endpoint of ["/apply", "/strip"]) {
    for (const body of [{}, { ids: [] }, { ids: [0] }, { ids: [1, "bad"] }, { ids: "1" }, { ids: [null] }, { ids: [1.5] }]) {
      const res = createMockResponse();
      await getPostHandler(endpoint)({ body }, res);
      assert.equal(res.statusCode, 400, `${endpoint} ${JSON.stringify(body)}`);
      assert.equal((dbModule.db.prepare("SELECT COUNT(*) count FROM commands").get() as { count: number }).count, 0);
    }
  }
});

test("persisted invalid RetagFiles commands fail before catalogue scope or file work is evaluated", async () => {
  const { handleRetagFiles } = await import("../services/commands/handlers/library-handlers.js");
  for (const payload of [{ ids: [] }, {}, { applyAll: true }, { ids: [-1], stripOnly: true }]) {
    await assert.rejects(handleRetagFiles({ name: "RetagFiles", payload } as any, {} as any), /identifiers|scope/);
  }
  assert.equal((dbModule.db.prepare("SELECT COUNT(*) count FROM CommandFileWorkPlans").get() as { count: number }).count, 0);
});


test("malformed rename selections never expand into a library-wide command", async () => {
  for (const body of [{}, { ids: [] }, { ids: ["bad"] }, { ids: [0] }, { ids: [1, "bad"] }, { ids: [1.5] }]) {
    const res = createMockResponse();
    await getPostHandler("/rename/apply", renameRouter)({ body }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal((dbModule.db.prepare("SELECT COUNT(*) count FROM commands").get() as { count: number }).count, 0);
  }
  const { handleRenameFiles } = await import("../services/commands/handlers/library-handlers.js");
  for (const payload of [{ ids: [] }, {}, { applyAll: true }, { ids: [-1] }]) {
    await assert.rejects(handleRenameFiles({ name: "RenameFiles", payload } as any, {} as any), /identifiers|scope/);
  }
});
