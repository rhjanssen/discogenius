import assert from "node:assert/strict";
import fs from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import express from "express";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-media-cover-route-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.media-cover-route.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let server: Server;
let baseUrl: string;
const originalFetch = globalThis.fetch;

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  const mediaCoverRouter = (await import("./media-cover.js")).default;
  const app = express();
  app.use("/media-cover", mediaCoverRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(path.join(tempDir, "media-cover"), { recursive: true, force: true });
});

after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeCurrentMarker(folder: string, coverType: string): void {
  fs.writeFileSync(
    path.join(folder, `.${coverType.toLowerCase()}.source.json`),
    JSON.stringify({
      url: "https://example.test/cover.jpg",
      preference: "canonical",
      fulfilledBy: "canonical",
    }),
  );
}

function rawRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ statusCode: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        statusCode: response.statusCode || 0,
        body: Buffer.concat(chunks),
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("album requests serve the exact requested derivative before larger variants", async () => {
  const folder = path.join(tempDir, "media-cover", "Albums", "exact-album");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "cover-500.jpg"), Buffer.alloc(50, 5));
  fs.writeFileSync(path.join(folder, "cover-250.jpg"), Buffer.alloc(25, 2));
  writeCurrentMarker(folder, "Cover");

  const derivative = await fetch(`${baseUrl}/media-cover/Albums/exact-album/cover-250.jpg`);
  assert.equal(derivative.status, 200);
  assert.deepEqual(Buffer.from(await derivative.arrayBuffer()), Buffer.alloc(25, 2));

  const stableAlias = await fetch(`${baseUrl}/media-cover/Albums/exact-album/cover.jpg`);
  assert.equal(stableAlias.status, 200);
  assert.deepEqual(Buffer.from(await stableAlias.arrayBuffer()), Buffer.alloc(50, 5));
});

test("detail requests prefer the origin over a smaller cached derivative", async () => {
  const folder = path.join(tempDir, "media-cover", "Albums", "origin-fallback-album");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "cover.jpg"), Buffer.alloc(100, 9));
  fs.writeFileSync(path.join(folder, "cover-250.jpg"), Buffer.alloc(25, 2));
  writeCurrentMarker(folder, "Cover");

  const response = await fetch(
    `${baseUrl}/media-cover/Albums/origin-fallback-album/cover-500.jpg`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.alloc(100, 9));
});

test("video card requests serve the 250px derivative instead of the full origin", async () => {
  const folder = path.join(tempDir, "media-cover", "Videos", "exact-video");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "cover.jpg"), Buffer.alloc(100, 9));
  fs.writeFileSync(path.join(folder, "cover-250.jpg"), Buffer.alloc(20, 2));
  writeCurrentMarker(folder, "Cover");

  const derivative = await fetch(`${baseUrl}/media-cover/Videos/exact-video/cover-250.jpg`);
  assert.equal(derivative.status, 200);
  assert.deepEqual(Buffer.from(await derivative.arrayBuffer()), Buffer.alloc(20, 2));

  const origin = await fetch(`${baseUrl}/media-cover/Videos/exact-video/cover.jpg`);
  assert.equal(origin.status, 200);
  assert.deepEqual(Buffer.from(await origin.arrayBuffer()), Buffer.alloc(100, 9));
});

test("local covers expose validators, content length, HEAD, and conditional 304", async () => {
  const folder = path.join(tempDir, "media-cover", "Albums", "validated-album");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "cover-500.jpg"), Buffer.alloc(64, 7));
  writeCurrentMarker(folder, "Cover");

  const url = `${baseUrl}/media-cover/Albums/validated-album/cover-500.jpg`;
  const first = await fetch(url);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-length"), "64");
  assert.ok(first.headers.get("last-modified"));
  assert.ok(first.headers.get("etag"));
  assert.equal(first.headers.get("accept-ranges"), "bytes");
  assert.equal(first.headers.get("cache-control"), "public, max-age=31536000, immutable");
  await first.arrayBuffer();

  const conditional = await rawRequest(url, {
    headers: { "If-None-Match": String(first.headers.get("etag")) },
  });
  assert.equal(conditional.statusCode, 304);
  assert.equal(conditional.body.byteLength, 0);

  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "64");
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test("a true cache miss returns 404 without acquiring artwork on the delivery route", async () => {
  const albumMbid = "route-cold-miss-album";
  const artistMbid = "route-cold-miss-artist";
  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run(artistMbid, "Cold Miss Artist");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, images) VALUES (?, ?, ?, ?)")
    .run(
      albumMbid,
      artistMbid,
      "Cold Miss Album",
      JSON.stringify([{ coverType: "Cover", url: "https://example.test/remote.jpg" }]),
    );

  let remoteFetches = 0;
  globalThis.fetch = (async () => {
    remoteFetches += 1;
    throw new Error("delivery route must not fetch");
  }) as typeof fetch;

  const response = await rawRequest(
    `${baseUrl}/media-cover/Albums/${albumMbid}/cover.jpg`,
  );
  assert.equal(response.statusCode, 404);
  assert.equal(remoteFetches, 0);
});

test("existing local covers are served immediately without blocking on source refresh", async () => {
  const albumMbid = "route-source-change-album";
  const artistMbid = "route-source-change-artist";
  const oldUrl = "https://example.test/artwork/old.jpg";
  const newUrl = "https://example.test/artwork/new.jpg";
  const folder = path.join(tempDir, "media-cover", "Albums", albumMbid);
  const oldBytes = Buffer.alloc(37, 7);

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run(artistMbid, "Route Source Change Artist");
  dbModule.db.prepare("INSERT INTO Albums (mbid, artist_mbid, title, images) VALUES (?, ?, ?, ?)")
    .run(
      albumMbid,
      artistMbid,
      "Route Source Change Album",
      JSON.stringify([{ coverType: "Cover", url: newUrl }]),
    );
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "cover-500.jpg"), oldBytes);
  fs.writeFileSync(
    path.join(folder, ".cover.source.json"),
    JSON.stringify({ url: oldUrl, preference: "canonical", fulfilledBy: "canonical" }),
  );
  let fetchCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    fetchCalls += 1;
    return originalFetch(input, init);
  }) as typeof fetch;

  const response = await fetch(
    `${baseUrl}/media-cover/Albums/${albumMbid}/cover.jpg?source=canonical&rev=new`,
  );
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.deepEqual(body, oldBytes);
  assert.equal(
    fetchCalls,
    1,
    "browser/fetch client for the assertion itself counts as one; route must not pull remote artwork",
  );
});

test("existing video covers are served immediately without blocking on source refresh", async () => {
  const oldUrl = "https://example.test/video/old.jpg";
  const newUrl = "https://example.test/video/new.jpg";
  const recording = dbModule.db.prepare(`
    INSERT INTO Recordings (title, is_video, cover_image_url, metadata_status)
    VALUES ('Changed Video Cover', 1, ?, 'provider_catalog')
    RETURNING id
  `).get(newUrl) as { id: number };
  const folder = path.join(tempDir, "media-cover", "Videos", String(recording.id));
  const oldBytes = Buffer.alloc(41, 3);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "cover.jpg"), oldBytes);
  fs.writeFileSync(path.join(folder, "cover-250.jpg"), Buffer.alloc(20, 3));
  fs.writeFileSync(
    path.join(folder, ".cover.source.json"),
    JSON.stringify({ url: oldUrl, preference: "canonical", fulfilledBy: "canonical" }),
  );
  let fetchCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    fetchCalls += 1;
    return originalFetch(input, init);
  }) as typeof fetch;

  const response = await fetch(
    `${baseUrl}/media-cover/Videos/${recording.id}/cover.jpg?rev=new`,
  );
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.deepEqual(body, oldBytes);
  assert.equal(fetchCalls, 1);
});
