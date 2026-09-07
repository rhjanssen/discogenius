import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-metadata-route-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.metadata-route.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let metadataRouter: typeof import("./metadata.js").default;

before(async () => {
  dbModule = await import("../database.js");
  metadataRouter = (await import("./metadata.js")).default;
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
  const layer = (metadataRouter as any).stack.find((entry: any) => entry.route?.path === pathName && entry.route?.methods?.post);
  assert.ok(layer, `Expected POST handler for path ${pathName}`);
  return layer.route.stack[0].handle;
}

test("metadata regenerate queues tag and sidecar regeneration instead of running inline", async () => {
  const handler = getPostHandler("/regenerate");
  const res = createMockResponse();

  await handler({
    body: {
      scope: "artist",
      entityId: "artist-one",
      kind: "all",
    },
  }, res);

  assert.equal(res.statusCode, 202);
  assert.equal(res.body.success, true);
  assert.equal(res.body.queued, true);
  assert.equal(res.body.commandIds.length, 2);

  const commands = dbModule.db.prepare(`
    SELECT name, ref_id, payload
    FROM commands
    ORDER BY id
  `).all() as Array<{ name: string; ref_id: string | null; payload: string }>;

  assert.deepEqual(commands.map((command) => command.name), ["RetagArtist", "RescanFolders"]);
  assert.deepEqual(commands.map((command) => command.ref_id), ["artist-one", "artist-one"]);

  const retagPayload = JSON.parse(commands[0].payload);
  assert.equal(retagPayload.artistId, "artist-one");
  assert.deepEqual(retagPayload.artistIds, ["artist-one"]);

  const rescanPayload = JSON.parse(commands[1].payload);
  assert.equal(rescanPayload.artistId, "artist-one");
  assert.equal(rescanPayload.skipCuration, true);
  assert.equal(rescanPayload.trackUnmappedFiles, false);
});

test("metadata regenerate rejects unsupported scopes", async () => {
  const handler = getPostHandler("/regenerate");
  const res = createMockResponse();

  await handler({
    body: {
      scope: "library",
      entityId: "all",
      kind: "all",
    },
  }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.detail, /scope must be/);
});

test("metadata regenerate queues tag regeneration for the exact file row, not a matching provider id", async () => {
  dbModule.db.prepare(`INSERT INTO TrackFiles
    (id, file_path, relative_path, library_root, filename, extension, file_type, provider, provider_id)
    VALUES (123, '/test/one.flac', 'one.flac', 'music', 'one.flac', 'flac', 'track', 'tidal', '999'),
           (124, '/test/two.flac', 'two.flac', 'music', 'two.flac', 'flac', 'track', 'deezer', '123')`).run();

  const handler = getPostHandler("/regenerate");
  const res = createMockResponse();

  await handler({
    body: {
      scope: "track",
      entityId: "123",
      kind: "tags",
    },
  }, res);

  assert.equal(res.statusCode, 202);
  assert.equal(res.body.success, true);
  assert.equal(res.body.queued, true);
  assert.equal(res.body.commandIds.length, 1);

  const command = dbModule.db.prepare(`
    SELECT name, ref_id, payload
    FROM commands
    ORDER BY id DESC
    LIMIT 1
  `).get() as { name: string; ref_id: string | null; payload: string };

  assert.equal(command.name, "RetagFiles");
  assert.equal(command.ref_id, 'retag-files:{"ids":[123]}');

  const payload = JSON.parse(command.payload);
  assert.deepEqual(payload.ids, [123]);
  assert.equal(payload.applyAll, false);
});

test("track regeneration rejects ambiguous resource identifiers and missing file rows", async () => {
  const handler = getPostHandler('/regenerate');
  for (const [entityId, expected] of [['provider-track', 400], ['999999', 404]]) {
    const res = createMockResponse();
    await handler({ body: { scope: 'track', kind: 'tags', entityId } }, res);
    assert.equal(res.statusCode, expected);
  }
  assert.equal((dbModule.db.prepare('SELECT COUNT(*) n FROM commands').get() as {n:number}).n, 0);
});
