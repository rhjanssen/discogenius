import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { authMiddleware } from "../middleware/auth.js";

/** Derive a non-reversible fingerprint from the password so we never store the plaintext in the JWT. */
export function passwordFingerprint(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const MAX_LOGIN_CLIENTS = 10_000;
const failedLogins = new Map<string, { count: number; resetAt: number }>();

function passwordMatches(actual: string, expected: string): boolean {
  const actualDigest = crypto.createHash("sha256").update(actual).digest();
  const expectedDigest = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(actualDigest, expectedDigest);
}

const router = Router();

/**
 * POST /app-auth
 * Authenticate with admin password and get JWT token
 */
router.post("/", async (req: Request, res: Response) => {
  const { password } = req.body;
  const envPassword = process.env.ADMIN_PASSWORD;
  const jwtSecret = process.env.JWT_SECRET;

  if (!password) {
    return res.status(400).json({
      error: true,
      message: "Password required",
    });
  }

  if (!envPassword) {
    return res.status(200).json({
      accessGranted: true,
      authDisabled: true,
      token: null,
    });
  }

  const clientKey = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const attempts = failedLogins.get(clientKey);
  if (attempts && attempts.resetAt > now && attempts.count >= MAX_FAILED_LOGINS) {
    res.setHeader("retry-after", String(Math.ceil((attempts.resetAt - now) / 1000)));
    return res.status(429).json({ error: true, message: "Too many login attempts" });
  }
  if (attempts && attempts.resetAt <= now) failedLogins.delete(clientKey);

  const isAllowed = typeof password === "string" && passwordMatches(password, envPassword);

  if (!jwtSecret) {
    return res.status(401).json({
      error: true,
      message: "No JWT secret",
    });
  }

  if (!isAllowed) {
    if (!failedLogins.has(clientKey) && failedLogins.size >= MAX_LOGIN_CLIENTS) {
      for (const [key, entry] of failedLogins) {
        if (entry.resetAt <= now) failedLogins.delete(key);
      }
      if (failedLogins.size >= MAX_LOGIN_CLIENTS) {
        const oldestKey = failedLogins.keys().next().value;
        if (oldestKey) failedLogins.delete(oldestKey);
      }
    }
    const current = failedLogins.get(clientKey);
    failedLogins.set(clientKey, {
      count: (current?.count ?? 0) + 1,
      resetAt: current?.resetAt ?? now + LOGIN_WINDOW_MS,
    });
    return res.status(401).json({
      error: true,
      message: "Invalid credentials",
    });
  }

  failedLogins.delete(clientKey);

  // Generate token — store only a fingerprint, never the plaintext password
  const token = jwt.sign({ fp: passwordFingerprint(envPassword) }, jwtSecret, {
    expiresIn: "12h",
  });

  res.status(200).json({ accessGranted: true, token });
});

/**
 * GET /is-auth-active
 * Check if app authentication is enabled
 */
router.get("/is-auth-active", (_req: Request, res: Response) => {
  const isActive = !!process.env.ADMIN_PASSWORD;
  res.status(200).json({
    isAuthActive: isActive,
    authType: isActive ? "password" : null,
  });
});

/**
 * GET /app-auth/verify
 * Verify current JWT token (when auth is active)
 */
router.get("/verify", authMiddleware, (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

export default router;
