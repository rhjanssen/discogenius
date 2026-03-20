import cors from "cors";
import { randomBytes } from "crypto";
import express, { Express } from "express";
import fs from "fs";
import path from "path";

import { closeDatabase, initDatabase } from "./database.js";
import { authMiddleware } from "./middleware/auth.js";
import albumsRouter from "./routes/albums.js";
import appAuthRouter from "./routes/app-auth.js";
import artistsRouter from "./routes/artists.js";
import authRouter from "./routes/auth.js";
import commandRouter from "./routes/command.js";
import configRouter from "./routes/config.js";
import downloadQueueRouter from "./routes/download-queue.js";
import eventsRouter from "./routes/events.js";
import historyRouter from "./routes/history.js";
import libraryFilesRouter from "./routes/library-files.js";
import logRouter from "./routes/log.js";
import monitoringRouter from "./routes/monitoring.js";
import playbackRouter from "./routes/playback.js";
import playlistsRouter from "./routes/playlists.js";
import taskQueueRouter from "./routes/queue.js";
import retagRouter from "./routes/retag.js";
import searchRouter from "./routes/search.js";
import statsRouter from "./routes/stats.js";
import statusRouter from "./routes/status.js";
import systemTaskRouter from "./routes/system-task.js";
import tidalRouter from "./routes/tidal.js";
import tracksRouter from "./routes/tracks.js";
import ultraBlurRouter from "./routes/ultrablur.js";
import unmappedRouter from "./routes/unmapped.js";
import videosRouter from "./routes/videos.js";
import { closeAppLogging, initAppLogging } from "./services/app-logger.js";
import { ensureConfigExists, getConfigSection, CONFIG_DIR, REPO_ROOT } from "./services/config.js";
import { initCurationListeners } from "./services/curation.listener.js";
import { downloadProcessor } from "./services/download-processor.js";
import { startMonitoring } from "./services/monitoring-scheduler.js";
import { setupTidalProxy } from "./services/proxy.js";
import {
  getRuntimeDiagnosticsSnapshot,
  startRuntimeDiagnostics,
  trackRuntimeRequest,
} from "./services/runtime-diagnostics.js";
import { runRuntimeMaintenance } from "./services/runtime-maintenance.js";
import { collectHealthDiagnosticsSnapshot } from "./services/health.js";
import { Scheduler } from "./services/scheduler.js";
import { readIntEnv } from "./utils/env.js";

function initializeAuthEnvironment() {
  ensureConfigExists();

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
setupTidalProxy(app);

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

app.use("/api/auth", authMiddleware, authRouter);
app.use("/api/config", authMiddleware, configRouter);
app.use("/api/search", authMiddleware, searchRouter);
app.use("/api/tidal", authMiddleware, tidalRouter);
app.use("/api/artists", authMiddleware, artistsRouter);
app.use("/api/albums", authMiddleware, albumsRouter);
app.use("/api/tracks", authMiddleware, tracksRouter);
app.use("/api/videos", authMiddleware, videosRouter);
app.use("/api/playlists", authMiddleware, playlistsRouter);
app.use("/api/retag", authMiddleware, retagRouter);
app.use("/api/stats", authMiddleware, statsRouter);
app.use("/api", downloadQueueRouter);
app.use("/api/tasks", authMiddleware, taskQueueRouter);
app.use("/api/command", authMiddleware, commandRouter);
app.use("/api/system/task", authMiddleware, systemTaskRouter);
app.use("/api/library-files", authMiddleware, libraryFilesRouter);
app.use("/api/monitoring", authMiddleware, monitoringRouter);
app.use("/api/status", authMiddleware, statusRouter);
app.use("/api/log", authMiddleware, logRouter);
app.use("/api/playback", playbackRouter);
app.use("/api/events", authMiddleware, eventsRouter);
app.use("/api/history", authMiddleware, historyRouter);
app.use("/api/unmapped", authMiddleware, unmappedRouter);

app.get("/health", (_, res) => {
  res.json({
    status: "healthy",
    runtime: getRuntimeDiagnosticsSnapshot(),
    startup: startupHealthSnapshot,
    preflight: collectHealthDiagnosticsSnapshot(),
  });
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

  import("./services/token-refresh.js").then(({ startTokenRefreshInterval }) => {
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
      console.log("[APP] Scheduler disabled via DISCOGENIUS_DISABLE_SCHEDULER=1");
    } else {
      try {
        Scheduler.start();
      } catch (error) {
        console.error("Failed to start scheduler:", error);
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
