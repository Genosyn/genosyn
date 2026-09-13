import { Router, type Response } from "express";
import { z } from "zod";

import {
  customJavaScriptAllowedForUrl,
  getCustomJavaScriptAsset,
  getCustomJavaScriptLoaderAsset,
  hasCustomJavaScript,
} from "../services/customJavaScript.js";
import { resolveUserSession } from "../services/userSessions.js";

/**
 * Browser asset referenced by the App shell. It deliberately lives under
 * /api so the service worker never caches code an operator has removed.
 */
export const customJavaScriptRouter = Router();

function sendJavaScript(res: Response, source: string): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.type("text/javascript").send(source);
}

const customJavaScriptAssetQuery = z.object({
  page: z.string().min(1).max(8192),
});

customJavaScriptRouter.get("/custom-javascript-loader.js", (_req, res) => {
  sendJavaScript(res, getCustomJavaScriptLoaderAsset());
});

customJavaScriptRouter.get("/custom-javascript.js", async (req, res, next) => {
  const emptyAsset = "/* Custom JavaScript is unavailable on this page. */\n";
  const query = customJavaScriptAssetQuery.safeParse(req.query);
  if (!hasCustomJavaScript() || !query.success || !customJavaScriptAllowedForUrl(query.data.page)) {
    sendJavaScript(res, emptyAsset);
    return;
  }

  try {
    // A signed cookie alone is not enough: honor persisted logout and account
    // revocation exactly as the rest of the App does.
    const user = await resolveUserSession(req.session);
    if (!user) {
      req.session = null;
      sendJavaScript(res, emptyAsset);
      return;
    }
    sendJavaScript(res, getCustomJavaScriptAsset());
  } catch (err) {
    next(err);
  }
});
