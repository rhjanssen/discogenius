import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { authMiddleware } from "../middleware/auth.js";

/** Derive a non-reversible fingerprint from the password so we never store the plaintext in the JWT. */
export function passwordFingerprint(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex").slice(0, 16);
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

  const isAllowed = password === envPassword;

  if (!jwtSecret) {
    return res.status(401).json({
      error: true,
      message: "No JWT secret",
    });
  }

  if (!isAllowed) {
    return res.status(401).json({
      error: true,
      message: "Invalid credentials",
    });
  }

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
  res.status(200).json({ isAuthActive: isActive });
});

/**
 * GET /app-auth/verify
 * Verify current JWT token (when auth is active)
 */
router.get("/verify", authMiddleware, (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

export default router;
