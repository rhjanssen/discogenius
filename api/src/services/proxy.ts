import apicache from "apicache";
import { Express } from "express";
import proxy from "express-http-proxy";
import { loadToken } from "./tidal.js";

const TIDAL_API_BASE = "https://api.tidal.com/v1";
const cache = apicache.middleware;

/**
 * Configure Tidal API proxy with caching
 * This centralizes token management and provides automatic caching
 */
export function setupTidalProxy(app: Express): void {
  app.use(
    "/proxy/tidal",
    cache("1 minute"),
    proxy(TIDAL_API_BASE, {
      proxyReqOptDecorator: (proxyReqOpts) => {
        const token = loadToken();
        if (token) {
          proxyReqOpts.headers = proxyReqOpts.headers || {};
          proxyReqOpts.headers["Authorization"] = `Bearer ${token.access_token}`;
        }
        // Remove referer and origin to avoid CORS issues
        delete proxyReqOpts.headers["referer"];
        delete proxyReqOpts.headers["origin"];
        return proxyReqOpts;
      },
      userResDecorator: (proxyRes, proxyResData) => {
        // Log proxy errors for debugging
        if (proxyRes.statusCode && proxyRes.statusCode >= 400) {
          console.error(`[Tidal Proxy] Error ${proxyRes.statusCode}:`, proxyResData.toString());
        }
        return proxyResData;
      },
    })
  );

  // Simple image proxy to avoid CORS when extracting colors client-side
  app.get("/proxy/image", async (req, res) => {
    const targetUrl = req.query.url as string;
    if (!targetUrl) {
      res.status(400).json({ detail: "Missing url param" });
      return;
    }

    try {
      const upstream = await fetch(targetUrl);
      if (!upstream.ok) {
        res.status(upstream.status).json({ detail: `Upstream error ${upstream.status}` });
        return;
      }

      const contentType = upstream.headers.get("content-type");
      if (contentType) res.setHeader("Content-Type", contentType);
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.send(buffer);
    } catch (error: any) {
      console.error("[Image Proxy] Failed to fetch image:", error?.message || error);
      res.status(502).json({ detail: "Failed to proxy image" });
    }
  });
}
