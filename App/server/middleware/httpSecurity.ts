import type { NextFunction, Request, Response } from "express";
import { config } from "../../config.js";
import { getPublicUrl } from "../services/publicUrl.js";

export type TrustedOriginInput = {
  method: string;
  authorization?: string;
  origin?: string;
  fetchSite?: string;
  host?: string;
};

/** Pure CSRF decision used by the middleware and its regression tests. */
export function isTrustedBrowserOrigin(input: TrustedOriginInput): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(input.method.toUpperCase())) return true;
  if (input.authorization?.toLowerCase().startsWith("bearer ")) return true;
  if (input.fetchSite === "cross-site") return false;
  if (!input.origin) return true;
  if (!input.host) return false;
  try {
    return new URL(input.origin).host.toLowerCase() === input.host.toLowerCase();
  } catch {
    return false;
  }
}

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (req.secure || getPublicUrl().startsWith("https://")) {
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
  const forwardedHost =
    config.security.trustedProxyHops > 0
      ? req.headers["x-forwarded-host"]
      : undefined;
  const host =
    typeof forwardedHost === "string"
      ? forwardedHost.split(",")[0]?.trim()
      : req.headers.host;
  if (
    !isTrustedBrowserOrigin({
      method: req.method,
      authorization: req.headers.authorization,
      origin: req.headers.origin,
      fetchSite:
        typeof req.headers["sec-fetch-site"] === "string"
          ? req.headers["sec-fetch-site"]
          : undefined,
      host,
    })
  ) {
    return res.status(403).json({ error: "Cross-origin request rejected" });
  }
  next();
}
