import assert from "node:assert/strict";
import { test } from "node:test";
import { withSqliteWriteGate } from "./database.js";

test("withSqliteWriteGate serializes overlapping async writers", async () => {
  const order: string[] = [];
  let enterFirst!: () => void;
  let releaseFirst!: () => void;
  const entered = new Promise<void>(resolve => { enterFirst = resolve; });
  const release = new Promise<void>(resolve => { releaseFirst = resolve; });
  const first = withSqliteWriteGate(async () => {
    order.push("a-start");
    enterFirst();
    await release;
    order.push("a-end");
    return "a";
  });
  // Cold dynamic imports need not resolve in invocation order. Establish an
  // admitted owner before testing whether another writer can overlap it.
  await entered;
  const second = withSqliteWriteGate(async () => {
    order.push("b-start");
    order.push("b-end");
    return "b";
  });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(order, ["a-start"]);
  } finally {
    releaseFirst();
  }
  const results = await Promise.all([first, second]);
  assert.deepEqual(results, ["a", "b"]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
});
