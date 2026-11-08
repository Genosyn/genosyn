import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";

import { DASHBOARD_LINK_TOKEN } from "../../shared/dashboardLinks.js";
import {
  AuthRateLimitError,
  assertAuthAllowed,
  authThrottleKeys,
  recordAuthFailure,
} from "../services/authThrottle.js";
import {
  DashboardLinkNotFoundError,
  SharedChartUnavailableError,
  dashboardLinkTokenExists,
  resolveDashboardLink,
  sharedDashboardChart,
  sharedDashboardView,
  type DashboardLinkContext,
} from "../services/dashboardLinks.js";

/**
 * Whoever holds a Dashboard link: a TV in the office, a screen in a lobby, a
 * person someone sent it to. Mount at `/api/dashboards`, before the session
 * and the trusted-origin gate like the other link surfaces: there is no
 * account here, and the unguessable token in the path is the only credential.
 *
 * Reads only. A token that never was, a link that is off and a link whose
 * sharer has left all answer the same 404, and a guess counts against the
 * source address (`services/authThrottle.ts`), keyed by address alone so
 * random tokens cannot grow the table. What a link shows is decided in
 * `services/dashboardLinks.ts`.
 */
export const publicDashboardsRouter = Router();

/** Bearer-token pages and payloads are never cached, indexed or sent on as a referrer. */
export const publicDashboardSecurityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
};

publicDashboardsRouter.use(publicDashboardSecurityHeaders);

const NOT_FOUND = "This dashboard link is invalid or turned off.";

const tokenParams = z.object({ token: z.string().regex(DASHBOARD_LINK_TOKEN) }).strict();
const chartParams = z
  .object({ token: z.string().regex(DASHBOARD_LINK_TOKEN), chartId: z.string().uuid() })
  .strict();

function throttleKeys(req: Request): string[] {
  return authThrottleKeys(req, "public-dashboard");
}

async function throttleAllowed(req: Request, res: Response): Promise<boolean> {
  try {
    await assertAuthAllowed(throttleKeys(req));
    return true;
  } catch (error) {
    if (!(error instanceof AuthRateLimitError)) throw error;
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
    res.status(429).json({ error: error.message });
    return false;
  }
}

/** A link someone turned off is not a guess; only a token that never was counts. */
async function notFound(req: Request, res: Response, token: string | null): Promise<void> {
  if (!token || !(await dashboardLinkTokenExists(token))) {
    await recordAuthFailure(throttleKeys(req));
  }
  res.status(404).json({ error: NOT_FOUND });
}

/**
 * Validate params here rather than with `validateParams`, so a malformed token
 * answers exactly like an unknown one — and counts as a failed guess.
 */
function withParams(schema: z.ZodTypeAny): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const parsed = schema.safeParse(req.params);
      if (parsed.success) {
        req.params = parsed.data;
        next();
        return;
      }
      if (!(await throttleAllowed(req, res))) return;
      await notFound(req, res, null);
    })().catch(next);
  };
}

function linkRoute(
  handler: (req: Request, res: Response, context: DashboardLinkContext) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      if (!(await throttleAllowed(req, res))) return;
      const token = req.params.token;
      const context = await resolveDashboardLink(token);
      if (!context) {
        await notFound(req, res, token);
        return;
      }
      try {
        await handler(req, res, context);
      } catch (error) {
        if (error instanceof DashboardLinkNotFoundError) {
          // The token is good; only the chart is not on this Dashboard.
          res.status(404).json({ error: "That chart is not on this dashboard." });
          return;
        }
        if (error instanceof SharedChartUnavailableError) {
          res.status(422).json({ error: error.message });
          return;
        }
        throw error;
      }
    })().catch(next);
  };
}

publicDashboardsRouter.get(
  "/:token",
  withParams(tokenParams),
  linkRoute(async (_req, res, context) => {
    res.json(await sharedDashboardView(context));
  }),
);

publicDashboardsRouter.get(
  "/:token/charts/:chartId/result",
  withParams(chartParams),
  linkRoute(async (req, res, context) => {
    res.json(await sharedDashboardChart(context, req.params.chartId));
  }),
);
