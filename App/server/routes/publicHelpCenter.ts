import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from "express";
import { z } from "zod";

import { SUPPORT_LIMITS } from "../../shared/support.js";
import { withRouteMetadata } from "../middleware/routeMetadata.js";
import { validateQuery } from "../middleware/validate.js";
import {
  AuthRateLimitError,
  assertAuthAllowed,
  authThrottleKeys,
  consumeAuthAttempt,
  type AuthRateLimitPolicy,
} from "../services/authThrottle.js";
import { ListQueryError, pageQueryShape } from "../services/listPaging.js";
import {
  HELP_CENTER_MISSING_HEAD,
  fillHelpCenterShell,
  findHelpCenter,
  helpCenterArticleHead,
  helpCenterHome,
  helpCenterHomeHead,
  listHelpCenterArticles,
  readHelpCenterArticle,
  searchHelpCenter,
  type HelpCenter,
  type HelpCenterHead,
} from "../services/support/helpCenter.js";

/**
 * A company's public help center: its pages at `/help/<company slug>` and their
 * API at `/api/help`. Mounted before the session and the trusted-origin gate: a
 * visitor has no account, so what a Member's cookie says never changes an answer.
 *
 * Off, the slug of a company that never existed, a malformed slug or id, a draft
 * and another company's Article all answer the same 404, so none can be told from
 * another. A malformed value never reaches a lookup: Postgres types an Article's
 * id as uuid and raises on anything else.
 */
export const publicHelpCenterRouter = Router();

/**
 * Not indexed, on purpose. Turning the help center on lets anyone with the link
 * read the Articles; it does not ask to have them copied into search engines,
 * which keep a copy after the switch goes off or an Article is taken back. Not
 * cached either, so both of those take effect on the very next request.
 */
export const helpCenterSecurityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
};

publicHelpCenterRouter.use(helpCenterSecurityHeaders);

const NOT_FOUND = "This page is not available.";
const TOO_MANY_READS = "Too many requests. Try again later.";
const TOO_MANY_SEARCHES = "Too many searches. Try again in a minute.";

/**
 * Scanning for slugs and ids. A dead link is not a guessed password, so this is
 * looser than the sign-in limits, while still stopping a scan within minutes. Only
 * a miss counts, and only an address that has missed or searched leaves a row.
 */
export const HELP_CENTER_MISS_LIMIT: AuthRateLimitPolicy = {
  windowMinutes: 15,
  maxAttempts: 100,
  blockMinutes: 15,
};

/** Search reads every word of a company's Articles, on SQLite on the event loop. */
export const HELP_CENTER_SEARCH_LIMIT: AuthRateLimitPolicy = {
  windowMinutes: 1,
  maxAttempts: 30,
  blockMinutes: 1,
};

const companySlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/);
const centerParams = z.object({ companySlug }).strict();
const articleParams = z.object({ companySlug, articleId: z.string().uuid() }).strict();

const pageQuery = z.object(pageQueryShape).strict();
const searchQuery = z
  .object({
    q: z
      .string()
      .trim()
      .min(1)
      .max(SUPPORT_LIMITS.helpCenterQueryChars)
      .describe("The words to find. Every word must appear in an Article's title or body."),
    ...pageQueryShape,
  })
  .strict();

/** Why a request gets no page. */
type Refusal = { status: 404 } | { status: 429; retryAfterSeconds: number };

function isRefusal(value: HelpCenter | Refusal): value is Refusal {
  return "status" in value;
}

function refusalFrom(error: unknown): Refusal {
  if (!(error instanceof AuthRateLimitError)) throw error;
  return { status: 429, retryAfterSeconds: error.retryAfterSeconds };
}

function readKeys(req: Request): string[] {
  return authThrottleKeys(req, "public-help-center");
}

/** A request for something that is not there: counted, however it was asked for. */
async function missed(req: Request): Promise<Refusal> {
  try {
    await consumeAuthAttempt(readKeys(req), HELP_CENTER_MISS_LIMIT);
    return { status: 404 };
  } catch (error) {
    return refusalFrom(error);
  }
}

/** The help center this request may read; `slug` is null when it was not one at all. */
async function openHelpCenter(req: Request, slug: string | null): Promise<HelpCenter | Refusal> {
  try {
    await assertAuthAllowed(readKeys(req));
  } catch (error) {
    return refusalFrom(error);
  }
  const center = slug ? await findHelpCenter(slug) : null;
  return center ?? missed(req);
}

function refuse(res: Response, refusal: Refusal, tooMany = TOO_MANY_READS): void {
  if (refusal.status === 429) {
    res.setHeader("Retry-After", String(refusal.retryAfterSeconds));
    res.status(429).json({ error: tooMany });
    return;
  }
  res.status(404).json({ error: NOT_FOUND });
}

/** A malformed slug or id is a guess like any other: the same 404, counted the same way. */
function validParams(schema: z.ZodTypeAny): RequestHandler {
  return withRouteMetadata(
    (req: Request, res: Response, next: NextFunction) => {
      const parsed = schema.safeParse(req.params);
      if (parsed.success) {
        req.params = parsed.data as Request["params"];
        next();
        return;
      }
      void openHelpCenter(req, null)
        .then((answer) => refuse(res, answer as Refusal))
        .catch(next);
    },
    { kind: "requestSchema", location: "params", schema },
  );
}

function route(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch((error: unknown) => {
      if (error instanceof ListQueryError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    });
  };
}

publicHelpCenterRouter.get(
  "/:companySlug",
  validParams(centerParams),
  route(async (req, res) => {
    const center = await openHelpCenter(req, req.params.companySlug);
    if (isRefusal(center)) return refuse(res, center);
    res.json(await helpCenterHome(center));
  }),
);

publicHelpCenterRouter.get(
  "/:companySlug/articles",
  validParams(centerParams),
  validateQuery(pageQuery),
  route(async (req, res) => {
    const center = await openHelpCenter(req, req.params.companySlug);
    if (isRefusal(center)) return refuse(res, center);
    const { limit, cursor } = req.query as unknown as z.infer<typeof pageQuery>;
    res.json(await listHelpCenterArticles(center, { limit, cursor }));
  }),
);

publicHelpCenterRouter.get(
  "/:companySlug/articles/:articleId",
  validParams(articleParams),
  route(async (req, res) => {
    const center = await openHelpCenter(req, req.params.companySlug);
    if (isRefusal(center)) return refuse(res, center);
    const article = await readHelpCenterArticle(center, req.params.articleId);
    if (!article) return refuse(res, await missed(req));
    res.json({ companyName: center.companyName, article });
  }),
);

publicHelpCenterRouter.get(
  "/:companySlug/search",
  validParams(centerParams),
  validateQuery(searchQuery),
  route(async (req, res) => {
    const center = await openHelpCenter(req, req.params.companySlug);
    if (isRefusal(center)) return refuse(res, center);
    try {
      await consumeAuthAttempt(
        authThrottleKeys(req, "public-help-center-search"),
        HELP_CENTER_SEARCH_LIMIT,
      );
    } catch (error) {
      return refuse(res, refusalFrom(error), TOO_MANY_SEARCHES);
    }
    const { q, limit, cursor } = req.query as unknown as z.infer<typeof searchQuery>;
    res.json(await searchHelpCenter(center, q, { limit, cursor }));
  }),
);

/**
 * The pages, in the App's own shell, which draws them from the API. They answer
 * here rather than from the App's catch-all so that a page that is not there is a
 * real 404, for a link checker as much as a person, and so that a pasted link shows
 * this page's title rather than the App's.
 */
export function helpCenterPagesRouter(options: {
  /** The App shell for a URL: the built file in production, Vite's transform in development. */
  loadTemplate: (url: string) => Promise<string>;
}): Router {
  const router = Router();

  async function send(req: Request, res: Response, answer: HelpCenterHead | Refusal) {
    const refusal = "status" in answer ? answer : null;
    if (refusal?.status === 429) res.setHeader("Retry-After", String(refusal.retryAfterSeconds));
    res.status(refusal?.status ?? 200);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      fillHelpCenterShell(
        await options.loadTemplate(req.originalUrl),
        refusal ? HELP_CENTER_MISSING_HEAD : (answer as HelpCenterHead),
      ),
    );
  }

  router.get(
    "/help/:companySlug",
    route(async (req, res) => {
      const parsed = centerParams.safeParse(req.params);
      const center = await openHelpCenter(req, parsed.success ? parsed.data.companySlug : null);
      await send(req, res, isRefusal(center) ? center : helpCenterHomeHead(center));
    }),
  );

  router.get(
    "/help/:companySlug/articles/:articleId",
    route(async (req, res) => {
      const parsed = articleParams.safeParse(req.params);
      const center = await openHelpCenter(req, parsed.success ? parsed.data.companySlug : null);
      if (isRefusal(center) || !parsed.success) {
        await send(req, res, center as Refusal);
        return;
      }
      const article = await readHelpCenterArticle(center, parsed.data.articleId);
      await send(req, res, article ? helpCenterArticleHead(center, article) : await missed(req));
    }),
  );

  // No other page lives here, and none of them falls through to the App's sign-in.
  router.get(
    ["/help", "/help/*"],
    route(async (req, res) => {
      await send(req, res, await missed(req));
    }),
  );

  return router;
}
