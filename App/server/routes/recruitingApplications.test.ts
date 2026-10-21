import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";
import { PDFDocument, StandardFonts } from "pdf-lib";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { RecruitingApplication } from "../db/entities/RecruitingApplication.js";
import { RecruitingApplicationEvent } from "../db/entities/RecruitingApplicationEvent.js";
import type { RecruitingOpening } from "../db/entities/RecruitingOpening.js";
import { RecruitingScorecard } from "../db/entities/RecruitingScorecard.js";
import { RecruitingSettings } from "../db/entities/RecruitingSettings.js";
import { User } from "../db/entities/User.js";
import { ResourceChangeSubscriber } from "../db/subscribers/resourceChangeSubscriber.js";
import { errorHandler } from "../middleware/error.js";
import { securityHeaders } from "../middleware/httpSecurity.js";
import {
  addApplication,
  submitApplication,
  type ApplicationDetail,
  type ApplicationSummary,
  type PublicApplicationInput,
  type UploadedResume,
} from "../services/recruiting/applications.js";
import { RESUME_TYPE_HINT } from "../services/recruiting/files.js";
import { createOpening, publishOpening, updateOpening } from "../services/recruiting/openings.js";
import { setScreenRunnerForTests, type ScreenRunnerArgs } from "../services/recruiting/screening.js";
import {
  runScreeningQueueOnce,
  setScreeningAutoKickForTests,
} from "../services/recruiting/screeningQueue.js";
import { registerResourceChangeSink } from "../services/resourceEvents.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { recruitingRouter } from "./recruiting.js";

/**
 * Applications through the signed-in Member API (`/api/companies/:cid/
 * recruiting/applications`), on the real router behind the App's own security
 * headers, with resumes on disk under a throwaway data directory.
 *
 * What this pins, and why it matters:
 *  - Who reaches an Application. Any Member works them — reads, moves, notes,
 *    scores, asks for a screen — and only owners and admins erase one. An
 *    Application id from another company is simply not there.
 *  - The list: its filters, sorts and search, and that it never carries the
 *    resume, cover letter or answers a list has no need for.
 *  - The record: every move, note, Scorecard and email lands on the timeline.
 *    The rejection email goes only when a person chooses it, uses the
 *    company's template and never the reason, and without an email provider it
 *    is logged as `skipped` rather than pretended sent.
 *  - Scorecards: the server computes the score from the ratings — nobody types
 *    a number — and every quote is checked against what the candidate wrote.
 *  - Screening on request: the Application is queued, and the screener scores
 *    it later from the blinded text (the model call is faked).
 *  - Resumes: a PDF opens inline as a PDF; anything else, and any explicit
 *    download, is an inert attachment under a sandbox; the browser is never
 *    allowed to sniff; and the file name in the header is safe whatever the
 *    applicant called the file.
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
let opening: RecruitingOpening;
let designer: RecruitingOpening;
let theirOpening: RecruitingOpening;

const DESCRIPTION =
  "You will run the billing service, mentor two engineers, and own our TypeScript platform from end to end.";

const RESUME_TEXT = [
  "Ada Lovelace — ada@example.com — +44 20 7946 0958",
  "Ada led the migration of the billing service to TypeScript in 2023.",
  "She mentors four engineers and writes JavaScript daily.",
].join("\n");

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-recruiting-applications-"));
  mutableConfig.dataDir = path.join(root, "data");
  setScreeningAutoKickForTests(false);
  await initTestDb();
  AppDataSource.subscribers.push(new ResourceChangeSubscriber());
  const app = express();
  // The App's own order (`server/index.ts`): security headers, then the parser.
  app.use(securityHeaders);
  app.use(express.json({ limit: "1mb" }));
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
  setScreenRunnerForTests(null);
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
  setScreenRunnerForTests(null);
  fs.rmSync(mutableConfig.dataDir, { recursive: true, force: true });
  const user = (email: string, name: string) =>
    insert(User, { email, name, passwordHash: "x", sessionVersion: 0 });
  owner = await user("applications-owner@example.test", "Owner");
  admin = await user("applications-admin@example.test", "Admin");
  member = await user("applications-member@example.test", "Member");
  outsider = await user("applications-outsider@example.test", "Outsider");
  company = await insert(Company, { name: "Sunwise", slug: "applications-sunwise", ownerId: owner.id });
  otherCompany = await insert(Company, {
    name: "Other",
    slug: "applications-other",
    ownerId: outsider.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: admin.id, role: "admin" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  await insert(Membership, { companyId: otherCompany.id, userId: outsider.id, role: "owner" });
  iris = await insert(AIEmployee, {
    companyId: company.id,
    name: "Iris",
    slug: "applications-iris",
    role: "Recruiter",
    soulBody: "",
  });
  // Connected only so model resolution passes; the screen itself is faked.
  await insert(AIModel, {
    employeeId: iris.id,
    provider: "openai",
    model: "gpt-4.1-mini",
    authMode: "apikey",
    isActive: true,
    configJson: JSON.stringify({ apiKeyEncrypted: "encrypted-test-api-key" }),
    connectedAt: new Date(),
  });
  const byOwner = { kind: "member" as const, userId: owner.id };
  opening = await publishOpening(
    company.id,
    (
      await createOpening(
        company.id,
        {
          title: "Staff Engineer",
          description: DESCRIPTION,
          criteria: [
            { name: "TypeScript", importance: "must_have", description: "Ships production TypeScript." },
            { name: "Mentoring", importance: "important" },
            { name: "Design", importance: "nice_to_have" },
          ],
          questions: [{ label: "Years of TypeScript?", kind: "number" }],
          form: { resume: "optional" },
        },
        byOwner,
      )
    ).id,
  );
  designer = await publishOpening(
    company.id,
    (await createOpening(company.id, { title: "Designer", description: DESCRIPTION, form: { resume: "optional" } }, byOwner)).id,
  );
  theirOpening = await publishOpening(
    otherCompany.id,
    (
      await createOpening(
        otherCompany.id,
        { title: "Their role", description: DESCRIPTION, form: { resume: "optional" } },
        { kind: "member", userId: outsider.id },
      )
    ).id,
  );
  actingUserId = owner.id;
});

type Issue = { path: Array<string | number>; message: string };
type ApiError = { error: string; issues?: Issue[]; fields?: Record<string, string> };
type Reply<T> = { status: number; body: T };
type List = { rows: ApplicationSummary[]; total: number };
type Moved = { application: ApplicationDetail; email: { status: string; error: string } | null };

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

async function download(applicationId: string, query = ""): Promise<Response> {
  return fetch(
    `${baseUrl}/api/companies/${company.id}/recruiting/applications/${applicationId}/resume${query}`,
  );
}

/** The status of a resume request, with its body read so nothing is left open. */
async function downloadStatus(applicationId: string, query = ""): Promise<number> {
  const response = await download(applicationId, query);
  await response.arrayBuffer();
  return response.status;
}

/** Someone applying on the careers site, through the same service the public route uses. */
async function apply(
  values: Partial<PublicApplicationInput> & { name: string; email: string },
  file: UploadedResume | null = null,
  target: RecruitingOpening = opening,
): Promise<RecruitingApplication> {
  const { application } = await submitApplication({
    opening: target,
    input: { consent: true, clientSubmissionId: randomUUID(), ...values },
    file,
    source: "careers_site",
  });
  return application;
}

/** Someone a Member typed in, with pasted resume text. */
async function addByHand(name: string, email: string, resumeText?: string, target = opening) {
  return addApplication({
    companyId: target.companyId,
    openingId: target.id,
    input: { name, email },
    file: null,
    resumeText,
    source: "manual",
    actor: { kind: "member", userId: owner.id },
  });
}

async function pdfResume(lines: string[]): Promise<Buffer> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  lines.forEach((line, index) => page.drawText(line, { x: 48, y: 740 - index * 18, size: 12, font }));
  return Buffer.from(await document.save());
}

function blob(bytes: Uint8Array, type: string): Blob {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Blob([copy], { type });
}

async function addByForm(
  fields: Record<string, string>,
  file?: { bytes: Uint8Array; name: string; type: string },
  openingId = opening.id,
): Promise<Reply<ApplicationDetail & ApiError>> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  if (file) form.append("resume", blob(file.bytes, file.type), file.name);
  const response = await fetch(
    `${baseUrl}/api/companies/${company.id}/recruiting/openings/${openingId}/applications`,
    { method: "POST", body: form },
  );
  return { status: response.status, body: JSON.parse(await response.text()) };
}

function resumesDir(companyId = company.id): string {
  return path.join(mutableConfig.dataDir, ".private", "recruiting", companyId, "resumes");
}

function filesIn(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

async function detailOf(applicationId: string): Promise<ApplicationDetail> {
  const read = await call<ApplicationDetail>("GET", `/recruiting/applications/${applicationId}`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  return read.body;
}

async function rowOf(applicationId: string): Promise<RecruitingApplication | null> {
  return AppDataSource.getRepository(RecruitingApplication).findOneBy({ id: applicationId });
}

async function auditFor(action: string): Promise<AuditEvent[]> {
  return AppDataSource.getRepository(AuditEvent).find({ where: { companyId: company.id, action } });
}

async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
  // Generous, for `npm test` running many files at once on a busy machine.
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${what} never happened`);
}

/** The console email transport prints every message; keep the test output readable. */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const { log, warn } = console;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    return await work();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

function criterionId(name: string): string {
  const criteria = JSON.parse(opening.criteriaJson) as Array<{ id: string; name: string }>;
  const found = criteria.find((criterion) => criterion.name === name);
  assert.ok(found, `criterion ${name}`);
  return found.id;
}

const textResume = (text = RESUME_TEXT, originalname = "ada-lovelace.txt"): UploadedResume => ({
  buffer: Buffer.from(text, "utf8"),
  originalname,
});

describe("who may work Applications", () => {
  function routesFor(applicationId: string, openingId: string): Array<[string, string, unknown?]> {
    return [
      ["GET", "/recruiting/applications"],
      ["GET", `/recruiting/applications/${applicationId}`],
      ["POST", `/recruiting/applications/${applicationId}/move`, { stage: "interview" }],
      ["POST", `/recruiting/applications/${applicationId}/notes`, { body: "Hello" }],
      [
        "POST",
        `/recruiting/applications/${applicationId}/scorecards`,
        { ratings: [{ criterionId: "typescript", rating: 1 }] },
      ],
      ["POST", `/recruiting/applications/${applicationId}/screen`, {}],
      ["GET", `/recruiting/applications/${applicationId}/resume`],
      ["DELETE", `/recruiting/applications/${applicationId}`],
      ["POST", `/recruiting/openings/${openingId}/applications`, { name: "Spy", email: "spy@example.com" }],
    ];
  }

  test("a Member reads, moves, notes, scores and re-screens, but only an admin or the owner erases", async () => {
    await insert(RecruitingSettings, { companyId: company.id, screenerEmployeeId: iris.id });
    const ada = await apply({ name: "Ada Lovelace", email: "ada@example.com" }, textResume());
    const grace = await apply({ name: "Grace Hopper", email: "grace@example.com" });

    actingUserId = member.id;
    assert.equal((await call<List>("GET", "/recruiting/applications")).body.total, 2);
    assert.equal((await call("GET", `/recruiting/applications/${ada.id}`)).status, 200);
    assert.equal((await call("POST", `/recruiting/applications/${ada.id}/move`, { stage: "screening" })).status, 200);
    assert.equal((await call("POST", `/recruiting/applications/${ada.id}/notes`, { body: "Promising." })).status, 201);
    const scored = await call("POST", `/recruiting/applications/${ada.id}/scorecards`, {
      ratings: [{ criterionId: criterionId("TypeScript"), rating: 2 }],
    });
    assert.equal(scored.status, 201);
    assert.equal((await call("POST", `/recruiting/applications/${ada.id}/screen`, {})).status, 200);
    assert.equal(await downloadStatus(ada.id, "?download=1"), 200);

    const refused = await call("DELETE", `/recruiting/applications/${ada.id}`);
    assert.equal(refused.status, 403);
    assert.deepEqual(refused.body, { error: "admin company role required" });
    assert.ok(await rowOf(ada.id));

    actingUserId = admin.id;
    assert.equal((await call("DELETE", `/recruiting/applications/${ada.id}`)).status, 204);
    actingUserId = owner.id;
    assert.equal((await call("DELETE", `/recruiting/applications/${grace.id}`)).status, 204);
    assert.equal(await AppDataSource.getRepository(RecruitingApplication).count(), 0);
  });

  test("another company's owner reaches none of it, and nor does a signed-out request", async () => {
    const ada = await apply({ name: "Ada Lovelace", email: "ada@example.com" }, textResume());
    for (const [userId, status] of [
      [outsider.id, 403],
      [null, 401],
    ] as Array<[string | null, number]>) {
      actingUserId = userId;
      for (const [method, route, body] of routesFor(ada.id, opening.id)) {
        const response = await call(method, route, body);
        assert.equal(response.status, status, `${userId ? "outsider" : "signed out"}: ${method} ${route}`);
      }
    }
    const row = await rowOf(ada.id);
    assert.equal(row?.stage, "applied");
    assert.equal(await AppDataSource.getRepository(RecruitingApplication).count(), 1);
    assert.equal(await AppDataSource.getRepository(RecruitingApplicationEvent).count(), 1);
    assert.equal(await AppDataSource.getRepository(RecruitingScorecard).count(), 0);
    assert.equal(filesIn(resumesDir()).length, 1);
  });

  test("an Application id from another company is not found here, and stays as it was", async () => {
    const theirs = await apply({ name: "Their Candidate", email: "them@example.com" }, textResume(), theirOpening);
    for (const [method, route, body] of routesFor(theirs.id, theirOpening.id)) {
      const response = await call(method, route, body);
      if (route === "/recruiting/applications") {
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, { rows: [], total: 0 });
        continue;
      }
      assert.equal(response.status, 404, `${method} ${route}`);
      assert.match(response.body.error, /^(Application|Opening) not found$/, `${method} ${route}`);
    }
    const filtered = await call<List>("GET", `/recruiting/applications?openingId=${theirOpening.id}`);
    assert.deepEqual(filtered.body, { rows: [], total: 0 });

    const row = await rowOf(theirs.id);
    assert.equal(row?.stage, "applied");
    assert.equal(row?.screenStatus, "none");
    assert.equal(await AppDataSource.getRepository(RecruitingApplicationEvent).count(), 1);
    assert.equal(await AppDataSource.getRepository(RecruitingScorecard).count(), 0);
    assert.equal(filesIn(resumesDir(otherCompany.id)).length, 1);
    assert.equal(await AppDataSource.getRepository(RecruitingApplication).count(), 1);
  });

  test("the same person's other Applications never reach into another company", async () => {
    const ada = await apply({ name: "Ada Lovelace", email: "ada@example.com" });
    const again = await apply({ name: "Ada Lovelace", email: "ADA@example.com" }, null, designer);
    await apply({ name: "Ada Lovelace", email: "ada@example.com" }, null, theirOpening);
    const detail = await detailOf(ada.id);
    assert.deepEqual(
      detail.otherApplications.map(({ id, openingTitle, stage }) => ({ id, openingTitle, stage })),
      [{ id: again.id, openingTitle: "Designer", stage: "applied" }],
    );
  });
});

describe("listing Applications", () => {
  async function names(query: string): Promise<string[]> {
    const list = await call<List>("GET", `/recruiting/applications${query}`);
    assert.equal(list.status, 200, `${query}: ${JSON.stringify(list.body)}`);
    return list.body.rows.map((row) => row.candidateName);
  }

  async function seed() {
    const repo = AppDataSource.getRepository(RecruitingApplication);
    const hour = 60 * 60 * 1000;
    const people = [
      { name: "Ada Lovelace", email: "ada@example.com", stage: "applied", score: 55, at: 5 },
      { name: "Grace Hopper", email: "grace.hopper@navy.example", stage: "interview", score: 90, at: 4 },
      { name: "Alan Turing", email: "alan@example.com", stage: "rejected", score: null, at: 3 },
      { name: "Linus Torvalds", email: "linus@example.com", stage: "hired", score: 70, at: 2 },
    ] as const;
    const made = [];
    for (const person of people) {
      const row = await apply({ name: person.name, email: person.email });
      await repo.update(
        { id: row.id },
        { stage: person.stage, score: person.score, createdAt: new Date(Date.now() - person.at * hour) },
      );
      made.push(row);
    }
    const margaret = await apply({ name: "Margaret Hamilton", email: "margaret@example.com" }, null, designer);
    await repo.update(
      { id: margaret.id },
      { stage: "screening", screenStatus: "queued", createdAt: new Date(Date.now() - hour) },
    );
    return { made, margaret };
  }

  test("filters by Opening, stage and screen status, and pages with a total", async () => {
    await seed();
    const sorted = async (query: string) => (await names(query)).sort();
    assert.equal((await names("")).length, 5);
    assert.deepEqual(await sorted(`?openingId=${designer.id}`), ["Margaret Hamilton"]);
    assert.deepEqual(await sorted("?stage=active"), ["Ada Lovelace", "Grace Hopper", "Margaret Hamilton"]);
    assert.deepEqual(await sorted("?stage=rejected"), ["Alan Turing"]);
    assert.deepEqual(await sorted("?stage=hired"), ["Linus Torvalds"]);
    assert.deepEqual(await sorted("?screenStatus=queued"), ["Margaret Hamilton"]);
    assert.deepEqual(await sorted(`?openingId=${opening.id}&stage=active`), ["Ada Lovelace", "Grace Hopper"]);

    const page = await call<List>("GET", "/recruiting/applications?limit=2");
    assert.equal(page.body.rows.length, 2);
    assert.equal(page.body.total, 5);
    const last = await call<List>("GET", "/recruiting/applications?limit=2&offset=4");
    assert.equal(last.body.rows.length, 1);
    assert.equal(last.body.total, 5);
  });

  test("sorts newest first, oldest first on request, or by score with the unscored last", async () => {
    await seed();
    assert.deepEqual(await names(`?openingId=${opening.id}`), [
      "Linus Torvalds",
      "Alan Turing",
      "Grace Hopper",
      "Ada Lovelace",
    ]);
    assert.deepEqual(await names(`?openingId=${opening.id}&sort=oldest`), [
      "Ada Lovelace",
      "Grace Hopper",
      "Alan Turing",
      "Linus Torvalds",
    ]);
    assert.deepEqual(await names(`?openingId=${opening.id}&sort=score`), [
      "Grace Hopper",
      "Linus Torvalds",
      "Ada Lovelace",
      "Alan Turing",
    ]);
  });

  test("searches names whatever their case, and email addresses", async () => {
    await seed();
    assert.deepEqual(await names("?q=ada"), ["Ada Lovelace"]);
    assert.deepEqual(await names("?q=LOVELACE"), ["Ada Lovelace"]);
    assert.deepEqual(await names(`?q=${encodeURIComponent("  hopper ")}`), ["Grace Hopper"]);
    assert.deepEqual(await names("?q=navy.example"), ["Grace Hopper"]);
    assert.deepEqual(await names("?q=nobody"), []);
  });

  test("finds an email address that has an underscore in it", async () => {
    await apply({ name: "Jane Doe", email: "jane_doe@example.com" });
    await apply({ name: "John Smith", email: "janedoe@example.com" });
    // Pasting the address from the candidate's email must find exactly them.
    assert.deepEqual(await names(`?q=${encodeURIComponent("jane_doe@example.com")}`), ["Jane Doe"]);
  });

  test("finds a name that starts with a non-ASCII capital, typed as it is written", async () => {
    await apply({ name: "Émile Zola", email: "emile@example.com" });
    await apply({ name: "Øyvind Berg", email: "oyvind@example.com" });
    assert.deepEqual(await names(`?q=${encodeURIComponent("Émile")}`), ["Émile Zola"]);
    assert.deepEqual(await names(`?q=${encodeURIComponent("Øyvind")}`), ["Øyvind Berg"]);
  });

  test("leaves the resume, the cover letter and the answers out of the list", async () => {
    await apply(
      { name: "Ada Lovelace", email: "ada@example.com", coverLetter: "Dear team", phone: "+1 415 555 0100" },
      textResume(),
    );
    const list = await call<List>("GET", "/recruiting/applications");
    const [row] = list.body.rows;
    assert.equal(row.hasResume, true);
    assert.equal(row.opening?.title, "Staff Engineer");
    for (const key of ["resumeText", "coverLetter", "answers", "candidatePhone", "resume"]) {
      assert.equal(key in row, false, key);
    }
  });

  test("refuses a query the schema does not describe", async () => {
    for (const query of [
      "?sort=random",
      "?limit=0",
      "?limit=201",
      "?offset=-1",
      "?stage=archived",
      "?openingId=abc",
      "?screenStatus=done",
      "?minScore=60",
      "?unknown=1",
    ]) {
      const response = await call("GET", `/recruiting/applications${query}`);
      assert.equal(response.status, 400, query);
      assert.equal(response.body.error, "ValidationError", query);
    }
  });
});

describe("reading one Application", () => {
  test("tells its whole story: answers, resume details, Scorecards and the timeline in order", async () => {
    const [question] = JSON.parse(opening.questionsJson) as Array<{ id: string }>;
    const bytes = Buffer.from(RESUME_TEXT, "utf8");
    const ada = await apply(
      {
        name: "Ada Lovelace",
        email: "ada@example.com",
        coverLetter: "I would love to own the billing service.",
        answers: { [question.id]: "7" },
      },
      { buffer: bytes, originalname: "ada-lovelace.txt" },
    );
    actingUserId = member.id;
    await call("POST", `/recruiting/applications/${ada.id}/notes`, { body: "Strong portfolio." });
    await call("POST", `/recruiting/applications/${ada.id}/move`, { stage: "screening" });
    await call("POST", `/recruiting/applications/${ada.id}/scorecards`, {
      ratings: [{ criterionId: criterionId("TypeScript"), rating: 3 }],
      summary: "Clearly meets the TypeScript bar.",
    });

    const detail = await detailOf(ada.id);
    assert.equal(detail.candidateName, "Ada Lovelace");
    assert.equal(detail.candidateEmail, "ada@example.com");
    assert.equal(detail.source, "careers_site");
    assert.ok(detail.consentAt);
    assert.equal(detail.stage, "screening");
    assert.equal(detail.stageLabel, "Screening");
    assert.equal(detail.coverLetter, "I would love to own the billing service.");
    assert.deepEqual(detail.answers, [
      { questionId: question.id, label: "Years of TypeScript?", kind: "number", value: 7 },
    ]);
    assert.equal(detail.hasResume, true);
    assert.deepEqual(detail.resume, {
      fileName: "ada-lovelace.txt",
      mimeType: "text/plain; charset=utf-8",
      size: bytes.length,
    });
    assert.equal(detail.resumeTextStatus, "extracted");
    assert.match(detail.resumeText, /billing service to TypeScript/);
    assert.equal(detail.openingDetail.title, "Staff Engineer");
    assert.deepEqual(
      detail.openingDetail.criteria.map((criterion) => criterion.name),
      ["TypeScript", "Mentoring", "Design"],
    );
    assert.equal(detail.screener, null);
    assert.equal(detail.scorecards.length, 1);
    assert.equal(detail.scorecards[0].summary, "Clearly meets the TypeScript bar.");
    assert.deepEqual(
      detail.timeline.map(({ kind, actorKind, actorName }) => ({ kind, actorKind, actorName })),
      [
        { kind: "applied", actorKind: "candidate", actorName: "Ada Lovelace" },
        { kind: "note", actorKind: "member", actorName: "Member" },
        { kind: "stage_changed", actorKind: "member", actorName: "Member" },
        { kind: "scored", actorKind: "member", actorName: "Member" },
      ],
    );
    assert.deepEqual(detail.otherApplications, []);
  });

  test("says when there is no resume, and an unknown or malformed id is refused", async () => {
    const alan = await addByHand("Alan Turing", "alan@example.com");
    const detail = await detailOf(alan.id);
    assert.equal(detail.resume, null);
    assert.equal(detail.hasResume, false);
    assert.equal(detail.resumeTextStatus, "none");
    assert.equal(detail.source, "manual");

    const missing = await call("GET", `/recruiting/applications/${randomUUID()}`);
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: "Application not found" });
    assert.equal((await call("GET", "/recruiting/applications/not-a-uuid")).status, 400);
  });
});

describe("moving an Application", () => {
  test("writes the move and its reason on the timeline, and moving to the same stage changes nothing", async () => {
    const ada = await apply({ name: "Ada Lovelace", email: "ada@example.com" });
    actingUserId = member.id;
    const moved = await call<Moved>("POST", `/recruiting/applications/${ada.id}/move`, {
      stage: "interview",
      reason: "  Great portfolio. ",
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.email, null);
    assert.equal(moved.body.application.stage, "interview");
    assert.equal(moved.body.application.stageLabel, "Interview");
    const last = moved.body.application.timeline.at(-1);
    assert.equal(last?.kind, "stage_changed");
    assert.equal(last?.fromStage, "applied");
    assert.equal(last?.toStage, "interview");
    assert.equal(last?.body, "Great portfolio.");
    assert.equal(last?.actorUserId, member.id);
    const [audit] = await auditFor("recruiting.application.move");
    assert.deepEqual(JSON.parse(audit.metadataJson), { stage: "interview", emailed: null });
    assert.equal(audit.actorUserId, member.id);

    const again = await call<Moved>("POST", `/recruiting/applications/${ada.id}/move`, { stage: "interview" });
    assert.equal(again.status, 200);
    assert.equal(again.body.application.timeline.length, moved.body.application.timeline.length);
    assert.equal((await auditFor("recruiting.application.move")).length, 1);
  });

  test("rejecting without the email keeps the reason for the team and sends nothing", async () => {
    const ada = await apply({ name: "Ada Lovelace", email: "ada@example.com" });
    const moved = await call<Moved>("POST", `/recruiting/applications/${ada.id}/move`, {
      stage: "rejected",
      reason: "Not enough TypeScript yet.",
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.email, null);
    assert.equal(moved.body.application.stage, "rejected");
    assert.equal(moved.body.application.rejectionReason, "Not enough TypeScript yet.");
    assert.equal(await AppDataSource.getRepository(EmailLog).count(), 0);
    assert.ok(moved.body.application.timeline.every((event) => !event.kind.startsWith("email_")));
  });

  test("rejecting with the email sends the company's own template, never the reason, logged as skipped without a provider", async () => {
    const ada = await apply({ name: "Ada Lovelace", email: "ada@example.com" });
    actingUserId = member.id;
    const moved = await quietly(() =>
      call<Moved>("POST", `/recruiting/applications/${ada.id}/move`, {
        stage: "rejected",
        reason: "Not enough TypeScript yet.",
        notifyCandidate: true,
      }),
    );
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.body.email, { status: "skipped", error: "No email provider configured" });

    const logs = await AppDataSource.getRepository(EmailLog).find();
    assert.equal(logs.length, 1);
    const [log] = logs;
    assert.equal(log.companyId, company.id);
    assert.equal(log.purpose, "recruiting");
    assert.equal(log.status, "skipped");
    assert.equal(log.transport, "console");
    assert.equal(log.toAddress, "ada@example.com");
    assert.equal(log.subject, "Your application for Staff Engineer");
    assert.equal(log.triggeredByUserId, member.id);
    assert.match(log.bodyPreview, /^Hi Ada,/);
    assert.match(log.bodyPreview, /Staff Engineer role at Sunwise/);
    assert.doesNotMatch(log.bodyPreview, /TypeScript yet/);

    const emailed = moved.body.application.timeline.at(-1);
    assert.equal(emailed?.kind, "email_skipped");
    assert.equal(emailed?.meta.delivery, "rejection");
    assert.equal(emailed?.meta.emailLogId, log.id);
    const [audit] = await auditFor("recruiting.application.move");
    assert.deepEqual(JSON.parse(audit.metadataJson), { stage: "rejected", emailed: "skipped" });
  });

  test("only a rejection may email the candidate", async () => {
    const ada = await apply({ name: "Ada Lovelace", email: "ada@example.com" });
    const refused = await call("POST", `/recruiting/applications/${ada.id}/move`, {
      stage: "interview",
      notifyCandidate: true,
    });
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body, { error: "Only a rejection sends the candidate an email from here." });
    assert.equal((await rowOf(ada.id))?.stage, "applied");
    assert.equal(await AppDataSource.getRepository(EmailLog).count(), 0);
    assert.equal(await AppDataSource.getRepository(RecruitingApplicationEvent).count(), 1);
  });

  test("a rejected Application can come back, and loses its rejection reason", async () => {
    const ada = await apply({ name: "Ada Lovelace", email: "ada@example.com" });
    await call("POST", `/recruiting/applications/${ada.id}/move`, { stage: "rejected", reason: "Too junior." });
    const back = await call<Moved>("POST", `/recruiting/applications/${ada.id}/move`, { stage: "interview" });
    assert.equal(back.body.application.stage, "interview");
    assert.equal(back.body.application.rejectionReason, "");
    const last = back.body.application.timeline.at(-1);
    assert.equal(last?.fromStage, "rejected");
    assert.equal(last?.toStage, "interview");
  });

  test("validates the move at the boundary", async () => {
    const ada = await apply({ name: "Ada Lovelace", email: "ada@example.com" });
    for (const body of [
      {},
      { stage: "archived" },
      { stage: "interview", reason: "x".repeat(2_001) },
      { stage: "interview", notify: true },
      { stage: "interview", notifyCandidate: "yes" },
    ]) {
      const response = await call("POST", `/recruiting/applications/${ada.id}/move`, body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.equal((await rowOf(ada.id))?.stage, "applied");
  });
});

describe("notes", () => {
  test("adds a note to the timeline under the Member's name", async () => {
    const ada = await apply({ name: "Ada Lovelace", email: "ada@example.com" });
    actingUserId = member.id;
    const noted = await call<ApplicationDetail>("POST", `/recruiting/applications/${ada.id}/notes`, {
      body: "  Strong portfolio.\r\nCall on Tuesday.  ",
    });
    assert.equal(noted.status, 201);
    const note = noted.body.timeline.at(-1);
    assert.equal(note?.kind, "note");
    assert.equal(note?.body, "Strong portfolio.\nCall on Tuesday.");
    assert.equal(note?.actorKind, "member");
    assert.equal(note?.actorUserId, member.id);
    assert.equal(note?.actorName, "Member");
  });

  test("refuses an empty, blank or overlong note", async () => {
    const ada = await apply({ name: "Ada Lovelace", email: "ada@example.com" });
    const route = `/recruiting/applications/${ada.id}/notes`;
    assert.equal((await call("POST", route, { body: "" })).status, 400);
    const blank = await call("POST", route, { body: "   \n  " });
    assert.equal(blank.status, 400);
    assert.deepEqual(blank.body, { error: "Write the note first." });
    assert.equal((await call("POST", route, { body: "x".repeat(5_001) })).status, 400);
    assert.equal((await call("POST", route, { text: "Hello" })).status, 400);
    const notes = await AppDataSource.getRepository(RecruitingApplicationEvent).countBy({ kind: "note" });
    assert.equal(notes, 0);
  });
});

describe("a person's Scorecard", () => {
  test("is scored by the server from the ratings, with every quote checked against what the candidate wrote", async () => {
    const ada = await addByHand("Ada Lovelace", "ada@example.com", RESUME_TEXT);
    actingUserId = member.id;
    const scored = await call<ApplicationDetail>("POST", `/recruiting/applications/${ada.id}/scorecards`, {
      ratings: [
        {
          criterionId: criterionId("TypeScript"),
          rating: 3,
          evidence: ["Led the migration of the billing service, to TypeScript!", "Java"],
        },
        {
          criterionId: criterionId("Mentoring"),
          rating: 2,
          // Four-fifths of a long quote as one run is enough; a paraphrase is not.
          evidence: ["She mentors four engineers and writes JavaScript daily, too", "managed a team of forty engineers"],
        },
        { criterionId: criterionId("Design"), rating: null, note: "Nothing about design." },
      ],
      summary: "Meets the bar on TypeScript and mentoring.",
      strengths: ["Led a TypeScript migration"],
      concerns: ["No design work shown"],
      interviewQuestions: ["How did you sequence the migration?"],
    });
    assert.equal(scored.status, 201);
    const [card] = scored.body.scorecards;
    // round(100 × (3·3 + 2·2 + 1·0) ÷ (3 × (3 + 2 + 1))) = round(72.2)
    assert.equal(card.score, 72);
    assert.equal(card.label, "good");
    assert.equal(card.labelText, "Good match");
    assert.equal(card.authorKind, "member");
    assert.equal(card.authorUserId, member.id);
    assert.equal(card.authorName, "Member");
    assert.equal(card.unverifiedQuotes, 2);
    assert.equal(card.criteriaChanged, false);
    assert.deepEqual(
      card.ratings.map(({ name, rating, evidence }) => ({
        name,
        rating,
        found: evidence.map((quote) => quote.found),
      })),
      [
        { name: "TypeScript", rating: 3, found: [true, false] },
        { name: "Mentoring", rating: 2, found: [true, false] },
        { name: "Design", rating: null, found: [] },
      ],
    );
    assert.equal(card.ratings[2].note, "Nothing about design.");
    assert.deepEqual(card.strengths, ["Led a TypeScript migration"]);
    assert.deepEqual(card.concerns, ["No design work shown"]);
    assert.deepEqual(card.interviewQuestions, ["How did you sequence the migration?"]);

    // A person's Scorecard sits beside the AI's reading; it does not replace it.
    assert.equal(scored.body.score, null);
    assert.equal(scored.body.scoreLabel, null);
    const event = scored.body.timeline.at(-1);
    assert.equal(event?.kind, "scored");
    assert.equal(event?.body, "Meets the bar on TypeScript and mentoring.");
    assert.deepEqual(event?.meta, {
      scorecardId: card.id,
      score: 72,
      label: "good",
      authorKind: "member",
      missingMustHaves: [],
      unverifiedQuotes: 2,
    });
    const [audit] = await auditFor("recruiting.application.score");
    assert.deepEqual(JSON.parse(audit.metadataJson), { score: 72 });
  });

  test("a must-have rated Not shown makes it Weak, and one rated Partly caps it at Possible", async () => {
    const ratingsOf = (typescript: number) => ({
      ratings: [
        { criterionId: criterionId("TypeScript"), rating: typescript },
        { criterionId: criterionId("Mentoring"), rating: 3 },
        { criterionId: criterionId("Design"), rating: 3 },
      ],
    });
    const missing = await addByHand("Ada Lovelace", "ada@example.com", RESUME_TEXT);
    const weak = await call<ApplicationDetail>(
      "POST",
      `/recruiting/applications/${missing.id}/scorecards`,
      ratingsOf(0),
    );
    // 50 earns Possible on its own; the missing must-have makes it Weak.
    assert.equal(weak.body.scorecards[0].score, 50);
    assert.equal(weak.body.scorecards[0].label, "weak");
    assert.deepEqual(weak.body.scorecards[0].missingMustHaves, ["TypeScript"]);

    const partial = await addByHand("Grace Hopper", "grace@example.com", RESUME_TEXT);
    const capped = await call<ApplicationDetail>(
      "POST",
      `/recruiting/applications/${partial.id}/scorecards`,
      ratingsOf(1),
    );
    // 67 earns Good on its own; a partly shown must-have caps it.
    assert.equal(capped.body.scorecards[0].score, 67);
    assert.equal(capped.body.scorecards[0].label, "possible");
    assert.deepEqual(capped.body.scorecards[0].partialMustHaves, ["TypeScript"]);
  });

  test("refuses a typed score, an unknown or repeated criterion, and a rating off the scale", async () => {
    const ada = await addByHand("Ada Lovelace", "ada@example.com", RESUME_TEXT);
    const route = `/recruiting/applications/${ada.id}/scorecards`;
    const typescript = criterionId("TypeScript");
    const boundary = [
      { ratings: [{ criterionId: typescript, rating: 3 }], score: 100 },
      { ratings: [{ criterionId: typescript, rating: 4 }] },
      { ratings: [] },
      { ratings: [{ criterionId: typescript, rating: 2, evidence: ["x".repeat(301)] }] },
      { ratings: [{ criterionId: typescript, rating: 2, evidence: ["a", "b", "c", "d"] }] },
      { ratings: [{ criterionId: typescript, rating: 2 }], strengths: ["1", "2", "3", "4", "5", "6"] },
    ];
    for (const body of boundary) {
      const refused = await call("POST", route, body);
      assert.equal(refused.status, 400, JSON.stringify(body));
      assert.equal(refused.body.error, "ValidationError", JSON.stringify(body));
    }
    const unknown = await call("POST", route, { ratings: [{ criterionId: "nope", rating: 2 }] });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /^"nope" is not one of this Opening's criteria\./);
    const twice = await call("POST", route, {
      ratings: [
        { criterionId: typescript, rating: 2 },
        { criterionId: typescript, rating: 3 },
      ],
    });
    assert.equal(twice.status, 400);
    assert.deepEqual(twice.body, { error: 'Rate "TypeScript" only once.' });
    assert.equal(await AppDataSource.getRepository(RecruitingScorecard).count(), 0);
  });

  test("an Opening without criteria has nothing to score against", async () => {
    const bare = await createOpening(
      company.id,
      { title: "Generalist", description: DESCRIPTION },
      { kind: "member", userId: owner.id },
    );
    const alan = await addByHand("Alan Turing", "alan@example.com", undefined, bare);
    const refused = await call("POST", `/recruiting/applications/${alan.id}/scorecards`, {
      ratings: [{ criterionId: "anything", rating: 2 }],
    });
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body, {
      error: "This Opening has no criteria yet, so there is nothing to score against. Add criteria first.",
    });
  });

  test("says when it was written against criteria that have since changed", async () => {
    const ada = await addByHand("Ada Lovelace", "ada@example.com", RESUME_TEXT);
    await call("POST", `/recruiting/applications/${ada.id}/scorecards`, {
      ratings: [{ criterionId: criterionId("TypeScript"), rating: 3 }],
    });
    assert.equal((await detailOf(ada.id)).scorecards[0].criteriaChanged, false);
    const criteria = JSON.parse(opening.criteriaJson) as Array<{ id: string; name: string }>;
    await updateOpening(
      company.id,
      opening.id,
      { criteria: criteria.map((criterion, index) => (index === 0 ? { ...criterion, name: "TypeScript and Node" } : criterion)) },
      { kind: "member", userId: owner.id },
    );
    const after = await detailOf(ada.id);
    assert.equal(after.scorecards[0].criteriaChanged, true);
    // The Scorecard still shows the criterion as it was when it was written.
    assert.equal(after.scorecards[0].ratings[0].name, "TypeScript");
  });
});

describe("asking for a fresh AI screen", () => {
  test("needs an AI screener", async () => {
    const ada = await addByHand("Ada Lovelace", "ada@example.com", RESUME_TEXT);
    const refused = await call("POST", `/recruiting/applications/${ada.id}/screen`, {});
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body, {
      error: "No AI screener is appointed. Choose one at Recruiting → Settings first.",
    });
    assert.equal((await rowOf(ada.id))?.screenStatus, "none");
    assert.equal((await call("POST", `/recruiting/applications/${ada.id}/screen`, { now: true })).status, 400);
  });

  test("queues the Application for the screener and answers at once", async () => {
    await insert(RecruitingSettings, { companyId: company.id, screenerEmployeeId: iris.id });
    const ada = await addByHand("Ada Lovelace", "ada@example.com", RESUME_TEXT);
    await AppDataSource.getRepository(RecruitingApplication).update(
      { id: ada.id },
      { screenStatus: "failed", screenAttempts: 3, screenError: "The screen took too long." },
    );
    const queued = await call<ApplicationDetail>("POST", `/recruiting/applications/${ada.id}/screen`, {});
    assert.equal(queued.status, 200);
    assert.equal(queued.body.screenStatus, "queued");
    assert.equal(queued.body.screenAttempts, 0);
    assert.equal(queued.body.screenError, "");
    assert.equal(queued.body.screener?.id, iris.id);
    const first = await rowOf(ada.id);
    assert.ok(first?.screenQueuedAt);

    // Asking again while it waits changes nothing, and nothing has run yet.
    const again = await call<ApplicationDetail>("POST", `/recruiting/applications/${ada.id}/screen`, {});
    assert.equal(again.body.screenStatus, "queued");
    assert.equal((await rowOf(ada.id))?.screenQueuedAt?.getTime(), first?.screenQueuedAt?.getTime());
    assert.deepEqual(again.body.scorecards, []);
  });

  test("the screener scores the queued Application from the blinded text, and the score lands on it", async () => {
    await insert(RecruitingSettings, { companyId: company.id, screenerEmployeeId: iris.id });
    const ada = await addByHand("Ada Lovelace", "ada@example.com", RESUME_TEXT);
    const seen: ScreenRunnerArgs[] = [];
    setScreenRunnerForTests(async (args) => {
      seen.push(args);
      return {
        ratings: args.criteria.map((criterion) => ({
          criterionId: criterion.id,
          rating: 3,
          evidence:
            criterion.name === "TypeScript"
              ? ["[Candidate] led the migration of the billing service to TypeScript"]
              : [],
          note: "Clear evidence.",
        })),
        summary: "Exceeds the bar on every criterion.",
        strengths: ["Led a TypeScript migration"],
        concerns: [],
        interviewQuestions: [],
        injectionDetected: false,
      };
    });
    assert.equal((await call("POST", `/recruiting/applications/${ada.id}/screen`, {})).status, 200);
    const outcomes = await runScreeningQueueOnce();
    assert.deepEqual(
      outcomes.map((outcome) => outcome.outcome),
      ["scored"],
    );

    assert.equal(seen.length, 1);
    const resume = seen[0].application.resume;
    assert.match(resume, /\[Candidate\] led the migration/);
    assert.match(resume, /\[email\]/);
    assert.match(resume, /\[phone\]/);
    assert.doesNotMatch(resume, /Ada|Lovelace|ada@example\.com|7946/);

    const detail = await detailOf(ada.id);
    assert.equal(detail.screenStatus, "scored");
    assert.equal(detail.score, 100);
    assert.equal(detail.scoreLabel, "strong");
    const [card] = detail.scorecards;
    assert.equal(card.authorKind, "screener");
    assert.equal(card.authorEmployeeId, iris.id);
    assert.equal(card.modelLabel, "gpt-4.1-mini");
    assert.equal(card.unverifiedQuotes, 0);

    // A strong match is the one result worth telling the Opening's owner about.
    const notices = await AppDataSource.getRepository(Notification).findBy({ userId: owner.id });
    assert.deepEqual(
      notices.map((notice) => notice.kind),
      ["recruiting_strong_match"],
    );
  });
});

describe("adding a candidate by hand", () => {
  test("a Member adds someone with a resume file, and the timeline says who added them and why", async () => {
    const pdf = await pdfResume(["Grace Hopper", "Built the first compiler.", "Led the COBOL team."]);
    actingUserId = member.id;
    const added = await addByForm(
      {
        name: "Grace Hopper",
        email: " Grace@Example.com ",
        phone: "+1 415 555 0100",
        sourceDetail: "Referred by Ada",
      },
      { bytes: pdf, name: "grace-hopper.pdf", type: "application/pdf" },
    );
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const detail = added.body;
    assert.equal(detail.candidateEmail, "grace@example.com");
    assert.equal(detail.candidatePhone, "+1 415 555 0100");
    assert.equal(detail.source, "manual");
    assert.equal(detail.sourceDetail, "Referred by Ada");
    assert.deepEqual(detail.resume, { fileName: "grace-hopper.pdf", mimeType: "application/pdf", size: pdf.length });
    assert.equal(detail.resumeTextStatus, "extracted");
    assert.match(detail.resumeText, /first compiler/);
    assert.deepEqual(
      detail.timeline.map(({ kind, actorKind, actorUserId, body, meta }) => ({ kind, actorKind, actorUserId, body, meta })),
      [{ kind: "added", actorKind: "member", actorUserId: member.id, body: "Referred by Ada", meta: { source: "manual" } }],
    );
    const [stored] = filesIn(resumesDir());
    assert.ok(stored?.endsWith(".pdf"));
    assert.deepEqual(fs.readFileSync(path.join(resumesDir(), stored)), pdf);
    const [audit] = await auditFor("recruiting.application.add");
    assert.equal(audit.targetId, detail.id);
    assert.equal(audit.targetLabel, "Grace Hopper");

    // With no screener watching, the Opening's owner hears about it; the
    // candidate gets no confirmation, because they never applied.
    await eventually(
      async () => (await AppDataSource.getRepository(Notification).countBy({ userId: owner.id })) === 1,
      "the owner's notification",
    );
    const [notice] = await AppDataSource.getRepository(Notification).findBy({ userId: owner.id });
    assert.equal(notice.kind, "recruiting_application");
    assert.equal(notice.title, "New candidate for Staff Engineer");
    assert.equal(notice.body, "Grace Hopper was added.");
    assert.equal(await AppDataSource.getRepository(EmailLog).count(), 0);
  });

  test("adds someone from pasted resume text, sent as JSON", async () => {
    // Another Member adds them, so the Opening's owner is told.
    actingUserId = member.id;
    const added = await call<ApplicationDetail>("POST", `/recruiting/openings/${opening.id}/applications`, {
      name: "Alan Turing",
      email: "alan@example.com",
      resumeText: "Alan broke Enigma at Bletchley Park and designed the ACE.",
    });
    assert.equal(added.status, 201);
    assert.equal(added.body.resume, null);
    assert.equal(added.body.resumeTextStatus, "extracted");
    assert.equal(added.body.resumeText, "Alan broke Enigma at Bletchley Park and designed the ACE.");
    await eventually(
      async () => (await AppDataSource.getRepository(Notification).countBy({ userId: owner.id })) === 1,
      "the owner's notification",
    );
  });

  test("queues the new candidate for the AI screen when a screener is appointed", async () => {
    await insert(RecruitingSettings, { companyId: company.id, screenerEmployeeId: iris.id });
    const added = await call<ApplicationDetail>("POST", `/recruiting/openings/${opening.id}/applications`, {
      name: "Alan Turing",
      email: "alan@example.com",
      resumeText: "Alan broke Enigma at Bletchley Park and designed the ACE.",
    });
    assert.equal(added.status, 201);
    await eventually(async () => (await rowOf(added.body.id))?.screenStatus === "queued", "the queued screen");
    assert.equal(await AppDataSource.getRepository(Notification).count(), 0);
  });

  test("refuses bad details by field, a file that is not a resume, an oversized file and unknown fields", async () => {
    const badFields = await addByForm({ name: "", email: "not-an-email", linkedinUrl: "javascript:alert(1)" });
    assert.equal(badFields.status, 400);
    assert.equal(badFields.body.error, "Enter your name.");
    assert.deepEqual(badFields.body.fields, {
      name: "Enter your name.",
      email: "Enter an email address, like ada@example.com.",
      linkedin: "Enter a link, like https://www.linkedin.com/in/you.",
    });

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    const notResume = await addByForm(
      { name: "Grace Hopper", email: "grace@example.com" },
      { bytes: png, name: "resume.pdf", type: "application/pdf" },
    );
    assert.equal(notResume.status, 400);
    assert.deepEqual(notResume.body, { error: RESUME_TYPE_HINT });

    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 0x20);
    oversized.write("%PDF-1.4\n");
    const tooBig = await addByForm(
      { name: "Grace Hopper", email: "grace@example.com" },
      { bytes: oversized, name: "resume.pdf", type: "application/pdf" },
    );
    assert.equal(tooBig.status, 413);
    assert.deepEqual(tooBig.body, { error: "Attach the resume as one file under 10 MB." });

    const unknown = await addByForm({ name: "Grace Hopper", email: "grace@example.com", stage: "hired" });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error, "ValidationError");

    const elsewhere = await addByForm({ name: "Grace Hopper", email: "grace@example.com" }, undefined, theirOpening.id);
    assert.equal(elsewhere.status, 404);

    assert.equal(await AppDataSource.getRepository(RecruitingApplication).count(), 0);
    assert.deepEqual(filesIn(resumesDir()), []);
  });

  test("keeps the letters of a resume's file name as the browser sent them", async () => {
    actingUserId = member.id;
    const pdf = await pdfResume(["Zoe Muller", "Platform engineer."]);
    const added = await addByForm(
      { name: "Zoë Müller", email: "zoe@example.com" },
      { bytes: pdf, name: "Zoë Müller – CV.pdf", type: "application/pdf" },
    );
    assert.equal(added.status, 201);
    await eventually(
      async () => (await AppDataSource.getRepository(Notification).countBy({ userId: owner.id })) === 1,
      "the owner's notification",
    );
    assert.equal(added.body.candidateName, "Zoë Müller");
    assert.equal(added.body.resume?.fileName, "Zoë Müller – CV.pdf");
  });
});

describe("downloading a resume", () => {
  test("opens a PDF inline as a PDF, with no sandbox to break the viewer, and never lets the browser sniff", async () => {
    const pdf = await pdfResume(["Ada Lovelace", "Staff engineer."]);
    const ada = await apply(
      { name: "Ada Lovelace", email: "ada@example.com" },
      { buffer: pdf, originalname: "Ada Lovelace.pdf" },
    );
    const response = await download(ada.id);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(
      response.headers.get("content-disposition"),
      `inline; filename="Ada Lovelace.pdf"; filename*=UTF-8''Ada%20Lovelace.pdf`,
    );
    assert.equal(response.headers.get("content-security-policy"), null);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf);
  });

  test("downloads a PDF as an inert attachment when asked", async () => {
    const pdf = await pdfResume(["Ada Lovelace", "Staff engineer."]);
    const ada = await apply(
      { name: "Ada Lovelace", email: "ada@example.com" },
      { buffer: pdf, originalname: "Ada Lovelace.pdf" },
    );
    const response = await download(ada.id, "?download=1");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.equal(
      response.headers.get("content-disposition"),
      `attachment; filename="Ada Lovelace.pdf"; filename*=UTF-8''Ada%20Lovelace.pdf`,
    );
    assert.equal(response.headers.get("content-security-policy"), "sandbox");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf);
  });

  test("serves nothing else inline: a text resume holding HTML downloads as inert bytes", async () => {
    const html =
      "<html><body><script>fetch('/api/auth/me')</script>Ada Lovelace, TypeScript engineer for ten years.</body></html>";
    const ada = await apply(
      { name: "Ada Lovelace", email: "ada@example.com" },
      { buffer: Buffer.from(html), originalname: "resume.txt" },
    );
    assert.equal((await detailOf(ada.id)).resume?.mimeType, "text/plain; charset=utf-8");
    const response = await download(ada.id);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.match(response.headers.get("content-disposition") ?? "", /^attachment; /);
    assert.equal(response.headers.get("content-security-policy"), "sandbox");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), html);
  });

  test("keeps the header safe whatever the applicant called the file", async () => {
    const ada = await apply(
      { name: "Zoë Müller", email: "zoe@example.com" },
      textResume(RESUME_TEXT, 'Zoë "The Coder"\r\nMüller résumé.txt'),
    );
    const stored = (await detailOf(ada.id)).resume?.fileName ?? "";
    // Quotes and line breaks never reach storage.
    assert.equal(stored, "Zoë The CoderMüller résumé.txt");

    const safeHeader = /^attachment; filename="([\x20\x21\x23-\x7e]*)"; filename\*=UTF-8''([A-Za-z0-9%!'()*._~-]+)$/;
    const response = await download(ada.id);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), RESUME_TEXT);
    const header = response.headers.get("content-disposition") ?? "";
    const match = safeHeader.exec(header);
    assert.ok(match, header);
    assert.equal(match[1], "Zo_ The CoderM_ller r_sum_.txt");
    assert.equal(decodeURIComponent(match[2]), stored);

    // A name stored by some other path is made safe on the way out too.
    await AppDataSource.getRepository(RecruitingApplication).update(
      { id: ada.id },
      { resumeFileName: 'cv"; filename="evil.html\r\nX-Injected: 1' },
    );
    const hostile = await download(ada.id);
    assert.equal(hostile.status, 200);
    await hostile.arrayBuffer();
    assert.equal(hostile.headers.get("x-injected"), null);
    const hostileHeader = hostile.headers.get("content-disposition") ?? "";
    const hostileMatch = safeHeader.exec(hostileHeader);
    assert.ok(hostileMatch, hostileHeader);
    assert.equal(hostileMatch[1], "cv_; filename=_evil.html__X-Injected: 1");
  });

  test("answers 404 when the file is gone, and validates the query", async () => {
    const ada = await apply({ name: "Ada Lovelace", email: "ada@example.com" }, textResume());
    assert.equal(await downloadStatus(ada.id, "?download=yes"), 400);
    assert.equal(await downloadStatus(ada.id, "?inline=1"), 400);
    for (const file of filesIn(resumesDir())) fs.rmSync(path.join(resumesDir(), file));
    const gone = await download(ada.id);
    assert.equal(gone.status, 404);
    assert.deepEqual(await gone.json(), { error: "No resume on file." });
  });
});

describe("erasing an Application", () => {
  test("removes the row, its Scorecards and timeline, and the resume on disk", async () => {
    const ada = await apply({ name: "Ada Lovelace", email: "ada@example.com" }, textResume());
    await call("POST", `/recruiting/applications/${ada.id}/notes`, { body: "Strong." });
    await call("POST", `/recruiting/applications/${ada.id}/scorecards`, {
      ratings: [{ criterionId: criterionId("TypeScript"), rating: 3 }],
    });
    const grace = await apply({ name: "Grace Hopper", email: "grace@example.com" });
    assert.equal(filesIn(resumesDir()).length, 1);

    actingUserId = admin.id;
    assert.equal((await call("DELETE", `/recruiting/applications/${ada.id}`)).status, 204);
    assert.equal(await rowOf(ada.id), null);
    assert.equal(await AppDataSource.getRepository(RecruitingScorecard).countBy({ applicationId: ada.id }), 0);
    assert.equal(
      await AppDataSource.getRepository(RecruitingApplicationEvent).countBy({ applicationId: ada.id }),
      0,
    );
    assert.deepEqual(filesIn(resumesDir()), []);
    assert.equal((await call("GET", `/recruiting/applications/${ada.id}`)).status, 404);
    assert.equal((await call("DELETE", `/recruiting/applications/${ada.id}`)).status, 404);
    // Nobody else's record is touched.
    assert.ok(await rowOf(grace.id));
    const [audit] = await auditFor("recruiting.application.delete");
    assert.equal(audit.targetId, ada.id);
    assert.equal(audit.targetLabel, "Ada Lovelace");
    assert.equal(audit.actorUserId, admin.id);
  });
});

describe("live sync", () => {
  type Change = { companyId: string; kind: string; scopeIds: string[] };

  function listen(): Change[] {
    const changes: Change[] = [];
    registerResourceChangeSink((companyId, kind, scopeIds) => changes.push({ companyId, kind, scopeIds }));
    return changes;
  }

  function announced(changes: Change[]): boolean {
    return changes.some(
      (change) =>
        change.companyId === company.id &&
        change.kind === "recruiting_application" &&
        (change.scopeIds.length === 0 || change.scopeIds.includes(opening.id)),
    );
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  test("moving an Application or writing a note reaches the boards that show its Opening", async () => {
    const ada = await apply({ name: "Ada Lovelace", email: "ada@example.com" });
    const changes = listen();
    await settle();
    changes.length = 0;
    await call("POST", `/recruiting/applications/${ada.id}/move`, { stage: "interview" });
    await settle();
    assert.ok(announced(changes), `move: ${JSON.stringify(changes)}`);
    changes.length = 0;
    await call("POST", `/recruiting/applications/${ada.id}/notes`, { body: "Strong." });
    await settle();
    assert.ok(announced(changes), `note: ${JSON.stringify(changes)}`);
  });

  test("erasing an Application reaches the boards too, so nobody opens a record that is gone", async () => {
    const ada = await apply({ name: "Ada Lovelace", email: "ada@example.com" });
    const changes = listen();
    await settle();
    changes.length = 0;
    assert.equal((await call("DELETE", `/recruiting/applications/${ada.id}`)).status, 204);
    await settle();
    assert.ok(announced(changes), `expected a recruiting_application change, saw ${JSON.stringify(changes)}`);
  });
});
