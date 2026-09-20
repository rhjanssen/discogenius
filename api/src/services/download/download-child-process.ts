import { spawn, execFileSync, type SpawnOptions } from "node:child_process";
import { isMainThread, parentPort, workerData, type Worker } from "node:worker_threads";

type ChildMessage = { kind: "downloadChildStarted" | "downloadChildExited"; pid: number };

/** Native downloaders outlive worker.terminate(); their owner must retire them. */
export const spawnDownloadProcess: typeof spawn = ((...args: Parameters<typeof spawn>) => {
  const [command, argvOrOptions, trailingOptions] = args;
  const argv = Array.isArray(argvOrOptions) ? argvOrOptions : [];
  const options = (Array.isArray(argvOrOptions) ? trailingOptions : argvOrOptions) as SpawnOptions | undefined;
  const supervised = !isMainThread && workerData?.discogeniusDownloadWorker === true;
  const child = spawn(command, argv, {
    ...options,
    ...(supervised && process.platform !== "win32" ? { detached: true } : {}),
  });
  if (supervised && child.pid) {
    const pid = child.pid;
    parentPort!.postMessage({ kind: "downloadChildStarted", pid } satisfies ChildMessage);
    child.once("close", () => {
      parentPort!.postMessage({ kind: "downloadChildExited", pid } satisfies ChildMessage);
    });
  }
  return child;
}) as typeof spawn;

export function superviseDownloadProcesses(worker: Worker): void {
  const children = new Set<number>();
  worker.on("message", (message: ChildMessage) => {
    if (!Number.isSafeInteger(message.pid) || message.pid <= 0) return;
    if (message.kind === "downloadChildStarted") children.add(message.pid);
    if (message.kind === "downloadChildExited") children.delete(message.pid);
  });
  // Register before the recovery listener, so native processes are stopped
  // before failed attempts can be claimed by a replacement worker.
  worker.once("exit", () => {
    for (const pid of children) {
      try {
        if (process.platform === "win32") {
          execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } else {
          process.kill(-pid, "SIGKILL");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          console.warn(`[DOWNLOAD-PROCESSOR] Could not retire downloader ${pid}:`, error);
        }
      }
    }
    children.clear();
  });
}
