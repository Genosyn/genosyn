import type { RequestHandler } from "express";

export const AI_BROWSER_REQUEST_HEADER = "x-genosyn-ai-browser";
export const AI_BROWSER_REQUEST_VALUE = "1";

const SESSION_COOKIE_PATTERN = /(?:^|;\s*)genosyn\.sid=/;

/**
 * Mark requests that carry a Genosyn Member session inside App-owned Chromium.
 * The marker is added after page/service-worker code chooses its headers, so a
 * self-origin page cannot remove it. Requests to unrelated sites remain
 * untouched unless that site independently uses Genosyn's cookie name.
 */
export function markAiBrowserSessionRequestHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const cookie = Object.entries(headers).find(([name]) => name.toLowerCase() === "cookie")?.[1];
  if (!cookie || !SESSION_COOKIE_PATTERN.test(cookie)) return headers;
  return { ...headers, [AI_BROWSER_REQUEST_HEADER]: AI_BROWSER_REQUEST_VALUE };
}

/** Global `/api` gate installed after cookie-session parsing. */
export const rejectAiBrowserAppRequests: RequestHandler = (req, res, next) => {
  if (req.get(AI_BROWSER_REQUEST_HEADER) === AI_BROWSER_REQUEST_VALUE) {
    res.status(403).json({
      error:
        "Genosyn App APIs are unavailable inside an AI Browser. Use governed AI Employee tools.",
    });
    return;
  }
  next();
};
