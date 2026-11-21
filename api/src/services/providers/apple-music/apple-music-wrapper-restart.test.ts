import "./setup-test-env.js";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { WRAPPER_ENTRYPOINT_SCRIPT, WRAPPER_ENTRYPOINT_VERSION } from "./apple-music-auth.js";

function isDockerRunning(): boolean {
  try {
    const res = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 10000 });
    return res.status === 0;
  } catch {
    return false;
  }
}

test("entrypoint script contains v12 marker, setsid, pkill, readiness check, and crash-loop guidance", () => {
  assert.equal(WRAPPER_ENTRYPOINT_VERSION, "discogenius-wrapper-entrypoint v12");
  assert.match(WRAPPER_ENTRYPOINT_SCRIPT, /# discogenius-wrapper-entrypoint v12/);
  assert.match(WRAPPER_ENTRYPOINT_SCRIPT, /pkill -9 -f "wrapper\.\*-M 20020"/);
  assert.match(WRAPPER_ENTRYPOINT_SCRIPT, /setsid \.\/wrapper -M 20020 -D 10020 -H 0\.0\.0\.0/);
  assert.match(WRAPPER_ENTRYPOINT_SCRIPT, /stop_server/);
  assert.match(WRAPPER_ENTRYPOINT_SCRIPT, /ports_bound/);
  // Readiness check: TCP connect with 1s timeout on both ports 10020 and 20020
  assert.match(WRAPPER_ENTRYPOINT_SCRIPT, /timeout 1 bash -c 'exec 3<>\/dev\/tcp\/127\.0\.0\.1\/10020 && exec 3>&-'/);
  assert.match(WRAPPER_ENTRYPOINT_SCRIPT, /timeout 1 bash -c 'exec 3<>\/dev\/tcp\/127\.0\.0\.1\/20020 && exec 3>&-'/);
  assert.match(WRAPPER_ENTRYPOINT_SCRIPT, /answers/);
  assert.match(WRAPPER_ENTRYPOINT_SCRIPT, /Restart the wrapper container \(docker compose restart apple-music-wrapper\)/);
});

test("shell-level verification: restart request leaves exactly one wrapper process tree and ports 10020/20020 answer", {
  skip: !isDockerRunning() ? "Docker is not available in this environment" : false,
}, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dg-wrapper-test-"));
  const dataDir = path.join(tmpDir, "data");
  const sessionDir = path.join(dataDir, "data", "com.apple.android.music", "files", "mpl_db");
  fs.mkdirSync(sessionDir, { recursive: true });

  // Provision session marker so supervisor starts server immediately
  fs.writeFileSync(path.join(sessionDir, "cookies.sqlitedb"), "dummy-session", "utf-8");
  // Write entrypoint script
  const scriptPath = path.join(dataDir, "wrapper-entrypoint.sh");
  fs.writeFileSync(scriptPath, WRAPPER_ENTRYPOINT_SCRIPT, { mode: 0o755 });

  const containerName = `dg-test-wrapper-${Date.now()}`;
  try {
    // Start container with entrypoint
    execSync(
      `docker run -d --name ${containerName} -v "${dataDir}:/app/rootfs/data" ghcr.io/itouakirai/wrapper:x86@sha256:e47a5f42a3db65296dc641b379b48fc3752dae1d21c7e712c3dd2e7f7e0c2482 /bin/bash /app/rootfs/data/wrapper-entrypoint.sh`,
      { stdio: "pipe" },
    );

    // Wait up to 20s for server to become ready
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const statusJson = path.join(dataDir, "login_status.json");
        if (fs.existsSync(statusJson)) {
          const parsed = JSON.parse(fs.readFileSync(statusJson, "utf-8"));
          if (parsed.status === "success") {
            ready = true;
            break;
          }
        }
      } catch {
        // Retry
      }
    }
    assert.equal(ready, true, "Supervisor should report success after starting decryption server");

    // Check process count inside container: should have exactly one parent wrapper and one child wrapper
    const psInitial = execSync(
      `docker exec ${containerName} /bin/bash -c "pgrep -f '[w]rapper -M 20020' | wc -l"`,
      { encoding: "utf-8" },
    ).trim();
    assert.equal(psInitial, "2", "Initial startup should have exactly 2 wrapper processes (parent + child)");

    // Verify ports 10020 and 20020 answer connections
    const portInitial = execSync(
      `docker exec ${containerName} /bin/bash -c "timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/10020 && exec 3>&-' && timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/20020 && exec 3>&-' && echo 'ok'"`,
      { encoding: "utf-8" },
    ).trim();
    assert.equal(portInitial, "ok", "Ports 10020 and 20020 should answer connections initially");

    // Request restart by dropping restart_server.txt
    const restartFile = path.join(dataDir, "restart_server.txt");
    fs.writeFileSync(restartFile, new Date().toISOString(), "utf-8");

    // Wait for restart_server.txt to be consumed by supervisor
    let consumed = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (!fs.existsSync(restartFile)) {
        consumed = true;
        break;
      }
    }
    assert.equal(consumed, true, "restart_server.txt should be consumed by supervisor");

    // Wait up to 15s for the server to be ready after restart
    let readyAfterRestart = false;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const check = execSync(
          `docker exec ${containerName} /bin/bash -c "timeout 1 bash -c 'exec 3<>/dev/tcp/127.0.0.1/10020 && exec 3>&-' && timeout 1 bash -c 'exec 3<>/dev/tcp/127.0.0.1/20020 && exec 3>&-' && echo 'ok'"`,
          { encoding: "utf-8" },
        ).trim();
        if (check === "ok") {
          readyAfterRestart = true;
          break;
        }
      } catch {
        // Retrying
      }
    }
    assert.equal(readyAfterRestart, true, "Ports 10020 and 20020 should answer connections after restart");

    // Verify process count after restart: exactly 2 wrapper processes (1 parent + 1 child), NO ORPHANS!
    const psAfterRestart = execSync(
      `docker exec ${containerName} /bin/bash -c "pgrep -f '[w]rapper -M 20020' | wc -l"`,
      { encoding: "utf-8" },
    ).trim();
    assert.equal(psAfterRestart, "2", "After restart, exactly 2 wrapper processes must exist (parent + child; no orphaned processes)");
  } finally {
    try {
      execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
    } catch {
      // Ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
});

test("shell-level verification: once the PID namespace passes 65535 the supervisor restarts the container and the wrapper answers again", {
  skip: !isDockerRunning() ? "Docker is not available in this environment" : false,
}, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dg-wrapper-pid-test-"));
  const dataDir = path.join(tmpDir, "data");
  const sessionDir = path.join(dataDir, "data", "com.apple.android.music", "files", "mpl_db");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "cookies.sqlitedb"), "dummy-session", "utf-8");
  fs.writeFileSync(path.join(dataDir, "wrapper-entrypoint.sh"), WRAPPER_ENTRYPOINT_SCRIPT, { mode: 0o755 });

  const containerName = `dg-test-wrapper-pid-${Date.now()}`;
  const sh = (cmd: string) => execSync(`docker exec ${containerName} /bin/bash -c "${cmd}"`, { encoding: "utf-8" }).trim();
  const portsAnswer = () => {
    try {
      return sh("timeout 1 bash -c 'exec 3<>/dev/tcp/127.0.0.1/10020 && exec 3>&-' && timeout 1 bash -c 'exec 3<>/dev/tcp/127.0.0.1/20020 && exec 3>&-' && echo ok") === "ok";
    } catch {
      return false;
    }
  };
  const waitFor = async (check: () => boolean, seconds: number) => {
    for (let i = 0; i < seconds; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (check()) return true;
    }
    return false;
  };
  try {
    // --privileged so the test can move the namespace PID counter (production never needs it).
    execSync(
      `docker run -d --privileged --restart unless-stopped --name ${containerName} -v "${dataDir}:/app/rootfs/data" ghcr.io/itouakirai/wrapper:x86@sha256:e47a5f42a3db65296dc641b379b48fc3752dae1d21c7e712c3dd2e7f7e0c2482 /bin/bash /app/rootfs/data/wrapper-entrypoint.sh`,
      { stdio: "pipe" },
    );
    assert.equal(await waitFor(portsAnswer, 20), true, "Ports should answer after the first start");

    // The wrapper still starts threads right after its ports open; measure once it has settled.
    await new Promise((r) => setTimeout(r, 15000));
    const idleStart = Number(sh("cat /proc/sys/kernel/ns_last_pid"));
    await new Promise((r) => setTimeout(r, 10000));
    const idleEnd = Number(sh("cat /proc/sys/kernel/ns_last_pid"));
    // Each docker exec costs one id; an idle supervisor itself must not fork.
    assert.ok(idleEnd - idleStart <= 3, `Idle supervisor used ${idleEnd - idleStart} PIDs in 10s`);

    sh("echo 70000 > /proc/sys/kernel/ns_last_pid");
    fs.writeFileSync(path.join(dataDir, "restart_server.txt"), new Date().toISOString(), "utf-8");

    const restarted = await waitFor(
      () => Number(execSync(`docker inspect -f '{{.RestartCount}}' ${containerName}`, { encoding: "utf-8" }).trim()) >= 1,
      30,
    );
    assert.equal(restarted, true, "Supervisor should exit so Docker restarts the container with a fresh PID namespace");
    assert.equal(await waitFor(portsAnswer, 30), true, "Ports should answer again after the container restart");
    assert.ok(Number(sh("cat /proc/sys/kernel/ns_last_pid")) < 65535, "The restarted container should run in a fresh PID namespace");
  } finally {
    try {
      execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
    } catch {
      // Ignore
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
