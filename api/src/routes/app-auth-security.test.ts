import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import type { Server } from "node:http";
import appAuthRouter from "./app-auth.js";

const password = "correct horse battery staple";
const secret = "app-auth-security-test-secret";
let server: Server;
let baseUrl: string;

before(async () => {
  process.env.ADMIN_PASSWORD = password;
  process.env.JWT_SECRET = secret;
  const app = express();
  app.use(express.json());
  app.use("/app-auth", appAuthRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  delete process.env.ADMIN_PASSWORD;
  delete process.env.JWT_SECRET;
});

test("login issues an HS256 token with the full password fingerprint", async () => {
  const login = await fetch(`${baseUrl}/app-auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const body = await login.json() as { token: string };
  const decoded = jwt.verify(body.token, secret, { algorithms: ["HS256"] }) as jwt.JwtPayload;
  assert.equal(decoded.fp, crypto.createHash("sha256").update(password).digest("hex"));

  const verify = await fetch(`${baseUrl}/app-auth/verify`, {
    headers: { authorization: `Bearer ${body.token}` },
  });
  assert.equal(verify.status, 200);
});

test("query tokens are rejected on ordinary JSON endpoints", async () => {
  const token = jwt.sign({ fp: crypto.createHash("sha256").update(password).digest("hex") }, secret);
  const response = await fetch(`${baseUrl}/app-auth/verify?token=${encodeURIComponent(token)}`);
  assert.equal(response.status, 401);
});

test("login throttles repeated failures by client address", async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`${baseUrl}/app-auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: `wrong-${attempt}` }),
    });
    assert.equal(response.status, 401);
  }

  const blocked = await fetch(`${baseUrl}/app-auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
});
