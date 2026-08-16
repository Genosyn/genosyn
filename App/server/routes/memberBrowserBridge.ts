import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";

import { validateBody } from "../middleware/validate.js";
import {
  assertAuthAllowed,
  authThrottleKeys,
  consumeAuthAttempt,
  recordAuthFailure,
} from "../services/authThrottle.js";
import { memberBrowsersEnabled, redeemPairingCode } from "../services/memberBrowsers.js";

/**
 * The machine-facing half of member browsers, mounted at
 * `/api/internal/member-browsers` beside the other bearer-authenticated
 * internal surfaces.
 *
 * Two endpoints, both talking to a Node process on somebody's laptop rather
 * than to a browser:
 *
 *   POST /pair       one-time code → long-lived bridge token
 *   GET  /agent.mjs  the bridge itself, so `curl | node` works
 *
 * Mounted *below* `requireTrustedOrigin`. The agent sends no `Origin` header,
 * so it passes that gate anyway — but sitting below it means a web page cannot
 * reach `/pair` cross-origin, and sitting below `rejectAiBrowserAppRequests`
 * means an AI-driven browser cannot pair a browser for itself.
 */
export const memberBrowserBridgeRouter = Router();

memberBrowserBridgeRouter.use((_req, res, next) => {
  if (!memberBrowsersEnabled()) {
    return res.status(404).json({ error: "Member browsers are disabled on this instance" });
  }
  next();
});

const pairSchema = z
  .object({
    code: z.string().min(8).max(200),
    agentVersion: z.string().max(40).optional(),
  })
  .strict();

memberBrowserBridgeRouter.post("/pair", validateBody(pairSchema), async (req, res) => {
  // Codes are 160-bit and single-use, so this is not the thing standing
  // between an attacker and a browser — it is what keeps a scripted sweep of
  // the endpoint from being free, and it reuses the same counters the login
  // routes already use.
  const keys = authThrottleKeys(req, "member-browser-pair");
  try {
    await assertAuthAllowed(keys);
  } catch (err) {
    return res.status(429).json({
      error: err instanceof Error ? err.message : "Too many attempts. Try again later.",
    });
  }

  const body = req.body as z.infer<typeof pairSchema>;
  const redeemed = await redeemPairingCode(body.code);
  if (!redeemed) {
    await recordAuthFailure(keys);
    return res.status(400).json({
      error: "That pairing code is not valid. Codes expire after 10 minutes and work once.",
    });
  }
  await consumeAuthAttempt(keys);

  res.json({
    browserId: redeemed.browser.id,
    name: redeemed.browser.name,
    token: redeemed.token,
  });
});

/** Absolute path to the bridge agent (dev: `server/`, prod: `dist/server/`). */
const AGENT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "browser-bridge",
  "agent.mjs",
);

let cachedAgent: string | null = null;

memberBrowserBridgeRouter.get("/agent.mjs", (_req, res) => {
  try {
    if (cachedAgent === null) cachedAgent = fs.readFileSync(AGENT_PATH, "utf8");
  } catch {
    return res.status(500).json({ error: "The bridge agent is not available on this install" });
  }
  // Served without auth on purpose: it is open-source code carrying no
  // secrets, and requiring a token here would mean pasting one into a shell
  // before the pairing step that exists to avoid exactly that.
  res.setHeader("Content-Type", "text/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(cachedAgent);
});
