import "./setup-test-env.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

const databaseModule = await import("../../../database.js");
databaseModule.initDatabase();
const authState = await import("../provider-auth-state.js");
const {
  APPLE_WRAPPER_SESSION_MARKER,
  checkTcpPort,
  getWrapperLoginStatus,
  saveStoredAppleMusicToken,
} = await import("./apple-music-auth.js");

function listenOnV4(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer();
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

test("IPv6-first DNS still counts an IPv4-only listener as open", async () => {
  const { server, port } = await listenOnV4();
  try {
    const open = await checkTcpPort("apple-music-wrapper", port, 2_000, (_host, _options, callback) => {
      callback(null, [
        { address: "::1", family: 6 },
        { address: "127.0.0.1", family: 4 },
      ]);
    });
    assert.equal(open, true);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test("a hanging address does not hide an address that already accepted", async () => {
  const { server, port } = await listenOnV4();
  const started = Date.now();
  try {
    const open = await checkTcpPort("apple-music-wrapper", port, 3_000, (_host, _options, callback) => {
      callback(null, [
        { address: "192.0.2.1", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]);
    });
    assert.equal(open, true);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_000, `returned in ${elapsed}ms; a hanging address must not use the whole timeout`);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test("a port that refuses every address is closed", async () => {
  const { server, port } = await listenOnV4();
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  const open = await checkTcpPort("apple-music-wrapper", port, 1_000, (_host, _options, callback) => {
    callback(null, [
      { address: "::1", family: 6 },
      { address: "127.0.0.1", family: 4 },
    ]);
  });
  assert.equal(open, false);
});

test("startup grace does not hold Apple while the sidecar is still binding", async () => {
  fs.mkdirSync(path.dirname(APPLE_WRAPPER_SESSION_MARKER), { recursive: true });
  fs.writeFileSync(APPLE_WRAPPER_SESSION_MARKER, "session");
  const dataDir = path.resolve(APPLE_WRAPPER_SESSION_MARKER, "..", "..", "..", "..", "..");
  const loginStatusPath = path.join(dataDir, "login_status.json");
  fs.writeFileSync(loginStatusPath, JSON.stringify({
    status: "success",
    message: "Decryption server is running with an active session.",
  }));
  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(loginStatusPath, old, old);
  saveStoredAppleMusicToken({ media_user_token: "token" });
  await authState.recordProviderAuthOk("apple-music", { force: true });

  const starting = await getWrapperLoginStatus({ checkPort: async () => false });
  assert.equal(starting.status, "logging_in");
  assert.equal(authState.providerNeedsReauth("apple-music"), false);

  const later = await getWrapperLoginStatus({
    checkPort: async () => false,
    now: Date.now() + 60_000,
  });
  assert.equal(later.status, "failed");
  assert.equal(authState.providerNeedsReauth("apple-music"), true);
});
