import { Marked, type Tokens } from "marked";
import { In } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { Company } from "../../db/entities/Company.js";
import { Membership } from "../../db/entities/Membership.js";
import { RecruitingOpening } from "../../db/entities/RecruitingOpening.js";
import type { RecruitingSettings } from "../../db/entities/RecruitingSettings.js";
import { User } from "../../db/entities/User.js";
import {
  COMPENSATION_PERIOD_SCHEMA_ORG,
  DEFAULT_ACCENT_COLOR,
  EMPLOYMENT_TYPE_SCHEMA_ORG,
  normalizeAccentColor,
  openingMetaLine,
  type OpeningVisibility,
} from "../../../shared/recruiting.js";
import { hasTwoFactorMethod } from "../twoFactor.js";
import { parseForm, parseQuestions } from "./content.js";
import { customDomainLive } from "./domains.js";
import { acceptingApplications, openingCompensation } from "./openings.js";
import { findRecruitingSettings, logoPath } from "./settings.js";
import { careersApiPath, careersBaseUrl, openingPublicUrl } from "./urls.js";

/**
 * The careers site as the outside world sees it: which company a request is
 * for, what it may be shown, and the data the public pages and job search
 * engines read.
 *
 * What a visitor sees depends on two things only — the site's visibility and
 * whether they are a signed-in Member of the company. Criteria, Scorecards,
 * screeners and owners are never part of it: a careers site publishes the
 * role, not how applicants are judged.
 */

export type CareersViewer = {
  /** A signed-in Member of this company, on the install's own address. */
  member: boolean;
  userId: string | null;
  name: string;
  email: string;
};

export const ANONYMOUS_VIEWER: CareersViewer = { member: false, userId: null, name: "", email: "" };

export type ResolvedSite = {
  company: Company;
  settings: RecruitingSettings;
};

/**
 * The site for a company slug, when it is switched on. `onCustomDomain` says
 * the request arrived on a careers domain, where an internal site is never
 * served and only that domain's company answers.
 */
export async function resolveSite(
  companySlug: string,
  context: { hostCompanyId: string | null },
): Promise<ResolvedSite | null> {
  const company = await AppDataSource.getRepository(Company).findOneBy({ slug: companySlug });
  if (!company) return null;
  if (context.hostCompanyId && context.hostCompanyId !== company.id) return null;
  const settings = await findRecruitingSettings(company.id);
  if (!settings?.siteEnabled) return null;
  if (context.hostCompanyId && settings.siteVisibility !== "public") return null;
  return { company, settings };
}

/**
 * Who is looking: a Member of this company, or anyone. A company that
 * requires two-factor authentication treats a Member without a second factor
 * as anyone, exactly as `requireCompanyMember` refuses them everywhere else.
 */
export async function careersViewer(
  company: Pick<Company, "id" | "requireTwoFactor">,
  userId: string | null,
): Promise<CareersViewer> {
  if (!userId) return ANONYMOUS_VIEWER;
  const membership = await AppDataSource.getRepository(Membership).findOneBy({
    companyId: company.id,
    userId,
  });
  if (!membership) return ANONYMOUS_VIEWER;
  if (company.requireTwoFactor && !(await hasTwoFactorMethod(userId))) return ANONYMOUS_VIEWER;
  const user = await AppDataSource.getRepository(User).findOneBy({ id: userId });
  return { member: true, userId, name: user?.name ?? "", email: user?.email ?? "" };
}

/** Whether this viewer may see the site at all. */
export function siteVisibleTo(site: ResolvedSite, viewer: CareersViewer): boolean {
  return site.settings.siteVisibility === "public" || viewer.member;
}

/** Whether this viewer may read (and apply to) this Opening. */
export function openingVisibleTo(
  opening: RecruitingOpening,
  site: ResolvedSite,
  viewer: CareersViewer,
): boolean {
  if (opening.companyId !== site.company.id || opening.status === "draft") return false;
  if (!siteVisibleTo(site, viewer)) return false;
  return opening.visibility !== "internal" || viewer.member;
}

/** Listed on the site's front page for this viewer. Unlisted Openings never are. */
function listedFor(opening: RecruitingOpening, viewer: CareersViewer): boolean {
  if (opening.status !== "open" || !acceptingApplications(opening)) return false;
  const listed: OpeningVisibility[] = viewer.member ? ["public", "internal"] : ["public"];
  return listed.includes(opening.visibility);
}

export function publicSiteDto(site: ResolvedSite, viewer: CareersViewer) {
  const { company, settings } = site;
  return {
    companySlug: company.slug,
    name: settings.siteTitle || company.name,
    headline: settings.siteHeadline,
    intro: settings.siteIntro,
    websiteUrl: settings.websiteUrl,
    privacyPolicyUrl: settings.privacyPolicyUrl,
    accentColor: normalizeAccentColor(settings.accentColor) ?? DEFAULT_ACCENT_COLOR,
    logoUrl: logoPath(company.slug, settings),
    visibility: settings.siteVisibility,
    url: careersBaseUrl(company.slug, settings),
    apiPath: careersApiPath(company.slug),
    viewer: { member: viewer.member, name: viewer.name, email: viewer.email },
  };
}

export type PublicSite = ReturnType<typeof publicSiteDto>;

function openingCard(opening: RecruitingOpening, site: ResolvedSite) {
  return {
    slug: opening.slug,
    title: opening.title,
    summary: opening.summary,
    department: opening.department,
    location: opening.location,
    workplace: opening.workplace,
    employmentType: opening.employmentType,
    visibility: opening.visibility,
    // The department heads its group on the site, so the line under the title omits it.
    meta: openingMetaLine({
      employmentType: opening.employmentType,
      workplace: opening.workplace,
      location: opening.location,
    }),
    compensation: openingCompensation(opening).label,
    publishedAt: opening.publishedAt?.toISOString() ?? null,
    applyBy: opening.applyBy?.toISOString() ?? null,
    url: openingPublicUrl(site.company.slug, site.settings, opening.slug),
  };
}

export type PublicOpeningCard = ReturnType<typeof openingCard>;

/** The Openings listed on the site for this viewer, newest first. */
export async function listSiteOpenings(site: ResolvedSite, viewer: CareersViewer): Promise<PublicOpeningCard[]> {
  const openings = await AppDataSource.getRepository(RecruitingOpening).find({
    where: {
      companyId: site.company.id,
      status: "open",
      visibility: In(viewer.member ? ["public", "internal"] : ["public"]),
    },
    order: { publishedAt: "DESC" },
    take: 500,
  });
  return openings.filter((opening) => listedFor(opening, viewer)).map((opening) => openingCard(opening, site));
}

export async function findSiteOpening(
  site: ResolvedSite,
  openingSlug: string,
  viewer: CareersViewer,
): Promise<RecruitingOpening | null> {
  const opening = await AppDataSource.getRepository(RecruitingOpening).findOneBy({
    companyId: site.company.id,
    slug: openingSlug,
  });
  return opening && openingVisibleTo(opening, site, viewer) ? opening : null;
}

/** One Opening on its own page: the card, the full description, and the form to apply with. */
export function publicOpeningDto(opening: RecruitingOpening, site: ResolvedSite) {
  return {
    ...openingCard(opening, site),
    description: opening.description,
    headcount: opening.headcount,
    accepting: acceptingApplications(opening),
    status: opening.status,
    form: parseForm(opening.formJson),
    questions: parseQuestions(opening.questionsJson),
  };
}

export type PublicOpening = ReturnType<typeof publicOpeningDto>;

/**
 * The public JSON feed a company's own website can render its openings from.
 * Public, listed Openings only — never internal or unlisted ones — and only
 * while the site is public.
 */
export async function careersFeed(site: ResolvedSite) {
  const openings =
    site.settings.siteVisibility === "public" ? await listSiteOpenings(site, { ...ANONYMOUS_VIEWER }) : [];
  return {
    version: 1,
    company: site.settings.siteTitle || site.company.name,
    url: careersBaseUrl(site.company.slug, site.settings),
    openings,
  };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Whether search engines may index this site at all. */
export function siteIndexable(site: ResolvedSite): boolean {
  return site.settings.siteVisibility === "public" && site.settings.allowIndexing;
}

export async function sitemapXml(site: ResolvedSite): Promise<string> {
  const base = careersBaseUrl(site.company.slug, site.settings);
  const openings = siteIndexable(site) ? await listSiteOpenings(site, ANONYMOUS_VIEWER) : [];
  const urls = [
    `  <url><loc>${xmlEscape(base)}</loc></url>`,
    ...openings.map(
      (opening) =>
        `  <url><loc>${xmlEscape(opening.url)}</loc>${
          opening.publishedAt ? `<lastmod>${opening.publishedAt.slice(0, 10)}</lastmod>` : ""
        }</url>`,
    ),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...(siteIndexable(site) ? urls : []),
    "</urlset>",
    "",
  ].join("\n");
}

export function robotsTxt(site: ResolvedSite | null, sitemapUrl: string | null): string {
  if (!site || !siteIndexable(site)) return "User-agent: *\nDisallow: /\n";
  return ["User-agent: *", "Allow: /", ...(sitemapUrl ? [`Sitemap: ${sitemapUrl}`] : []), ""].join("\n");
}

const SAFE_HREF = /^(?:https?:|mailto:)/i;

/**
 * Markdown as job boards receive it, which may render it as it comes: HTML
 * written into the description is left out, images become their alt text,
 * and only web and mail links stay links.
 */
const jobBoardMarkdown = new Marked({
  async: false,
  renderer: {
    html() {
      return "";
    },
    link({ href, tokens }: Tokens.Link) {
      const label = this.parser.parseInline(tokens);
      return SAFE_HREF.test(href) ? `<a href="${xmlEscape(href)}">${label}</a>` : label;
    },
    image({ text }: Tokens.Image) {
      return xmlEscape(text);
    },
  },
});

export function descriptionHtml(markdown: string): string {
  return jobBoardMarkdown.parse(markdown) as string;
}

/**
 * The schema.org JobPosting for an Opening — what Google for Jobs and other
 * job search engines read. Built from the same fields the page shows, so the
 * rate published in search results is the rate on the page.
 */
export function jobPostingJsonLd(opening: RecruitingOpening, site: ResolvedSite): Record<string, unknown> {
  const compensation = openingCompensation(opening);
  const base = careersBaseUrl(site.company.slug, site.settings);
  const logo = logoPath(site.company.slug, site.settings);
  const origin = new URL(base).origin;
  const posting: Record<string, unknown> = {
    "@context": "https://schema.org/",
    "@type": "JobPosting",
    title: opening.title,
    description: descriptionHtml(opening.description || opening.summary || opening.title),
    identifier: { "@type": "PropertyValue", name: site.settings.siteTitle || site.company.name, value: opening.id },
    datePosted: (opening.publishedAt ?? opening.createdAt).toISOString().slice(0, 10),
    employmentType: EMPLOYMENT_TYPE_SCHEMA_ORG[opening.employmentType],
    hiringOrganization: {
      "@type": "Organization",
      name: site.settings.siteTitle || site.company.name,
      ...(site.settings.websiteUrl ? { sameAs: site.settings.websiteUrl } : {}),
      ...(logo ? { logo: `${origin}${logo}` } : {}),
    },
    directApply: true,
    url: openingPublicUrl(site.company.slug, site.settings, opening.slug),
  };
  if (opening.applyBy) posting.validThrough = opening.applyBy.toISOString();
  if (opening.workplace === "remote") {
    posting.jobLocationType = "TELECOMMUTE";
    if (opening.location) {
      posting.applicantLocationRequirements = { "@type": "Country", name: opening.location };
    }
  } else if (opening.location) {
    posting.jobLocation = {
      "@type": "Place",
      address: { "@type": "PostalAddress", addressLocality: opening.location },
    };
  }
  const unitText = COMPENSATION_PERIOD_SCHEMA_ORG[opening.compensationPeriod];
  if (compensation.label && unitText && (compensation.min !== null || compensation.max !== null)) {
    posting.baseSalary = {
      "@type": "MonetaryAmount",
      currency: opening.compensationCurrency,
      value: {
        "@type": "QuantitativeValue",
        ...(compensation.min !== null ? { minValue: compensation.min } : {}),
        ...(compensation.max !== null ? { maxValue: compensation.max } : {}),
        ...(compensation.min !== null && compensation.min === compensation.max ? { value: compensation.min } : {}),
        unitText,
      },
    };
  }
  return posting;
}

/** True when a custom domain, not the install path, is this site's front door. */
export function siteOnCustomDomain(site: ResolvedSite): boolean {
  return customDomainLive(site.settings);
}
