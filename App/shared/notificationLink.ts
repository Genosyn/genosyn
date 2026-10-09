/**
 * Where a notification takes its reader. A link is a path inside the App, and
 * almost every one lives under the company it belongs to (`/c/acme/goals`).
 * A few producers wrote a bare section path instead (`/goals`), which the
 * router's catch-all sent to the first company's Home: the wrong page, and for
 * a Member of two companies, the wrong company. So a bare path takes its
 * company's prefix — when the row is written, and again when an older row is
 * opened. A path that already says where it goes (`/c/…`, `/invite/…`,
 * `/link-chat/…`) and anything that is not a plain App path are left alone.
 */

/** Top-level App paths that belong to no single company. */
const OUTSIDE_ANY_COMPANY = /^\/(?:c|invite|link-chat)(?:[/?#]|$)/;

/** Whether `link` is a bare App path that still needs its company's prefix. */
export function needsCompanyPrefix(link: string | null | undefined): link is string {
  return (
    typeof link === "string" &&
    link.startsWith("/") &&
    !link.startsWith("//") &&
    !OUTSIDE_ANY_COMPANY.test(link)
  );
}

/** `link` inside the company `companySlug`, or null when there is none. */
export function companyNotificationLink(
  companySlug: string,
  link: string | null | undefined,
): string | null {
  if (!link) return null;
  return needsCompanyPrefix(link) ? `/c/${companySlug}${link}` : link;
}
