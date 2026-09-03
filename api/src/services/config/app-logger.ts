import fs from "fs";
import path from "path";
import { inspect } from "util";
import { CONFIG_DIR } from "./config.js";
import { getDiscogeniusVersion } from "./user-agent.js";
import { readIntEnv } from "../../utils/env.js";

type LogLevel = "debug" | "info" | "warn" | "error";

type LogRecord = {
  id: number;
  level: LogLevel;
  message: string;
  time: string;
};

const LEVEL_ORDER: LogLevel[] = ["debug", "info", "warn", "error"];
const MAX_LOG_RECORDS = 5000;
const LOG_FILE_NAME = "discogenius.jsonl";
const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

let loggingInitialized = false;
let consolePatched = false;
let nextLogId = 1;
const logBuffer: LogRecord[] = [];
let currentFileBytes = 0;

function getLogDir(): string {
  const override = process.env.DISCOGENIUS_LOG_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(CONFIG_DIR, "logs");
}

function getLogFilePath(): string {
  return path.join(getLogDir(), LOG_FILE_NAME);
}

function getArchiveFilePath(index: number): string {
  return path.join(getLogDir(), `discogenius.${index}.jsonl`);
}

function getMaxArchiveFiles(): number {
  return readIntEnv("DISCOGENIUS_LOG_ROTATE", 5, 1);
}

function getArchiveAboveBytes(): number {
  const rawBytes = process.env.DISCOGENIUS_LOG_ARCHIVE_ABOVE_BYTES?.trim();
  if (rawBytes) {
    const parsed = Number.parseInt(rawBytes, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return parsed;
    }
  }

  return readIntEnv("DISCOGENIUS_LOG_SIZE_LIMIT_MB", 1, 1) * 1024 * 1024;
}

function pushLogRecord(record: LogRecord) {
  logBuffer.push(record);

  if (logBuffer.length > MAX_LOG_RECORDS) {
    logBuffer.splice(0, logBuffer.length - MAX_LOG_RECORDS);
  }
}

function ensureLogDirectory() {
  fs.mkdirSync(getLogDir(), { recursive: true });
}

function currentLogFileSize(): number {
  const logFile = getLogFilePath();
  if (!fs.existsSync(logFile)) {
    return 0;
  }
  return fs.statSync(logFile).size;
}

function rotateLogFiles() {
  const logFile = getLogFilePath();
  if (!fs.existsSync(logFile)) {
    currentFileBytes = 0;
    return;
  }

  const maxArchiveFiles = getMaxArchiveFiles();
  const oldest = getArchiveFilePath(maxArchiveFiles);
  if (fs.existsSync(oldest)) {
    fs.rmSync(oldest, { force: true });
  }

  for (let index = maxArchiveFiles - 1; index >= 1; index -= 1) {
    const from = getArchiveFilePath(index);
    if (!fs.existsSync(from)) {
      continue;
    }
    fs.renameSync(from, getArchiveFilePath(index + 1));
  }

  fs.renameSync(logFile, getArchiveFilePath(1));
  currentFileBytes = 0;
}

function rotateLogFilesIfNeeded(incomingBytes = 0) {
  if (currentFileBytes <= 0) {
    currentFileBytes = currentLogFileSize();
  }

  const limit = getArchiveAboveBytes();
  if (currentFileBytes > 0 && currentFileBytes + incomingBytes > limit) {
    rotateLogFiles();
  }
}

function persistLine(line: string) {
  ensureLogDirectory();
  const bytes = Buffer.byteLength(line, "utf8");
  rotateLogFilesIfNeeded(bytes);
  fs.appendFileSync(getLogFilePath(), line);
  currentFileBytes += bytes;
}

function normalizeMessage(args: unknown[]): string {
  return args.map((value) => {
    if (typeof value === "string") {
      return value;
    }

    return inspect(value, {
      depth: 6,
      breakLength: 120,
      maxArrayLength: 50,
    });
  }).join(" ").slice(0, 8000);
}

function appendLog(level: LogLevel, args: unknown[]) {
  const record: LogRecord = {
    id: nextLogId,
    level,
    message: normalizeMessage(args),
    time: new Date().toISOString(),
  };

  pushLogRecord(record);
  nextLogId += 1;

  try {
    persistLine(`${JSON.stringify(record)}\n`);
  } catch (error) {
    originalConsole.warn("[Logging] Failed to write to log file:", error);
  }
}

function patchConsoleMethod(method: keyof typeof originalConsole, level: LogLevel) {
  return (...args: unknown[]) => {
    originalConsole[method](...args);
    appendLog(level, args);
  };
}

function restoreConsole() {
  if (!consolePatched) {
    return;
  }

  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  console.debug = originalConsole.debug;
  consolePatched = false;
}

export function initAppLogging() {
  if (loggingInitialized) {
    return;
  }

  ensureLogDirectory();
  currentFileBytes = currentLogFileSize();
  loggingInitialized = true;
  console.log = patchConsoleMethod("log", "info");
  console.info = patchConsoleMethod("info", "info");
  console.warn = patchConsoleMethod("warn", "warn");
  console.error = patchConsoleMethod("error", "error");
  console.debug = patchConsoleMethod("debug", "debug");
  consolePatched = true;

  console.info(`[Discogenius] ${getDiscogeniusVersion()} starting`);
}

export function closeAppLogging() {
  currentFileBytes = currentLogFileSize();
}

export function resetAppLoggingForTests() {
  restoreConsole();
  loggingInitialized = false;
  nextLogId = 1;
  logBuffer.splice(0, logBuffer.length);
  currentFileBytes = 0;
}

function getAllowedLevels(level?: string | null): LogLevel[] {
  const normalized = String(level || "").trim().toLowerCase();
  if (!normalized) {
    return LEVEL_ORDER;
  }

  const index = LEVEL_ORDER.indexOf(normalized as LogLevel);
  return index >= 0 ? LEVEL_ORDER.slice(index) : LEVEL_ORDER;
}

export function getLogs(options: { limit?: number; offset?: number; level?: string | null } = {}) {
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const offset = Math.max(0, options.offset ?? 0);
  const allowedLevels = new Set(getAllowedLevels(options.level));
  const filtered = logBuffer.filter((record) => allowedLevels.has(record.level));
  const sorted = [...filtered].sort((left, right) => right.id - left.id);

  return {
    records: sorted.slice(offset, offset + limit),
    totalRecords: filtered.length,
  };
}

export function getAppLogFilePathForTests(): string {
  return getLogFilePath();
}
