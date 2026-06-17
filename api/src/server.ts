import cors from "cors";
import { randomBytes } from "crypto";
import express, { Express } from "express";
import fs from "fs";
import path from "path";

import { backfillArtistPaths, closeDatabase, initDatabase } from "./database.js";
import { authMiddleware } from "./middleware/auth.js";
import albumsRouter from "./routes/v1/album.js";
import appAuthRouter from "./routes/app-auth.js";
import artistsRouter from "./routes/v1/artist.js";
import authRouter from "./routes/auth.js";
import commandRouter from "./routes/v1/command.js";
import configRouter from "./routes/v1/config.js";
import eventsRouter from "./routes/events.js";
import historyRouter from "./routes/v1/history.js";
import libraryFilesRouter from "./routes/library-files.js";
import libraryBulkRouter from "./routes/library-bulk.js";
import logRouter from "./routes/log.js";
import mediaCoverProxyRouter from "./routes/media-cover-proxy.js";
import metadataRouter from "./routes/metadata.js";
import monitoringRouter from "./routes/monitoring.js";
import playbackRouter from "./routes/playback.js";
import providersRouter from "./routes/providers.js";
import queueRouter from "./routes/v1/queue.js";
import retagRouter from "./routes/retag.js";
import searchRouter from "./routes/search.js";
import statsRouter from "./routes/stats.js";
import statusRouter from "./routes/status.js";
import systemTaskRouter from "./routes/system-task.js";
import tracksRouter from "./routes/v1/track.js";
import ultraBlurRouter from "./routes/ultrablur.js";
import unmappedRouter from "./routes/unmapped.js";
import videosRouter from "./routes/v1/video.js";
import { closeAppLogging, initAppLogging } from "./services/config/app-logger.js";
import { ensureConfigExists, getConfigSection, CONFIG_DIR, REPO_ROOT } from "./services/config/config.js";
import { migrateLegacyTiddlDir } from "./services/providers/tidal/tiddl.js";
import { initCurationListeners } from "./services/music/curation.listener.js";
import { downloadProcessor } from "./services/download/download-processor.js";
import { startMonitoring } from "./services/jobs/scheduler.js";
import {
  getRuntimeDiagnosticsSnapshot,
  startRuntimeDiagnostics,
  trackRuntimeRequest,
} from "./services/jobs/runtime-diagnostics.js";
import { runRuntimeMaintenance } from "./services/jobs/runtime-maintenance.js";
import { collectHealthDiagnosticsSnapshot } from "./services/jobs/health.js";
import { CommandExecutor } from "./services/jobs/command-executor.js";
import { readIntEnv } from "./utils/env.js";

function initializeAuthEnvironment() {
  ensureConfigExists();
  // Relocate a pre-2.0.2 tiddl directory into config/providers/tidal/ before
  // any TIDAL auth/health path reads it.
  migrateLegacyTiddlDir();

  if (!process.env.ADMIN_PASSWORD) {
    const configuredPassword = String(getConfigSection("app").admin_password || "").trim();
    if (configuredPassword) {
      process.env.ADMIN_PASSWORD = configuredPassword;
      console.log("[AUTH] Loaded ADMIN_PASSWORD from config.toml.");
    }
  }

  if (!process.env.JWT_SECRET) {
    const secretFilePath = path.join(CONFIG_DIR, "jwt_secret");

    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });

      if (fs.existsSync(secretFilePath)) {
        const existingSecret = fs.readFileSync(secretFilePath, "utf-8").trim();
        if (existingSecret) {
          process.env.JWT_SECRET = existingSecret;
          console.log("[AUTH] Loaded JWT secret from runtime config.");
        }
      }

      if (!process.env.JWT_SECRET) {
        const newSecret = randomBytes(32).toString("hex");
        fs.writeFileSync(secretFilePath, `${newSecret}\n`, "utf-8");
        process.env.JWT_SECRET = newSecret;
        console.log("[AUTH] Generated JWT secret in runtime config.");
      }
    } catch (error) {
      process.env.JWT_SECRET = randomBytes(32).toString("hex");
      console.warn("[AUTH] Could not persist JWT secret to runtime config:", (error as Error).message);
      console.log("[AUTH] Using ephemeral JWT secret for this session.");
    }
  }

  if (!process.env.ADMIN_PASSWORD) {
    console.log("[AUTH] No admin password configured; API auth is disabled.");
  }
}

initializeAuthEnvironment();

const DEFAULT_PORT = 3737;
const parsedPort = Number.parseInt(String(process.env.PORT || "").trim(), 10);
const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
const hostname = "0.0.0.0";

const app: Express = express();

let runtimeMaintenanceStarted = false;

async function runStartupMaintenance() {
  if (runtimeMaintenanceStarted) {
    return;
  }

  runtimeMaintenanceStarted = true;
  console.log("[Maintenance] Running deferred startup maintenance");

  try {
    await runRuntimeMaintenance();
    console.log("[Maintenance] Startup maintenance completed");
  } catch (error) {
    console.error("[Maintenance] Startup maintenance failed:", error);
  }
}

function scheduleStartupMaintenance() {
  if (process.env.DISCOGENIUS_STARTUP_MAINTENANCE !== "1") {
    console.log(
      "[Maintenance] Startup maintenance is disabled by default. " +
      "Set DISCOGENIUS_STARTUP_MAINTENANCE=1 to enable deferred startup maintenance.",
    );
    return;
  }

  const delayMs = readIntEnv("DISCOGENIUS_STARTUP_MAINTENANCE_DELAY_MS", 30000, 0);
  console.log(
    `[Maintenance] Startup maintenance scheduled in ${delayMs}ms ` +
    "(configure DISCOGENIUS_STARTUP_MAINTENANCE_DELAY_MS to change delay).",
  );

  const timer = setTimeout(() => {
    void runStartupMaintenance();
  }, delayMs);
  timer.unref();
}

app.use(express.json());
app.use(cors({
  origin: true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

initDatabase();

const backfilled = backfillArtistPaths();
if (backfilled > 0) {
  console.log(`📁 Backfilled path for ${backfilled} existing artist(s)`);
}

initAppLogging();
startRuntimeDiagnostics();
const startupHealthSnapshot = collectHealthDiagnosticsSnapshot();
if (startupHealthSnapshot.status !== "healthy") {
  console.warn("[HEALTH] Startup preflight found issues:");
  for (const issue of startupHealthSnapshot.issues) {
    console.warn(`[HEALTH] ${issue.scope}: ${issue.message}`);
  }
}
initCurationListeners();

app.use((req, res, next) => {
  const finishTracking = trackRuntimeRequest(req.method, req.originalUrl || req.path);

  res.on("finish", () => {
    finishTracking(res.statusCode);
  });

  res.on("close", () => {
    finishTracking(res.statusCode || 499);
  });

  next();
});

app.use("/app-auth", appAuthRouter);
app.use("/api/app-auth", appAuthRouter);
app.use("/services/ultrablur", ultraBlurRouter);
app.use("/MediaCoverProxy", mediaCoverProxyRouter);

// Auth is an infra endpoint, kept un-versioned (like Lidarr's /login, /ping).
app.use("/api/auth", authMiddleware, authRouter);

// All business/resource routers live under a single /api/v1 namespace (Lidarr-style).
app.use("/api/v1/config", authMiddleware, configRouter);
app.use("/api/v1/artist", authMiddleware, artistsRouter);
app.use("/api/v1/album", authMiddleware, albumsRouter);
app.use("/api/v1/track", authMiddleware, tracksRouter);
app.use("/api/v1/video", authMiddleware, videosRouter);
app.use("/api/v1/queue", queueRouter);
app.use("/api/v1/command", authMiddleware, commandRouter);
app.use("/api/v1/history", historyRouter);
app.use("/api/v1/search", authMiddleware, searchRouter);
app.use("/api/v1/providers", authMiddleware, providersRouter);
app.use("/api/v1/retag", authMiddleware, retagRouter);
app.use("/api/v1/stats", authMiddleware, statsRouter);
app.use("/api/v1/system-task", authMiddleware, systemTaskRouter);
app.use("/api/v1/library-files", authMiddleware, libraryFilesRouter);
app.use("/api/v1/library-bulk", authMiddleware, libraryBulkRouter);
app.use("/api/v1/metadata", authMiddleware, metadataRouter);
app.use("/api/v1/monitoring", authMiddleware, monitoringRouter);
app.use("/api/v1/status", authMiddleware, statusRouter);
app.use("/api/v1/log", authMiddleware, logRouter);
app.use("/api/v1/events", authMiddleware, eventsRouter);
app.use("/api/v1/unmapped", authMiddleware, unmappedRouter);

// Media streaming stays un-versioned: binary/stream endpoints whose URLs are
// generated by the backend and consumed directly by the player/browser.
app.use("/api/playback", playbackRouter);

function sendHealthSnapshot(res: express.Response) {
  const runtime = getRuntimeDiagnosticsSnapshot();
  const preflight = collectHealthDiagnosticsSnapshot();
  const status = preflight.status;

  res.status(status === "unhealthy" ? 503 : 200).json({
    status,
    runtime,
    startup: startupHealthSnapshot,
    preflight,
  });
}

app.get("/health", (_, res) => {
  sendHealthSnapshot(res);
});

app.get("/api/health", (_, res) => {
  sendHealthSnapshot(res);
});

app.use((err: any, _req: any, res: any, _next: any) => {
  const status = err.status || err.statusCode || 500;
  const message = status < 500 ? (err.message || "Request failed") : "Internal server error";
  if (status >= 500) {
    console.error("[ERROR]", err);
  }
  if (!res.headersSent) {
    res.status(status).json({ error: message });
  }
});

const frontendPath = path.join(REPO_ROOT, "app", "dist");
console.log(`[SERVER] Repo root: ${REPO_ROOT}`);
console.log(`[SERVER] Looking for frontend at: ${frontendPath}`);

if (fs.existsSync(frontendPath)) {
  console.log(`[SERVER] Serving frontend from: ${frontendPath}`);

  app.use(express.static(frontendPath, {
    setHeaders: (res, filePath) => {
      const normalizedPath = filePath.replace(/\\/g, "/");
      if (
        normalizedPath.endsWith("/index.html")
        || normalizedPath.endsWith("/sw.js")
        || normalizedPath.endsWith("/manifest.json")
      ) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  }));

  app.get("*", (req, res) => {
    if (
      req.path.startsWith("/api")
      || req.path.startsWith("/app-auth")
      || req.path.startsWith("/proxy")
      || req.path.startsWith("/services")
      || req.path.startsWith("/health")
    ) {
      return res.status(404).json({ error: "Not found" });
    }

    res.sendFile(path.join(frontendPath, "index.html"));
  });
} else {
  console.log(`[SERVER] Frontend not found at ${frontendPath} - run 'yarn --cwd app build' first`);
}

const server = app.listen(port, () => {
  console.log(`⚡️ [SERVER]: Server is running at http://${hostname}:${port}`);

  import("./services/providers/token-refresh.js").then(({ startTokenRefreshInterval }) => {
    startTokenRefreshInterval();
  }).catch((error) => {
    console.error("Failed to start token refresh:", error);
  });

  scheduleStartupMaintenance();

  if (process.env.DISCOGENIUS_DISABLE_DOWNLOADS === "1") {
    console.log("[APP] Download processor disabled via DISCOGENIUS_DISABLE_DOWNLOADS=1");
  } else {
    console.log("[APP] Initializing download processor...");
    downloadProcessor.initialize().catch((error) => {
      console.error("Failed to initialize download processor:", error);
    });
  }

  setTimeout(() => {
    if (process.env.DISCOGENIUS_DISABLE_MONITORING === "1") {
      console.log("[APP] Monitoring disabled via DISCOGENIUS_DISABLE_MONITORING=1");
    } else {
      try {
        startMonitoring();
      } catch (error) {
        console.error("Failed to start monitoring:", error);
      }
    }

    if (process.env.DISCOGENIUS_DISABLE_SCHEDULER === "1") {
      console.log("[APP] Command executor disabled via DISCOGENIUS_DISABLE_SCHEDULER=1");
    } else {
      try {
        CommandExecutor.start();
      } catch (error) {
        console.error("Failed to start command executor:", error);
      }
    }
  }, 1000);
});

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`[APP] ${signal} received, shutting down...`);

  try {
    await downloadProcessor.pause();
  } catch (error) {
    console.warn("[APP] Failed to pause download processor during shutdown:", error);
  }

  const forceExitTimer = setTimeout(() => {
    closeAppLogging();
    closeDatabase();
    process.exit(1);
  }, 10000);
  forceExitTimer.unref();

  server.close(() => {
    closeAppLogging();
    closeDatabase();
    clearTimeout(forceExitTimer);
    process.exit(0);
  });
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
