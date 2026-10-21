import { normalizeAccentColor, DEFAULT_ACCENT_COLOR } from "../../../shared/recruiting.js";
import type { RecruitingOpening } from "../../db/entities/RecruitingOpening.js";
import { getPublicUrl } from "../publicUrl.js";
import { logoPath } from "./settings.js";
import {
  findSiteOpening,
  jobPostingJsonLd,
  listSiteOpenings,
  publicOpeningDto,
  publicSiteDto,
  siteIndexable,
  siteVisibleTo,
  type CareersViewer,
  type PublicOpening,
  type PublicOpeningCard,
  type PublicSite,
  type ResolvedSite,
} from "./site.js";
import { careersBaseUrl, openingPublicUrl } from "./urls.js";

/**
 * The careers site's HTML: the built `careers.html` shell with this page's
 * head and first data filled in on the server.
 *
 * Link previews, search engines and job boards do not run JavaScript, so the
 * title, description, canonical address, Open Graph tags, `robots` rules and
 * the schema.org JobPosting are written into the page itself. The same data
 * the page renders from is embedded as a JSON data block — never executed,
 * so the strict Content-Security-Policy stays as it is — and the browser
 * paints the right page without a second request.
 */

export const CAREERS_HEAD_MARKER = "<!--careers-head-->";
export const CAREERS_DATA_MARKER = "<!--careers-bootstrap-->";

export type CareersBootstrap = {
  kind: "home" | "opening" | "not_found" | "members_only";
  /** "" on a custom domain; "/careers/<slug>" on the install's own address. */
  basePath: string;
  site: PublicSite | null;
  openings: PublicOpeningCard[];
  opening: PublicOpening | null;
  /** Where a visitor signs in, for a site only Members may see. */
  signInUrl: string;
};

export type RenderedCareersPage = {
  status: number;
  html: string;
  noindex: boolean;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * JSON safe inside a `<script>` element: nothing in a string can close the
 * element or open a comment, whatever a company typed into a title.
 */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** The first sentence or so of Markdown, as plain text for a meta description. */
export function plainSnippet(markdown: string, max = 160): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

type Head = {
  title: string;
  description: string;
  canonical: string | null;
  noindex: boolean;
  image: string | null;
  siteName: string;
  themeColor: string;
  favicon: string | null;
  jsonLd: Record<string, unknown> | null;
};

function headTags(head: Head): string {
  const tags = [
    `<title>${escapeHtml(head.title)}</title>`,
    `<meta name="description" content="${escapeHtml(head.description)}" />`,
    `<meta name="robots" content="${head.noindex ? "noindex, nofollow" : "index, follow"}" />`,
    `<meta name="theme-color" content="${escapeHtml(head.themeColor)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${escapeHtml(head.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(head.description)}" />`,
    `<meta property="og:site_name" content="${escapeHtml(head.siteName)}" />`,
    `<meta name="twitter:card" content="summary" />`,
  ];
  if (head.canonical) {
    tags.push(`<link rel="canonical" href="${escapeHtml(head.canonical)}" />`);
    tags.push(`<meta property="og:url" content="${escapeHtml(head.canonical)}" />`);
  }
  if (head.image) tags.push(`<meta property="og:image" content="${escapeHtml(head.image)}" />`);
  tags.push(
    head.favicon
      ? `<link rel="icon" href="${escapeHtml(head.favicon)}" />`
      : `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`,
  );
  if (head.jsonLd) {
    tags.push(`<script type="application/ld+json">${scriptSafeJson(head.jsonLd)}</script>`);
  }
  return tags.join("\n    ");
}

/** Put this page's head and data into the shell. */
export function fillCareersTemplate(template: string, headHtml: string, bootstrap: CareersBootstrap): string {
  const data = `<script type="application/json" id="careers-bootstrap">${scriptSafeJson(bootstrap)}</script>`;
  // Replacer functions, never strings: in a replacement string "$'" and "$`"
  // splice in the rest of the template, and an Opening's text may hold them.
  return template
    .replace(/<title>[\s\S]*?<\/title>/, "")
    .replace(CAREERS_HEAD_MARKER, () => headHtml)
    .replace(CAREERS_DATA_MARKER, () => data);
}

function absolute(origin: string, path: string | null): string | null {
  if (!path) return null;
  try {
    return new URL(path, origin).toString();
  } catch {
    return null;
  }
}

/**
 * Render one careers page. The status is
 * 404 for anything this visitor may not see — including an internal Opening
 * shown to someone who is not a Member — so an unlisted or internal Opening
 * cannot be told apart from one that never existed.
 */
export type CareersPageRequest =
  | { kind: "home" }
  | { kind: "opening"; slug: string }
  /** A path the site has no page for. */
  | { kind: "missing" };

export async function renderCareersPage(args: {
  template: string;
  site: ResolvedSite | null;
  viewer: CareersViewer;
  page: CareersPageRequest;
  basePath: string;
}): Promise<RenderedCareersPage> {
  const { site, viewer } = args;
  const notFound = (siteForHead: ResolvedSite | null): RenderedCareersPage => {
    const name = siteForHead ? siteForHead.settings.siteTitle || siteForHead.company.name : "Careers";
    const bootstrap: CareersBootstrap = {
      kind: "not_found",
      basePath: args.basePath,
      site: siteForHead && siteVisibleTo(siteForHead, viewer) ? publicSiteDto(siteForHead, viewer) : null,
      openings: [],
      opening: null,
      signInUrl: `${getPublicUrl()}/login`,
    };
    return {
      status: 404,
      noindex: true,
      html: fillCareersTemplate(
        args.template,
        headTags({
          title: `Page not found · ${name}`,
          description: "This page is not available.",
          canonical: null,
          noindex: true,
          image: null,
          siteName: name,
          themeColor: DEFAULT_ACCENT_COLOR,
          favicon: null,
          jsonLd: null,
        }),
        bootstrap,
      ),
    };
  };

  if (!site) return notFound(null);
  const name = site.settings.siteTitle || site.company.name;
  const base = careersBaseUrl(site.company.slug, site.settings);
  const origin = new URL(base).origin;
  const accent = normalizeAccentColor(site.settings.accentColor) ?? DEFAULT_ACCENT_COLOR;
  const logo = absolute(origin, logoPath(site.company.slug, site.settings));

  if (!siteVisibleTo(site, viewer)) {
    const bootstrap: CareersBootstrap = {
      kind: "members_only",
      basePath: args.basePath,
      site: null,
      openings: [],
      opening: null,
      signInUrl: `${getPublicUrl()}/login`,
    };
    return {
      status: 403,
      noindex: true,
      html: fillCareersTemplate(
        args.template,
        headTags({
          title: `Careers · ${name}`,
          description: `${name}'s internal careers site, for Members.`,
          canonical: null,
          noindex: true,
          image: null,
          siteName: name,
          themeColor: accent,
          favicon: null,
          jsonLd: null,
        }),
        bootstrap,
      ),
    };
  }

  const siteDto = publicSiteDto(site, viewer);
  const indexable = siteIndexable(site);

  if (args.page.kind === "missing") return notFound(site);

  if (args.page.kind === "home") {
    const openings = await listSiteOpenings(site, viewer);
    const description =
      site.settings.siteHeadline ||
      plainSnippet(site.settings.siteIntro) ||
      `Open roles at ${name}: ${openings.length} ${openings.length === 1 ? "opening" : "openings"}.`;
    return {
      status: 200,
      noindex: !indexable,
      html: fillCareersTemplate(
        args.template,
        headTags({
          title: `Careers at ${name}`,
          description,
          canonical: base,
          noindex: !indexable,
          image: logo,
          siteName: name,
          themeColor: accent,
          favicon: logo,
          jsonLd: null,
        }),
        { kind: "home", basePath: args.basePath, site: siteDto, openings, opening: null, signInUrl: "" },
      ),
    };
  }

  const opening: RecruitingOpening | null = await findSiteOpening(site, args.page.slug, viewer);
  if (!opening) return notFound(site);
  const dto = publicOpeningDto(opening, site);
  const listedPublicly = opening.visibility === "public";
  const noindex = !indexable || !listedPublicly || !dto.accepting;
  return {
    status: 200,
    noindex,
    html: fillCareersTemplate(
      args.template,
      headTags({
        title: `${opening.title} · ${name}`,
        description: opening.summary || plainSnippet(opening.description) || `${opening.title} at ${name}.`,
        canonical: openingPublicUrl(site.company.slug, site.settings, opening.slug),
        noindex,
        image: logo,
        siteName: name,
        themeColor: accent,
        favicon: logo,
        jsonLd: !noindex ? jobPostingJsonLd(opening, site) : null,
      }),
      { kind: "opening", basePath: args.basePath, site: siteDto, openings: [], opening: dto, signInUrl: "" },
    ),
  };
}
