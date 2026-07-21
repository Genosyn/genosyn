import type { NextFunction, Request, Response } from "express";
import { config } from "../../config.js";

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (new URL(config.publicUrl).protocol === "https:") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (process.env.NODE_ENV === "production" && !req.path.startsWith("/api/docs")) {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; " +
        "form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob: https:; font-src 'self' data:; " +
        "connect-src 'self' https: wss:; frame-src 'self'",
    );
  }
  next();
}

/** Reject cross-origin browser mutations; bearer-authenticated API calls remain valid. */
export function requireTrustedOrigin(
  req: Request,
  res: Response,
  next: NextFunction,
): void | Response {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  if (req.headers.authorization?.toLowerCase().startsWith("bearer ")) {
    next();
    return;
  }
  const expected = new URL(config.publicUrl).origin;
  const origin = req.headers.origin;
  const fetchSite = req.headers["sec-fetch-site"];
  if (origin && origin !== expected) {
    return res.status(403).json({ error: "Cross-origin request rejected" });
  }
  if (!origin && fetchSite === "cross-site") {
    return res.status(403).json({ error: "Cross-site request rejected" });
  }
  next();
}
