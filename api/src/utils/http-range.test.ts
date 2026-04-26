import assert from "node:assert/strict";
import test from "node:test";
import { parseSingleByteRange } from "./http-range.js";

test("parseSingleByteRange accepts common single-range forms", () => {
  assert.deepEqual(parseSingleByteRange(undefined, 100), {
    satisfiable: true,
    range: null,
  });
  assert.deepEqual(parseSingleByteRange("bytes=10-19", 100), {
    satisfiable: true,
    range: { start: 10, end: 19, chunkSize: 10 },
  });
  assert.deepEqual(parseSingleByteRange("bytes=90-", 100), {
    satisfiable: true,
    range: { start: 90, end: 99, chunkSize: 10 },
  });
  assert.deepEqual(parseSingleByteRange("bytes=-10", 100), {
    satisfiable: true,
    range: { start: 90, end: 99, chunkSize: 10 },
  });
  assert.deepEqual(parseSingleByteRange("bytes=90-200", 100), {
    satisfiable: true,
    range: { start: 90, end: 99, chunkSize: 10 },
  });
});

test("parseSingleByteRange rejects malformed or unsatisfiable ranges", () => {
  assert.deepEqual(parseSingleByteRange("bytes=100-120", 100), {
    satisfiable: false,
    contentRange: "bytes */100",
  });
  assert.deepEqual(parseSingleByteRange("bytes=20-10", 100), {
    satisfiable: false,
    contentRange: "bytes */100",
  });
  assert.deepEqual(parseSingleByteRange("bytes=0-1,4-5", 100), {
    satisfiable: false,
    contentRange: "bytes */100",
  });
  assert.deepEqual(parseSingleByteRange("items=0-10", 100), {
    satisfiable: false,
    contentRange: "bytes */100",
  });
  assert.deepEqual(parseSingleByteRange("bytes=0-0", 0), {
    satisfiable: false,
    contentRange: "bytes */0",
  });
});
