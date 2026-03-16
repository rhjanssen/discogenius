import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";

function passwordFingerprint(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex").slice(0, 16);
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // If no admin password is set, allow access
  if (!process.env.ADMIN_PASSWORD) {
    return next();
  }

  // Try to get token from Authorization header first, then query parameter (for SSE)
  let token = req.headers.authorization?.replace("Bearer ", "");
  if (!token && req.query.token) {
    token = req.query.token as string;
  }

  const jwtSecret = process.env.JWT_SECRET;
  const envPassword = process.env.ADMIN_PASSWORD;

  if (!jwtSecret) {
    return res.status(401).json({ error: true, message: "Server misconfigured" });
  }

  if (!token) {
    return res.status(401).json({ error: true, message: "No token provided" });
  }

  try {
    const decoded = jwt.verify(token, jwtSecret) as jwt.JwtPayload | string;

    const payload = typeof decoded === "string" ? {} : decoded;
    const tokenFp = payload.fp as string | undefined;

    if (envPassword) {
      const expectedFp = passwordFingerprint(envPassword);
      if (!tokenFp || !timingSafeEqual(tokenFp, expectedFp)) {
        return res.status(401).json({ error: true, message: "Invalid token" });
      }
    }

    return next();
  } catch (error) {
    return res.status(401).json({ error: true, message: "Invalid token" });
  }
}
