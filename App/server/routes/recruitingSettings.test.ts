import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import {
  DEFAULT_CONFIRMATION_EMAIL_BODY,
  DEFAULT_CONFIRMATION_EMAIL_SUBJECT,
  DEFAULT_REJECTION_EMAIL_BODY,
  DEFAULT_REJECTION_EMAIL_SUBJECT,
  DEFAULT_SCREENING_INSTRUCTIONS,
} from "../../shared/recruiting.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { EmployeeRecruitingGrant } from "../db/entities/EmployeeRecruitingGrant.js";
import { Membership } from "../db/entities/Membership.js";
import { RecruitingApplication } from "../db/entities/RecruitingApplication.js";
import { RecruitingSettings } from "../db/entities/RecruitingSettings.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { getPublicUrl } from "../services/publicUrl.js";
import { addApplication } from "../services/recruiting/applications.js";
import {
  careersCompanyForHost,
  refreshCareersHosts,
  setCareersDnsResolverForTests,
  setCustomDomain,
  type CareersDnsResolver,
  type DomainCheck,
} from "../services/recruiting/domains.js";
import { upsertRecruitingGrant, type RecruitingGrantRow } from "../services/recruiting/grants.js";
import { closeOpening, createOpening, publishOpening } from "../services/recruiting/openings.js";
import type { recruitingOverview } from "../services/recruiting/overview.js";
import { setScreeningAutoKickForTests } from "../services/recruiting/screeningQueue.js";
import { ensureRecruitingSettings, type recruitingSettingsDto } from "../services/recruiting/settings.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { recruitingRouter } from "./recruiting.js";

/**
 * Recruiting's company-wide setup through the signed-in Member API: the
 * settings, the careers site and its logo, a custom domain, which AI
 * Employees may do what (AI access), and the overview.
 *
 * What this pins, and why it matters:
 *  - Owners and admins change any of it; a Member may read the settings, the
 *    AI access list and the overview, and is refused every change — however
 *    the path is spelled — before the body is even read. Another company's
 *    owner reaches nothing.
 *  - Settings store what was typed in its normal form (a three-digit accent, a
 *    bare domain as a web address), refuse what cannot be stored with a
 *    sentence a person can act on, and save nothing when they refuse. Null
 *    templates and instructions follow the defaults; empty text is a choice.
 *  - The logo is a real image under 2 MB, never SVG, kept in the App-private
 *    directory, and replacing or removing it removes the old file.
 *  - A custom domain is served only after its TXT record proves it, only
 *    while the site is on and public, and changing it starts the proof over.
 *    DNS is faked; nothing here reaches a resolver.
 */

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let root = "";
let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let otherCompany: Company;
let owner: User;
let admin: User;
let member: User;
let outsider: User;
let iris: AIEmployee;
let otto: AIEmployee;
let stranger: AIEmployee;

const DESCRIPTION =
  "You will run the billing service, mentor two engineers, and own our TypeScript platform from end to end.";
const DOMAIN = "careers.sunwise.example";
// A real 1×1 PNG and a real 1×1 GIF.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-recruiting-settings-"));
  mutableConfig.dataDir = path.join(root, "data");
  setScreeningAutoKickForTests(false);
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? {
          userId: actingUserId,
          sessionVersion: 0,
          authenticatedAt: Date.now(),
          secondFactorAt: Date.now(),
        }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", recruitingRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  setCareersDnsResolverForTests(null);
  setScreeningAutoKickForTests(true);
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
  // The host map outlives the tables; rebuild it from the empty database.
  await refreshCareersHosts();
  setCareersDnsResolverForTests(null);
  fs.rmSync(mutableConfig.dataDir, { recursive: true, force: true });
  const user = (email: string, name: string) =>
    insert(User, { email, name, passwordHash: "x", sessionVersion: 0 });
  owner = await user("settings-owner@example.test", "Owner");
  admin = await user("settings-admin@example.test", "Admin");
  member = await user("settings-member@example.test", "Member");
  outsider = await user("settings-outsider@example.test", "Outsider");
  company = await insert(Company, { name: "Sunwise", slug: "settings-sunwise", ownerId: owner.id });
  otherCompany = await insert(Company, {
    name: "Other",
    slug: "settings-other",
    ownerId: outsider.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: admin.id, role: "admin" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  await insert(Membership, { companyId: otherCompany.id, userId: outsider.id, role: "owner" });
  const employee = (companyId: string, name: string, slug: string) =>
    insert(AIEmployee, { companyId, name, slug, role: "Recruiter", soulBody: "" });
  // Inserted out of order on purpose: AI access lists them by name.
  otto = await employee(company.id, "Otto", "settings-otto");
  iris = await employee(company.id, "Iris", "settings-iris");
  stranger = await employee(otherCompany.id, "Stranger", "settings-stranger");
  actingUserId = owner.id;
});

type SettingsDto = Awaited<ReturnType<typeof recruitingSettingsDto>>;
type Overview = Awaited<ReturnType<typeof recruitingOverview>>;
type Verified = { settings: SettingsDto; check: DomainCheck };
type Issue = { path: Array<string | number>; message: string };
type ApiError = { error: string; issues?: Issue[] };
type Reply<T> = { status: number; body: T };

async function call<T = ApiError>(
  method: string,
  route: string,
  body?: unknown,
  companyId = company.id,
): Promise<Reply<T>> {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${route}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

function blob(bytes: Uint8Array, type: string): Blob {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Blob([copy], { type });
}

async function uploadLogo(
  bytes: Uint8Array | null,
  options: { name?: string; type?: string; field?: string; route?: string } = {},
): Promise<Reply<SettingsDto & ApiError>> {
  const form = new FormData();
  if (bytes) {
    form.append(options.field ?? "file", blob(bytes, options.type ?? "image/png"), options.name ?? "logo.png");
  } else {
    form.append("note", "no file here");
  }
  const response = await fetch(
    `${baseUrl}/api/companies/${company.id}${options.route ?? "/recruiting/settings/logo"}`,
    { method: "POST", body: form },
  );
  return { status: response.status, body: JSON.parse(await response.text()) };
}

function siteDir(): string {
  return path.join(mutableConfig.dataDir, ".private", "recruiting", company.id, "site");
}

function filesIn(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

async function settingsRow(companyId = company.id): Promise<RecruitingSettings | null> {
  return AppDataSource.getRepository(RecruitingSettings).findOneBy({ companyId });
}

async function auditFor(action: string): Promise<AuditEvent[]> {
  return AppDataSource.getRepository(AuditEvent).find({ where: { companyId: company.id, action } });
}

function dnsError(code: string): Error {
  return Object.assign(new Error(`queryTxt ${code} ${DOMAIN}`), { code });
}

/** DNS that answers with these TXT values at the proof's name, and this CNAME for the domain. */
function fakeDns(txt: () => Promise<string[][]>, cname: string[] = []): CareersDnsResolver {
  return {
    resolveTxt: () => txt(),
    resolveCname: async () => cname,
  };
}

async function connect(domain = DOMAIN): Promise<SettingsDto> {
  const connected = await call<SettingsDto>("PUT", "/recruiting/settings/domain", { domain });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  return connected.body;
}

async function verifyWith(resolver: CareersDnsResolver): Promise<Reply<Verified & ApiError>> {
  setCareersDnsResolverForTests(resolver);
  return call<Verified & ApiError>("POST", "/recruiting/settings/domain/verify", {});
}

async function proven(record: { value: string }): Promise<Verified> {
  const verified = await verifyWith(fakeDns(async () => [[record.value]]));
  assert.equal(verified.status, 200);
  assert.equal(verified.body.check.verified, true);
  return verified.body;
}

describe("who may change Recruiting's company-wide setup", () => {
  async function fixtures() {
    const grant = await upsertRecruitingGrant(company.id, iris.id, "read");
    const opening = await createOpening(
      company.id,
      { title: "Staff Engineer", description: DESCRIPTION },
      { kind: "member", userId: owner.id },
    );
    const application = await addApplication({
      companyId: company.id,
      openingId: opening.id,
      input: { name: "Ada Lovelace", email: "ada@example.com" },
      file: null,
      source: "manual",
      actor: { kind: "member", userId: owner.id },
    });
    return { grant, application };
  }

  function adminRoutes(grantId: string, applicationId: string): Array<[string, string, unknown?]> {
    return [
      ["PATCH", "/recruiting/settings", { siteEnabled: true }],
      ["DELETE", "/recruiting/settings/logo"],
      ["PUT", "/recruiting/settings/domain", { domain: DOMAIN }],
      ["POST", "/recruiting/settings/domain/verify", {}],
      ["PUT", `/recruiting/ai-access/${otto.id}`, { accessLevel: "hire" }],
      ["DELETE", `/recruiting/ai-access/${grantId}`],
      ["DELETE", `/recruiting/applications/${applicationId}`],
      // However the path is spelled, the guard sees the route Express runs.
      ["PATCH", "/RECRUITING/SETTINGS", { siteEnabled: true }],
      ["PATCH", "/recruiting/settings/", { siteEnabled: true }],
      ["PUT", `/Recruiting/AI-Access/${otto.id}`, { accessLevel: "hire" }],
      // Refused before the body is read: a Member learns nothing from validation.
      ["PATCH", "/recruiting/settings", {}],
      ["PUT", "/recruiting/settings/domain", { domain: 42 }],
    ];
  }

  test("a Member reads the settings, AI access and the overview, and changes none of it", async () => {
    const { grant, application } = await fixtures();
    actingUserId = member.id;
    assert.equal((await call("GET", "/recruiting/settings")).status, 200);
    const grants = await call<{ rows: RecruitingGrantRow[] }>("GET", "/recruiting/ai-access");
    assert.equal(grants.status, 200);
    assert.equal(grants.body.rows.length, 2);
    const overview = await call<Overview>("GET", "/recruiting/overview");
    assert.equal(overview.status, 200);
    assert.equal(overview.body.counts.awaitingReview, 1);

    for (const [method, route, body] of adminRoutes(grant.id, application.id)) {
      const response = await call(method, route, body);
      assert.equal(response.status, 403, `${method} ${route}`);
      assert.deepEqual(response.body, { error: "admin company role required" }, `${method} ${route}`);
    }
    const logo = await uploadLogo(PNG);
    assert.equal(logo.status, 403);

    const row = await settingsRow();
    assert.equal(row?.siteEnabled, false);
    assert.equal(row?.customDomain, null);
    assert.equal(row?.logoKey, null);
    assert.deepEqual(filesIn(siteDir()), []);
    const grants2 = await AppDataSource.getRepository(EmployeeRecruitingGrant).find();
    assert.deepEqual(
      grants2.map((row2) => [row2.employeeId, row2.accessLevel]),
      [[iris.id, "read"]],
    );
    assert.ok(await AppDataSource.getRepository(RecruitingApplication).findOneBy({ id: application.id }));
    assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
  });

  test("owners and admins change it", async () => {
    for (const [userId, title] of [
      [admin.id, "Careers by an admin"],
      [owner.id, "Careers by the owner"],
    ] as Array<[string, string]>) {
      actingUserId = userId;
      const saved = await call<SettingsDto>("PATCH", "/recruiting/settings", { siteTitle: title });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.site.title, title);
      const granted = await call("PUT", `/recruiting/ai-access/${iris.id}`, { accessLevel: "screen" });
      assert.equal(granted.status, 200);
    }
    const audits = await auditFor("recruiting.settings.update");
    assert.deepEqual(audits.map((audit) => audit.actorUserId).sort(), [admin.id, owner.id].sort());
  });

  test("another company's owner reaches none of it, reads included, and a signed-out request neither", async () => {
    const { grant, application } = await fixtures();
    const routes: Array<[string, string, unknown?]> = [
      ["GET", "/recruiting/settings"],
      ["GET", "/recruiting/ai-access"],
      ["GET", "/recruiting/overview"],
      ...adminRoutes(grant.id, application.id),
    ];
    for (const [userId, status] of [
      [outsider.id, 403],
      [null, 401],
    ] as Array<[string | null, number]>) {
      actingUserId = userId;
      for (const [method, route, body] of routes) {
        assert.equal((await call(method, route, body)).status, status, `${method} ${route}`);
      }
      assert.equal((await uploadLogo(PNG)).status, status);
    }
    // Nor does anyone reach a company that is not theirs by naming another.
    actingUserId = owner.id;
    assert.equal((await call("GET", "/recruiting/settings", undefined, otherCompany.id)).status, 403);
    assert.equal((await call("GET", "/recruiting/overview", undefined, randomUUID())).status, 403);
    assert.equal(await settingsRow(), null);
  });
});

describe("settings", () => {
  test("read the defaults before anything is saved", async () => {
    const read = await call<SettingsDto>("GET", "/recruiting/settings");
    assert.equal(read.status, 200);
    const install = `${getPublicUrl()}/careers/settings-sunwise`;
    assert.deepEqual(read.body, {
      site: {
        enabled: false,
        visibility: "public",
        title: "",
        effectiveTitle: "Sunwise",
        headline: "",
        intro: "",
        websiteUrl: "",
        privacyPolicyUrl: "",
        accentColor: "#4f46e5",
        logoUrl: null,
        allowIndexing: true,
        url: install,
        installUrl: install,
        feedUrl: `${getPublicUrl()}/api/careers/sites/settings-sunwise/feed.json`,
      },
      domain: {
        name: null,
        verifiedAt: null,
        checkedAt: null,
        error: "",
        live: false,
        record: null,
        cnameTarget: new URL(getPublicUrl()).hostname,
      },
      screening: {
        screener: null,
        autoScreen: true,
        instructions: null,
        effectiveInstructions: DEFAULT_SCREENING_INSTRUCTIONS,
        defaultInstructions: DEFAULT_SCREENING_INSTRUCTIONS,
      },
      emails: {
        confirmationEnabled: true,
        confirmationSubject: null,
        confirmationBody: null,
        effectiveConfirmation: {
          subject: DEFAULT_CONFIRMATION_EMAIL_SUBJECT,
          body: DEFAULT_CONFIRMATION_EMAIL_BODY,
        },
        defaultConfirmation: {
          subject: DEFAULT_CONFIRMATION_EMAIL_SUBJECT,
          body: DEFAULT_CONFIRMATION_EMAIL_BODY,
        },
        rejectionSubject: null,
        rejectionBody: null,
        effectiveRejection: { subject: DEFAULT_REJECTION_EMAIL_SUBJECT, body: DEFAULT_REJECTION_EMAIL_BODY },
        defaultRejection: { subject: DEFAULT_REJECTION_EMAIL_SUBJECT, body: DEFAULT_REJECTION_EMAIL_BODY },
        sender: { source: "console", fromAddress: "", delivers: false },
      },
    });
  });

  test("switch the site on, make it internal, and keep what was typed in its normal form", async () => {
    const patch = {
      siteEnabled: true,
      siteVisibility: "internal",
      siteTitle: "  Careers at Sunwise ",
      siteHeadline: " Build with us ",
      siteIntro: "Line one\r\nLine two\n",
      websiteUrl: "sunwise.example",
      privacyPolicyUrl: "https://sunwise.example/privacy",
      accentColor: " #0F9 ",
      allowIndexing: false,
    };
    const saved = await call<SettingsDto>("PATCH", "/recruiting/settings", patch);
    assert.equal(saved.status, 200);
    const { site } = saved.body;
    assert.equal(site.enabled, true);
    assert.equal(site.visibility, "internal");
    assert.equal(site.title, "Careers at Sunwise");
    assert.equal(site.effectiveTitle, "Careers at Sunwise");
    assert.equal(site.headline, "Build with us");
    assert.equal(site.intro, "Line one\nLine two");
    assert.equal(site.websiteUrl, "https://sunwise.example/");
    assert.equal(site.privacyPolicyUrl, "https://sunwise.example/privacy");
    assert.equal(site.accentColor, "#00ff99");
    assert.equal(site.allowIndexing, false);
    const [audit] = await auditFor("recruiting.settings.update");
    assert.deepEqual(JSON.parse(audit.metadataJson), { fields: Object.keys(patch) });
    assert.equal(audit.actorUserId, owner.id);

    // An empty website clears it; the rest stays.
    const cleared = await call<SettingsDto>("PATCH", "/recruiting/settings", { websiteUrl: "" });
    assert.equal(cleared.body.site.websiteUrl, "");
    assert.equal(cleared.body.site.accentColor, "#00ff99");
    const read = await call<SettingsDto>("GET", "/recruiting/settings");
    assert.deepEqual(read.body, cleared.body);
  });

  test("refuse what cannot be stored, naming the problem, and save nothing", async () => {
    const lines = Array.from({ length: 31 }, (_, index) => `Principle ${index + 1}`).join("\n");
    const service: Array<[Record<string, unknown>, number, string]> = [
      [{ siteEnabled: true, accentColor: "red" }, 400, "Pick the accent as a hex color, like #4f46e5."],
      [{ websiteUrl: "not a url" }, 400, "The website must be a web address, like https://example.com."],
      [
        { privacyPolicyUrl: "ftp://files.example/privacy" },
        400,
        "The privacy policy must be a web address, like https://example.com.",
      ],
      [{ screenerEmployeeId: stranger.id }, 404, "AI Employee not found"],
      [{ screeningInstructions: lines }, 400, "Keep it to 30 instructions or fewer, one per line."],
      [{ confirmationEmailSubject: "   " }, 400, "The confirmation email needs a subject."],
      [{ rejectionEmailSubject: "x".repeat(201) }, 400, "Keep the subject under 200 characters."],
      [{ rejectionEmailBody: "Hi\u0007there" }, 400, "The email can only contain printable characters."],
    ];
    for (const [body, status, error] of service) {
      const response = await call("PATCH", "/recruiting/settings", body);
      assert.equal(response.status, status, JSON.stringify(body));
      assert.deepEqual(response.body, { error }, JSON.stringify(body));
    }
    const boundary: unknown[] = [
      {},
      { siteVisibility: "secret" },
      { siteEnabled: "yes" },
      { accentColor: "#" + "0".repeat(20) },
      { screenerEmployeeId: "iris" },
      { customDomain: DOMAIN },
    ];
    for (const body of boundary) {
      const response = await call("PATCH", "/recruiting/settings", body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.body.error, "ValidationError", JSON.stringify(body));
    }
    const empty = await call("PATCH", "/recruiting/settings", {});
    assert.equal(empty.body.issues?.[0]?.message, "At least one change is required");

    const read = await call<SettingsDto>("GET", "/recruiting/settings");
    assert.equal(read.body.site.enabled, false, "a refused change saves none of its fields");
    assert.equal(read.body.site.accentColor, "#4f46e5");
    assert.equal(read.body.screening.screener, null);
    assert.equal(read.body.emails.rejectionSubject, null);
    assert.equal((await auditFor("recruiting.settings.update")).length, 0);
  });

  test("appoint the screener and the company's own principles; null follows the default, empty is a choice", async () => {
    const patch = (body: Record<string, unknown>) => call<SettingsDto>("PATCH", "/recruiting/settings", body);
    const appointed = await patch({
      screenerEmployeeId: iris.id,
      autoScreen: false,
      screeningInstructions: "- Judge the work, not the path.  \r\n- Ignore gaps.\n\n",
    });
    assert.equal(appointed.status, 200);
    assert.deepEqual(appointed.body.screening.screener, {
      id: iris.id,
      name: "Iris",
      slug: "settings-iris",
      role: "Recruiter",
      avatarKey: null,
    });
    assert.equal(appointed.body.screening.autoScreen, false);
    assert.equal(appointed.body.screening.instructions, "- Judge the work, not the path.\n- Ignore gaps.");
    assert.equal(
      appointed.body.screening.effectiveInstructions,
      "- Judge the work, not the path.\n- Ignore gaps.",
    );

    const none = await patch({ screeningInstructions: "" });
    assert.equal(none.body.screening.instructions, "");
    assert.equal(none.body.screening.effectiveInstructions, "");

    const reset = await patch({ screeningInstructions: null, screenerEmployeeId: null });
    assert.equal(reset.body.screening.instructions, null);
    assert.equal(reset.body.screening.effectiveInstructions, DEFAULT_SCREENING_INSTRUCTIONS);
    assert.equal(reset.body.screening.screener, null);
  });

  test("keep the company's own email templates, which a rejection a person chooses to send then uses", async () => {
    const saved = await call<SettingsDto>("PATCH", "/recruiting/settings", {
      confirmationEmailEnabled: false,
      rejectionEmailSubject: "About {{opening_title}} at {{company_name}}",
      rejectionEmailBody: "Dear {{first_name}},\r\n\r\nWe will not move forward.\r\n",
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.emails.confirmationEnabled, false);
    assert.equal(saved.body.emails.rejectionSubject, "About {{opening_title}} at {{company_name}}");
    assert.equal(saved.body.emails.rejectionBody, "Dear {{first_name}},\n\nWe will not move forward.\n");
    assert.deepEqual(saved.body.emails.effectiveRejection, {
      subject: "About {{opening_title}} at {{company_name}}",
      body: "Dear {{first_name}},\n\nWe will not move forward.\n",
    });
    assert.deepEqual(saved.body.emails.effectiveConfirmation, {
      subject: DEFAULT_CONFIRMATION_EMAIL_SUBJECT,
      body: DEFAULT_CONFIRMATION_EMAIL_BODY,
    });

    const opening = await createOpening(
      company.id,
      { title: "Staff Engineer", description: DESCRIPTION },
      { kind: "member", userId: owner.id },
    );
    const ada = await addApplication({
      companyId: company.id,
      openingId: opening.id,
      input: { name: "Ada Lovelace", email: "ada@example.com" },
      file: null,
      source: "manual",
      actor: { kind: "member", userId: owner.id },
    });
    const { log } = console;
    console.log = () => undefined;
    try {
      const rejected = await call("POST", `/recruiting/applications/${ada.id}/move`, {
        stage: "rejected",
        notifyCandidate: true,
      });
      assert.equal(rejected.status, 200);
    } finally {
      console.log = log;
    }
    const [sent] = await AppDataSource.getRepository(EmailLog).find();
    assert.equal(sent.subject, "About Staff Engineer at Sunwise");
    assert.equal(sent.bodyPreview, "Dear Ada,\n\nWe will not move forward.\n");

    const restored = await call<SettingsDto>("PATCH", "/recruiting/settings", {
      rejectionEmailSubject: null,
      rejectionEmailBody: null,
    });
    assert.deepEqual(restored.body.emails.effectiveRejection, {
      subject: DEFAULT_REJECTION_EMAIL_SUBJECT,
      body: DEFAULT_REJECTION_EMAIL_BODY,
    });
  });
});

describe("the careers site logo", () => {
  test("uploads a real image, serves it from a cache-busted path, and replaces the old file", async () => {
    const first = await uploadLogo(PNG);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.match(first.body.site.logoUrl ?? "", /^\/api\/careers\/sites\/settings-sunwise\/logo\?v=[0-9a-f]{8}$/);
    const [png] = filesIn(siteDir());
    assert.match(png, /^[0-9a-f-]{36}\.png$/);
    assert.deepEqual(fs.readFileSync(path.join(siteDir(), png)), PNG);
    assert.equal((await settingsRow())?.logoKey, png);
    assert.equal((await auditFor("recruiting.logo.upload")).length, 1);

    const second = await uploadLogo(GIF, { name: "logo.gif", type: "image/gif" });
    assert.equal(second.status, 200);
    assert.notEqual(second.body.site.logoUrl, first.body.site.logoUrl);
    const files = filesIn(siteDir());
    assert.equal(files.length, 1, "the old logo is gone");
    assert.match(files[0], /\.gif$/);
    assert.deepEqual(fs.readFileSync(path.join(siteDir(), files[0])), GIF);
  });

  test("removes the logo and its file", async () => {
    await uploadLogo(PNG);
    const removed = await call<SettingsDto>("DELETE", "/recruiting/settings/logo");
    assert.equal(removed.status, 200);
    assert.equal(removed.body.site.logoUrl, null);
    assert.deepEqual(filesIn(siteDir()), []);
    assert.equal((await settingsRow())?.logoKey, null);
    assert.equal((await auditFor("recruiting.logo.remove")).length, 1);
    // Removing it again is harmless.
    assert.equal((await call("DELETE", "/recruiting/settings/logo")).status, 200);
  });

  test("refuses an SVG, a missing file, a file over 2 MB and a file sent under another name", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const script = await uploadLogo(svg, { name: "logo.png", type: "image/png" });
    assert.equal(script.status, 400);
    assert.deepEqual(script.body, { error: "Upload the logo as a PNG, JPEG, GIF or WebP image." });

    const missing = await uploadLogo(null);
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.body, { error: "Choose an image to upload." });

    const huge = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    const tooBig = await uploadLogo(huge);
    assert.equal(tooBig.status, 413);
    assert.deepEqual(tooBig.body, { error: "Upload the logo as a PNG, JPEG, GIF or WebP image under 2 MB." });

    const wrongField = await uploadLogo(PNG, { field: "logo" });
    assert.equal(wrongField.status, 400);
    assert.deepEqual(wrongField.body, { error: "Upload the logo as a PNG, JPEG, GIF or WebP image under 2 MB." });

    assert.deepEqual(filesIn(siteDir()), []);
    assert.equal((await settingsRow())?.logoKey ?? null, null);
    assert.equal((await auditFor("recruiting.logo.upload")).length, 0);
  });
});

describe("a custom domain", () => {
  test("connects a domain as it was typed, and hands back the TXT record that proves it", async () => {
    const connected = await connect("https://Careers.Sunwise.Example:8443/jobs?ref=1");
    const { domain } = connected;
    assert.equal(domain.name, DOMAIN);
    assert.equal(domain.verifiedAt, null);
    assert.equal(domain.checkedAt, null);
    assert.equal(domain.error, "");
    assert.equal(domain.live, false);
    assert.equal(domain.cnameTarget, new URL(getPublicUrl()).hostname);
    assert.equal(domain.record?.type, "TXT");
    assert.equal(domain.record?.name, `_genosyn-careers.${DOMAIN}`);
    assert.match(domain.record?.value ?? "", /^genosyn-careers-verify=[0-9a-f]{32}$/);
    // Until it is verified the site's address stays on this install.
    assert.equal(connected.site.url, `${getPublicUrl()}/careers/settings-sunwise`);
    const [audit] = await auditFor("recruiting.domain.update");
    assert.equal(audit.targetLabel, DOMAIN);
    assert.deepEqual(JSON.parse(audit.metadataJson), { domain: DOMAIN });

    // The same domain again, however spelled, keeps its proof.
    const again = await connect(`${DOMAIN.toUpperCase()}.`);
    assert.equal(again.domain.record?.value, domain.record?.value);
  });

  test("refuses what is not a public domain name", async () => {
    const cases: Array<[unknown, string]> = [
      ["localhost", '"localhost" is not a domain name.'],
      ["jobs.localhost", "Use a public domain name, not localhost."],
      ["10.0.0.1", "Use a domain name, not an IP address."],
      ["careers", '"careers" is not a domain name.'],
      ["not a domain!", '"not a domain!" is not a domain name.'],
      ["-careers-.example", '"-careers-.example" is not a domain name.'],
    ];
    for (const [domain, error] of cases) {
      const response = await call("PUT", "/recruiting/settings/domain", { domain });
      assert.equal(response.status, 400, String(domain));
      assert.deepEqual(response.body, { error }, String(domain));
    }
    for (const body of [{ domain: 42 }, {}, { domain: DOMAIN, verify: true }, { domain: "x".repeat(301) }]) {
      const response = await call("PUT", "/recruiting/settings/domain", body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.body.error, "ValidationError");
    }
    assert.equal((await settingsRow())?.customDomain ?? null, null);
  });

  test("refuses a domain another company has proved is theirs", async () => {
    const theirs = await setCustomDomain(await ensureRecruitingSettings(otherCompany.id), DOMAIN);
    await AppDataSource.getRepository(RecruitingSettings).update(
      { id: theirs.id },
      { customDomainVerifiedAt: new Date() },
    );
    const taken = await call("PUT", "/recruiting/settings/domain", { domain: DOMAIN });
    assert.equal(taken.status, 409);
    assert.deepEqual(taken.body, { error: `${DOMAIN} is already connected to another company on this install.` });
    assert.equal((await settingsRow())?.customDomain ?? null, null);
    assert.equal((await settingsRow(otherCompany.id))?.customDomain, DOMAIN);
  });

  test("takes a domain another company only typed in, so nobody can squat a name they cannot prove", async () => {
    await setCustomDomain(await ensureRecruitingSettings(otherCompany.id), DOMAIN);
    const claimed = await call("PUT", "/recruiting/settings/domain", { domain: DOMAIN });
    assert.equal(claimed.status, 200);
    assert.equal((await settingsRow())?.customDomain, DOMAIN);
    assert.equal((await settingsRow(otherCompany.id))?.customDomain ?? null, null);
  });

  test("verifies the domain from its TXT record, and serves the site there only while it is on and public", async () => {
    await call("PATCH", "/recruiting/settings", { siteEnabled: true });
    const { domain } = await connect();
    const record = domain.record;
    assert.ok(record);
    const asked: string[] = [];
    const verified = await verifyWith({
      resolveTxt: async (name) => {
        asked.push(`TXT ${name}`);
        // DNS may split a long value into chunks; they are read joined.
        return [["v=spf1 -all"], [record.value.slice(0, 25), record.value.slice(25)]];
      },
      resolveCname: async (name) => {
        asked.push(`CNAME ${name}`);
        return [`${new URL(getPublicUrl()).hostname.toUpperCase()}.`];
      },
    });
    assert.equal(verified.status, 200);
    assert.deepEqual(asked, [`TXT ${record.name}`, `CNAME ${DOMAIN}`]);
    assert.deepEqual(verified.body.check, {
      verified: true,
      cnameTargets: [new URL(getPublicUrl()).hostname],
      pointsHere: true,
    });
    const settings = verified.body.settings;
    assert.ok(settings.domain.verifiedAt);
    assert.ok(settings.domain.checkedAt);
    assert.equal(settings.domain.error, "");
    assert.equal(settings.domain.live, true);
    assert.equal(settings.site.url, `http://${DOMAIN}`);
    assert.equal(careersCompanyForHost(DOMAIN), company.id);
    assert.equal(careersCompanyForHost(`${DOMAIN.toUpperCase()}:443`), company.id);
    assert.equal((await auditFor("recruiting.domain.verify")).length, 1);

    const patch = (body: Record<string, unknown>) => call<SettingsDto>("PATCH", "/recruiting/settings", body);
    // An internal site is for signed-in Members on the install's own address.
    assert.equal((await patch({ siteVisibility: "internal" })).body.domain.live, false);
    assert.equal(careersCompanyForHost(DOMAIN), null);
    assert.equal((await patch({ siteVisibility: "public" })).body.domain.live, true);
    assert.equal(careersCompanyForHost(DOMAIN), company.id);
    assert.equal((await patch({ siteEnabled: false })).body.domain.live, false);
    assert.equal(careersCompanyForHost(DOMAIN), null);
  });

  test("says what is missing when the record is not there, and keeps a verified domain through a bad DNS minute", async () => {
    await call("PATCH", "/recruiting/settings", { siteEnabled: true });
    const { domain } = await connect();
    const record = domain.record;
    assert.ok(record);

    const missing = await verifyWith({
      resolveTxt: async () => {
        throw dnsError("ENOTFOUND");
      },
      resolveCname: async () => {
        throw dnsError("ENODATA");
      },
    });
    assert.equal(missing.status, 200);
    assert.deepEqual(missing.body.check, { verified: false, cnameTargets: [], pointsHere: false });
    assert.equal(
      missing.body.settings.domain.error,
      `No TXT record at ${record.name} yet. DNS changes can take a few minutes to appear.`,
    );
    assert.equal(missing.body.settings.domain.verifiedAt, null);
    assert.ok(missing.body.settings.domain.checkedAt);
    assert.equal(missing.body.settings.domain.live, false);
    assert.equal(careersCompanyForHost(DOMAIN), null);

    const wrong = await verifyWith(fakeDns(async () => [["genosyn-careers-verify=not-the-token"]]));
    assert.equal(wrong.body.check.verified, false);
    assert.equal(
      wrong.body.settings.domain.error,
      `Found a TXT record at ${record.name}, but none of its values is ${record.value}. Check for a typo or an extra quote.`,
    );

    const failing = await verifyWith(
      fakeDns(async () => {
        throw dnsError("ESERVFAIL");
      }),
    );
    assert.equal(failing.body.check.verified, false);
    assert.equal(
      failing.body.settings.domain.error,
      `DNS lookup for ${record.name} failed (queryTxt ESERVFAIL ${DOMAIN}). Try again in a minute.`,
    );
    assert.equal((await auditFor("recruiting.domain.verify")).length, 0);

    const ok = await proven(record);
    const verifiedAt = ok.settings.domain.verifiedAt;
    assert.ok(verifiedAt);
    const hiccup = await verifyWith(
      fakeDns(async () => {
        throw dnsError("ENOTFOUND");
      }),
    );
    assert.equal(hiccup.body.check.verified, true, "a verified domain stays verified");
    assert.equal(hiccup.body.settings.domain.verifiedAt, verifiedAt);
    assert.equal(hiccup.body.settings.domain.live, true);
    assert.match(hiccup.body.settings.domain.error, /^No TXT record at /);
    assert.equal(careersCompanyForHost(DOMAIN), company.id);
  });

  test("changing the domain starts the proof over, and removing it clears everything", async () => {
    await call("PATCH", "/recruiting/settings", { siteEnabled: true });
    const first = await connect();
    assert.ok(first.domain.record);
    await proven(first.domain.record);
    assert.equal(careersCompanyForHost(DOMAIN), company.id);

    const moved = await connect("jobs.sunwise.example");
    assert.equal(moved.domain.name, "jobs.sunwise.example");
    assert.equal(moved.domain.verifiedAt, null);
    assert.equal(moved.domain.live, false);
    assert.notEqual(moved.domain.record?.value, first.domain.record.value);
    assert.equal(careersCompanyForHost(DOMAIN), null);
    assert.equal(careersCompanyForHost("jobs.sunwise.example"), null);

    const removed = await call<SettingsDto>("PUT", "/recruiting/settings/domain", { domain: null });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.domain, {
      name: null,
      verifiedAt: null,
      checkedAt: null,
      error: "",
      live: false,
      record: null,
      cnameTarget: new URL(getPublicUrl()).hostname,
    });
    const audits = await auditFor("recruiting.domain.update");
    assert.deepEqual(JSON.parse(audits.find((audit) => audit.targetLabel === "None")?.metadataJson ?? "{}"), {
      domain: null,
    });
  });

  test("needs a domain before checking one", async () => {
    setCareersDnsResolverForTests(
      fakeDns(async () => {
        throw new Error("DNS must not be asked");
      }),
    );
    const refused = await call("POST", "/recruiting/settings/domain/verify", {});
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body, { error: "Connect a domain before checking it." });
    await connect();
    const withBody = await call("POST", "/recruiting/settings/domain/verify", { force: true });
    assert.equal(withBody.status, 400);
    assert.equal(withBody.body.error, "ValidationError");
  });
});

describe("AI access", () => {
  test("lists every AI Employee by name with the access it holds, one level each", async () => {
    const empty = await call<{ rows: RecruitingGrantRow[] }>("GET", "/recruiting/ai-access");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.rows, [
      {
        employee: { id: iris.id, name: "Iris", slug: "settings-iris", role: "Recruiter", avatarKey: null },
        grant: null,
      },
      {
        employee: { id: otto.id, name: "Otto", slug: "settings-otto", role: "Recruiter", avatarKey: null },
        grant: null,
      },
    ]);

    type Grant = { id: string; companyId: string; employeeId: string; accessLevel: string };
    const granted = await call<Grant>("PUT", `/recruiting/ai-access/${iris.id}`, { accessLevel: "screen" });
    assert.equal(granted.status, 200);
    assert.equal(granted.body.companyId, company.id);
    assert.equal(granted.body.employeeId, iris.id);
    assert.equal(granted.body.accessLevel, "screen");

    const raised = await call<Grant>("PUT", `/recruiting/ai-access/${iris.id}`, { accessLevel: "hire" });
    assert.equal(raised.body.id, granted.body.id, "one Grant per AI Employee");
    assert.equal(raised.body.accessLevel, "hire");

    const listed = await call<{ rows: RecruitingGrantRow[] }>("GET", "/recruiting/ai-access");
    assert.equal(listed.body.rows[0].grant?.id, granted.body.id);
    assert.equal(listed.body.rows[0].grant?.accessLevel, "hire");
    assert.equal(listed.body.rows[1].grant, null);
    assert.equal(await AppDataSource.getRepository(EmployeeRecruitingGrant).count(), 1);
    const audits = await auditFor("recruiting.grant.upsert");
    assert.deepEqual(
      audits.map((audit) => JSON.parse(audit.metadataJson).accessLevel).sort(),
      ["hire", "screen"],
    );
  });

  test("removes a Grant, and answers 404 for one that is not there or is another company's", async () => {
    const grant = await upsertRecruitingGrant(company.id, iris.id, "read");
    const theirs = await upsertRecruitingGrant(otherCompany.id, stranger.id, "hire");

    // The removal names the Grant, never the AI Employee.
    const byEmployee = await call("DELETE", `/recruiting/ai-access/${iris.id}`);
    assert.equal(byEmployee.status, 404);
    assert.deepEqual(byEmployee.body, { error: "Recruiting Grant not found" });
    assert.equal((await call("DELETE", `/recruiting/ai-access/${theirs.id}`)).status, 404);
    assert.ok(await AppDataSource.getRepository(EmployeeRecruitingGrant).findOneBy({ id: theirs.id }));

    assert.equal((await call("DELETE", `/recruiting/ai-access/${grant.id}`)).status, 204);
    const listed = await call<{ rows: RecruitingGrantRow[] }>("GET", "/recruiting/ai-access");
    assert.equal(listed.body.rows[0].grant, null);
    assert.equal((await call("DELETE", `/recruiting/ai-access/${grant.id}`)).status, 404);
    assert.equal((await call("DELETE", "/recruiting/ai-access/not-a-uuid")).status, 400);
    const [audit] = await auditFor("recruiting.grant.delete");
    assert.equal(audit.targetId, grant.id);
  });

  test("refuses another company's AI Employee and a level that does not exist", async () => {
    const foreign = await call("PUT", `/recruiting/ai-access/${stranger.id}`, { accessLevel: "read" });
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.body, { error: "AI Employee not found" });
    for (const [route, body] of [
      [`/recruiting/ai-access/${iris.id}`, { accessLevel: "admin" }],
      [`/recruiting/ai-access/${iris.id}`, {}],
      [`/recruiting/ai-access/${iris.id}`, { accessLevel: "read", expires: "never" }],
      ["/recruiting/ai-access/not-a-uuid", { accessLevel: "read" }],
    ] as Array<[string, unknown]>) {
      assert.equal((await call("PUT", route, body)).status, 400, `${route} ${JSON.stringify(body)}`);
    }
    assert.equal(await AppDataSource.getRepository(EmployeeRecruitingGrant).count(), 0);
  });
});

describe("the overview", () => {
  test("counts what is open and waiting, lists the strongest still waiting, and says what setup is missing", async () => {
    const actor = { kind: "member" as const, userId: owner.id };
    const open = await publishOpening(
      company.id,
      (await createOpening(company.id, { title: "Staff Engineer", description: DESCRIPTION }, actor)).id,
    );
    await publishOpening(
      company.id,
      (await createOpening(company.id, { title: "Designer", description: DESCRIPTION }, actor)).id,
    );
    await createOpening(company.id, { title: "Writer" }, actor);
    const closed = await createOpening(company.id, { title: "Old role", description: DESCRIPTION }, actor);
    await publishOpening(company.id, closed.id);
    await closeOpening(company.id, closed.id);

    const day = 24 * 60 * 60 * 1000;
    const minute = 60 * 1000;
    const people: Array<{
      name: string;
      stage?: RecruitingApplication["stage"];
      score?: number;
      screenStatus?: RecruitingApplication["screenStatus"];
      ageMs?: number;
      stageAgeMs?: number;
    }> = [
      { name: "Ada Lovelace", score: 85 },
      { name: "Grace Hopper", score: 62 },
      { name: "Alan Turing", score: 40 },
      { name: "Linus Torvalds" },
      { name: "Margaret Hamilton", stage: "interview" },
      { name: "Barbara Liskov", stage: "offer" },
      { name: "Katherine Johnson", stage: "hired" },
      { name: "Frances Allen", stage: "screening", screenStatus: "failed" },
      { name: "Edsger Dijkstra", stage: "rejected", screenStatus: "failed" },
      { name: "Hedy Lamarr", screenStatus: "queued", ageMs: 10 * day },
      { name: "Dorothy Vaughan", stage: "hired", ageMs: 45 * day, stageAgeMs: 40 * day },
    ];
    const repo = AppDataSource.getRepository(RecruitingApplication);
    for (const [index, person] of people.entries()) {
      const row = await addApplication({
        companyId: company.id,
        openingId: open.id,
        input: { name: person.name, email: `${person.name.split(" ")[0].toLowerCase()}@example.com` },
        file: null,
        source: "manual",
        actor,
      });
      await repo.update(
        { id: row.id },
        {
          stage: person.stage ?? "applied",
          score: person.score ?? null,
          screenStatus: person.screenStatus ?? "none",
          createdAt: new Date(Date.now() - (person.ageMs ?? index * minute)),
          stageChangedAt: new Date(Date.now() - (person.stageAgeMs ?? 0)),
        },
      );
    }
    // Another company's applicants count for nobody here.
    const theirs = await createOpening(otherCompany.id, { title: "Theirs" }, { kind: "member", userId: outsider.id });
    await addApplication({
      companyId: otherCompany.id,
      openingId: theirs.id,
      input: { name: "Their Candidate", email: "them@example.com" },
      file: null,
      source: "manual",
      actor: { kind: "member", userId: outsider.id },
    });
    await repo.update({ companyId: otherCompany.id }, { score: 99 });

    actingUserId = member.id;
    const overview = await call<Overview>("GET", "/recruiting/overview");
    assert.equal(overview.status, 200);
    assert.deepEqual(overview.body.counts, {
      openOpenings: 2,
      draftOpenings: 1,
      newThisWeek: 9,
      awaitingReview: 5,
      interviewing: 1,
      offers: 1,
      hiredThisMonth: 1,
      screening: 1,
      failedScreens: 1,
    });
    assert.deepEqual(
      overview.body.topMatches.map((row) => [row.candidateName, row.score]),
      [
        ["Ada Lovelace", 85],
        ["Grace Hopper", 62],
      ],
    );
    assert.deepEqual(
      overview.body.recent.map((row) => row.candidateName),
      people.slice(0, 8).map((person) => person.name),
    );
    assert.deepEqual(overview.body.setup, {
      siteEnabled: false,
      siteUrl: `${getPublicUrl()}/careers/settings-sunwise`,
      siteVisibility: "public",
      customDomain: null,
      customDomainLive: false,
      screenerAppointed: false,
      autoScreen: true,
      emailDelivers: false,
      hasOpenOpening: true,
    });

    actingUserId = owner.id;
    await call("PATCH", "/recruiting/settings", {
      siteEnabled: true,
      siteVisibility: "internal",
      screenerEmployeeId: iris.id,
      autoScreen: false,
    });
    await connect();
    const after = await call<Overview>("GET", "/recruiting/overview");
    assert.deepEqual(after.body.setup, {
      siteEnabled: true,
      siteUrl: `${getPublicUrl()}/careers/settings-sunwise`,
      siteVisibility: "internal",
      customDomain: DOMAIN,
      customDomainLive: false,
      screenerAppointed: true,
      autoScreen: false,
      emailDelivers: false,
      hasOpenOpening: true,
    });
  });

  test("reads as empty for a company that has not started", async () => {
    const overview = await call<Overview>("GET", "/recruiting/overview");
    assert.equal(overview.status, 200);
    assert.ok(Object.values(overview.body.counts).every((count) => count === 0));
    assert.deepEqual(overview.body.topMatches, []);
    assert.deepEqual(overview.body.recent, []);
    assert.equal(overview.body.setup.hasOpenOpening, false);
    // Reading the overview sets nothing up.
    assert.equal(await settingsRow(), null);
  });
});
