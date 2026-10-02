import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { withMediaFileLock } from "./media-file-lock.js";

export function mediaRewritePath(originalPath: string, kind: "tags" | "rewrite" = "rewrite"): string {
  return path.join(path.dirname(originalPath), `.discogenius-${kind}-${randomUUID()}${path.extname(originalPath)}`);
}

/** Only exclude files owned by our rewrite protocol, not arbitrary hidden music. */
export function isMediaRewriteTemporaryName(name: string): boolean {
  return /^\.discogenius-(?:tags|rewrite)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[^/\\]+$/i.test(name);
}

export async function rewriteMediaCopy(
  originalPath: string, mutate: (workingPath: string) => Promise<boolean>,
): Promise<boolean> {
  return withMediaFileLock(originalPath, () => rewriteMediaCopyUnlocked(originalPath, mutate));
}

async function rewriteMediaCopyUnlocked(
  originalPath: string,
  mutate: (workingPath: string) => Promise<boolean>,
): Promise<boolean> {
  const workingPath = mediaRewritePath(originalPath, "tags");
  try {
    await fs.promises.copyFile(originalPath, workingPath, fs.constants.COPYFILE_EXCL);
    if (!await mutate(workingPath)) return false;
    replaceMediaFile(originalPath, workingPath);
    return true;
  } finally {
    await fs.promises.rm(workingPath, { force: true });
  }
}

/** Replace in one filesystem rename. A failed replacement leaves the original
 * name and contents intact; never unlink it or move it out of the way first. */
export function replaceMediaFile(originalPath: string, preparedPath: string): void {
  const original = path.resolve(originalPath);
  const prepared = path.resolve(preparedPath);
  if (original === prepared || path.dirname(original) !== path.dirname(prepared)) {
    throw new Error("A media replacement must be a separate file in the original directory");
  }
  const source = fs.statSync(original);
  const replacement = fs.statSync(prepared);
  if (!source.isFile() || !replacement.isFile() || replacement.size === 0) {
    throw new Error("Media replacement requires an existing original and a nonempty prepared file");
  }
  fs.chmodSync(prepared, source.mode);
  const fd = fs.openSync(prepared, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(prepared, original);
}

/** Wait for the child to close before deleting temporary output or releasing
 * the file to another operation. A timeout never installs partial output. */
export async function runMediaRewrite(options: {
  originalPath: string;
  temporaryPath: string;
  command: string;
  args: string[];
  timeoutMs?: number;
}): Promise<void> {
  return withMediaFileLock(options.originalPath, () => runMediaRewriteUnlocked(options));
}

async function runMediaRewriteUnlocked(options: Parameters<typeof runMediaRewrite>[0]): Promise<void> {
  const original = path.resolve(options.originalPath);
  const temporary = path.resolve(options.temporaryPath);
  if (original === temporary || path.dirname(original) !== path.dirname(temporary)) {
    throw new Error("Temporary media output must be a separate file in the original directory");
  }
  if (fs.existsSync(temporary)) throw new Error("Temporary media output already exists");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(options.command, options.args, {
        stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
      });
      let timedOut = false;
      let launchError: Error | undefined;
      let stderr = "";
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs ?? 30_000);
      timer.unref();
      child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
      child.on("error", error => { launchError = error; });
      child.on("close", code => {
        clearTimeout(timer);
        if (timedOut) reject(new Error("Media rewrite timed out; original file retained"));
        else if (launchError) reject(launchError);
        else if (code !== 0) reject(new Error(stderr.trim() || `Media rewrite exited with code ${code}`));
        else resolve();
      });
    });
    replaceMediaFile(options.originalPath, options.temporaryPath);
  } finally {
    fs.rmSync(options.temporaryPath, { force: true });
  }
}
