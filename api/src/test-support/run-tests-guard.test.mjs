import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTapFailures,
  describeRunnerStop,
  isCloneFlakeOnly,
  reporterSummary,
  runnerCompleted,
  runnerSucceeded,
} from "../../scripts/run-tests.mjs";

const node22Success = `
TAP version 13
ok 1 - passes
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10
`;

const node24Success = `
\u2139 tests 2615
\u2139 suites 0
\u2139 pass 2615
\u2139 fail 0
\u2139 cancelled 0
\u2139 skipped 6
\u2139 todo 0
\u2139 duration_ms 45
`;

test("Node 22 TAP summary counts as a finished successful run", () => {
  const result = { status: 0, stdout: node22Success, stderr: "" };
  assert.deepEqual(reporterSummary(node22Success), { tests: 1, fail: 0 });
  assert.equal(runnerCompleted(result), true);
  assert.equal(runnerSucceeded(result), true);
});

test("Node 24 spec summary counts as success without a TAP plan line", () => {
  const result = { status: 0, stdout: node24Success, stderr: "" };
  assert.equal(/^1\.\.\d+\s*$/m.test(node24Success), false);
  assert.deepEqual(reporterSummary(node24Success), { tests: 2615, fail: 0 });
  assert.equal(runnerCompleted(result), true);
  assert.equal(runnerSucceeded(result), true);
});

test("a missing summary or a killed runner is incomplete", () => {
  assert.equal(runnerCompleted({ status: 0, stdout: "ok 1 - passes\n", stderr: "" }), false);
  assert.equal(runnerSucceeded({ status: 0, stdout: node24Success, stderr: "", signal: "SIGKILL" }), false);
  assert.equal(runnerCompleted({
    status: null,
    stdout: "",
    stderr: "",
    error: Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" }),
  }), false);
  assert.match(
    describeRunnerStop({
      status: null,
      signal: "SIGTERM",
      error: Object.assign(new Error("maxBuffer exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
      stdout: "",
      stderr: "",
    }),
    /status=null/,
  );
  assert.match(
    describeRunnerStop({
      status: null,
      signal: "SIGTERM",
      error: Object.assign(new Error("maxBuffer exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
      stdout: "",
      stderr: "",
    }),
    /signal=SIGTERM/,
  );
  assert.match(
    describeRunnerStop({
      status: null,
      signal: "SIGTERM",
      error: Object.assign(new Error("maxBuffer exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
      stdout: "",
      stderr: "",
    }),
    /ERR_CHILD_PROCESS_STDIO_MAXBUFFER/,
  );
});

test("clone-flake diagnostics are not assertion failures", () => {
  const stdout = `
not ok 4 - a download import started from a queue wake completes the whole pipeline
  ---
  location: '/home/runner/work/discogenius/discogenius/api/src/services/mediafiles/import-pipeline.e2e.test.ts:10:1'
  failureType: 'testCodeFailure'
  error: 'Unable to deserialize cloned data.'
  code: 'ERR_TEST_FAILURE'
  ...
not ok 5 - title mismatch
  ---
  location: '/home/runner/work/discogenius/discogenius/api/src/services/mediafiles/import-pipeline.e2e.test.ts:20:1'
  error: 'boom'
  ...
# tests 5
# fail 2
`;
  const classified = classifyTapFailures(stdout);
  assert.deepEqual(classified.flakeFiles, ["src/services/mediafiles/import-pipeline.e2e.test.ts"]);
  assert.deepEqual(classified.realTests, ["title mismatch"]);
  const flake = isCloneFlakeOnly(stdout, "", 1);
  assert.equal(flake.flaked, true);
  assert.deepEqual(flake.failedTests, ["title mismatch"]);
});

test("a non-zero status with only clone-flake tests can be retried", () => {
  const stdout = `
not ok 8 - src/services/mediafiles/vorbis-removal-keys.test.ts
  ---
  location: 'src/services/mediafiles/vorbis-removal-keys.test.ts:1:1'
  error: 'Unable to deserialize cloned data.'
  ...
# tests 8
# fail 1
`;
  const flake = isCloneFlakeOnly(stdout, "Unable to deserialize cloned data.", 1);
  assert.equal(flake.flaked, true);
  assert.deepEqual(flake.failedTests, []);
  assert.deepEqual(flake.failedFiles, ["src/services/mediafiles/vorbis-removal-keys.test.ts"]);
});
