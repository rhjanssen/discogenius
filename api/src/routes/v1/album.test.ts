import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { RequestValidationError } from "../../utils/request-validation.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-album-route-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.album.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let albumMutationHttpStatus: typeof import("./album.js").albumMutationHttpStatus;

before(async () => {
  ({ albumMutationHttpStatus } = await import("./album.js"));
});

test("albumMutationHttpStatus maps validation and busy separately from conflicts", () => {
  assert.equal(albumMutationHttpStatus(new RequestValidationError("planKey is required")), 400);
  assert.equal(albumMutationHttpStatus(Object.assign(new Error("edition in use"), { status: 409 })), 409);
  assert.equal(albumMutationHttpStatus(Object.assign(new Error("missing"), { status: 404 })), 404);

  const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  assert.equal(albumMutationHttpStatus(busy), 503);
  assert.equal(albumMutationHttpStatus(new Error("database is locked")), 503);

  assert.equal(albumMutationHttpStatus(new Error("unexpected")), 500);
});
