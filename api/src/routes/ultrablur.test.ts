import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, test } from "node:test";

import express from "express";
import * as pngjs from "pngjs";

import ultraBlurRouter from "./ultrablur.js";

const PNG = (pngjs as unknown as { PNG: any }).PNG as any;

let server: Server | null = null;
let baseUrl = "";

beforeEach(async () => {
  const app = express();
  app.use("/services/ultrablur", ultraBlurRouter);
  server = createServer(app);

  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  if (!server) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server!.close((error) => error ? reject(error) : resolve());
  });
  server = null;
});

test("ultrablur image endpoint renders a cacheable server-side PNG", async () => {
  const response = await fetch(`${baseUrl}/services/ultrablur/image?topLeft=%23AA0000&topRight=%2300AA00&bottomLeft=%230000AA&bottomRight=%23AAAA00&width=640&height=360`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^image\/png/);
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");

  const bytes = Buffer.from(await response.arrayBuffer());
  const decoded = PNG.sync.read(bytes);
  assert.equal(decoded.width, 640);
  assert.equal(decoded.height, 360);
  assert.ok(bytes.byteLength > 1000);
});

test("ultrablur image endpoint clamps excessive render dimensions", async () => {
  const response = await fetch(`${baseUrl}/services/ultrablur/image?width=9999&height=9999`);

  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  const decoded = PNG.sync.read(bytes);
  assert.equal(decoded.width, 1920);
  assert.equal(decoded.height, 1080);
});

test("ultrablur colors endpoint rejects non-http image URLs", async () => {
  const response = await fetch(`${baseUrl}/services/ultrablur/colors?url=${encodeURIComponent("file:///etc/passwd")}`);

  assert.equal(response.status, 400);
  const body = await response.json() as { detail?: string };
  assert.match(body.detail || "", /http\/https/i);
});
