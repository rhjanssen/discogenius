import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

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
