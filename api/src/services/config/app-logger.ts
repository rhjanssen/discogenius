import fs from "fs";
import path from "path";
import { inspect } from "util";
import { CONFIG_DIR } from "./config.js";

type LogLevel = "debug" | "info" | "warn" | "error";

type LogRecord = {
  id: number;
  level: LogLevel;
  message: string;
  time: string;
};

const LEVEL_ORDER: LogLevel[] = ["debug", "info", "warn", "error"];
const MAX_LOG_RECORDS = 5000;
const MAX_STARTUP_LOG_LOAD_BYTES = 4 * 1024 * 1024;
const LOG_DIR = path.join(CONFIG_DIR, "logs");
const LOG_FILE = path.join(LOG_DIR, "discogenius.jsonl");
const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

let loggingInitialized = false;
let nextLogId = 1;
const logBuffer: LogRecord[] = [];
let logStream: fs.WriteStream | null = null;
let persistedLogsLoaded = false;

function pushLogRecord(record: LogRecord) {
  logBuffer.push(record);

  if (logBuffer.length > MAX_LOG_RECORDS) {
    logBuffer.splice(0, logBuffer.length - MAX_LOG_RECORDS);
  }
}

function ensureLogDirectory() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function loadPersistedLogs() {
  if (persistedLogsLoaded) {
    return;
  }

  persistedLogsLoaded = true;
  ensureLogDirectory();

  if (!fs.existsSync(LOG_FILE)) {
    return;
  }

  try {
    const { size: fileSize } = fs.statSync(LOG_FILE);
    if (fileSize <= 0) {
      return;
    }

    const tailBytes = Math.min(fileSize, MAX_STARTUP_LOG_LOAD_BYTES);
    const startOffset = fileSize - tailBytes;
    const tailBuffer = Buffer.alloc(tailBytes);
    let totalRead = 0;
    let startsMidLine = false;

    const fd = fs.openSync(LOG_FILE, "r");
    try {
      if (tailBytes > 0) {
        while (totalRead < tailBytes) {
          const bytesRead = fs.readSync(
            fd,
            tailBuffer,
            totalRead,
            tailBytes - totalRead,
            startOffset + totalRead
          );
          if (bytesRead === 0) {
            break;
          }

          totalRead += bytesRead;
        }
      }

      if (startOffset > 0) {
        const previousByte = Buffer.alloc(1);
        fs.readSync(fd, previousByte, 0, 1, startOffset - 1);
        startsMidLine = previousByte[0] !== 0x0a && previousByte[0] !== 0x0d;
      }
    } finally {
      fs.closeSync(fd);
    }

    if (totalRead === 0) {
      return;
    }

    if (totalRead < tailBytes) {
      originalConsole.warn(
        `[Logging] Requested ${tailBytes} startup log bytes but read ${totalRead}. Parsing available bytes only.`
      );
    }

    if (fileSize > tailBytes) {
      originalConsole.info(
        `[Logging] Loading startup logs from tail ${tailBytes}/${fileSize} bytes.`
      );
    }

    let lines = tailBuffer
      .subarray(0, totalRead)
      .toString("utf-8")
      .split(/\r?\n/);

    if (startsMidLine && lines.length > 0) {
      lines = lines.slice(1);
    }

    lines = lines
      .filter((line) => line.trim().length > 0)
      .slice(-MAX_LOG_RECORDS);

    for (const line of lines) {
      try {
        const record = JSON.parse(line) as Partial<LogRecord>;
        if (
          typeof record.id !== "number" ||
          typeof record.level !== "string" ||
          typeof record.message !== "string" ||
          typeof record.time !== "string"
        ) {
          continue;
        }

        pushLogRecord({
          id: record.id,
          level: record.level as LogLevel,
          message: record.message,
          time: record.time,
        });
        nextLogId = Math.max(nextLogId, record.id + 1);
      } catch {
        // Ignore malformed log lines from previous builds.
      }
    }
  } catch (error) {
    originalConsole.warn("[Logging] Failed to load persisted logs:", error);
  }
}

function ensureLogStream() {
  if (logStream) {
    return;
  }

  ensureLogDirectory();
  logStream = fs.createWriteStream(LOG_FILE, {
    flags: "a",
    encoding: "utf8",
  });
  logStream.on("error", (error) => {
    originalConsole.warn("[Logging] Failed to write to log file:", error);
  });
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

  if (logStream) {
    logStream.write(`${JSON.stringify(record)}\n`);
  }
}

function patchConsoleMethod(method: keyof typeof originalConsole, level: LogLevel) {
  return (...args: unknown[]) => {
    originalConsole[method](...args);
    appendLog(level, args);
  };
}

export function initAppLogging() {
  if (loggingInitialized) {
    return;
  }

  loadPersistedLogs();
  ensureLogStream();
  loggingInitialized = true;
  console.log = patchConsoleMethod("log", "info");
  console.info = patchConsoleMethod("info", "info");
  console.warn = patchConsoleMethod("warn", "warn");
  console.error = patchConsoleMethod("error", "error");
  console.debug = patchConsoleMethod("debug", "debug");
}

export function closeAppLogging() {
  if (!logStream) {
    return;
  }

  logStream.end();
  logStream = null;
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
