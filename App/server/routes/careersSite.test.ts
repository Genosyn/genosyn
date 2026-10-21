import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { RecruitingOpening } from "../db/entities/RecruitingOpening.js";
import { RecruitingSettings } from "../db/entities/RecruitingSettings.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { setPublicUrl } from "../services/publicUrl.js";
import { refreshCareersHosts } from "../services/recruiting/domains.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { careersRouter } from "./careers.js";
import { appShellFallback, careersHostGuard, careersPagesRouter } from "./careersSite.js";

/**
 * The careers site's pages and the guard that keeps a careers custom domain
 * to the careers site (`routes/careersSite.ts`).
 *
 * The pages are what search engines, link previews and job boards read, so
 * their head is written on the server: title, description, canonical
 * address, Open Graph, robots rules and a schema.org JobPosting, plus the
 * page's first data as a JSON block. That block and the head carry
 * company-written text on a page that shares the App's origin, so a title
 * must never be able to end the block or the element it sits in.
 *
 * A verified custom domain serves `/`, `/openings/<slug>`, `robots.txt` and
 * `sitemap.xml`, the careers API and the static files the page loads — and
 * nothing of the App: no other API, no App shell, no sign-in page, no
 * service worker. The server here is mounted in `server/index.ts`'s order,
 * ending in its production tail (static files, then the SPA fallback to
 * `index.html`), with marker files standing in for the App, so a test can
 * see exactly which layer answered a request.
 */

const PUBLIC_URL = "https://app.genosyn.test";
const CAREERS_DOMAIN = "careers.acme.test";
const DOMAIN_ORIGIN = `https://${CAREERS_DOMAIN}`;
const APP_SHELL = "APP-SHELL-MARKER";
const SERVICE_WORKER = "APP-SERVICE-WORKER-MARKER";
const RAW_CAREERS_SHELL = "RAW-CAREERS-SHELL-MARKER";
const FELL_THROUGH = "FELL-THROUGH-MARKER";
const CAREERS_ASSET = "/* careers bundle */";
const LINE_SEPARATOR = " ";
const PARAGRAPH_SEPARATOR = " ";

/** The shape of `client/careers.html`: its own title and the two markers the server fills. */
const TEMPLATE = [
  "<!doctype html>",
  '<html lang="en">',
  "  <head>",
  '    <meta charset="UTF-8" />',
  "    <title>Careers</title>",
  "    <!--careers-head-->",
  "  </head>",
  '  <body class="bg-white">',
  '    <div id="careers-root"></div>',
  "    <!--careers-bootstrap-->",
  '    <script type="module" src="/careers-site/main.tsx"></script>',
  "  </body>",
  "</html>",
  "",
].join("\n");

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let root = "";
let clientDir = "";
let server: Server;
let port = 0;
let actingUserId: string | null = null;
let applyBy: Date;

let member: User;
let acme: Company;
let acmeSettings: RecruitingSettings;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-careers-site-"));
  mutableConfig.dataDir = path.join(root, "data");
  clientDir = path.join(root, "client");
  fs.mkdirSync(path.join(clientDir, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(clientDir, "index.html"),
    `<!doctype html><html><head><title>Genosyn</title></head><body>${APP_SHELL}</body></html>`,
  );
  fs.writeFileSync(path.join(clientDir, "sw.js"), `/* ${SERVICE_WORKER} */`);
  fs.writeFileSync(path.join(clientDir, "manifest.webmanifest"), `{"name":"${APP_SHELL}"}`);
  fs.writeFileSync(path.join(clientDir, "careers.html"), `<title>${RAW_CAREERS_SHELL}</title>`);
  fs.writeFileSync(path.join(clientDir, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(clientDir, "assets", "careers-abc123.js"), CAREERS_ASSET);

  await initTestDb();
  await setPublicUrl(PUBLIC_URL);

  const app = express();
  app.use(careersHostGuard({ isDev: false }));
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0, authenticatedAt: Date.now() }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/careers", careersRouter);
  // Stand-ins for the App's own API, where index.ts mounts the real ones.
  app.post("/api/auth/login", (_req, res) => {
    res.json({ app: "sign-in" });
  });
  app.use("/api/companies/:cid", (_req, res) => {
    res.json({ app: "company-api" });
  });
  app.use(careersPagesRouter({ isDev: false, loadTemplate: async () => TEMPLATE }));
  // server/index.ts's production tail (the `else if (fs.existsSync(clientDir))`
  // branch): the built client, then the App shell for every other path.
  app.use(express.static(clientDir));
  app.get(/^\/(?!api).*/, appShellFallback(path.join(clientDir, "index.html")));
  app.use((req, res) => {
    res.status(418).type("text/plain").send(`${FELL_THROUGH} ${req.method} ${req.originalUrl}`);
  });
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  mutableConfig.dataDir = originalDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetTestDb();
  await refreshCareersHosts();
  actingUserId = null;
  const owner = await insert(User, {
    email: "owner@acme.test",
    name: "Olive Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  member = await insert(User, {
    email: "member@acme.test",
    name: "Mel Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  acme = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  await insert(Membership, { companyId: acme.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: acme.id, userId: member.id, role: "member" });
  acmeSettings = await insert(RecruitingSettings, {
    companyId: acme.id,
    siteEnabled: true,
    siteVisibility: "public",
    siteHeadline: "Build the future of widgets",
    websiteUrl: "https://acme.example/",
  });
  applyBy = new Date(Date.now() + 30 * 86_400_000);
  await opening({
    slug: "platform-engineer",
    title: "Platform Engineer",
    applyBy,
    compensationMinMinor: 12_000_000,
    compensationMaxMinor: 15_000_000,
    compensationCurrency: "EUR",
    compensationPeriod: "year",
  });
  await opening({
    slug: "product-designer",
    title: "Product Designer",
    employmentType: "contract",
    workplace: "hybrid",
    location: "Berlin",
    publishedAt: new Date("2026-10-05T09:00:00.000Z"),
  });
  await opening({ slug: "unlisted-role", title: "Unlisted Role", visibility: "unlisted" });
  await opening({ slug: "internal-move", title: "Internal Move", visibility: "internal" });
  await opening({ slug: "draft-role", title: "Draft Role", status: "draft", publishedAt: null });
  await opening({
    slug: "closed-role",
    title: "Closed Role",
    status: "closed",
    closedAt: new Date("2026-10-10T00:00:00.000Z"),
  });
  await opening({ slug: "expired-role", title: "Expired Role", applyBy: new Date(Date.now() - 60_000) });
});

async function opening(values: Partial<RecruitingOpening>): Promise<RecruitingOpening> {
  return insert(RecruitingOpening, {
    companyId: acme.id,
    status: "open",
    visibility: "public",
    employmentType: "full_time",
    workplace: "remote",
    department: "Engineering",
    location: "Europe",
    publishedAt: new Date("2026-10-01T09:00:00.000Z"),
    summary: "Keep the platform fast and boring.",
    description: "You will run the platform everything else runs on. On call one week in six.",
    ...values,
  });
}

async function updateSettings(values: Partial<RecruitingSettings>): Promise<void> {
  await AppDataSource.getRepository(RecruitingSettings).update({ id: acmeSettings.id }, values);
}

async function connectDomain(values: Partial<RecruitingSettings> = {}): Promise<void> {
  await updateSettings({
    customDomain: CAREERS_DOMAIN,
    customDomainToken: "token",
    customDomainVerifiedAt: new Date(),
    ...values,
  });
  await refreshCareersHosts();
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; text: string };

/** One raw request; `fetch` neither sends its own `Host` nor keeps `..` in a path. */
function request(
  urlPath: string,
  options: { host?: string; method?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method: options.method ?? "GET",
        agent: false,
        headers: { host: options.host ?? `127.0.0.1:${port}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function onDomain(urlPath: string, method = "GET"): Promise<Reply> {
  return request(urlPath, { host: CAREERS_DOMAIN, method });
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

function canonicalOf(html: string): string | null {
  const match = /<link rel="canonical" href="([^"]*)" \/>/.exec(html);
  return match ? decodeHtml(match[1]) : null;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * The text of every `<script>` element with this opening tag. An HTML parser
 * ends script data at the first `</script`, so a body with no `<` at all is
 * exactly what the browser will hand to `JSON.parse`.
 */
function scriptBodies(html: string, openingTag: string): string[] {
  const bodies: string[] = [];
  let index = html.indexOf(openingTag);
  while (index !== -1) {
    const start = index + openingTag.length;
    const end = html.indexOf("</script", start);
    assert.notEqual(end, -1, `${openingTag} is never closed`);
    const body = html.slice(start, end);
    assert.ok(!body.includes("<"), `${openingTag} carries a raw "<": ${body}`);
    assert.ok(!body.includes(LINE_SEPARATOR) && !body.includes(PARAGRAPH_SEPARATOR));
    bodies.push(body);
    index = html.indexOf(openingTag, end);
  }
  return bodies;
}

type Bootstrap = {
  kind: string;
  basePath: string;
  site: Record<string, unknown> | null;
  openings: Array<Record<string, unknown>>;
  opening: Record<string, unknown> | null;
  signInUrl: string;
};

function bootstrapOf(html: string): Bootstrap {
  const bodies = scriptBodies(html, '<script type="application/json" id="careers-bootstrap">');
  assert.equal(bodies.length, 1, "the page carries exactly one bootstrap block");
  return JSON.parse(bodies[0]) as Bootstrap;
}

function jobPostingsOf(html: string): Array<Record<string, unknown>> {
  return scriptBodies(html, '<script type="application/ld+json">').map(
    (body) => JSON.parse(body) as Record<string, unknown>,
  );
}

function assertNotFoundPage(reply: Reply, label: string): Bootstrap {
  assert.equal(reply.status, 404, label);
  assert.equal(reply.headers["content-type"], "text/html; charset=utf-8", label);
  assert.equal(reply.headers["x-robots-tag"], "noindex, nofollow", label);
  assert.equal(metaContent(reply.text, "name", "robots"), "noindex, nofollow", label);
  assert.equal(metaContent(reply.text, "name", "description"), "This page is not available.", label);
  for (const marker of [APP_SHELL, SERVICE_WORKER, RAW_CAREERS_SHELL, FELL_THROUGH]) {
    assert.ok(!reply.text.includes(marker), `${label} answered with ${marker}`);
  }
  const data = bootstrapOf(reply.text);
  assert.equal(data.kind, "not_found", label);
  return data;
}

/**
 * The requests among these that the careers domain answered with one of the
 * App's own files, or with anything at all (200). Reaching the end of the
 * stack is fine here: in production that is Express's own 404.
 */
async function appFilesServedOnDomain(urlPaths: string[]): Promise<string[]> {
  const offenders: string[] = [];
  for (const urlPath of urlPaths) {
    const reply = await onDomain(urlPath);
    const marker = [APP_SHELL, SERVICE_WORKER, RAW_CAREERS_SHELL].find((candidate) =>
      reply.text.includes(candidate),
    );
    if (marker || reply.status === 200) offenders.push(`${urlPath} -> ${reply.status} ${marker ?? ""}`.trim());
  }
  return offenders;
}

describe("on the install's own address", () => {
  test("the careers home is rendered on the server: title, description, canonical, Open Graph and robots", async () => {
    const reply = await request("/careers/acme");
    assert.equal(reply.status, 200);
    assert.equal(reply.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(reply.headers["cache-control"], "private, no-cache");
    assert.equal(reply.headers["x-robots-tag"], undefined);

    const html = reply.text;
    assert.equal(count(html, "<title>"), 1, "the shell's own title is replaced, not repeated");
    assert.equal(titleOf(html), "Careers at Acme");
    assert.equal(metaContent(html, "name", "description"), "Build the future of widgets");
    assert.equal(metaContent(html, "name", "robots"), "index, follow");
    assert.equal(metaContent(html, "name", "theme-color"), "#4f46e5");
    assert.equal(canonicalOf(html), `${PUBLIC_URL}/careers/acme`);
    assert.equal(metaContent(html, "property", "og:url"), `${PUBLIC_URL}/careers/acme`);
    assert.equal(metaContent(html, "property", "og:type"), "website");
    assert.equal(metaContent(html, "property", "og:title"), "Careers at Acme");
    assert.equal(metaContent(html, "property", "og:description"), "Build the future of widgets");
    assert.equal(metaContent(html, "property", "og:site_name"), "Acme");
    assert.ok(html.indexOf("<title>") < html.indexOf("</head>"), "the head is written into <head>");
    assert.ok(
      html.indexOf('id="careers-bootstrap"') > html.indexOf("<body"),
      "the data is written into <body>",
    );
    assert.ok(!html.includes("<!--careers-head-->") && !html.includes("<!--careers-bootstrap-->"));
    assert.deepEqual(jobPostingsOf(html), [], "the home page is not a job posting");

    const data = bootstrapOf(html);
    assert.equal(data.kind, "home");
    assert.equal(data.basePath, "/careers/acme");
    assert.equal(data.site?.companySlug, "acme");
    assert.equal(data.site?.apiPath, "/api/careers/sites/acme");
    assert.deepEqual(
      data.openings.map((card) => card.slug),
      ["product-designer", "platform-engineer"],
    );
    assert.equal(data.opening, null);
    assert.equal(data.signInUrl, "");
  });

  test("an Opening's page carries a JobPosting a search engine can read", async () => {
    const target = await AppDataSource.getRepository(RecruitingOpening).findOneByOrFail({
      slug: "platform-engineer",
    });
    const reply = await request("/careers/acme/openings/platform-engineer");
    assert.equal(reply.status, 200);
    const html = reply.text;
    const url = `${PUBLIC_URL}/careers/acme/openings/platform-engineer`;
    assert.equal(titleOf(html), "Platform Engineer · Acme");
    assert.equal(metaContent(html, "name", "description"), "Keep the platform fast and boring.");
    assert.equal(metaContent(html, "name", "robots"), "index, follow");
    assert.equal(canonicalOf(html), url);
    assert.equal(metaContent(html, "property", "og:url"), url);
    assert.equal(metaContent(html, "property", "og:title"), "Platform Engineer · Acme");

    const postings = jobPostingsOf(html);
    assert.equal(postings.length, 1);
    const [posting] = postings;
    assert.equal(posting["@context"], "https://schema.org/");
    assert.equal(posting["@type"], "JobPosting");
    assert.equal(posting.title, "Platform Engineer");
    assert.equal(posting.url, url);
    assert.equal(posting.datePosted, "2026-10-01");
    assert.equal(posting.validThrough, applyBy.toISOString());
    assert.equal(posting.employmentType, "FULL_TIME");
    assert.equal(posting.directApply, true);
    assert.deepEqual(posting.identifier, { "@type": "PropertyValue", name: "Acme", value: target.id });
    assert.deepEqual(posting.hiringOrganization, {
      "@type": "Organization",
      name: "Acme",
      sameAs: "https://acme.example/",
    });
    assert.equal(posting.jobLocationType, "TELECOMMUTE");
    assert.deepEqual(posting.applicantLocationRequirements, { "@type": "Country", name: "Europe" });
    assert.deepEqual(posting.baseSalary, {
      "@type": "MonetaryAmount",
      currency: "EUR",
      value: { "@type": "QuantitativeValue", minValue: 120000, maxValue: 150000, unitText: "YEAR" },
    });

    const data = bootstrapOf(html);
    assert.equal(data.kind, "opening");
    assert.equal(data.opening?.slug, "platform-engineer");
    assert.equal(data.opening?.accepting, true);
    assert.deepEqual(data.openings, []);
  });

  test("a closed Opening still renders, but keeps search engines away and carries no JobPosting", async () => {
    const reply = await request("/careers/acme/openings/closed-role");
    assert.equal(reply.status, 200);
    assert.equal(reply.headers["x-robots-tag"], "noindex, nofollow");
    assert.equal(metaContent(reply.text, "name", "robots"), "noindex, nofollow");
    assert.equal(canonicalOf(reply.text), `${PUBLIC_URL}/careers/acme/openings/closed-role`);
    assert.deepEqual(jobPostingsOf(reply.text), []);
    const data = bootstrapOf(reply.text);
    assert.equal(data.opening?.status, "closed");
    assert.equal(data.opening?.accepting, false);

    const expired = await request("/careers/acme/openings/expired-role");
    assert.equal(expired.status, 200);
    assert.equal(metaContent(expired.text, "name", "robots"), "noindex, nofollow");
    assert.deepEqual(jobPostingsOf(expired.text), []);
  });

  test("unlisted Openings, internal Openings and sites that may not be indexed are noindex, with no JobPosting", async () => {
    const unlisted = await request("/careers/acme/openings/unlisted-role");
    assert.equal(unlisted.status, 200);
    assert.equal(metaContent(unlisted.text, "name", "robots"), "noindex, nofollow");
    assert.equal(unlisted.headers["x-robots-tag"], "noindex, nofollow");
    assert.deepEqual(jobPostingsOf(unlisted.text), []);

    actingUserId = member.id;
    const internal = await request("/careers/acme/openings/internal-move");
    assert.equal(internal.status, 200);
    assert.equal(metaContent(internal.text, "name", "robots"), "noindex, nofollow");
    assert.deepEqual(jobPostingsOf(internal.text), []);
    actingUserId = null;

    await updateSettings({ allowIndexing: false });
    const home = await request("/careers/acme");
    assert.equal(home.status, 200);
    assert.equal(metaContent(home.text, "name", "robots"), "noindex, nofollow");
    assert.equal(home.headers["x-robots-tag"], "noindex, nofollow");
    const listed = await request("/careers/acme/openings/platform-engineer");
    assert.equal(metaContent(listed.text, "name", "robots"), "noindex, nofollow");
    assert.deepEqual(jobPostingsOf(listed.text), []);
  });

  test("an internal site shows a visitor only the members-only page; a Member sees it, noindex", async () => {
    await updateSettings({ siteVisibility: "internal" });
    const visitor = await request("/careers/acme");
    assert.equal(visitor.status, 403);
    assert.equal(visitor.headers["x-robots-tag"], "noindex, nofollow");
    assert.equal(metaContent(visitor.text, "name", "robots"), "noindex, nofollow");
    assert.equal(titleOf(visitor.text), "Careers · Acme");
    assert.equal(canonicalOf(visitor.text), null);
    assert.deepEqual(bootstrapOf(visitor.text), {
      kind: "members_only",
      basePath: "/careers/acme",
      site: null,
      openings: [],
      opening: null,
      signInUrl: `${PUBLIC_URL}/login`,
    });
    for (const title of ["Platform Engineer", "Internal Move", "Build the future of widgets"]) {
      assert.ok(!visitor.text.includes(title), `the members-only page shows ${title}`);
    }
    const visitorOpening = await request("/careers/acme/openings/platform-engineer");
    assert.equal(visitorOpening.status, 403);
    assert.equal(bootstrapOf(visitorOpening.text).kind, "members_only");
    assert.ok(!visitorOpening.text.includes("Platform Engineer"));

    actingUserId = member.id;
    const home = await request("/careers/acme");
    assert.equal(home.status, 200);
    assert.equal(metaContent(home.text, "name", "robots"), "noindex, nofollow");
    const data = bootstrapOf(home.text);
    assert.equal(data.kind, "home");
    assert.deepEqual((data.site?.viewer as Record<string, unknown>).member, true);
    assert.ok(data.openings.some((card) => card.slug === "internal-move"));
    const page = await request("/careers/acme/openings/platform-engineer");
    assert.equal(page.status, 200);
    assert.equal(metaContent(page.text, "name", "robots"), "noindex, nofollow");
    assert.deepEqual(jobPostingsOf(page.text), []);
  });

  test("the bootstrap block is JSON that nothing in a title can break out of", async () => {
    const hostile =
      'Engineer </script><script>alert(1)</script> <!-- <script> --> "q" \'a\' & b ' +
      `${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR} end`;
    await opening({ slug: "hostile-role", title: hostile, summary: hostile });
    const reply = await request("/careers/acme/openings/hostile-role");
    assert.equal(reply.status, 200);
    const html = reply.text;
    assert.equal(count(html, "<script"), 3, "the JobPosting, the bootstrap and the page's module, nothing else");
    assert.equal(count(html, "</script>"), 3);
    assert.ok(!html.includes("<script>alert(1)"));
    assert.equal(count(html, "</html>"), 1);

    const data = bootstrapOf(html);
    assert.equal(data.opening?.title, hostile);
    assert.equal(data.opening?.summary, hostile);
    const [posting] = jobPostingsOf(html);
    assert.equal(posting.title, hostile);
    assert.equal(titleOf(html), `${hostile} · Acme`);
    assert.equal(metaContent(html, "name", "description"), hostile);
    assert.equal(metaContent(html, "property", "og:title"), `${hostile} · Acme`);
  });

  test("dollar signs in a title are copied as typed, never read as replacement patterns", async () => {
    // `String#replace` with a string replacement expands $$, $&, $` and $'.
    const title = "Earn $$$ fast: $' and $` and $& and $1";
    await opening({ slug: "dollar-role", title, summary: title });
    const reply = await request("/careers/acme/openings/dollar-role");
    assert.equal(reply.status, 200);
    const html = reply.text;
    assert.equal(count(html, "<!doctype html>"), 1, "the shell is not copied into itself");
    assert.equal(count(html, "<!--careers-"), 0, "no marker is copied into the page");
    assert.equal(titleOf(html), `${title} · Acme`);
    assert.equal(metaContent(html, "name", "description"), title);
    const data = bootstrapOf(html);
    assert.equal(data.opening?.title, title);
    const [posting] = jobPostingsOf(html);
    assert.equal(posting?.title, title);
  });

  test("an unknown company or Opening, a draft, and any other careers path get the careers not-found page", async () => {
    const unknownCompany = assertNotFoundPage(await request("/careers/nobody"), "/careers/nobody");
    assert.equal(unknownCompany.site, null);
    assert.equal(unknownCompany.basePath, "/careers/nobody");
    assert.equal(unknownCompany.signInUrl, `${PUBLIC_URL}/login`);
    assert.equal(titleOf((await request("/careers/nobody")).text), "Page not found · Careers");

    for (const urlPath of [
      "/careers/acme/openings/no-such-role",
      "/careers/acme/openings/draft-role",
      "/careers/acme/openings/internal-move",
      "/careers/acme/somewhere/else",
    ]) {
      const reply = await request(urlPath);
      const data = assertNotFoundPage(reply, urlPath);
      assert.equal(data.site?.companySlug, "acme", urlPath);
      assert.equal(titleOf(reply.text), "Page not found · Acme", urlPath);
      assert.ok(!reply.text.includes("Draft Role") && !reply.text.includes("Internal Move"), urlPath);
    }

    for (const urlPath of ["/careers", "/careers.html", "/careers/Acme", "/careers/acme.json"]) {
      const data = assertNotFoundPage(await request(urlPath), urlPath);
      assert.equal(data.site, null, urlPath);
    }
  });

  test("a switched-off site is not found", async () => {
    await updateSettings({ siteEnabled: false });
    const data = assertNotFoundPage(await request("/careers/acme"), "/careers/acme");
    assert.equal(data.site, null);
    assertNotFoundPage(await request("/careers/acme/openings/platform-engineer"), "an Opening");
  });

  test("the install path serves the site's sitemap", async () => {
    const reply = await request("/careers/acme/sitemap.xml");
    assert.equal(reply.status, 200);
    assert.match(reply.headers["content-type"] ?? "", /^application\/xml/);
    assert.deepEqual(
      [...reply.text.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]),
      [
        `${PUBLIC_URL}/careers/acme`,
        `${PUBLIC_URL}/careers/acme/openings/product-designer`,
        `${PUBLIC_URL}/careers/acme/openings/platform-engineer`,
      ],
    );
    assert.equal((await request("/careers/nobody/sitemap.xml")).status, 404);
  });
});

describe("on a verified custom domain", () => {
  beforeEach(async () => {
    await connectDomain();
  });

  test("`/` and `/openings/<slug>` render the site, with every address on the domain", async () => {
    const home = await onDomain("/");
    assert.equal(home.status, 200);
    assert.equal(titleOf(home.text), "Careers at Acme");
    assert.equal(canonicalOf(home.text), DOMAIN_ORIGIN);
    assert.equal(metaContent(home.text, "name", "robots"), "index, follow");
    const data = bootstrapOf(home.text);
    assert.equal(data.kind, "home");
    assert.equal(data.basePath, "");
    assert.equal(data.site?.url, DOMAIN_ORIGIN);
    assert.equal(data.site?.apiPath, "/api/careers/sites/acme");
    assert.deepEqual(
      data.openings.map((card) => card.url),
      [`${DOMAIN_ORIGIN}/openings/product-designer`, `${DOMAIN_ORIGIN}/openings/platform-engineer`],
    );

    for (const urlPath of ["/openings/platform-engineer", "/openings/platform-engineer/"]) {
      const page = await onDomain(urlPath);
      assert.equal(page.status, 200, urlPath);
      assert.equal(titleOf(page.text), "Platform Engineer · Acme", urlPath);
      assert.equal(canonicalOf(page.text), `${DOMAIN_ORIGIN}/openings/platform-engineer`, urlPath);
      const [posting] = jobPostingsOf(page.text);
      assert.equal(posting.url, `${DOMAIN_ORIGIN}/openings/platform-engineer`, urlPath);
      assert.equal(bootstrapOf(page.text).basePath, "", urlPath);
    }

    // The install path stays an alias, and points search engines at the domain.
    const alias = await request("/careers/acme");
    assert.equal(alias.status, 200);
    assert.equal(canonicalOf(alias.text), DOMAIN_ORIGIN);
  });

  test("robots.txt invites crawlers and names the domain's sitemap; a site that may not be indexed closes the door", async () => {
    const open = await onDomain("/robots.txt");
    assert.equal(open.status, 200);
    assert.match(open.headers["content-type"] ?? "", /^text\/plain/);
    assert.equal(open.text, `User-agent: *\nAllow: /\nSitemap: ${DOMAIN_ORIGIN}/sitemap.xml\n`);

    await updateSettings({ allowIndexing: false });
    assert.equal((await onDomain("/robots.txt")).text, "User-agent: *\nDisallow: /\n");
  });

  test("sitemap.xml lists the home page and only listed, open Openings, as addresses on the domain", async () => {
    const reply = await onDomain("/sitemap.xml");
    assert.equal(reply.status, 200);
    assert.match(reply.headers["content-type"] ?? "", /^application\/xml/);
    assert.ok(reply.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    const entries = [...reply.text.matchAll(/<url><loc>([^<]*)<\/loc>(?:<lastmod>([^<]*)<\/lastmod>)?<\/url>/g)];
    assert.deepEqual(
      entries.map((match) => [match[1], match[2] ?? null]),
      [
        [DOMAIN_ORIGIN, null],
        [`${DOMAIN_ORIGIN}/openings/product-designer`, "2026-10-05"],
        [`${DOMAIN_ORIGIN}/openings/platform-engineer`, "2026-10-01"],
      ],
    );
    for (const hidden of ["unlisted-role", "internal-move", "draft-role", "closed-role", "expired-role"]) {
      assert.ok(!reply.text.includes(hidden), `the sitemap lists ${hidden}`);
    }

    await updateSettings({ allowIndexing: false });
    const closed = await onDomain("/sitemap.xml");
    assert.equal(closed.status, 200);
    assert.ok(!closed.text.includes("<url>"), "a site that may not be indexed lists nothing");
  });

  test("no API answers there but the careers API and the health probe", async () => {
    for (const [urlPath, method] of [
      ["/api/companies/some-company/employees", "GET"],
      ["/api/auth/login", "POST"],
      ["/api/auth/me", "GET"],
      ["/api", "GET"],
      ["/api/careersx", "GET"],
    ] as const) {
      const reply = await onDomain(urlPath, method);
      assert.equal(reply.status, 404, `${method} ${urlPath}`);
      assert.deepEqual(JSON.parse(reply.text), { error: "Not found" }, `${method} ${urlPath}`);
    }

    const careersApi = await onDomain("/api/careers/sites/acme");
    assert.equal(careersApi.status, 200);
    assert.equal((JSON.parse(careersApi.text) as { site: { url: string } }).site.url, DOMAIN_ORIGIN);
    assert.equal((await onDomain("/api/careers/sites/acme/feed.json")).status, 200);
    const health = await onDomain("/api/health");
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.text), { ok: true });
  });

  test("every other path is the careers not-found page: never the App, its sign-in or its service worker", async () => {
    for (const urlPath of [
      "/login",
      "/settings/profile",
      "/index.html",
      "/sw.js",
      "/manifest.webmanifest",
      "/careers.html",
      "/careers/acme",
      "/careers/acme/openings/platform-engineer",
      "/openings/no-such-role",
      "/openings/draft-role",
      "/unsubscribe/some-token",
      "/sign/some-token",
    ]) {
      const data = assertNotFoundPage(await onDomain(urlPath), urlPath);
      assert.equal(data.site?.companySlug, "acme", urlPath);
      assert.equal(data.basePath, "", urlPath);
    }
    const posted = await onDomain("/", "POST");
    assert.equal(posted.status, 404);
    assert.deepEqual(JSON.parse(posted.text), { error: "Not found" });
  });

  test("the static files the careers page loads are served there", async () => {
    const bundle = await onDomain("/assets/careers-abc123.js");
    assert.equal(bundle.status, 200);
    assert.equal(bundle.text, CAREERS_ASSET);
    assert.equal((await onDomain("/favicon.svg")).status, 200);
  });

  test("a missing static file there never falls back to the App shell", async () => {
    // index.ts ends with `app.get(/^\/(?!api).*/, sendFile(index.html))`, and
    // the guard lets every `/assets/*` path through towards it.
    assert.deepEqual(await appFilesServedOnDomain(["/assets/no-such-file.js", "/assets/"]), []);
  });

  test("a path that climbs out of /assets/ never reaches the App's own files", async () => {
    // `express.static` decodes and normalizes the path inside its root, so
    // `/assets/..%2findex.html` is `index.html`. A browser keeps `..%2f`, so
    // a link can carry it.
    const climbing = [
      "/assets/../index.html",
      "/assets/..%2findex.html",
      "/assets/%2e%2e/index.html",
      "/assets/..%2fsw.js",
      "/assets/..%2fmanifest.webmanifest",
      "/assets/..%2fcareers.html",
    ];
    assert.deepEqual(await appFilesServedOnDomain(climbing), []);
  });

  test("a Member's session never reaches the domain: internal Openings stay hidden there", async () => {
    actingUserId = member.id;
    const onTheDomain = await onDomain("/openings/internal-move");
    const data = assertNotFoundPage(onTheDomain, "/openings/internal-move");
    assert.equal((data.site?.viewer as Record<string, unknown>).member, false);
    const onTheInstall = await request("/careers/acme/openings/internal-move");
    assert.equal(onTheInstall.status, 200);
  });

  test("a domain whose site was switched off since the last refresh serves only the careers not-found page", async () => {
    // Another replica switched the site off; this one's host map has not caught up yet.
    await updateSettings({ siteEnabled: false });
    const data = assertNotFoundPage(await onDomain("/"), "/");
    assert.equal(data.site, null);
    assertNotFoundPage(await onDomain("/login"), "/login");
    assert.equal((await onDomain("/robots.txt")).text, "User-agent: *\nDisallow: /\n");
    assert.equal((await onDomain("/sitemap.xml")).status, 404);
    assert.equal((await onDomain("/api/companies/some-company/employees")).status, 404);
  });
});

describe("domains that are not careers hosts", () => {
  test("an unverified domain, an internal site's domain and a switched-off site's domain are ordinary hosts", async () => {
    const variants: Array<[string, Partial<RecruitingSettings>]> = [
      ["unverified", { customDomainVerifiedAt: null }],
      ["internal site", { siteVisibility: "internal" }],
      ["switched-off site", { siteEnabled: false }],
    ];
    for (const [label, values] of variants) {
      await connectDomain(values);
      const home = await onDomain("/");
      assert.equal(home.status, 200, label);
      assert.ok(home.text.includes(APP_SHELL), `${label}: the App answers as on any other host`);
      const api = await onDomain("/api/companies/some-company/employees");
      assert.deepEqual(JSON.parse(api.text), { app: "company-api" }, label);
      const careersPage = await onDomain("/openings/platform-engineer");
      assert.ok(careersPage.text.includes(APP_SHELL), `${label}: no careers page at the domain's root paths`);
    }
  });
});
