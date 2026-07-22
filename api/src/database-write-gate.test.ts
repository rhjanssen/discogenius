import assert from "node:assert/strict";
import { test } from "node:test";
import { withSqliteWriteGate } from "./database.js";

test("withSqliteWriteGate serializes overlapping async writers", async () => {
  const order: string[] = [];
  const first = withSqliteWriteGate(async () => {
    order.push("a-start");
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push("a-end");
    return "a";
  });
  const second = withSqliteWriteGate(async () => {
    order.push("b-start");
    order.push("b-end");
    return "b";
  });
  const results = await Promise.all([first, second]);
  assert.deepEqual(results, ["a", "b"]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
});
