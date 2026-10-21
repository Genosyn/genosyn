import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";

import { resolveUserSession } from "../services/userSessions.js";
import { careersCompanyForHost } from "../services/recruiting/domains.js";
import { renderCareersPage, type CareersPageRequest } from "../services/recruiting/pages.js";
import {
  careersViewer,
  resolveSite,
  robotsTxt,
  sitemapXml,
  ANONYMOUS_VIEWER,
  type ResolvedSite,
} from "../services/recruiting/site.js";
import { careersBaseUrl, requestHostname } from "../services/recruiting/urls.js";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";

/**
 * The careers site's pages, on both of its addresses:
 *
 *  - the install's own: `/careers/<company slug>` and
 *    `/careers/<company slug>/openings/<opening slug>`;
 *  - a verified custom domain: `/` and `/openings/<opening slug>`, plus its
 *    own `robots.txt` and `sitemap.xml`.
 *
 * A custom domain serves the careers site and nothing else. The guard below
 * runs before any other route, so `careers.example.com/api/auth/login`, the
 * App shell, the service worker and every company API answer 404 there: a
 * domain the company controls must never become a second front door to the
 * App, its sign-in page or its session cookie.
 */

/** Builds the HTML shell for a URL: the built file in production, Vite's transform in development. */
export type CareersTemplateLoader = (url: string) => Promise<string>;

/** App files that must never answer on a careers domain. */
const APP_ONLY_FILES = new Set(["/index.html", "/sw.js", "/manifest.webmanifest", "/careers.html"]);

/** Where the guard sends a path a careers domain has no page for: the careers "not found". */
export const CAREERS_MISSING_PATH = "/__careers/missing";

/** One built file by its own name: no directory, no "..", nothing percent-encoded. */
const BUILT_ASSET = /^\/assets\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
/** A plain path that walks nowhere: what Vite's modules look like in development. */
const PLAIN_PATH = /^\/[A-Za-z0-9@._/-]*$/;
const DOT_SEGMENT = /(?:^|\/)\.{1,2}(?:\/|$)/;

/**
 * Static files the careers page needs: built assets in production, Vite's
 * modules in development. `express.static` decodes and normalizes what it is
 * given, so anything that could climb out of `/assets/` — `/assets/../`,
 * `..%2f`, `%2e%2e` — is not an asset here.
 */
function isAssetPath(path: string, isDev: boolean): boolean {
  if (path === "/favicon.svg" || BUILT_ASSET.test(path)) return true;
  if (!isDev || !PLAIN_PATH.test(path) || DOT_SEGMENT.test(path) || APP_ONLY_FILES.has(path)) return false;
  return path.startsWith("/@") || path.startsWith("/node_modules/") || /\.[a-z0-9]+$/i.test(path);
}

/**
 * The App shell for every other path, except on a careers domain: there a
 * file that is not found is a 404, never the App's sign-in page.
 */
export function appShellFallback(indexHtmlPath: string): RequestHandler {
  return (req, res, next) => {
    if (careersCompanyForHost(requestHostname(req))) return next();
    res.sendFile(indexHtmlPath);
  };
}

const OPENING_PATH = /^\/openings\/([a-z0-9][a-z0-9-]{0,119})\/?$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/;

function isCareersDomainPage(path: string): boolean {
  return path === "/" || path === "/robots.txt" || path === "/sitemap.xml" || OPENING_PATH.test(path);
}

/**
 * Mounted first. On a careers custom domain the only API routes are the
 * careers API and the health probe; the only pages are the careers site's;
 * and every other path — the App shell, a signing link, an unsubscribe link —
 * is answered by the careers site's own "not found", so no router mounted
 * later can respond there.
 */
export function careersHostGuard(options: { isDev: boolean }): RequestHandler {
  return (req, res, next) => {
    if (!careersCompanyForHost(requestHostname(req))) return next();
    const path = req.path;
    if (path === "/api/health" || path.startsWith("/api/careers/")) return next();
    if (path === "/api" || path.startsWith("/api/")) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (isCareersDomainPage(path) || isAssetPath(path, options.isDev)) return next();
    req.url = CAREERS_MISSING_PATH;
    next();
  };
}

async function sessionUserId(req: Request): Promise<string | null> {
  if (!req.session?.userId) return null;
  try {
    return (await resolveUserSession(req.session))?.id ?? null;
  } catch {
    return null;
  }
}

export function careersPagesRouter(options: {
  loadTemplate: CareersTemplateLoader;
  isDev: boolean;
}): Router {
  const router = Router();

  async function sendPage(
    req: Request,
    res: Response,
    site: ResolvedSite | null,
    page: CareersPageRequest,
    basePath: string,
    onCustomDomain: boolean,
  ): Promise<void> {
    const viewer = site
      ? await careersViewer(site.company, onCustomDomain ? null : await sessionUserId(req))
      : ANONYMOUS_VIEWER;
    const template = await options.loadTemplate(req.originalUrl);
    const rendered = await renderCareersPage({ template, site, viewer, page, basePath });
    res.status(rendered.status);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-cache");
    if (rendered.noindex) res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.send(rendered.html);
  }

  const wrap =
    (handler: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler =>
    (req, res, next) => {
      void handler(req, res, next).catch(next);
    };

  // The custom-domain host first: it owns every path on that host.
  router.use(
    wrap(async (req, res, next) => {
      const companyId = careersCompanyForHost(requestHostname(req));
      if (!companyId) return next();
      if (isAssetPath(req.path, options.isDev)) return next();
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.status(404).json({ error: "Not found" });
        return;
      }
      const company = await AppDataSource.getRepository(Company).findOneBy({ id: companyId });
      const site = company ? await resolveSite(company.slug, { hostCompanyId: companyId }) : null;
      if (req.path === "/robots.txt") {
        res.type("text/plain").send(robotsTxt(site, site ? `${careersBaseUrl(site.company.slug, site.settings)}/sitemap.xml` : null));
        return;
      }
      if (req.path === "/sitemap.xml") {
        if (!site) {
          res.status(404).type("text/plain").send("Not found");
          return;
        }
        res.type("application/xml").send(await sitemapXml(site));
        return;
      }
      if (req.path === "/") {
        await sendPage(req, res, site, { kind: "home" }, "", true);
        return;
      }
      const opening = OPENING_PATH.exec(req.path);
      await sendPage(
        req,
        res,
        site,
        opening ? { kind: "opening", slug: opening[1] } : { kind: "missing" },
        "",
        true,
      );
    }),
  );

  router.get(
    "/careers/:siteSlug/sitemap.xml",
    wrap(async (req, res) => {
      const site = SLUG.test(req.params.siteSlug)
        ? await resolveSite(req.params.siteSlug, { hostCompanyId: null })
        : null;
      if (!site) {
        res.status(404).type("text/plain").send("Not found");
        return;
      }
      res.type("application/xml").send(await sitemapXml(site));
    }),
  );

  router.get(
    ["/careers/:siteSlug", "/careers/:siteSlug/openings/:openingSlug"],
    wrap(async (req, res) => {
      const siteSlug = req.params.siteSlug;
      const openingSlug = req.params.openingSlug ?? null;
      const valid = SLUG.test(siteSlug) && (openingSlug === null || SLUG.test(openingSlug));
      const site = valid ? await resolveSite(siteSlug, { hostCompanyId: null }) : null;
      const page: CareersPageRequest = !valid
        ? { kind: "missing" }
        : openingSlug === null
          ? { kind: "home" }
          : { kind: "opening", slug: openingSlug };
      await sendPage(req, res, site, page, `/careers/${encodeURIComponent(siteSlug)}`, false);
    }),
  );

  // Anything else under a careers path is the careers site's own "not found",
  // never the App shell.
  router.get(
    ["/careers", "/careers.html", "/careers/:siteSlug/*"],
    wrap(async (req, res) => {
      const siteSlug = req.params.siteSlug;
      const site =
        siteSlug && SLUG.test(siteSlug) ? await resolveSite(siteSlug, { hostCompanyId: null }) : null;
      await sendPage(
        req,
        res,
        site,
        { kind: "missing" },
        siteSlug ? `/careers/${encodeURIComponent(siteSlug)}` : "/careers",
        false,
      );
    }),
  );

  return router;
}
