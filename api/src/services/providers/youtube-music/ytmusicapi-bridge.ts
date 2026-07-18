import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { YOUTUBE_MUSIC_HEADERS_FILE } from "./youtube-music-auth.js";

export type YtMusicBridgeOperation =
  | "search"
  | "get_artist"
  | "get_artist_albums"
  | "get_artist_videos"
  | "get_album"
  | "get_track"
  | "get_video"
  | "list_import_sources"
  | "get_import_artists";

export interface YtMusicBridge {
  request<T = unknown>(operation: YtMusicBridgeOperation, payload?: Record<string, unknown>): Promise<T>;
}

export interface BridgeExecutionRequest {
  binary: string;
  args: string[];
  input: string;
  timeoutMs: number;
}

export interface BridgeExecutionResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type BridgeRunner = (request: BridgeExecutionRequest) => Promise<BridgeExecutionResult>;

const MAX_BRIDGE_OUTPUT_BYTES = 32 * 1024 * 1024;

export function getYtMusicPythonBinary(): string {
  if (process.env.YTMUSICAPI_PYTHON_BIN?.trim()) {
    return process.env.YTMUSICAPI_PYTHON_BIN.trim();
  }
  const bundled = "/opt/ytmusic-venv/bin/python";
  if (fs.existsSync(bundled)) return bundled;
  return process.platform === "win32" ? "python" : "python3";
}

export function getYtMusicBridgeScript(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(currentDir, "ytmusicapi-bridge.py"),
    path.join(process.cwd(), "api", "src", "services", "providers", "youtube-music", "ytmusicapi-bridge.py"),
    path.join(process.cwd(), "src", "services", "providers", "youtube-music", "ytmusicapi-bridge.py"),
    path.resolve(currentDir, "../../../../../src/services/providers/youtube-music/ytmusicapi-bridge.py"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

export const defaultBridgeRunner: BridgeRunner = (request) => new Promise((resolve, reject) => {
  const child = spawn(request.binary, request.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  let stdout = "";
  let stderr = "";
  let settled = false;

  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    callback();
  };
  const append = (current: string, chunk: Buffer): string => {
    const next = current + chunk.toString("utf8");
    if (Buffer.byteLength(next, "utf8") > MAX_BRIDGE_OUTPUT_BYTES) {
      child.kill("SIGKILL");
      finish(() => reject(new Error("ytmusicapi bridge returned an unexpectedly large response.")));
    }
    return next;
  };

  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
  child.on("error", (error) => finish(() => reject(error)));
  child.on("close", (code) => finish(() => resolve({ code, stdout, stderr })));
  child.stdin.end(request.input);

  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    finish(() => reject(new Error(`ytmusicapi bridge timed out after ${request.timeoutMs}ms.`)));
  }, request.timeoutMs);
  timeout.unref?.();
});

function conciseError(stderr: string, stdout: string): string {
  const lines = `${stderr}\n${stdout}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return (lines.at(-1) || "Unknown bridge error").slice(0, 800);
}

export class PythonYtMusicBridge implements YtMusicBridge {
  constructor(private readonly options: {
    runner?: BridgeRunner;
    pythonBinary?: string;
    scriptPath?: string;
    headersPath?: string;
    timeoutMs?: number;
  } = {}) {}

  async request<T = unknown>(
    operation: YtMusicBridgeOperation,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    const scriptPath = this.options.scriptPath || getYtMusicBridgeScript();
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`ytmusicapi bridge script is missing: ${scriptPath}`);
    }
    const args = [scriptPath, operation];
    const headersPath = this.options.headersPath || YOUTUBE_MUSIC_HEADERS_FILE;
    if (fs.existsSync(headersPath)) {
      args.push("--headers", headersPath);
    }

    const result = await (this.options.runner || defaultBridgeRunner)({
      binary: this.options.pythonBinary || getYtMusicPythonBinary(),
      args,
      input: JSON.stringify(payload),
      timeoutMs: this.options.timeoutMs ?? 45_000,
    });
    if (result.code !== 0) {
      throw new Error(`ytmusicapi bridge failed (${result.code ?? "signal"}): ${conciseError(result.stderr, result.stdout)}`);
    }
    try {
      return JSON.parse(result.stdout) as T;
    } catch {
      throw new Error(`ytmusicapi bridge returned invalid JSON: ${conciseError(result.stderr, result.stdout)}`);
    }
  }
}
