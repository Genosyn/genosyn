import type { Request } from "express";

import { config } from "../../../config.js";
import type { RecruitingSettings } from "../../db/entities/RecruitingSettings.js";
import { getPublicUrl } from "../publicUrl.js";
import { customDomainLive, hostnameOf } from "./domains.js";

/**
 * Every address the careers site is reachable at, built in one place so an
 * email, the JSON-LD a search engine reads, the sitemap and the App's "View
 * site" button can never disagree about where an Opening lives.
 *
 * A site always answers at `<public URL>/careers/<company slug>`. Once a
 * custom domain is verified and the site is public, that domain is the
 * canonical address and the install path stays as an alias.
 */

/** The careers site on this install's own address. */
export function installCareersUrl(companySlug: string): string {
  return `${getPublicUrl()}/careers/${encodeURIComponent(companySlug)}`;
}

/** The address people should be sent to: the custom domain once it is live. */
export function careersBaseUrl(companySlug: string, settings: RecruitingSettings | null): string {
  if (settings && customDomainLive(settings)) {
    const protocol = getPublicUrl().startsWith("http://") ? "http" : "https";
    return `${protocol}://${settings.customDomain}`;
  }
  return installCareersUrl(companySlug);
}

export function openingPublicUrl(
  companySlug: string,
  settings: RecruitingSettings | null,
  openingSlug: string,
): string {
  return `${careersBaseUrl(companySlug, settings)}/openings/${encodeURIComponent(openingSlug)}`;
}

/** Same-origin paths the careers pages call, valid on the install and on a custom domain. */
export function careersApiPath(companySlug: string): string {
  return `/api/careers/sites/${encodeURIComponent(companySlug)}`;
}

/**
 * The host the request arrived for. Behind a trusted proxy that is the
 * forwarded host, the same rule `requireTrustedOrigin` applies, so the
 * careers site and the CSRF check agree on who the request was for.
 */
export function requestHostname(req: Request): string {
  const forwarded =
    config.security.trustedProxyHops > 0 ? req.headers["x-forwarded-host"] : undefined;
  const header =
    typeof forwarded === "string" && forwarded.trim()
      ? forwarded.split(",")[0]?.trim()
      : req.headers.host;
  return hostnameOf(header);
}
