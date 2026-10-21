import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import express from "express";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";

import { config } from "../../config.js";
import { DEFAULT_OPENING_FORM, RESUME_MAX_BYTES } from "../../shared/recruiting.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { Membership } from "../db/entities/Membership.js";
import { RecruitingApplication } from "../db/entities/RecruitingApplication.js";
import { RecruitingApplicationEvent } from "../db/entities/RecruitingApplicationEvent.js";
import { RecruitingOpening } from "../db/entities/RecruitingOpening.js";
import { RecruitingSettings } from "../db/entities/RecruitingSettings.js";
import { TotpCredential } from "../db/entities/TotpCredential.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { recruitingPrivateCompanyDir } from "../services/paths.js";
import { setPublicUrl } from "../services/publicUrl.js";
import { refreshCareersHosts } from "../services/recruiting/domains.js";
import { RESUME_TYPE_HINT, storeLogo } from "../services/recruiting/files.js";
import { setScreeningAutoKickForTests } from "../services/recruiting/screeningQueue.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { docxFixture, para } from "../test/docxFixtures.js";
import { persistTestSession } from "../test/userSession.js";
import { careersRouter, resetCareersSubmitThrottleForTests } from "./careers.js";

/**
 * The careers site's public API: everything under `/api/careers` that a
 * stranger on the internet can reach without signing in.
 *
 * It is the one Recruiting surface with no Membership check in front of it,
 * so this file pins what it hands out and what it takes in:
 *
 *  - Who sees what. A public site answers anyone; an internal site only a
 *    signed-in Member of that company, and only one with a second factor
 *    enrolled when the company requires it. Drafts never show; an unlisted
 *    Opening opens by its link but is never listed; an internal Opening shows
 *    only to Members. On a careers custom domain only that domain's company
 *    answers, and any session is ignored.
 *  - What leaves. The public DTOs only: never criteria, the screener or its
 *    instructions, an Opening's owner, or anyone else's application.
 *  - What comes in. A multipart application whose resume is judged by its
 *    bytes and stored under a server-chosen name, guarded by the honeypot,
 *    the per-connection throttle and idempotent retries, and followed by a
 *    confirmation email (logged as `skipped` while no provider is set up).
 *  - The JSON feed (readable from any origin), the logo, and
 *    `domains/check`, which tells a reverse proxy whether to request a
 *    certificate for a name.
 */

const PUBLIC_URL = "https://app.genosyn.test";
const CAREERS_DOMAIN = "careers.acme.test";
const ADA_EMAIL = "ada@example.test";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const RESUME_SENTENCE =
  "Ada Lovelace wrote the first published algorithm for the Analytical Engine.";
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 7),
]);

const SITE_NOT_AVAILABLE = { error: "This careers site is not available." };
const OPENING_NOT_AVAILABLE = { error: "This opening is not available." };
const MEMBERS_ONLY = { error: "This careers site is for Members. Sign in to see it." };
const UNREADABLE = { error: "The application could not be read. Reload the page and try again." };
const NEEDS_ANOTHER_LOOK = "Some answers need another look.";

const CRITERIA = [
  {
    id: "crit-kafka",
    name: "SECRET-CRITERION distributed systems",
    description: "SECRET-CRITERION-DETAIL has run Kafka in production",
    importance: "must_have",
  },
];

const QUESTIONS = [
  { id: "q-years", label: "Years running Kubernetes", help: "", kind: "number", required: true, options: [] },
  { id: "q-relocate", label: "Open to relocating?", help: "", kind: "yes_no", required: false, options: [] },
];

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
// eslint-disable-next-line no-console
const originalConsoleLog = console.log;
let root = "";
let server: Server;
let port = 0;
let baseUrl = "";
/** The signed-in user for the next request, or null for an anonymous visitor. */
let actingUserId: string | null = null;
/** A hand-made session sent as is, for sessions that should no longer resolve. */
let rawSession: Record<string, unknown> | null = null;

let owner: User;
let member: User;
let outsider: User;
let acme: Company;
let globex: Company;
let acmeSettings: RecruitingSettings;

type Json = Record<string, unknown>;
type SiteBody = { site: Json; openings: Json[] };
type OpeningBody = { site: Json; opening: Json };
type Reply<T = Json> = { status: number; headers: Headers; body: T };
type Resume = { bytes: Buffer; name: string; type?: string };

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-careers-api-"));
  mutableConfig.dataDir = path.join(root, "data");
  setScreeningAutoKickForTests(false);
  // The console email transport prints every confirmation; keep the run readable.
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[email:skipped]")) return;
    originalConsoleLog(...args);
  };
  await initTestDb();
  await setPublicUrl(PUBLIC_URL);
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = rawSession
      ? { ...rawSession }
      : actingUserId
        ? { userId: actingUserId, sessionVersion: 0, authenticatedAt: Date.now() }
        : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/careers", careersRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  setScreeningAutoKickForTests(true);
  // eslint-disable-next-line no-console
  console.log = originalConsoleLog;
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
  resetCareersSubmitThrottleForTests();
  fs.rmSync(mutableConfig.dataDir, { recursive: true, force: true });
  actingUserId = null;
  rawSession = null;
  const user = (email: string, name: string) =>
    insert(User, { email, name, passwordHash: "x", sessionVersion: 0 });
  owner = await user("owner@acme.test", "Olive Owner");
  member = await user("member@acme.test", "Mel Member");
  outsider = await user("outsider@globex.test", "Otto Outsider");
  acme = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  globex = await insert(Company, { name: "Globex", slug: "globex", ownerId: outsider.id });
  await insert(Membership, { companyId: acme.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: acme.id, userId: member.id, role: "member" });
  await insert(Membership, { companyId: globex.id, userId: outsider.id, role: "owner" });
  acmeSettings = await insert(RecruitingSettings, {
    companyId: acme.id,
    siteEnabled: true,
    siteVisibility: "public",
    siteHeadline: "Build the future of widgets",
  });
});

afterEach(async () => {
  // An application's confirmation email is sent after the response; let it
  // land before the next test rebuilds the database underneath it.
  await settleFollowUps();
  actingUserId = null;
  rawSession = null;
});

async function settleFollowUps(): Promise<void> {
  const repo = AppDataSource.getRepository(RecruitingApplication);
  const deadline = Date.now() + 10_000;
  while ((await repo.countBy({ confirmationEmailStatus: "" })) > 0) {
    if (Date.now() > deadline) throw new Error("An application's confirmation never finished.");
    await delay(10);
  }
  // The follow-up still looks up the screener after recording the email.
  await delay(25);
}

async function opening(values: Partial<RecruitingOpening> = {}): Promise<RecruitingOpening> {
  return insert(RecruitingOpening, {
    companyId: acme.id,
    slug: "platform-engineer",
    title: "Platform Engineer",
    status: "open",
    visibility: "public",
    employmentType: "full_time",
    workplace: "remote",
    department: "Engineering",
    location: "Europe",
    publishedAt: new Date("2026-10-01T09:00:00.000Z"),
    summary: "Keep the platform fast and boring.",
    description: "You will run the platform everything else runs on. On call one week in six.",
    formJson: JSON.stringify(DEFAULT_OPENING_FORM),
    criteriaJson: JSON.stringify(CRITERIA),
    questionsJson: "[]",
    ...values,
  });
}

/** Openings nobody browsing the site may see listed. */
async function unlistableOpenings(): Promise<void> {
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
}

async function updateSettings(values: Partial<RecruitingSettings>): Promise<void> {
  await AppDataSource.getRepository(RecruitingSettings).update({ id: acmeSettings.id }, values);
}

async function get<T = Json>(urlPath: string): Promise<Reply<T>> {
  const response = await fetch(`${baseUrl}${urlPath}`);
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: (text ? JSON.parse(text) : {}) as T };
}

/** A GET with its own `Host` header, which `fetch` will not send. */
function onHost(host: string, urlPath: string): Promise<{ status: number; body: Json }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: urlPath, method: "GET", agent: false, headers: { host } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: response.statusCode ?? 0, body: (text ? JSON.parse(text) : {}) as Json });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/** The fields the careers page's form sends, with these overrides; `undefined` leaves one out. */
function applicationForm(fields: Record<string, string | undefined> = {}): FormData {
  const values: Record<string, string | undefined> = {
    submissionId: randomUUID(),
    name: "Ada Lovelace",
    email: ADA_EMAIL,
    answers: "{}",
    consent: "true",
    fax: "",
    ...fields,
  };
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) form.append(key, value);
  }
  return form;
}

function attach(form: FormData, field: string, resume: Resume): void {
  form.append(
    field,
    new Blob([new Uint8Array(resume.bytes)], { type: resume.type ?? "application/octet-stream" }),
    resume.name,
  );
}

async function postApplication(openingSlug: string, form: FormData, siteSlug = "acme"): Promise<Reply> {
  const response = await fetch(
    `${baseUrl}/api/careers/sites/${siteSlug}/openings/${openingSlug}/applications`,
    { method: "POST", body: form },
  );
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: (text ? JSON.parse(text) : {}) as Json };
}

async function apply(
  openingSlug: string,
  fields: Record<string, string | undefined> = {},
  resume: Resume | null = null,
): Promise<Reply> {
  const form = applicationForm(fields);
  if (resume) attach(form, "resume", resume);
  return postApplication(openingSlug, form);
}

async function pdfResume(sentence = RESUME_SENTENCE): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText(sentence, { x: 48, y: 730, size: 12 });
  return Buffer.from(await pdf.save());
}

function txtResume(): Resume {
  return {
    bytes: Buffer.from("Katherine Johnson computed the trajectory for Freedom 7 by hand.\n"),
    name: "resume.txt",
    type: "text/plain",
  };
}

async function applications(): Promise<RecruitingApplication[]> {
  return AppDataSource.getRepository(RecruitingApplication).find({ order: { createdAt: "ASC" } });
}

function storedResumes(companyId: string): string[] {
  const dir = path.join(recruitingPrivateCompanyDir(companyId), "resumes");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

/** Every key anywhere in a JSON value. */
function keysIn(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysIn(item, found);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      keysIn(child, found);
    }
  }
  return found;
}

describe("the site", () => {
  test("a public site answers anyone with its listed Openings, newest first", async () => {
    await opening();
    await opening({
      slug: "product-designer",
      title: "Product Designer",
      summary: "Design the widgets.",
      department: "Design",
      employmentType: "contract",
      workplace: "hybrid",
      location: "Berlin",
      compensationMinMinor: 9_000_000,
      compensationMaxMinor: 11_000_000,
      compensationCurrency: "EUR",
      compensationPeriod: "year",
      publishedAt: new Date("2026-10-05T09:00:00.000Z"),
    });
    await unlistableOpenings();

    const reply = await get<SiteBody>("/api/careers/sites/acme");
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("cache-control"), "private, no-store");
    assert.equal(reply.headers.get("x-robots-tag"), "noindex");
    assert.deepEqual(reply.body.site, {
      companySlug: "acme",
      name: "Acme",
      headline: "Build the future of widgets",
      intro: "",
      websiteUrl: "",
      privacyPolicyUrl: "",
      accentColor: "#4f46e5",
      logoUrl: null,
      visibility: "public",
      url: `${PUBLIC_URL}/careers/acme`,
      apiPath: "/api/careers/sites/acme",
      viewer: { member: false, name: "", email: "" },
    });
    assert.deepEqual(
      reply.body.openings.map((card) => card.slug),
      ["product-designer", "platform-engineer"],
    );
    assert.deepEqual(reply.body.openings[0], {
      slug: "product-designer",
      title: "Product Designer",
      summary: "Design the widgets.",
      department: "Design",
      location: "Berlin",
      workplace: "hybrid",
      employmentType: "contract",
      visibility: "public",
      meta: "Contract · Hybrid · Berlin",
      compensation: "€90,000 – €110,000 per year",
      publishedAt: "2026-10-05T09:00:00.000Z",
      applyBy: null,
      url: `${PUBLIC_URL}/careers/acme/openings/product-designer`,
    });
  });

  test("an unknown company, a switched-off site, and a company that never set one up are not found", async () => {
    const unknown = await get("/api/careers/sites/nobody");
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, SITE_NOT_AVAILABLE);

    const neverSetUp = await get("/api/careers/sites/globex");
    assert.equal(neverSetUp.status, 404);
    assert.deepEqual(neverSetUp.body, SITE_NOT_AVAILABLE);

    await updateSettings({ siteEnabled: false });
    const switchedOff = await get("/api/careers/sites/acme");
    assert.equal(switchedOff.status, 404);
    assert.deepEqual(switchedOff.body, SITE_NOT_AVAILABLE);
  });

  test("a slug that cannot be one is refused at the boundary", async () => {
    for (const slug of ["Acme", "-acme", "acme_co"]) {
      assert.equal((await get(`/api/careers/sites/${slug}`)).status, 400, slug);
    }
  });
});

describe("an internal site", () => {
  beforeEach(async () => {
    await updateSettings({ siteVisibility: "internal" });
    await opening();
    await opening({
      slug: "internal-move",
      title: "Internal Move",
      visibility: "internal",
      publishedAt: new Date("2026-10-03T09:00:00.000Z"),
    });
    await opening({ slug: "unlisted-role", title: "Unlisted Role", visibility: "unlisted" });
  });

  test("is refused to an anonymous visitor, with nothing about the site in the answer", async () => {
    const site = await get("/api/careers/sites/acme");
    assert.equal(site.status, 403);
    assert.deepEqual(site.body, MEMBERS_ONLY);

    const one = await get("/api/careers/sites/acme/openings/platform-engineer");
    assert.equal(one.status, 403);
    assert.deepEqual(one.body, MEMBERS_ONLY);

    const applied = await apply("platform-engineer", {}, txtResume());
    assert.equal(applied.status, 403);
    assert.deepEqual(applied.body, MEMBERS_ONLY);
    assert.equal((await applications()).length, 0);
  });

  test("is served to a signed-in Member of the company, internal Openings included", async () => {
    actingUserId = member.id;
    const reply = await get<SiteBody>("/api/careers/sites/acme");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.site.visibility, "internal");
    assert.deepEqual(reply.body.site.viewer, {
      member: true,
      name: "Mel Member",
      email: "member@acme.test",
    });
    assert.deepEqual(
      reply.body.openings.map((card) => card.slug),
      ["internal-move", "platform-engineer"],
    );
    assert.equal((await get("/api/careers/sites/acme/openings/internal-move")).status, 200);
  });

  test("is refused to a signed-in Member of another company", async () => {
    actingUserId = outsider.id;
    const reply = await get("/api/careers/sites/acme");
    assert.equal(reply.status, 403);
    assert.deepEqual(reply.body, MEMBERS_ONLY);
  });

  test("a company that requires two factors refuses a Member who has none enrolled", async () => {
    await AppDataSource.getRepository(Company).update({ id: acme.id }, { requireTwoFactor: true });
    actingUserId = member.id;
    assert.equal((await get("/api/careers/sites/acme")).status, 403);

    // An authenticator still being set up is not a second factor.
    const pending = await insert(TotpCredential, {
      userId: member.id,
      name: "Phone",
      secret: "unused",
      verifiedAt: null,
    });
    assert.equal((await get("/api/careers/sites/acme")).status, 403);

    await AppDataSource.getRepository(TotpCredential).update({ id: pending.id }, { verifiedAt: new Date() });
    const enrolled = await get<SiteBody>("/api/careers/sites/acme");
    assert.equal(enrolled.status, 200);
    assert.deepEqual(enrolled.body.site.viewer, {
      member: true,
      name: "Mel Member",
      email: "member@acme.test",
    });
  });

  test("a session that no longer resolves counts as nobody", async () => {
    rawSession = {
      userId: member.id,
      sessionVersion: 0,
      userSessionId: randomUUID(),
      expiresAt: Date.now() + 3_600_000,
    };
    const reply = await get("/api/careers/sites/acme");
    assert.equal(reply.status, 403);
    assert.deepEqual(reply.body, MEMBERS_ONLY);
  });

  test("a Member's application through it is recorded as internal, with who applied", async () => {
    actingUserId = member.id;
    const reply = await apply(
      "platform-engineer",
      { name: "Mel Member", email: "member@acme.test" },
      txtResume(),
    );
    assert.equal(reply.status, 201);
    const [stored] = await applications();
    assert.equal(stored.source, "internal");
    assert.equal(stored.applicantUserId, member.id);
  });
});

describe("Openings", () => {
  test("an open public Opening is served with its form and questions, and nothing more", async () => {
    const applyBy = new Date(Date.now() + 30 * 86_400_000);
    await opening({
      questionsJson: JSON.stringify(QUESTIONS),
      formJson: JSON.stringify({ phone: "required", coverLetter: "hidden" }),
      compensationMinMinor: 12_000_000,
      compensationMaxMinor: 15_000_000,
      compensationCurrency: "EUR",
      headcount: 2,
      applyBy,
    });
    const reply = await get<OpeningBody>("/api/careers/sites/acme/openings/platform-engineer");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.site.companySlug, "acme");
    assert.deepEqual(reply.body.opening, {
      slug: "platform-engineer",
      title: "Platform Engineer",
      summary: "Keep the platform fast and boring.",
      department: "Engineering",
      location: "Europe",
      workplace: "remote",
      employmentType: "full_time",
      visibility: "public",
      meta: "Full-time · Remote · Europe",
      compensation: "€120,000 – €150,000 per year",
      publishedAt: "2026-10-01T09:00:00.000Z",
      applyBy: applyBy.toISOString(),
      url: `${PUBLIC_URL}/careers/acme/openings/platform-engineer`,
      description: "You will run the platform everything else runs on. On call one week in six.",
      headcount: 2,
      accepting: true,
      status: "open",
      form: {
        phone: "required",
        location: "optional",
        linkedin: "optional",
        website: "optional",
        resume: "required",
        coverLetter: "hidden",
      },
      questions: QUESTIONS,
    });
  });

  test("an unlisted Opening opens by its link although no list shows it", async () => {
    await opening({ slug: "unlisted-role", title: "Unlisted Role", visibility: "unlisted" });
    const site = await get<SiteBody>("/api/careers/sites/acme");
    assert.deepEqual(site.body.openings, []);
    const reply = await get<OpeningBody>("/api/careers/sites/acme/openings/unlisted-role");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.opening.visibility, "unlisted");
    assert.equal(reply.body.opening.accepting, true);
  });

  test("a closed Opening, or one past its closing date, is readable but not accepting", async () => {
    await unlistableOpenings();
    const closed = await get<OpeningBody>("/api/careers/sites/acme/openings/closed-role");
    assert.equal(closed.status, 200);
    assert.equal(closed.body.opening.status, "closed");
    assert.equal(closed.body.opening.accepting, false);

    const expired = await get<OpeningBody>("/api/careers/sites/acme/openings/expired-role");
    assert.equal(expired.status, 200);
    assert.equal(expired.body.opening.status, "open");
    assert.equal(expired.body.opening.accepting, false);
  });

  test("a draft, an unknown slug, an internal Opening for a visitor, and another company's Opening answer the same 404", async () => {
    await unlistableOpenings();
    await insert(RecruitingSettings, { companyId: globex.id, siteEnabled: true });
    await insert(RecruitingOpening, {
      companyId: globex.id,
      slug: "globex-role",
      title: "Globex Role",
      status: "open",
      publishedAt: new Date(),
    });
    for (const slug of ["draft-role", "no-such-role", "internal-move", "globex-role"]) {
      const reply = await get(`/api/careers/sites/acme/openings/${slug}`);
      assert.equal(reply.status, 404, slug);
      assert.deepEqual(reply.body, OPENING_NOT_AVAILABLE, slug);
    }
    assert.equal((await get("/api/careers/sites/globex/openings/globex-role")).status, 200);
  });

  test("a public site lists its internal Openings for a signed-in Member, and still never the unlisted ones", async () => {
    await opening();
    await unlistableOpenings();
    actingUserId = member.id;
    const site = await get<SiteBody>("/api/careers/sites/acme");
    assert.deepEqual(
      site.body.openings.map((card) => card.slug).sort(),
      ["internal-move", "platform-engineer"],
    );
    const internal = await get<OpeningBody>("/api/careers/sites/acme/openings/internal-move");
    assert.equal(internal.status, 200);
    assert.equal(internal.body.opening.visibility, "internal");
  });
});

describe("the feed", () => {
  test("lists only public, open Openings, readable from any origin", async () => {
    await opening();
    await unlistableOpenings();
    // A Member's session adds nothing to the feed: it is for the company's own website.
    actingUserId = member.id;
    const reply = await get<{ version: number; company: string; url: string; openings: Json[] }>(
      "/api/careers/sites/acme/feed.json",
    );
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("access-control-allow-origin"), "*");
    assert.equal(reply.headers.get("cache-control"), "public, max-age=300");
    assert.equal(reply.body.version, 1);
    assert.equal(reply.body.company, "Acme");
    assert.equal(reply.body.url, `${PUBLIC_URL}/careers/acme`);
    assert.deepEqual(
      reply.body.openings.map((card) => card.slug),
      ["platform-engineer"],
    );
  });

  test("an internal, switched-off or unknown site has no feed", async () => {
    await opening();
    await updateSettings({ siteVisibility: "internal" });
    const internal = await get("/api/careers/sites/acme/feed.json");
    assert.equal(internal.status, 404);
    assert.deepEqual(internal.body, SITE_NOT_AVAILABLE);
    assert.equal(internal.headers.get("access-control-allow-origin"), null);

    await updateSettings({ siteVisibility: "public", siteEnabled: false });
    assert.equal((await get("/api/careers/sites/acme/feed.json")).status, 404);
    assert.equal((await get("/api/careers/sites/nobody/feed.json")).status, 404);
  });
});

describe("applying", () => {
  test("a PDF resume is stored under a name the server chose and its text is read", async () => {
    const target = await opening();
    const bytes = await pdfResume();
    const submissionId = randomUUID();
    const reply = await apply(
      "platform-engineer",
      {
        submissionId,
        phone: "+1 415 555 0100",
        location: "London",
        linkedinUrl: "linkedin.com/in/ada",
        coverLetter: "I would like to help.",
      },
      { bytes, name: "Ada CV.pdf", type: "application/pdf" },
    );
    assert.equal(reply.status, 201);
    assert.deepEqual(reply.body, { ok: true, email: ADA_EMAIL });

    const rows = await applications();
    assert.equal(rows.length, 1);
    const [stored] = rows;
    assert.equal(stored.companyId, acme.id);
    assert.equal(stored.openingId, target.id);
    assert.equal(stored.candidateName, "Ada Lovelace");
    assert.equal(stored.candidateEmail, ADA_EMAIL);
    assert.equal(stored.candidatePhone, "+1 415 555 0100");
    assert.equal(stored.candidateLocation, "London");
    assert.equal(stored.linkedinUrl, "https://linkedin.com/in/ada");
    assert.equal(stored.coverLetter, "I would like to help.");
    assert.equal(stored.source, "careers_site");
    assert.equal(stored.applicantUserId, null);
    assert.equal(stored.stage, "applied");
    assert.equal(stored.clientSubmissionId, submissionId);
    assert.ok(stored.consentAt instanceof Date);
    assert.equal(stored.resumeFileName, "Ada CV.pdf");
    assert.equal(stored.resumeMimeType, "application/pdf");
    assert.equal(stored.resumeSize, bytes.length);
    assert.equal(stored.resumeTextStatus, "extracted");
    assert.match(stored.resumeText, /first published algorithm/);

    const key = stored.resumeFileKey ?? "";
    assert.match(key, /^[0-9a-f-]{36}\.pdf$/);
    assert.deepEqual(storedResumes(acme.id), [key]);
    const file = path.join(recruitingPrivateCompanyDir(acme.id), "resumes", key);
    assert.ok(fs.readFileSync(file).equals(bytes));
    assert.equal(fs.statSync(file).mode & 0o077, 0, "a resume is readable by the App's user only");

    const events = await AppDataSource.getRepository(RecruitingApplicationEvent).findBy({
      applicationId: stored.id,
      kind: "applied",
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].actorKind, "candidate");
  });

  test("a Word document and a plain-text resume are taken by their bytes, and their text read", async () => {
    await opening();
    const docx = await docxFixture({
      body: para("Grace Hopper wrote the first compiler and championed machine-independent languages."),
    });
    const word = await apply(
      "platform-engineer",
      { name: "Grace Hopper", email: "grace@example.test" },
      { bytes: docx, name: "grace.docx", type: DOCX_MIME },
    );
    assert.equal(word.status, 201);
    const text = await apply(
      "platform-engineer",
      { name: "Katherine Johnson", email: "katherine@example.test" },
      txtResume(),
    );
    assert.equal(text.status, 201);

    const byEmail = new Map((await applications()).map((row) => [row.candidateEmail, row]));
    const grace = byEmail.get("grace@example.test");
    assert.ok(grace);
    assert.equal(grace.resumeMimeType, DOCX_MIME);
    assert.equal(grace.resumeTextStatus, "extracted");
    assert.match(grace.resumeText, /first compiler/);
    assert.match(grace.resumeFileKey ?? "", /\.docx$/);

    const katherine = byEmail.get("katherine@example.test");
    assert.ok(katherine);
    assert.equal(katherine.resumeMimeType, "text/plain; charset=utf-8");
    assert.equal(katherine.resumeTextStatus, "extracted");
    assert.match(katherine.resumeText, /Freedom 7/);
    assert.match(katherine.resumeFileKey ?? "", /\.txt$/);
  });

  test("the bytes decide what a resume is, not its name", async () => {
    await opening();
    const reply = await apply("platform-engineer", {}, {
      bytes: await pdfResume(),
      name: "cv.txt",
      type: "text/plain",
    });
    assert.equal(reply.status, 201);
    const [stored] = await applications();
    assert.equal(stored.resumeMimeType, "application/pdf");
    assert.equal(stored.resumeFileName, "cv.txt");
    assert.match(stored.resumeFileKey ?? "", /\.pdf$/);
  });

  test("the confirmation email is logged as skipped while no email provider is set up", async () => {
    await opening();
    const reply = await apply("platform-engineer", {}, txtResume());
    assert.equal(reply.status, 201);
    await settleFollowUps();

    const logs = await AppDataSource.getRepository(EmailLog).find();
    assert.equal(logs.length, 1);
    const [log] = logs;
    assert.equal(log.companyId, acme.id);
    assert.equal(log.purpose, "recruiting");
    assert.equal(log.status, "skipped");
    assert.equal(log.transport, "console");
    assert.equal(log.toAddress, ADA_EMAIL);
    assert.equal(log.subject, "We received your application for Platform Engineer");
    assert.match(log.bodyPreview, /^Hi Ada,/);
    assert.ok(log.bodyPreview.includes(`${PUBLIC_URL}/careers/acme/openings/platform-engineer`));

    const [stored] = await applications();
    assert.equal(stored.confirmationEmailStatus, "skipped");
    const events = await AppDataSource.getRepository(RecruitingApplicationEvent).find({
      where: { applicationId: stored.id },
      order: { occurredAt: "ASC" },
    });
    assert.deepEqual(
      events.map((event) => event.kind),
      ["applied", "email_skipped"],
    );
  });

  test("answers are kept against the Opening's own questions; answers to questions it never asked are dropped", async () => {
    await opening({ questionsJson: JSON.stringify(QUESTIONS) });
    const reply = await apply(
      "platform-engineer",
      { answers: JSON.stringify({ "q-years": "7", "q-relocate": "yes", "q-invented": "dropped" }) },
      txtResume(),
    );
    assert.equal(reply.status, 201);
    const [stored] = await applications();
    assert.deepEqual(JSON.parse(stored.answersJson), [
      { questionId: "q-years", label: "Years running Kubernetes", kind: "number", value: 7 },
      { questionId: "q-relocate", label: "Open to relocating?", kind: "yes_no", value: true },
    ]);
  });

  test("a required question left blank, or answers that are not a JSON object, are refused and nothing is kept", async () => {
    await opening({ questionsJson: JSON.stringify(QUESTIONS) });
    const blank = await apply(
      "platform-engineer",
      { answers: JSON.stringify({ "q-relocate": "no" }) },
      txtResume(),
    );
    assert.equal(blank.status, 400);
    assert.deepEqual(blank.body, {
      error: NEEDS_ANOTHER_LOOK,
      fields: { "answers.q-years": "This question needs an answer." },
    });
    for (const answers of ["[1, 2]", "not json", "null", '"text"']) {
      const reply = await apply("platform-engineer", { answers }, txtResume());
      assert.equal(reply.status, 400, answers);
      assert.deepEqual(reply.body, { error: "The answers could not be read. Reload the page and try again." }, answers);
    }
    assert.equal((await applications()).length, 0);
    assert.deepEqual(storedResumes(acme.id), []);
  });

  test("an Opening that requires a resume refuses an application without one, naming the field", async () => {
    await opening();
    const reply = await apply("platform-engineer");
    assert.equal(reply.status, 400);
    assert.deepEqual(reply.body, { error: NEEDS_ANOTHER_LOOK, fields: { resume: "Attach your resume." } });
    assert.equal((await applications()).length, 0);
  });

  test("an Opening that makes the resume optional takes an application without one", async () => {
    await opening({ formJson: JSON.stringify({ ...DEFAULT_OPENING_FORM, resume: "optional" }) });
    const reply = await apply("platform-engineer");
    assert.equal(reply.status, 201);
    const [stored] = await applications();
    assert.equal(stored.resumeFileKey, null);
    assert.equal(stored.resumeTextStatus, "none");
  });

  test("a file that is not a resume by its bytes is refused, whatever it is called, and never written", async () => {
    await opening();
    const zip = new JSZip();
    zip.file("notes.txt", "A zip that is not a Word document.");
    const notDocx = await zip.generateAsync({ type: "nodebuffer" });
    const cases: Array<[Resume, string]> = [
      [{ bytes: PNG_BYTES, name: "resume.pdf", type: "application/pdf" }, RESUME_TYPE_HINT],
      [{ bytes: notDocx, name: "resume.docx", type: DOCX_MIME }, RESUME_TYPE_HINT],
      [
        {
          bytes: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]),
          name: "resume.txt",
          type: "text/plain",
        },
        RESUME_TYPE_HINT,
      ],
      [
        { bytes: Buffer.from("Plain words that only claim to be a PDF."), name: "resume.pdf", type: "application/pdf" },
        RESUME_TYPE_HINT,
      ],
      [{ bytes: Buffer.alloc(0), name: "resume.pdf", type: "application/pdf" }, "The resume file is empty."],
    ];
    for (const [resume, message] of cases) {
      const reply = await apply("platform-engineer", {}, resume);
      assert.equal(reply.status, 400, resume.name);
      assert.deepEqual(reply.body, { error: message, fields: { resume: message } }, resume.name);
    }
    assert.equal((await applications()).length, 0);
    assert.deepEqual(storedResumes(acme.id), []);
  });

  test("a resume is one file, sent as `resume`", async () => {
    await opening();
    const elsewhere = applicationForm();
    attach(elsewhere, "cv", txtResume());
    const misnamed = await postApplication("platform-engineer", elsewhere);
    assert.equal(misnamed.status, 400);
    assert.deepEqual(misnamed.body, { error: "The application could not be read. Try again." });

    const twice = applicationForm();
    attach(twice, "resume", txtResume());
    attach(twice, "resume", txtResume());
    const doubled = await postApplication("platform-engineer", twice);
    assert.equal(doubled.status, 400);
    assert.deepEqual(doubled.body, { error: "The application could not be read. Try again." });
    assert.equal((await applications()).length, 0);
  });

  test("a resume over 10 MB is refused with 413 and nothing is kept", async () => {
    await opening();
    const header = Buffer.from("%PDF-1.7\n");
    const bytes = Buffer.concat([header, Buffer.alloc(RESUME_MAX_BYTES + 1 - header.length, 0x20)]);
    const reply = await apply("platform-engineer", {}, { bytes, name: "huge.pdf", type: "application/pdf" });
    assert.equal(reply.status, 413);
    assert.deepEqual(reply.body, {
      error: "Keep the resume under 10 MB.",
      fields: { resume: "Keep the resume under 10 MB." },
    });
    assert.equal((await applications()).length, 0);
    assert.deepEqual(storedResumes(acme.id), []);
  });

  test("the honeypot is answered like a success, but nothing is stored and nobody is emailed", async () => {
    await opening();
    const reply = await apply(
      "platform-engineer",
      { fax: "+1 555 0100" },
      { bytes: await pdfResume(), name: "bot.pdf", type: "application/pdf" },
    );
    assert.equal(reply.status, 201);
    assert.deepEqual(reply.body, { ok: true, email: "" });
    await delay(50);
    assert.equal((await applications()).length, 0);
    assert.deepEqual(storedResumes(acme.id), []);
    assert.equal(await AppDataSource.getRepository(EmailLog).count(), 0);
  });

  test("the same submission sent twice makes one Application, one stored resume and one confirmation", async () => {
    await opening();
    const submissionId = randomUUID();
    const resume: Resume = { bytes: await pdfResume(), name: "ada.pdf", type: "application/pdf" };
    const first = await apply("platform-engineer", { submissionId }, resume);
    const second = await apply("platform-engineer", { submissionId }, resume);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.deepEqual(second.body, first.body);
    await settleFollowUps();
    assert.equal((await applications()).length, 1);
    assert.equal(storedResumes(acme.id).length, 1);
    assert.equal(await AppDataSource.getRepository(EmailLog).count(), 1);
    assert.equal(
      await AppDataSource.getRepository(RecruitingApplicationEvent).countBy({ kind: "applied" }),
      1,
    );
  });

  test("ten submissions per connection per Opening in ten minutes; the eleventh waits, other Openings do not", async () => {
    await opening();
    await opening({ slug: "product-designer", title: "Product Designer" });
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const refused = await apply("platform-engineer", { consent: "false" });
      assert.equal(refused.status, 400, `attempt ${attempt}`);
    }
    const limited = await apply("platform-engineer", {}, txtResume());
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.body, {
      error: "Too many applications from this connection. Try again in a few minutes.",
    });
    const retryAfter = Number(limited.headers.get("retry-after"));
    assert.ok(retryAfter >= 1 && retryAfter <= 600, `Retry-After was ${retryAfter}`);
    assert.equal((await applications()).length, 0);

    assert.equal((await apply("product-designer", {}, txtResume())).status, 201);
    resetCareersSubmitThrottleForTests();
    assert.equal((await apply("platform-engineer", {}, txtResume())).status, 201);
  });

  test("a closed Opening, or one past its closing date, takes no applications; a draft is not there to apply to", async () => {
    await unlistableOpenings();
    for (const slug of ["closed-role", "expired-role"]) {
      const reply = await apply(slug, {}, txtResume());
      assert.equal(reply.status, 400, slug);
      assert.deepEqual(reply.body, { error: "This opening is no longer taking applications." }, slug);
    }
    const draft = await apply("draft-role", {}, txtResume());
    assert.equal(draft.status, 404);
    assert.deepEqual(draft.body, OPENING_NOT_AVAILABLE);
    assert.equal((await applications()).length, 0);
    assert.deepEqual(storedResumes(acme.id), []);
  });

  test("an internal Opening takes applications only from signed-in Members, recorded as internal", async () => {
    await opening({ slug: "internal-move", title: "Internal Move", visibility: "internal" });
    const anonymous = await apply("internal-move", {}, txtResume());
    assert.equal(anonymous.status, 404);
    assert.deepEqual(anonymous.body, OPENING_NOT_AVAILABLE);

    actingUserId = member.id;
    const reply = await apply("internal-move", { name: "Mel Member", email: "member@acme.test" }, txtResume());
    assert.equal(reply.status, 201);
    const [stored] = await applications();
    assert.equal(stored.source, "internal");
    assert.equal(stored.applicantUserId, member.id);
  });

  test("an application must consent, and may carry no field the form does not have", async () => {
    await opening();
    const noConsent = await apply("platform-engineer", { consent: undefined }, txtResume());
    assert.equal(noConsent.status, 400);
    assert.deepEqual(noConsent.body, {
      error: NEEDS_ANOTHER_LOOK,
      fields: { consent: "Agree to how your application will be used to continue." },
    });
    const malformed: Array<Record<string, string | undefined>> = [
      { stage: "hired" },
      { submissionId: "not-a-uuid" },
      { submissionId: undefined },
      { name: "x".repeat(401) },
    ];
    for (const fields of malformed) {
      const reply = await apply("platform-engineer", fields, txtResume());
      assert.equal(reply.status, 400, JSON.stringify(Object.keys(fields)));
      assert.deepEqual(reply.body, UNREADABLE);
    }
    assert.equal((await applications()).length, 0);
  });
});

describe("what never leaves the App", () => {
  test("site, Opening and feed answers carry no criteria, screener, instructions, owners or other applicants", async () => {
    const screener = await insert(AIEmployee, {
      companyId: acme.id,
      name: "Screener Sable",
      slug: "screener-sable",
      role: "Recruiter",
      soulBody: "",
    });
    await updateSettings({
      screenerEmployeeId: screener.id,
      screeningInstructions: "SECRET-INSTRUCTIONS weigh open-source work heavily",
    });
    const target = await opening({
      ownerUserId: owner.id,
      createdByUserId: owner.id,
      screenerEmployeeId: screener.id,
      criteriaSource: "employee",
      criteriaByEmployeeId: screener.id,
      questionsJson: JSON.stringify(QUESTIONS),
    });
    await opening({ slug: "internal-move", title: "Internal Move", visibility: "internal", ownerUserId: owner.id });
    await insert(RecruitingApplication, {
      companyId: acme.id,
      openingId: target.id,
      candidateName: "Other Applicant",
      candidateEmail: "other.applicant@example.test",
      stageChangedAt: new Date(),
      confirmationEmailStatus: "sent",
      score: 91,
      scoreLabel: "strong",
      resumeText: "OTHER-RESUME-TEXT",
      coverLetter: "OTHER-COVER-LETTER",
    });

    const secrets = [
      "SECRET-CRITERION",
      "SECRET-INSTRUCTIONS",
      "Screener Sable",
      screener.id,
      owner.id,
      "owner@acme.test",
      "Olive Owner",
      "Other Applicant",
      "other.applicant@example.test",
      "OTHER-RESUME-TEXT",
      "OTHER-COVER-LETTER",
    ];
    const forbiddenKeys = [
      "criteria",
      "criteriaJson",
      "criteriaSource",
      "criteriaBy",
      "screener",
      "screenerEmployeeId",
      "screeningInstructions",
      "owner",
      "ownerUserId",
      "createdBy",
      "createdByUserId",
      "companyId",
      "score",
      "scoreLabel",
      "stageCounts",
      "applicationCount",
    ];
    // Anonymous, then as a Member, who sees more Openings but no more about how anyone is judged.
    for (const viewer of [null, member.id]) {
      actingUserId = viewer;
      for (const urlPath of [
        "/api/careers/sites/acme",
        "/api/careers/sites/acme/openings/platform-engineer",
        "/api/careers/sites/acme/feed.json",
      ]) {
        const response = await fetch(`${baseUrl}${urlPath}`);
        assert.equal(response.status, 200, urlPath);
        const text = await response.text();
        for (const secret of secrets) {
          assert.ok(!text.includes(secret), `${urlPath} (${viewer ? "member" : "anonymous"}) leaked ${secret}`);
        }
        const keys = keysIn(JSON.parse(text));
        for (const key of forbiddenKeys) {
          assert.ok(!keys.has(key), `${urlPath} (${viewer ? "member" : "anonymous"}) carries "${key}"`);
        }
      }
    }

    actingUserId = null;
    const applied = await apply("platform-engineer", { answers: JSON.stringify({ "q-years": 3 }) }, txtResume());
    assert.equal(applied.status, 201);
    assert.deepEqual(applied.body, { ok: true, email: ADA_EMAIL });
  });
});

describe("on a careers custom domain", () => {
  beforeEach(async () => {
    await updateSettings({
      customDomain: CAREERS_DOMAIN,
      customDomainToken: "token",
      customDomainVerifiedAt: new Date(),
    });
    await insert(RecruitingSettings, { companyId: globex.id, siteEnabled: true, siteVisibility: "public" });
    await insert(RecruitingOpening, {
      companyId: globex.id,
      slug: "globex-role",
      title: "Globex Role",
      status: "open",
      publishedAt: new Date(),
    });
    await opening();
    await opening({ slug: "internal-move", title: "Internal Move", visibility: "internal" });
    await refreshCareersHosts();
  });

  test("only that domain's company answers, and its addresses are on the domain", async () => {
    const own = await onHost(CAREERS_DOMAIN, "/api/careers/sites/acme");
    assert.equal(own.status, 200);
    const body = own.body as SiteBody;
    assert.equal(body.site.url, `https://${CAREERS_DOMAIN}`);
    assert.deepEqual(
      body.openings.map((card) => card.url),
      [`https://${CAREERS_DOMAIN}/openings/platform-engineer`],
    );

    for (const urlPath of [
      "/api/careers/sites/globex",
      "/api/careers/sites/globex/openings/globex-role",
      "/api/careers/sites/globex/feed.json",
    ]) {
      const other = await onHost(CAREERS_DOMAIN, urlPath);
      assert.equal(other.status, 404, urlPath);
    }
    // The same Globex site still answers on the install's own address.
    assert.equal((await get("/api/careers/sites/globex")).status, 200);
  });

  test("a Member's session counts for nothing there, so internal Openings stay hidden", async () => {
    actingUserId = member.id;
    const site = await onHost(CAREERS_DOMAIN, "/api/careers/sites/acme");
    assert.deepEqual((site.body as SiteBody).site.viewer, { member: false, name: "", email: "" });
    assert.equal((await onHost(CAREERS_DOMAIN, "/api/careers/sites/acme/openings/internal-move")).status, 404);
    assert.equal((await get("/api/careers/sites/acme/openings/internal-move")).status, 200);
  });
});

describe("the domain check", () => {
  async function check(domain: string): Promise<Reply> {
    return get(`/api/careers/domains/check?domain=${encodeURIComponent(domain)}`);
  }

  test("answers 200 for a verified domain whose site is live, however the name is written", async () => {
    await updateSettings({
      customDomain: CAREERS_DOMAIN,
      customDomainToken: "token",
      customDomainVerifiedAt: new Date(),
    });
    await refreshCareersHosts();
    for (const domain of [CAREERS_DOMAIN, "Careers.Acme.Test.", `https://${CAREERS_DOMAIN}/openings`]) {
      const reply = await check(domain);
      assert.equal(reply.status, 200, domain);
      assert.deepEqual(reply.body, { ok: true }, domain);
    }
  });

  test("answers 404 for every other name, so no certificate is requested for it", async () => {
    await updateSettings({
      customDomain: CAREERS_DOMAIN,
      customDomainToken: "token",
      customDomainVerifiedAt: new Date(),
    });
    await insert(RecruitingSettings, {
      companyId: globex.id,
      siteEnabled: true,
      siteVisibility: "public",
      customDomain: "careers.globex.test",
      customDomainToken: "never-published",
    });
    await refreshCareersHosts();
    for (const domain of [
      "careers.globex.test",
      "jobs.unknown.test",
      "acme.test",
      "127.0.0.1",
      "localhost",
      "app.genosyn.test",
      "not a domain",
    ]) {
      const reply = await check(domain);
      assert.equal(reply.status, 404, domain);
      assert.deepEqual(reply.body, { ok: false }, domain);
    }

    await updateSettings({ siteVisibility: "internal" });
    await refreshCareersHosts();
    assert.equal((await check(CAREERS_DOMAIN)).status, 404, "an internal site is never on a domain");

    await updateSettings({ siteVisibility: "public", siteEnabled: false });
    await refreshCareersHosts();
    assert.equal((await check(CAREERS_DOMAIN)).status, 404, "a switched-off site is on no domain");

    assert.equal((await get("/api/careers/domains/check")).status, 400);
  });
});

describe("the logo", () => {
  test("is served with a sandboxing policy and a day's cache; a site without one answers 404", async () => {
    const none = await get("/api/careers/sites/acme/logo");
    assert.equal(none.status, 404);
    assert.deepEqual(none.body, { error: "No logo." });

    const key = await storeLogo(acme.id, PNG_BYTES);
    await updateSettings({ logoKey: key });
    const response = await fetch(`${baseUrl}/api/careers/sites/acme/logo`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    assert.equal(response.headers.get("cache-control"), "public, max-age=86400");
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(PNG_BYTES));

    const site = await get<SiteBody>("/api/careers/sites/acme");
    assert.equal(site.body.site.logoUrl, `/api/careers/sites/acme/logo?v=${encodeURIComponent(key.slice(0, 8))}`);
  });
});
