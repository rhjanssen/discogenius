import assert from "node:assert/strict";
import test from "node:test";
import {
  createPinnedLookup,
  isPrivateNetworkAddress,
  validatePublicHttpUrl,
  type LookupAll,
} from "./outbound-http.js";

test("private, loopback, link-local, documentation, and mapped addresses are blocked", () => {
  for (const address of [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1",
    "172.16.0.1", "192.168.1.100", "198.18.0.1", "224.0.0.1", "::", "::1",
    "fc00::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
  ]) {
    assert.equal(isPrivateNetworkAddress(address), true, address);
  }
  assert.equal(isPrivateNetworkAddress("1.1.1.1"), false);
  assert.equal(isPrivateNetworkAddress("2606:4700:4700::1111"), false);
});

test("outbound URL validation rejects local names, credentials, and unsafe DNS answers", async () => {
  const publicLookup: LookupAll = async () => [{ address: "1.1.1.1", family: 4 }];
  const privateLookup: LookupAll = async () => [{ address: "192.168.1.100", family: 4 }];

  await assert.rejects(validatePublicHttpUrl("http://localhost/a", publicLookup), /Private outbound host/);
  await assert.rejects(validatePublicHttpUrl("http://service.local/a", publicLookup), /Private outbound host/);
  await assert.rejects(validatePublicHttpUrl("file:///etc/passwd", publicLookup), /Unsupported outbound URL scheme/);
  await assert.rejects(validatePublicHttpUrl("https://user:pass@example.com/a", publicLookup), /credentials/);
  await assert.rejects(validatePublicHttpUrl("https://cdn.example/a", privateLookup), /Private outbound address/);
  await assert.rejects(
    validatePublicHttpUrl("https://cdn.example/a", async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
    /Private outbound address/,
  );

  const parsed = await validatePublicHttpUrl("https://cdn.example/a", publicLookup);
  assert.equal(parsed.hostname, "cdn.example");
});

test("pinned lookup follows Node's scalar and all-address callback contracts", () => {
  const resolved = { address: "1.1.1.1", family: 4 };
  const lookup = createPinnedLookup(resolved);
  const calls: unknown[][] = [];

  lookup("cdn.example", {}, (...args) => calls.push(args));
  lookup("cdn.example", { all: true }, (...args) => calls.push(args));

  assert.deepEqual(calls, [
    [null, "1.1.1.1", 4],
    [null, [resolved]],
  ]);
});
