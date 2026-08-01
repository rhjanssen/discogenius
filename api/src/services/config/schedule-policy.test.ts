import assert from "node:assert/strict";
import test from "node:test";
import {
  isScheduledTaskDue,
  parseScheduledTaskTime,
} from "./schedule-policy.js";

test("SQLite scheduler timestamps are interpreted as UTC", () => {
  assert.equal(
    parseScheduledTaskTime("2026-01-02 03:04:05"),
    Date.parse("2026-01-02T03:04:05Z"),
  );
});

test("explicitly zoned scheduler timestamps retain their supplied offset", () => {
  assert.equal(
    parseScheduledTaskTime("2026-01-02T03:04:05+02:00"),
    Date.parse("2026-01-02T03:04:05+02:00"),
  );
});

test("a freshly stamped SQLite UTC time is not immediately due", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-01-02T03:10:00Z");
  try {
    assert.equal(isScheduledTaskDue(30, "2026-01-02 03:04:05"), false);
  } finally {
    Date.now = originalNow;
  }
});

test("a scheduler timestamp ahead of the current clock is due for repair", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-01-02T03:10:00Z");
  try {
    assert.equal(isScheduledTaskDue(30, "2026-01-02 04:10:00"), true);
  } finally {
    Date.now = originalNow;
  }
});
