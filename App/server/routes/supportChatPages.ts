import type { RequestHandler, Response } from "express";
import { Router } from "express";

import { frameAncestors, liveWidget } from "../services/support/chatWidgets.js";

/**
 * The Chat widget's two files outside the API: the loader a company's page runs, and
 * the page it opens in a frame. Neither carries a visitor's token: that stays inside
 * the frame, in storage the page around it can't read.
 *
 * Which sites may embed the widget is the frame page's `frame-ancestors`, rebuilt from
 * the widget's list on every load, so removing a site takes effect at its next page
 * view. `frame-ancestors` says nothing about a page opened on its own, so a request
 * that says it is a top-level document gets the same 404 as a widget that is off:
 * otherwise a site not on the list could still open the chat in a popup.
 */

/** Builds a page's HTML, or the loader's code: built files in production, Vite's in development. */
export type SupportChatFileLoader = (url: string) => Promise<string>;

/** Nothing outside the frame's own origin: what it fetches, runs or submits. */
function framePolicy(ancestors: string): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    `frame-ancestors ${ancestors}`,
  ].join("; ");
}

function notAvailable(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res
    .status(404)
    .type("html")
    .send('<!doctype html><meta charset="utf-8"><title>Not available</title>');
}

export function supportChatPagesRouter(options: {
  loadPage: SupportChatFileLoader;
  loadLoader: SupportChatFileLoader;
  isDev: boolean;
}): Router {
  const router = Router();

  const framePage: RequestHandler = (req, res, next) => {
    void (async () => {
      if (req.headers["sec-fetch-dest"] === "document") {
        notAvailable(res);
        return;
      }
      const live = await liveWidget(req.params.widgetKey ?? "");
      const ancestors = live ? frameAncestors(live.widget) : "'none'";
      if (!live || ancestors === "'none'") {
        notAvailable(res);
        return;
      }
      res.removeHeader("X-Frame-Options");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        // Vite's development client needs its inline script and socket.
        options.isDev ? `frame-ancestors ${ancestors}` : framePolicy(ancestors),
      );
      res.type("html").send(await options.loadPage(req.originalUrl));
    })().catch(next);
  };

  const loader: RequestHandler = (req, res, next) => {
    void (async () => {
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.type("text/javascript").send(await options.loadLoader(req.originalUrl));
    })().catch(next);
  };

  router.get("/support-chat/loader.js", loader);
  router.get("/support-chat/:widgetKey", framePage);
  return router;
}
