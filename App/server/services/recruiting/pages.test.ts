import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_ACCENT_COLOR, EMPLOYMENT_TYPES } from "../../../shared/recruiting.js";
import { AppDataSource } from "../../db/datasource.js";
import { Company } from "../../db/entities/Company.js";
import { RecruitingOpening } from "../../db/entities/RecruitingOpening.js";
import { RecruitingSettings } from "../../db/entities/RecruitingSettings.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { setPublicUrl } from "../publicUrl.js";
import {
  CAREERS_DATA_MARKER,
  CAREERS_HEAD_MARKER,
  fillCareersTemplate,
  plainSnippet,
  renderCareersPage,
  scriptSafeJson,
  type CareersBootstrap,
  type CareersPageRequest,
  type RenderedCareersPage,
} from "./pages.js";
import { ANONYMOUS_VIEWER, type CareersViewer, type ResolvedSite } from "./site.js";

/**
 * The careers pages' server-rendered HTML (`services/recruiting/pages.ts`).
 *
 * Link previews, search engines and job boards read a careers page without
 * running its JavaScript, so its head — title, description, canonical
 * address, Open Graph, robots, theme color, favicon and the schema.org
 * JobPosting — is written on the server, and the page's first data rides
 * along as a JSON block. Nearly every value in it is company-written text (a
 * site title, an Opening's title or summary) on a page that shares the App's
 * origin. This file pins that each is escaped for the place it lands, that
 * the JSON can never end its own `<script>` element, that the shell's
 * markers are filled exactly once and verbatim, and that the JobPosting
 * carries the fields job search engines read: employment type, dates,
 * hiring organization, location and salary.
 */

const PUBLIC_URL = "https://app.genosyn.test";
const LINE_SEPARATOR = "\u2028";
const PARAGRAPH_SEPARATOR = "\u2029";
const MEMBER: CareersViewer = {
  member: true,
  userId: "user-mel",
  name: "Mel Member",
  email: "member@acme.test",
};

/** The shape of `client/careers.html`. */
const TEMPLATE = [
  "<!doctype html>",
  '<html lang="en">',
  "  <head>",
  "    <title>Careers</title>",
  "    <!--careers-head-->",
  "  </head>",
  "  <body>",
  '    <div id="careers-root"></div>',
  "    <!--careers-bootstrap-->",
  '    <script type="module" src="/careers-site/main.tsx"></script>',
  "  </body>",
  "</html>",
].join("\n");

let acme: Company;

before(async () => {
  await initTestDb();
  await setPublicUrl(PUBLIC_URL);
});

after(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  acme = await insert(Company, { name: "Acme", slug: "acme", ownerId: "user-owner" });
  await insert(RecruitingSettings, {
    companyId: acme.id,
    siteEnabled: true,
    siteVisibility: "public",
  });
});

async function updateSettings(values: Partial<RecruitingSettings>): Promise<void> {
  await AppDataSource.getRepository(RecruitingSettings).update({ companyId: acme.id }, values);
}

async function currentSite(): Promise<ResolvedSite> {
  return {
    company: await AppDataSource.getRepository(Company).findOneByOrFail({ id: acme.id }),
    settings: await AppDataSource.getRepository(RecruitingSettings).findOneByOrFail({ companyId: acme.id }),
  };
}

async function opening(values: Partial<RecruitingOpening> = {}): Promise<RecruitingOpening> {
  return insert(RecruitingOpening, {
    companyId: acme.id,
    slug: "platform-engineer",
    title: "Platform Engineer",
    status: "open",
    visibility: "public",
    employmentType: "full_time",
    workplace: "onsite",
    location: "",
    publishedAt: new Date("2026-10-01T09:00:00.000Z"),
    summary: "Keep the platform fast and boring.",
    description: "You will run the platform everything else runs on.",
    ...values,
  });
}

async function render(
  page: CareersPageRequest,
  options: { viewer?: CareersViewer; site?: ResolvedSite | null; template?: string } = {},
): Promise<RenderedCareersPage> {
  return renderCareersPage({
    template: options.template ?? TEMPLATE,
    site: options.site === undefined ? await currentSite() : options.site,
    viewer: options.viewer ?? ANONYMOUS_VIEWER,
    page,
    basePath: "/careers/acme",
  });
}

/** The JobPosting an Opening's page carries, or null when it carries none. */
async function postingFor(
  values: Partial<RecruitingOpening>,
  viewer: CareersViewer = ANONYMOUS_VIEWER,
): Promise<Record<string, unknown> | null> {
  const row = await opening(values);
  const page = await render({ kind: "opening", slug: row.slug }, { viewer });
  assert.equal(page.status, 200, `${row.slug} did not render`);
  const bodies = scriptBodies(page.html, '<script type="application/ld+json">');
  assert.ok(bodies.length <= 1, "at most one JobPosting per page");
  return bodies.length ? (JSON.parse(bodies[0]) as Record<string, unknown>) : null;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleOf(html: string): string | null {
  const match = /<title>([^<]*)<\/title>/.exec(html);
  return match ? decodeHtml(match[1]) : null;
}

function metaContent(html: string, attribute: "name" | "property", key: string): string | null {
  const match = new RegExp(`<meta ${attribute}="${escapeRegExp(key)}" content="([^"]*)" />`).exec(html);
  return match ? decodeHtml(match[1]) : null;
}

function linkHref(html: string, rel: string): string | null {
  const match = new RegExp(`<link rel="${escapeRegExp(rel)}"(?: type="[^"]*")? href="([^"]*)" />`).exec(html);
  return match ? decodeHtml(match[1]) : null;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * The text of every `<script>` element with this opening tag. Script data
 * ends at the first `</script`, so a body with no `<` in it is exactly the
 * text the browser hands over.
 */
function scriptBodies(html: string, openingTag: string): string[] {
  const bodies: string[] = [];
  let index = html.indexOf(openingTag);
  while (index !== -1) {
    const start = index + openingTag.length;
    const end = html.indexOf("</script", start);
    assert.notEqual(end, -1, `${openingTag} is never closed`);
    const body = html.slice(start, end);
    assert.ok(!body.includes("<"), `${openingTag} carries a raw "<"`);
    bodies.push(body);
    index = html.indexOf(openingTag, end);
  }
  return bodies;
}

function bootstrapOf(html: string): CareersBootstrap {
  const bodies = scriptBodies(html, '<script type="application/json" id="careers-bootstrap">');
  assert.equal(bodies.length, 1, "exactly one bootstrap block");
  return JSON.parse(bodies[0]) as CareersBootstrap;
}

describe("scriptSafeJson", () => {
  test("escapes everything that could end a script element or open a comment, and still parses back", () => {
    const value = {
      title: `</script><script>alert(1)</script> <!-- --> & "quoted" \\ ${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}`,
      nested: [{ html: "<b>bold</b>" }],
    };
    const json = scriptSafeJson(value);
    for (const character of ["<", ">", "&", LINE_SEPARATOR, PARAGRAPH_SEPARATOR]) {
      assert.ok(!json.includes(character), `a raw ${JSON.stringify(character)} survived`);
    }
    assert.ok(json.includes("\\u003c/script\\u003e"));
    assert.ok(json.includes("\\u2028\\u2029"));
    assert.deepEqual(JSON.parse(json), value);
  });

  test("writes JSON without those characters exactly as JSON.stringify does", () => {
    const value = { kind: "home", count: 3, list: ["a", "b"], nothing: null, yes: true };
    assert.equal(scriptSafeJson(value), JSON.stringify(value));
  });
});

describe("plainSnippet", () => {
  test("reads Markdown as plain text", () => {
    const markdown = [
      "# Hello world",
      "",
      "We **build** _calm_ tools with [our partners](https://partners.example).",
      "",
      "![diagram](d.png)",
      "",
      "```js",
      "secret()",
      "```",
      "",
      "> Quoted line",
      "- list item",
    ].join("\n");
    assert.equal(
      plainSnippet(markdown),
      "Hello world We build calm tools with our partners. Quoted line list item",
    );
  });

  test("keeps short text whole, and makes nothing of nothing", () => {
    assert.equal(plainSnippet("Short and sweet."), "Short and sweet.");
    assert.equal(plainSnippet(""), "");
    assert.equal(plainSnippet("   \n\n  "), "");
  });

  test("cuts long text at a word, with an ellipsis, never past the limit", () => {
    const text = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
    for (const max of [160, 60]) {
      const snippet = plainSnippet(text, max);
      assert.ok(snippet.length <= max, `${snippet.length} > ${max}`);
      assert.ok(snippet.endsWith("…"));
      const kept = snippet.slice(0, -1);
      assert.ok(text.startsWith(kept));
      assert.equal(text[kept.length], " ", "the cut falls between words");
    }
  });

  test("cuts a single endless word where it must", () => {
    const snippet = plainSnippet("a".repeat(400));
    assert.equal(snippet, `${"a".repeat(159)}…`);
  });
});

describe("fillCareersTemplate", () => {
  const bootstrap: CareersBootstrap = {
    kind: "home",
    basePath: "/careers/acme",
    site: null,
    openings: [],
    opening: null,
    signInUrl: "",
  };

  test("drops the shell's own title and fills both markers", () => {
    const shell = `<head><title>Shell</title>${CAREERS_HEAD_MARKER}</head><body>${CAREERS_DATA_MARKER}</body>`;
    assert.equal(
      fillCareersTemplate(shell, "<title>Page</title>", bootstrap),
      '<head><title>Page</title></head><body><script type="application/json" id="careers-bootstrap">' +
        `${scriptSafeJson(bootstrap)}</script></body>`,
    );
  });

  test("copies the head and the data verbatim, even when they contain `$` patterns", () => {
    // `String#replace` with a string replacement reads $$, $&, $` and $' as
    // patterns. Both the head and the data are full of company-written text.
    const head = "<title>Pay $$$ now: $' and $` and $& and $1</title>";
    const data: CareersBootstrap = { ...bootstrap, signInUrl: "/login?next=$'$`$&$$" };
    const shell = `<head><title>Shell</title>${CAREERS_HEAD_MARKER}</head><body>${CAREERS_DATA_MARKER}</body>`;
    const filled = fillCareersTemplate(shell, head, data);
    assert.equal(
      filled,
      `<head>${head}</head><body><script type="application/json" id="careers-bootstrap">` +
        `${scriptSafeJson(data)}</script></body>`,
    );
  });

  test("the shell in client/careers.html carries one of each marker and a title to replace", () => {
    const shell = fs.readFileSync(
      fileURLToPath(new URL("../../../client/careers.html", import.meta.url)),
      "utf8",
    );
    assert.equal(count(shell, CAREERS_HEAD_MARKER), 1);
    assert.equal(count(shell, CAREERS_DATA_MARKER), 1);
    assert.equal(count(shell, "<title>"), 1);
    assert.ok(shell.indexOf(CAREERS_HEAD_MARKER) < shell.indexOf("</head>"));
    assert.ok(shell.indexOf(CAREERS_DATA_MARKER) > shell.indexOf("<body"));

    const filled = fillCareersTemplate(shell, "<title>Careers at Acme</title>", bootstrap);
    assert.equal(count(filled, "<title>"), 1);
    assert.equal(titleOf(filled), "Careers at Acme");
    assert.ok(!filled.includes(CAREERS_HEAD_MARKER) && !filled.includes(CAREERS_DATA_MARKER));
    assert.deepEqual(bootstrapOf(filled), bootstrap);
  });
});

describe("renderCareersPage: the head", () => {
  test("a page for no site is the generic not-found page", async () => {
    const page = await render({ kind: "home" }, { site: null });
    assert.equal(page.status, 404);
    assert.equal(page.noindex, true);
    assert.equal(titleOf(page.html), "Page not found · Careers");
    assert.equal(metaContent(page.html, "name", "description"), "This page is not available.");
    assert.equal(metaContent(page.html, "name", "robots"), "noindex, nofollow");
    assert.equal(metaContent(page.html, "name", "theme-color"), DEFAULT_ACCENT_COLOR);
    assert.equal(linkHref(page.html, "canonical"), null);
    assert.equal(linkHref(page.html, "icon"), "/favicon.svg");
    assert.deepEqual(bootstrapOf(page.html), {
      kind: "not_found",
      basePath: "/careers/acme",
      site: null,
      openings: [],
      opening: null,
      signInUrl: `${PUBLIC_URL}/login`,
    });
  });

  test("an internal site shows a visitor the members-only page and nothing of the site", async () => {
    await updateSettings({
      siteVisibility: "internal",
      siteHeadline: "Internal headline",
      accentColor: "#0a7d5a",
      logoKey: "0123456789abcdef.png",
    });
    await opening();
    const page = await render({ kind: "home" });
    assert.equal(page.status, 403);
    assert.equal(page.noindex, true);
    assert.equal(titleOf(page.html), "Careers · Acme");
    assert.equal(metaContent(page.html, "name", "description"), "Acme's internal careers site, for Members.");
    assert.equal(metaContent(page.html, "name", "robots"), "noindex, nofollow");
    assert.equal(metaContent(page.html, "name", "theme-color"), "#0a7d5a");
    assert.equal(metaContent(page.html, "property", "og:image"), null);
    assert.equal(linkHref(page.html, "canonical"), null);
    assert.ok(!page.html.includes("Platform Engineer") && !page.html.includes("Internal headline"));
    assert.deepEqual(bootstrapOf(page.html), {
      kind: "members_only",
      basePath: "/careers/acme",
      site: null,
      openings: [],
      opening: null,
      signInUrl: `${PUBLIC_URL}/login`,
    });

    const forMember = await render({ kind: "home" }, { viewer: MEMBER });
    assert.equal(forMember.status, 200);
    assert.equal(forMember.noindex, true, "an internal site is never indexed");
    assert.equal(metaContent(forMember.html, "name", "robots"), "noindex, nofollow");
  });

  test("the home page's description falls back from the headline to the intro to a count of openings", async () => {
    await opening();
    await updateSettings({
      siteHeadline: "Build the future of widgets",
      siteIntro: "## Who we are\n\nA **small** team.",
    });
    const headline = await render({ kind: "home" });
    assert.equal(headline.status, 200);
    assert.equal(headline.noindex, false);
    assert.equal(titleOf(headline.html), "Careers at Acme");
    assert.equal(metaContent(headline.html, "name", "description"), "Build the future of widgets");
    assert.equal(metaContent(headline.html, "property", "og:description"), "Build the future of widgets");
    assert.equal(metaContent(headline.html, "name", "robots"), "index, follow");
    assert.equal(linkHref(headline.html, "canonical"), `${PUBLIC_URL}/careers/acme`);
    assert.equal(metaContent(headline.html, "property", "og:url"), `${PUBLIC_URL}/careers/acme`);
    assert.equal(metaContent(headline.html, "name", "twitter:card"), "summary");

    await updateSettings({ siteHeadline: "" });
    const intro = await render({ kind: "home" });
    assert.equal(metaContent(intro.html, "name", "description"), "Who we are A small team.");

    await updateSettings({ siteIntro: "" });
    const one = await render({ kind: "home" });
    assert.equal(metaContent(one.html, "name", "description"), "Open roles at Acme: 1 opening.");
    await opening({ slug: "designer", title: "Designer" });
    const two = await render({ kind: "home" });
    assert.equal(metaContent(two.html, "name", "description"), "Open roles at Acme: 2 openings.");

    await updateSettings({ siteTitle: "Acme Careers" });
    const titled = await render({ kind: "home" });
    assert.equal(titleOf(titled.html), "Careers at Acme Careers");
    assert.equal(metaContent(titled.html, "property", "og:site_name"), "Acme Careers");
  });

  test("an Opening's description falls back from its summary to its description to a sentence", async () => {
    await opening({ slug: "with-summary", summary: "The summary." });
    await opening({ slug: "with-description", summary: "", description: "The **first** words of the role." });
    await opening({ slug: "with-nothing", title: "Quiet Role", summary: "", description: "" });
    const described = async (slug: string) =>
      metaContent((await render({ kind: "opening", slug })).html, "name", "description");
    assert.equal(await described("with-summary"), "The summary.");
    assert.equal(await described("with-description"), "The first words of the role.");
    assert.equal(await described("with-nothing"), "Quiet Role at Acme.");
  });

  test("the logo is the page's image and favicon, on the site's own origin; without one the default icon stays", async () => {
    await opening();
    const bare = await render({ kind: "home" });
    assert.equal(metaContent(bare.html, "property", "og:image"), null);
    assert.ok(bare.html.includes('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />'));

    await updateSettings({ logoKey: "0123456789abcdef.png" });
    const logo = `${PUBLIC_URL}/api/careers/sites/acme/logo?v=01234567`;
    for (const page of [await render({ kind: "home" }), await render({ kind: "opening", slug: "platform-engineer" })]) {
      assert.equal(metaContent(page.html, "property", "og:image"), logo);
      assert.equal(linkHref(page.html, "icon"), logo);
      assert.ok(!page.html.includes("/favicon.svg"));
    }
  });

  test("theme-color is the normalized accent, and the default for anything that is not a color", async () => {
    await updateSettings({ accentColor: "#ABC" });
    assert.equal(metaContent((await render({ kind: "home" })).html, "name", "theme-color"), "#aabbcc");
    await updateSettings({ accentColor: '"><script>alert(1)</script>' });
    const page = await render({ kind: "home" });
    assert.equal(metaContent(page.html, "name", "theme-color"), DEFAULT_ACCENT_COLOR);
    assert.equal(bootstrapOf(page.html).site?.accentColor, DEFAULT_ACCENT_COLOR);
  });

  test("every company-written value is escaped for the place it lands", async () => {
    const hostile = `"><script>alert('x')</script> & <!-- <b> ${LINE_SEPARATOR}`;
    await updateSettings({
      siteTitle: `Acme ${hostile}`,
      siteHeadline: `Hiring ${hostile}`,
      logoKey: '"><b>x.png',
    });
    await opening({ title: `Engineer ${hostile}`, summary: `Summary ${hostile}` });
    const name = `Acme ${hostile}`;

    const home = await render({ kind: "home" });
    assert.equal(titleOf(home.html), `Careers at ${name}`);
    assert.equal(metaContent(home.html, "name", "description"), `Hiring ${hostile}`);
    assert.equal(metaContent(home.html, "property", "og:title"), `Careers at ${name}`);
    assert.equal(metaContent(home.html, "property", "og:description"), `Hiring ${hostile}`);
    assert.equal(metaContent(home.html, "property", "og:site_name"), name);
    const logo = metaContent(home.html, "property", "og:image") ?? "";
    assert.ok(logo.startsWith(`${PUBLIC_URL}/api/careers/sites/acme/logo?v=`), logo);
    assert.ok(!/["<>]/.test(logo), logo);
    assert.equal(count(home.html, "<script"), 2, "the bootstrap and the page's module, nothing else");
    assert.equal(count(home.html, '<meta name="description"'), 1);

    const role = await render({ kind: "opening", slug: "platform-engineer" });
    assert.equal(titleOf(role.html), `Engineer ${hostile} · ${name}`);
    assert.equal(metaContent(role.html, "name", "description"), `Summary ${hostile}`);
    assert.equal(metaContent(role.html, "property", "og:title"), `Engineer ${hostile} · ${name}`);
    assert.equal(count(role.html, "<script"), 3, "the JobPosting, the bootstrap and the page's module");
    const [posting] = scriptBodies(role.html, '<script type="application/ld+json">').map(
      (body) => JSON.parse(body) as { title: string; hiringOrganization: { name: string } },
    );
    assert.equal(posting.title, `Engineer ${hostile}`);
    assert.equal(posting.hiringOrganization.name, name);
    assert.equal(bootstrapOf(role.html).opening?.title, `Engineer ${hostile}`);

    const missing = await render({ kind: "missing" });
    assert.equal(titleOf(missing.html), `Page not found · ${name}`);

    await updateSettings({ siteVisibility: "internal" });
    const membersOnly = await render({ kind: "home" });
    assert.equal(titleOf(membersOnly.html), `Careers · ${name}`);
    assert.equal(
      metaContent(membersOnly.html, "name", "description"),
      `${name}'s internal careers site, for Members.`,
    );

    for (const page of [home, role, missing, membersOnly]) {
      assert.ok(!page.html.includes("<script>alert"), "a company-written script tag reached the page");
      assert.ok(!page.html.includes("<b>"), "company-written markup reached the page");
    }
  });

  test("a missing page on a visible site keeps the site in its data, and is noindex", async () => {
    await opening();
    const page = await render({ kind: "missing" });
    assert.equal(page.status, 404);
    assert.equal(page.noindex, true);
    assert.equal(titleOf(page.html), "Page not found · Acme");
    const data = bootstrapOf(page.html);
    assert.equal(data.kind, "not_found");
    assert.equal(data.site?.companySlug, "acme");
    assert.deepEqual(data.openings, []);

    const unknown = await render({ kind: "opening", slug: "no-such-role" });
    assert.equal(unknown.status, 404);
    assert.equal(bootstrapOf(unknown.html).kind, "not_found");
  });
});

describe("renderCareersPage: the JobPosting", () => {
  test("carries the fields job search engines read", async () => {
    const applyBy = new Date(Date.now() + 30 * 86_400_000);
    await updateSettings({ websiteUrl: "https://acme.example/", logoKey: "0123456789abcdef.png" });
    const row = await opening({
      title: "Platform Engineer",
      applyBy,
      compensationMinMinor: 12_000_000,
      compensationMaxMinor: 15_000_000,
      compensationCurrency: "EUR",
      compensationPeriod: "year",
      workplace: "onsite",
      location: "Berlin",
    });
    const page = await render({ kind: "opening", slug: "platform-engineer" });
    assert.equal(page.status, 200);
    assert.equal(page.noindex, false);
    assert.equal(metaContent(page.html, "name", "robots"), "index, follow");
    const url = `${PUBLIC_URL}/careers/acme/openings/platform-engineer`;
    assert.equal(linkHref(page.html, "canonical"), url);
    const [posting] = scriptBodies(page.html, '<script type="application/ld+json">').map(
      (body) => JSON.parse(body) as Record<string, unknown>,
    );
    assert.deepEqual(posting, {
      "@context": "https://schema.org/",
      "@type": "JobPosting",
      title: "Platform Engineer",
      description: "<p>You will run the platform everything else runs on.</p>\n",
      identifier: { "@type": "PropertyValue", name: "Acme", value: row.id },
      datePosted: "2026-10-01",
      employmentType: "FULL_TIME",
      hiringOrganization: {
        "@type": "Organization",
        name: "Acme",
        sameAs: "https://acme.example/",
        logo: `${PUBLIC_URL}/api/careers/sites/acme/logo?v=01234567`,
      },
      directApply: true,
      url,
      validThrough: applyBy.toISOString(),
      jobLocation: {
        "@type": "Place",
        address: { "@type": "PostalAddress", addressLocality: "Berlin" },
      },
      baseSalary: {
        "@type": "MonetaryAmount",
        currency: "EUR",
        value: { "@type": "QuantitativeValue", minValue: 120000, maxValue: 150000, unitText: "YEAR" },
      },
    });
  });

  test("maps each employment type to its schema.org value", async () => {
    const expected: Record<string, string> = {
      full_time: "FULL_TIME",
      part_time: "PART_TIME",
      contract: "CONTRACTOR",
      internship: "INTERN",
      temporary: "TEMPORARY",
    };
    assert.deepEqual(Object.keys(expected).sort(), [...EMPLOYMENT_TYPES].sort());
    for (const employmentType of EMPLOYMENT_TYPES) {
      const posting = await postingFor({ slug: `role-${employmentType.replace("_", "-")}`, employmentType });
      assert.equal(posting?.employmentType, expected[employmentType], employmentType);
    }
  });

  test("dates the posting from publication, or creation when never published, with no validThrough without a closing date", async () => {
    const published = await postingFor({ slug: "late-evening", publishedAt: new Date("2026-10-01T23:30:00.000Z") });
    assert.equal(published?.datePosted, "2026-10-01");
    assert.ok(published && !("validThrough" in published));

    const row = await opening({ slug: "never-published", publishedAt: null });
    const page = await render({ kind: "opening", slug: row.slug });
    const [posting] = scriptBodies(page.html, '<script type="application/ld+json">').map(
      (body) => JSON.parse(body) as Record<string, unknown>,
    );
    assert.equal(posting.datePosted, row.createdAt.toISOString().slice(0, 10));
  });

  test("a remote Opening is TELECOMMUTE with its location as where applicants must be; others name a Place", async () => {
    const remote = await postingFor({ slug: "remote-europe", workplace: "remote", location: "Europe" });
    assert.equal(remote?.jobLocationType, "TELECOMMUTE");
    assert.deepEqual(remote?.applicantLocationRequirements, { "@type": "Country", name: "Europe" });
    assert.ok(remote && !("jobLocation" in remote));

    const anywhere = await postingFor({ slug: "remote-anywhere", workplace: "remote", location: "" });
    assert.equal(anywhere?.jobLocationType, "TELECOMMUTE");
    assert.ok(anywhere && !("applicantLocationRequirements" in anywhere) && !("jobLocation" in anywhere));

    const place = (locality: string) => ({
      "@type": "Place",
      address: { "@type": "PostalAddress", addressLocality: locality },
    });
    const onsite = await postingFor({ slug: "onsite-berlin", workplace: "onsite", location: "Berlin" });
    assert.deepEqual(onsite?.jobLocation, place("Berlin"));
    assert.ok(onsite && !("jobLocationType" in onsite) && !("applicantLocationRequirements" in onsite));

    const hybrid = await postingFor({ slug: "hybrid-london", workplace: "hybrid", location: "London" });
    assert.deepEqual(hybrid?.jobLocation, place("London"));

    const nowhere = await postingFor({ slug: "onsite-unsaid", workplace: "onsite", location: "" });
    assert.ok(nowhere && !("jobLocation" in nowhere) && !("jobLocationType" in nowhere));
  });

  test("baseSalary is the published rate in major units with schema.org's unit; none without a rate or for a project fee", async () => {
    type BaseSalary = { value?: { unitText?: string } } | undefined;
    const salary = async (slug: string, values: Partial<RecruitingOpening>) =>
      (await postingFor({ slug, ...values }))?.baseSalary as BaseSalary;

    assert.deepEqual(
      await salary("range", {
        compensationMinMinor: 12_000_000,
        compensationMaxMinor: 15_000_000,
        compensationCurrency: "EUR",
        compensationPeriod: "year",
      }),
      {
        "@type": "MonetaryAmount",
        currency: "EUR",
        value: { "@type": "QuantitativeValue", minValue: 120000, maxValue: 150000, unitText: "YEAR" },
      },
    );
    assert.deepEqual(
      await salary("fixed-rate", {
        compensationMinMinor: 3_750,
        compensationMaxMinor: 3_750,
        compensationCurrency: "USD",
        compensationPeriod: "hour",
      }),
      {
        "@type": "MonetaryAmount",
        currency: "USD",
        value: { "@type": "QuantitativeValue", minValue: 37.5, maxValue: 37.5, value: 37.5, unitText: "HOUR" },
      },
    );
    assert.deepEqual(
      await salary("from", {
        compensationMinMinor: 800_000,
        compensationMaxMinor: null,
        compensationCurrency: "GBP",
        compensationPeriod: "month",
      }),
      {
        "@type": "MonetaryAmount",
        currency: "GBP",
        value: { "@type": "QuantitativeValue", minValue: 8000, unitText: "MONTH" },
      },
    );
    assert.deepEqual(
      await salary("up-to", {
        compensationMinMinor: null,
        compensationMaxMinor: 60_000,
        compensationCurrency: "USD",
        compensationPeriod: "day",
      }),
      {
        "@type": "MonetaryAmount",
        currency: "USD",
        value: { "@type": "QuantitativeValue", maxValue: 600, unitText: "DAY" },
      },
    );
    assert.equal(
      (
        await salary("weekly", {
          compensationMinMinor: 200_000,
          compensationMaxMinor: 250_000,
          compensationPeriod: "week",
        })
      )?.value?.unitText,
      "WEEK",
    );
    assert.equal(
      await salary("project-fee", {
        compensationMinMinor: 800_000,
        compensationMaxMinor: 800_000,
        compensationPeriod: "project",
      }),
      undefined,
    );
    assert.equal(await salary("unpublished", { compensationMinMinor: null, compensationMaxMinor: null }), undefined);
  });

  test("is left out for a closed, unlisted, internal or past-deadline Opening, and on a site that may not be indexed", async () => {
    const quiet: Array<[string, Partial<RecruitingOpening>, CareersViewer]> = [
      ["closed", { status: "closed", closedAt: new Date() }, ANONYMOUS_VIEWER],
      ["unlisted", { visibility: "unlisted" }, ANONYMOUS_VIEWER],
      ["internal", { visibility: "internal" }, MEMBER],
      ["past-deadline", { applyBy: new Date(Date.now() - 60_000) }, ANONYMOUS_VIEWER],
    ];
    for (const [slug, values, viewer] of quiet) {
      const row = await opening({ slug, ...values });
      const page = await render({ kind: "opening", slug: row.slug }, { viewer });
      assert.equal(page.status, 200, slug);
      assert.equal(page.noindex, true, slug);
      assert.equal(metaContent(page.html, "name", "robots"), "noindex, nofollow", slug);
      assert.ok(!page.html.includes("application/ld+json"), `${slug} carries a JobPosting`);
    }

    await opening({ slug: "listed" });
    await updateSettings({ allowIndexing: false });
    const hidden = await render({ kind: "opening", slug: "listed" });
    assert.equal(hidden.noindex, true);
    assert.ok(!hidden.html.includes("application/ld+json"));

    await updateSettings({ allowIndexing: true, siteVisibility: "internal" });
    const internalSite = await render({ kind: "opening", slug: "listed" }, { viewer: MEMBER });
    assert.equal(internalSite.noindex, true);
    assert.ok(!internalSite.html.includes("application/ld+json"));
  });

  test("its description is the Opening's Markdown as HTML, with script-bearing elements dropped", async () => {
    const posting = await postingFor({
      description: [
        "We build **fast** systems. Read [the docs](https://docs.example).",
        "",
        "<script>alert(1)</script>",
        "",
        '<iframe src="https://evil.example"></iframe>',
      ].join("\n"),
    });
    const description = String(posting?.description);
    assert.ok(description.includes("<strong>fast</strong>"), description);
    assert.ok(description.includes('<a href="https://docs.example">the docs</a>'), description);
    assert.ok(!/<script|<iframe|alert\(1\)/i.test(description), description);
  });

  test("no HTML of the description's own reaches a job board, and only web and mail links stay links", async () => {
    const posting = await postingFor({
      description: [
        "Ship <img src=x onerror=alert(1)> it, <b onclick='steal()'>fast</b>.",
        "",
        "[Click](javascript:alert(2)), [mail us](mailto:jobs@acme.example), ![our team](https://acme.example/t.png)",
        "",
        "<script src=//evil.example/x.js>",
      ].join("\n"),
    });
    const description = String(posting?.description);
    assert.ok(!/<img|onerror|onclick|<b\b|javascript:|<script|evil\.example/i.test(description), description);
    assert.ok(description.includes("Click"), "a refused link keeps its words");
    assert.ok(description.includes('<a href="mailto:jobs@acme.example">mail us</a>'), description);
    assert.ok(description.includes("our team"), "an image becomes its alt text");
  });
});
